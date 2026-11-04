// services/loyaltyNotify.js
// Loyalty notifications (FLAG_LOYALTY_V2): push + in-app, exactly once per ledger row (LoyaltyNotice is unique
// on the row), after the ledger write has committed. Never fails the redemption or the reversal it follows.
//   visit credited    "Visit 3 at Alpha Cafe" / "2 more visits to 25%."
//   tier unlocked     "You've unlocked 25% at Alpha Cafe" (the visit that makes the next one count at a higher tier)
//   visit reversed    "A visit at Alpha Cafe was reversed" (an admin, with the reason)
// The push goes through pushGateway as a transactional message: quiet hours and the student's settings apply
// (the "loyalty" switch, on unless they turned it off), the marketing caps don't. The in-app notification is
// always kept. A tap opens the brand's screen with its loyalty card.
const User = require("../models/User");
const Notification = require("../models/Notification");
const LoyaltyNotice = require("../models/LoyaltyNotice");
const UserNotificationSetting = require("../models/UserNotificationSetting");

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function loyaltyPushOn(userId) {
  const s = await UserNotificationSetting.findOne({ user: userId, key: "loyalty" }).lean();
  return s ? s.enabled !== false : true;
}

async function brandOf(brandId) {
  const b = await User.findById(brandId).select("brandName name").lean();
  const name = b?.brandName || b?.name || "the brand";
  return { name, ref: { _id: String(brandId), name: b?.name || name, brandName: name } };
}

/** What to say for a ledger row: { kind, title, body } or null (a credit that didn't count says nothing) */
function messageFor(row, progress, brandName, thisVisitPct = null) {
  if (row.type === "CREDIT") {
    if (!(row.visitsDelta > 0)) return null;
    const next = progress?.currentTier; // what the next visit gets
    if (next && thisVisitPct != null && Number(next.discountPct) > Number(thisVisitPct)) {
      return { kind: "tier_unlocked", title: `You've unlocked ${next.discountPct}% at ${brandName}`, body: `Visit ${row.visitNumber} done. Your next visit at ${brandName} gets ${next.discountPct}% off.` };
    }
    const more = progress?.visitsBeforeNextTier;
    const body = progress?.nextTier && more != null
      ? (more === 0 ? `Your next visit gets ${progress.nextTier.discountPct}%.` : `${plural(more, "more visit")} to ${progress.nextTier.discountPct}%.`)
      : `You're at the top tier: ${next ? `${next.discountPct}% on every visit` : "keep visiting"}.`;
    return { kind: "visit", title: `Visit ${row.visitNumber} at ${brandName}`, body };
  }
  if (row.type === "REVERSAL") {
    const visits = progress?.visits;
    return { kind: "reversed", title: `A visit at ${brandName} was reversed`, body: `${row.reason ? `Reason: ${row.reason}. ` : ""}${visits != null ? `You now have ${plural(visits, "visit")}.` : ""}`.trim() };
  }
  return null;
}

/**
 * Notify the student about one ledger row. Safe to call any number of times: only the first call for a row
 * sends anything. Returns the notice, or { skipped } with the reason.
 */
async function notifyRow(row, progress, { thisVisitPct = null, gateway = null } = {}) {
  try {
    if (!row?._id || !row.student) return { skipped: "no row" };
    const { name, ref } = await brandOf(row.brand);
    const msg = messageFor(row, progress, name, thisVisitPct);
    if (!msg) return { skipped: "nothing to say" };
    let notice;
    try {
      notice = (await LoyaltyNotice.create({ ledgerRow: row._id, student: row.student, brand: row.brand, kind: msg.kind, title: msg.title, body: msg.body })).toObject();
    } catch (err) {
      if (err?.code === 11000) return { skipped: "already notified" };
      throw err;
    }
    const data = { type: "loyalty", screen: "OfferScreen", params: { brand: ref }, brandId: String(row.brand), ledgerRow: String(row._id) };
    // in-app first (kept even when the push can't go out); its own push is off: the push is sent below
    await Notification.create({ recipient: row.student, title: msg.title, description: msg.body, type: "Offer", metadata: { ...data, skipPush: true, loyaltyNoticeId: String(notice._id) } });
    let push;
    if (!(await loyaltyPushOn(row.student))) push = "pref_off";
    else {
      try {
        const g = gateway || require("./engagement/pushGateway");
        const r = await g.send(row.student, { type: "loyalty", essential: true, title: msg.title, body: msg.body, data });
        push = r?.sent ? "sent" : r?.reason || "not sent";
      } catch (err) {
        push = `failed: ${String(err.message || err).slice(0, 80)}`;
      }
    }
    await LoyaltyNotice.updateOne({ _id: notice._id }, { $set: { push } });
    return { ...notice, push };
  } catch (err) {
    console.error(`[loyalty] notification for ledger row ${row?._id} failed: ${err.message}`);
    return { skipped: "error" };
  }
}

module.exports = { notifyRow, messageFor, loyaltyPushOn };
