// services/socialPush.js
// A push to students for every new post, confession and skillshare listing.
//   posts, listings → every student          confessions → students of the author's university only
// Recipients: role student, a push token, the matching notification switch not off (no profile =
// on), never an author of the items. Sent in bulk (Expo chunks of 100 via sendAllSafe), not one
// student at a time like the engagement gateway; dead tokens are removed by handleTickets.
// No in-app Notification entries (those would push again on save and write one row per student).
//
// Privacy: a confession push carries no confession text, no author and no university, in the
// title, the body or the data.
const { Expo } = require("expo-server-sdk");
const mongoose = require("mongoose");
const User = require("../models/User");
const EngagementProfile = require("../models/EngagementProfile");
const { sendAllSafe, handleTickets, channelForToken, safeSoundKey, resolveSoundKey, featureMood, iconUrlForMood, titleWithEmoji } = require("../utils/pushNotification");
const { projectOfEntries } = require("../utils/expoProjects");

const KINDS = {
  post: { type: "social_post", pref: "posts" },
  confession: { type: "social_confession", pref: "confessions" },
  listing: { type: "skillshare_listing", pref: "skillshare" },
};
const PAGE = 1000; // students read per query

// one line, at most `max` characters ("…" when cut)
function snippet(text, max = 60) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "someone";

// Title, body and tap target. items: what was stored when each item was created
//   post: { id, firstName, text, hasImage }  confession: { id }  listing: { id, title }
function buildContent(kind, items) {
  const n = items.length;
  const one = items[0] || {};
  if (kind === "post") {
    if (n === 1) {
      return {
        title: `${firstName(one.firstName)} posted on campus`,
        body: snippet(one.text) || (one.hasImage ? "shared a photo" : ""),
        data: { route: "PostDetailScreen", params: { postId: String(one.id) }, postId: String(one.id) },
      };
    }
    return { title: `${n} new posts on campus`, body: "", data: { route: "FeedScreen", params: { tab: "Feed" } } };
  }
  if (kind === "confession") {
    // never the text, the author or the university
    if (n === 1) {
      return { title: "new confession on campus. tap to read.", body: "", data: { route: "FeedScreen", params: { tab: "Confession", postId: String(one.id) } } };
    }
    return { title: `${n} new confessions on campus. tap to read.`, body: "", data: { route: "FeedScreen", params: { tab: "Confession" } } };
  }
  if (kind === "listing") {
    if (n === 1) {
      return {
        title: `new skillshare listing: ${snippet(one.title)}`,
        body: "",
        data: { route: "ListingDetail", params: { listingId: String(one.id), id: String(one.id) }, listingId: String(one.id) },
      };
    }
    return { title: `${n} new skillshare listings`, body: "", data: { route: "Dashboard", params: {} } };
  }
  throw new Error(`socialPush: unknown kind ${kind}`);
}

const asId = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

// Students to notify, page by page: [{ _id, pushTokens }]
//   universityId: confessions only (required: no university → nobody)
async function findRecipients(kind, { universityId = null, excludeUserIds = [] } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`socialPush: unknown kind ${kind}`);
  const filter = {
    role: "student",
    "pushTokens.0": { $exists: true },
    _id: { $nin: excludeUserIds.map(asId).filter(Boolean) },
  };
  if (kind === "confession") {
    const uni = asId(universityId);
    if (!uni) return [];
    filter.university = uni;
  }
  const out = [];
  let after = null;
  for (;;) {
    const page = await User.find(after ? { ...filter, _id: { ...filter._id, $gt: after } } : filter)
      .select("_id +pushTokens")
      .sort({ _id: 1 })
      .limit(PAGE)
      .lean();
    if (!page.length) break;
    // the switch for this kind: off only when explicitly false (no profile / missing key = on)
    const off = await EngagementProfile.find({ user: { $in: page.map((u) => u._id) }, [`notifPrefs.${k.pref}`]: false })
      .select("user")
      .lean();
    const offSet = new Set(off.map((p) => String(p.user)));
    for (const u of page) if (!offSet.has(String(u._id))) out.push(u);
    after = page[page.length - 1]._id;
    if (page.length < PAGE) break;
  }
  return out;
}

// Build and send one push to these students. Returns { students, devices, delivered, failed }
// and the ids of the students that got it on at least one device.
async function sendToStudents(kind, items, students) {
  const k = KINDS[kind];
  const content = buildContent(kind, items);
  const mood = featureMood(k.type);
  const soundKey = safeSoundKey(resolveSoundKey(k.type, mood));
  const image = iconUrlForMood(mood);
  const title = titleWithEmoji(content.title, mood);

  const messages = [];
  const ownerOf = [];
  const entries = [];
  const seen = new Set();
  for (const s of students) {
    for (const e of s.pushTokens || []) {
      if (!e?.token || seen.has(e.token) || !Expo.isExpoPushToken(e.token)) continue;
      seen.add(e.token);
      const channelId = channelForToken(e, soundKey);
      entries.push(e);
      ownerOf.push(String(s._id));
      messages.push({
        to: e.token,
        title,
        body: content.body,
        sound: `${soundKey}.wav`,
        channelId,
        priority: "high",
        ttl: 60 * 60 * 24,
        ...(image ? { richContent: { image }, mutableContent: true } : {}),
        data: { v: 1, type: k.type, mood, iconUrl: image || null, channelId, soundKey, ...content.data },
      });
    }
  }
  if (!messages.length) return { students: students.length, devices: 0, delivered: 0, failed: 0, reached: [] };

  const tickets = await sendAllSafe(null, messages, projectOfEntries(entries));
  const reached = new Set();
  tickets.forEach((t, i) => { if (t?.status === "ok") reached.add(ownerOf[i]); });
  // readable log per failed device, removes only dead tokens, receipts later (never throws)
  const r = await handleTickets(messages, tickets, null, "[socialPush]");
  return { students: students.length, devices: messages.length, delivered: r.ok, failed: r.failed, reached: [...reached] };
}

module.exports = { KINDS, buildContent, findRecipients, sendToStudents, snippet };
