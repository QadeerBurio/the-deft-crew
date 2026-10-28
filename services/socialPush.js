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
const SocialPushGroup = require("../models/SocialPushGroup");
const { isQuietHour } = require("../utils/karachiTime");

const KINDS = {
  post: { type: "social_post", pref: "posts", env: "SOCIAL_PUSH_POSTS" },
  confession: { type: "social_confession", pref: "confessions", env: "SOCIAL_PUSH_CONFESSIONS" },
  listing: { type: "skillshare_listing", pref: "skillshare", env: "SOCIAL_PUSH_SKILLSHARE" },
};

// Railway switches, off unless exactly "true". Read every time (no restart needed for code,
// though Railway restarts the service when a variable changes).
const isOn = (kind) => process.env[KINDS[kind]?.env] === "true";
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

// ── Grouping, flood guard, quiet hours ──
// At most one push per kind (and per university for confessions) every 5 minutes; items in
// that window are combined ("4 new posts on campus"). 23:00–09:00 Karachi nothing is sent:
// those items go out together at 09:00. The create request only adds the item (in the
// background); a timer sends groups that are due.
const FLOOD_MS = 5 * 60 * 1000;
const QUIET = { quietStart: 23, quietEnd: 9 };
const PKT_MS = 5 * 60 * 60 * 1000;

// next 09:00 Karachi time (04:00 UTC) after a moment in quiet hours
function quietEnd(at) {
  const pkt = new Date(at.getTime() + PKT_MS);
  const day = pkt.getUTCHours() >= QUIET.quietStart ? pkt.getUTCDate() + 1 : pkt.getUTCDate();
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), day, QUIET.quietEnd, 0, 0) - PKT_MS);
}

// earliest moment this kind/scope may send again
async function nextSlot(kind, scope, now) {
  const last = await SocialPushGroup.findOne({ kind, scope, status: { $in: ["sending", "sent"] } })
    .sort({ sentAt: -1 })
    .select("sentAt")
    .lean();
  let at = now;
  if (last?.sentAt) at = new Date(Math.max(now.getTime(), new Date(last.sentAt).getTime() + FLOOD_MS));
  if (isQuietHour(at, QUIET)) at = quietEnd(at);
  return at;
}

// What a group stores per item (only what the text needs)
function itemFor(kind, item) {
  const base = { id: asId(item.id), authorId: asId(item.authorId) };
  if (kind === "post") return { ...base, firstName: firstName(item.authorName), text: snippet(item.text), hasImage: !!item.hasImage };
  if (kind === "listing") return { ...base, title: snippet(item.title) };
  return base; // confession: nothing but its id
}

// Add a new item. post: { id, authorId, authorName, text, hasImage }
// confession: { id, authorId, universityId }  listing: { id, authorId, title }
async function enqueue(kind, item, { now = new Date() } = {}) {
  if (!KINDS[kind]) throw new Error(`socialPush: unknown kind ${kind}`);
  if (!isOn(kind)) return { queued: false, reason: "switched_off" };
  let scope = "all";
  if (kind === "confession") {
    const uni = asId(item.universityId);
    if (!uni) return { queued: false, reason: "no_university" };
    scope = String(uni);
  }
  const stored = itemFor(kind, item);
  if (!stored.id || !stored.authorId) return { queued: false, reason: "bad_item" };

  const sendAfter = await nextSlot(kind, scope, now);
  const group = await SocialPushGroup.findOneAndUpdate(
    { kind, scope, status: "open" },
    { $push: { items: stored }, $setOnInsert: { sendAfter, createdAt: now } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  if (group && new Date(group.sendAfter) <= now) await flush(group._id, { now });
  return { queued: true, groupId: group?._id, sendAfter: group?.sendAfter };
}

// Items that still exist (deleted ones and closed listings are left out)
async function stillThere(kind, items) {
  const Model = kind === "post" ? require("../models/Post") : kind === "confession" ? require("../models/Confession") : require("../models/Listing");
  const filter = { _id: { $in: items.map((i) => i.id) } };
  if (kind === "listing") filter.status = "open";
  const found = await Model.find(filter).select("_id").lean();
  const ok = new Set(found.map((d) => String(d._id)));
  return items.filter((i) => ok.has(String(i.id)));
}

// Send one due group (only one caller wins the claim)
async function flush(groupId, { now = new Date() } = {}) {
  if (isQuietHour(now, QUIET)) {
    await SocialPushGroup.updateOne({ _id: groupId, status: "open" }, { $set: { sendAfter: quietEnd(now) } });
    return { sent: false, reason: "quiet_hours" };
  }
  const group = await SocialPushGroup.findOneAndUpdate(
    { _id: groupId, status: "open", sendAfter: { $lte: now } },
    { $set: { status: "sending", sentAt: now } },
    { new: true }
  ).lean();
  if (!group) return { sent: false, reason: "not_due" };

  // switched off while waiting: nothing goes out
  if (!isOn(group.kind)) {
    await SocialPushGroup.updateOne({ _id: group._id }, { $set: { status: "dropped", reason: "switched_off" } });
    return { sent: false, reason: "switched_off" };
  }

  try {
    const items = await stillThere(group.kind, group.items || []);
    if (!items.length) {
      await SocialPushGroup.updateOne({ _id: group._id }, { $set: { status: "dropped", reason: "items_gone" } });
      return { sent: false, reason: "items_gone" };
    }
    // never an author of anything in the group
    const authors = [...new Set((group.items || []).map((i) => String(i.authorId)))];
    const students = await findRecipients(group.kind, {
      universityId: group.kind === "confession" ? group.scope : null,
      excludeUserIds: authors,
    });
    const result = await sendToStudents(group.kind, items, students);
    await SocialPushGroup.updateOne(
      { _id: group._id },
      { $set: { status: "sent", result: { students: result.students, devices: result.devices, delivered: result.delivered, failed: result.failed } } }
    );
    // counts only, never names, ids or text
    console.log(`[socialPush] ${group.kind} x${items.length} → ${result.students} students, ${result.devices} devices, ${result.failed} failed`);
    return { sent: true, ...result };
  } catch (err) {
    await SocialPushGroup.updateOne({ _id: group._id }, { $set: { status: "dropped", reason: `error: ${err.message}` } }).catch(() => {});
    console.warn(`[socialPush] ${group.kind} not sent:`, err.message);
    return { sent: false, reason: "error" };
  }
}

// Every due group; groups stuck in "sending" (server stopped mid-send) are closed, not resent
async function flushDue({ now = new Date() } = {}) {
  await SocialPushGroup.updateMany(
    { status: "sending", sentAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) } },
    { $set: { status: "dropped", reason: "interrupted" } }
  );
  if (isQuietHour(now, QUIET)) return 0;
  const due = await SocialPushGroup.find({ status: "open", sendAfter: { $lte: now } }).select("_id").lean();
  for (const g of due) await flush(g._id, { now });
  return due.length;
}

let timer = null;
function startScheduler(everyMs = 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => {
    flushDue().catch((e) => console.warn("[socialPush] timer:", e.message));
  }, everyMs);
  if (timer.unref) timer.unref();
}

module.exports = { KINDS, isOn, buildContent, findRecipients, sendToStudents, snippet, enqueue, flush, flushDue, startScheduler, quietEnd, FLOOD_MS };
