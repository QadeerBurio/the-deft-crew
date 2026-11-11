// services/surplus/announcements.js
// "A new Surprise Box near you" (FLAG_SURPLUS_BOXES). When a box is published for the first time, every student
// with the flag on, a push token and the same city as the box's branch (profile location, compared as typed:
// services/surplus/city.js) gets one SurplusAnnouncement row, at most one per student per Karachi day.
// Delivery goes through the pushGateway as an ordinary (non-essential) push with pref "deals", so the daily and
// weekly caps, quiet hours and the "deals" opt-out apply; a sent push also leaves an in-app note. Quiet hours wait
// until they end (if the box can still be ordered then); a box that is closed, sold out, past its cutoff or from a
// blocked brand is never announced. Nothing here changes for students or brands outside the pilot.
//   onPublished(listing)   queue the rows, then deliver in the background
//   deliver(rowId, now)    one row          drain({ limit, now })   what's due (also every sweep tick)
const SurplusAnnouncement = require("../../models/SurplusAnnouncement");
const SurplusListing = require("../../models/SurplusListing");
const SurplusBrandBlock = require("../../models/SurplusBrandBlock");
const Notification = require("../../models/Notification");
const User = require("../../models/User");
const { isEnabled } = require("../../config/featureFlags");
const { dayKey } = require("../../utils/karachiTime");
const { cityName, cityFilter } = require("./city");

const MAX_ATTEMPTS = 5;
const MAX_STUDENTS = 5000;
const MIN = 60 * 1000;
const QUIET_END_HOUR = 9; // 09:00 Karachi (config/engagement.config.js push.quietEndHour)
const backoff = (attempts) => Math.min(60, 2 ** attempts) * MIN;
const at = (d) => {
  try { return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Karachi", weekday: "short", hour: "2-digit", minute: "2-digit" }); } catch { return new Date(d).toISOString(); }
};
/** the next 09:00 in Karachi (UTC+5 all year) after `now` */
function quietEnd(now = new Date()) {
  const k = new Date(now.getTime() + 5 * 3600e3);
  let end = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), QUIET_END_HOUR) - 5 * 3600e3;
  if (end <= now.getTime()) end += 24 * 3600e3;
  return new Date(end);
}
const orderable = (l, now) => !!l && l.status === "published" && l.quantityAvailable > 0 && now < new Date(l.orderCutoff) && now < new Date(l.pickupEnd);

function payloadFor(listing, brandName) {
  const price = `${listing.currency || "PKR"} ${listing.price}`;
  return {
    title: "A new Surprise Box near you",
    body: `${brandName}: ${listing.title}, ${price}. Pick up ${at(listing.pickupStart)} at ${listing.location?.branchName || "the branch"}.`,
    // a tap opens the box in the app (SurpriseBoxes screen)
    data: { surplusListingId: String(listing._id), screen: "SurpriseBoxes", params: { listingId: String(listing._id) } },
  };
}

/** Queue "a new box near you" for a box that was just published for the first time. Never throws. */
async function onPublished(listing, { now = new Date(), drainNow = true } = {}) {
  try {
    if (!listing?._id || !orderable(listing, now)) return { queued: 0, reason: "not orderable" };
    if (!isEnabled("surplusBoxes", { id: String(listing.brand), role: "brand" })) return { queued: 0, reason: "brand outside the pilot" };
    if (await SurplusBrandBlock.exists({ brand: listing.brand, active: true })) return { queued: 0, reason: "brand blocked" };
    const city = cityName(listing.location?.city);
    if (!city) return { queued: 0, reason: "no city" };
    const brand = await User.findById(listing.brand).select("brandName companyName name").lean();
    const payload = payloadFor(listing, brand?.brandName || brand?.companyName || brand?.name || "A brand");
    const students = await User.find({ role: "student", "pushTokens.0": { $exists: true }, location: cityFilter(city) }).select("_id").limit(MAX_STUDENTS).lean();
    const day = dayKey(now);
    let queued = 0;
    for (const s of students) {
      if (!isEnabled("surplusBoxes", { id: String(s._id), role: "student" })) continue;
      try {
        await SurplusAnnouncement.create({ listing: listing._id, brand: listing.brand, student: s._id, dayKey: day, key: `${s._id}:${day}`, payload, expiresAt: listing.orderCutoff, nextAttemptAt: now });
        queued += 1;
      } catch (err) {
        if (err?.code !== 11000) throw err; // 11000: this student already has today's announcement
      }
    }
    if (drainNow && queued) setImmediate(() => drain({ limit: 500 }).catch((e) => console.error(`[surplus] announcements: ${e.message}`)));
    return { queued, city };
  } catch (err) {
    console.error(`[surplus] announcements for a new box failed: ${err.message}`);
    return { queued: 0, error: err.message };
  }
}

async function deliver(rowId, now = new Date()) {
  const row = await SurplusAnnouncement.findOneAndUpdate(
    { _id: rowId, status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
    { $set: { status: "sending" }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!row) return null;
  let r;
  try {
    const listing = await SurplusListing.findById(row.listing).lean();
    if (now >= new Date(row.expiresAt) || !orderable(listing, now)) r = { status: "skipped", error: "box no longer available" };
    else if (await SurplusBrandBlock.exists({ brand: row.brand, active: true })) r = { status: "skipped", error: "brand blocked" };
    else if (!isEnabled("surplusBoxes", { id: String(row.student), role: "student" }) || !isEnabled("surplusBoxes", { id: String(row.brand), role: "brand" })) r = { status: "skipped", error: "outside the pilot" };
    else {
      const gateway = require("../engagement/pushGateway");
      const sent = await gateway.send(row.student, { type: "nearby_deal", pref: "deals", title: row.payload.title, body: row.payload.body, data: row.payload.data });
      if (sent?.sent) {
        await Notification.create({ recipient: row.student, title: row.payload.title, description: row.payload.body, type: "Offer", metadata: { ...row.payload.data, skipPush: true, surplusAnnouncementId: String(row._id) } });
        r = { status: "sent" };
      } else if (sent?.reason === "quiet_hours") {
        const next = quietEnd(now);
        r = next < new Date(row.expiresAt) ? { status: "defer", error: "quiet_hours", next } : { status: "skipped", error: "quiet hours until the box closes" };
      } else r = { status: "skipped", error: sent?.reason || "not sent" }; // daily / weekly cap, "deals" off, no token
    }
  } catch (err) {
    r = { status: "retry", error: err.message };
  }
  const update = r.status === "sent" ? { status: "sent", sentAt: now, lastError: "" }
    : r.status === "skipped" ? { status: "skipped", lastError: String(r.error || "").slice(0, 200) }
      : r.status === "defer" ? { status: "pending", lastError: "quiet_hours", nextAttemptAt: r.next, attempts: row.attempts - 1 }
        : { status: "failed", lastError: String(r.error || "").slice(0, 200), nextAttemptAt: new Date(now.getTime() + backoff(row.attempts)) };
  await SurplusAnnouncement.updateOne({ _id: row._id }, { $set: update });
  return { ...row, ...update };
}

async function drain({ limit = 200, now = new Date() } = {}) {
  const due = await SurplusAnnouncement.find({ status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select("_id").lean();
  const out = [];
  for (const d of due) out.push(await deliver(d._id, now));
  return out.filter(Boolean);
}

module.exports = { onPublished, deliver, drain, quietEnd, payloadFor, MAX_ATTEMPTS };
