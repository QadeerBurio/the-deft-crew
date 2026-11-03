// services/surplus/notifications.js
// Surprise Box notifications through an outbox (models/SurplusNotificationOutbox), the career outbox
// pattern: after a state change, one row per recipient and channel is queued (unique key: a re-run queues
// nothing new), then delivered. Push goes through the pushGateway as a transactional message (no
// marketing caps; quiet hours and the student's "deals" preference still apply); in-app through
// Notification. A failed delivery retries with backoff (5 attempts); quiet hours wait 30 minutes.
// In-app rows use the existing Notification type "Offer" (that schema is unchanged); metadata.surplusOrderId
// marks them. Texts carry the box, brand and pickup time; never phone numbers, e-mails or the pickup code.
const SurplusNotificationOutbox = require("../../models/SurplusNotificationOutbox");
const SurplusOrder = require("../../models/SurplusOrder");
const Notification = require("../../models/Notification");
const User = require("../../models/User");
const policy = require("./policy");

const MAX_ATTEMPTS = 5;
const MIN = 60 * 1000;
const backoff = (attempts) => Math.min(60, 2 ** attempts) * MIN;
const at = (d) => {
  try { return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Karachi", weekday: "short", hour: "2-digit", minute: "2-digit" }); } catch { return new Date(d).toISOString(); }
};

// type -> [{ to: student | brand, title, body }]
function messagesFor(type, order, brandName = "the brand") {
  const box = order.disclosures?.title || "your Surprise Box";
  const S = (title, body) => ({ to: "student", title, body });
  const B = (title, body) => ({ to: "brand", title, body });
  const pay = `Pay ${order.priceSnapshot.currency} ${order.priceSnapshot.total} at pickup.`;
  switch (type) {
    case "ORDER_PLACED": return [
      S("Surprise Box ordered", `${box} from ${brandName}: pick up ${at(order.pickupStart)} to ${at(order.pickupEnd)}. ${pay} Order ${order.ref}.`),
      B("New Surprise Box order", `Order ${order.ref}: ${order.qty} x ${box}, pickup from ${at(order.pickupStart)}.`),
    ];
    case "CONFIRMED": return [S("Order confirmed", `${brandName} confirmed ${box} (${order.ref}). Pick up from ${at(order.pickupStart)}.`)];
    case "READY_FOR_PICKUP": return [S("Ready for pickup", `${box} is ready at ${brandName}. Show your pickup code. ${pay}`)];
    case "MERCHANT_CANCELLED": return [S("Order cancelled by the brand", `${brandName} cancelled ${box} (${order.ref})${order.cancelReason ? `: ${order.cancelReason}` : ""}. You don't owe anything.`)];
    case "CUSTOMER_CANCELLED": return [B("Order cancelled", `Order ${order.ref} (${order.qty} x ${box}) was cancelled by the student. The boxes are back on sale.`)];
    case "REMINDER": return [S("Pickup soon", `${box} at ${brandName}: pickup starts ${at(order.pickupStart)}. Can't make it? You can't cancel any more; not collecting counts as a no-show.`)];
    case "NO_SHOW": return [
      S("Missed pickup", `${box} (${order.ref}) wasn't collected in time and is recorded as a no-show. Think it's wrong? Open a support case within 24 hours.`),
      B("Not collected", `Order ${order.ref} wasn't collected and is recorded as a no-show.`),
    ];
    case "COMPLETED": return [S("Enjoy your box", `Collected: ${box} from ${brandName}. Something wrong? You can open a support case within 24 hours.`)];
    default: return [];
  }
}

const brandNameOf = async (brandId) => {
  const b = await User.findById(brandId).select("brandName companyName name").lean();
  return b?.brandName || b?.companyName || b?.name || "the brand";
};

/** Queue the notifications for one order event (kind "event") or a reminder; then deliver what's due */
async function onOrderEvent(order, type, { kind = "event", drainNow = true } = {}) {
  const msgs = messagesFor(type, order, await brandNameOf(order.brand));
  let queued = 0;
  for (const m of msgs) {
    const recipient = m.to === "student" ? order.student : order.brand;
    const channels = m.to === "student" ? ["push", "inapp"] : ["inapp"];
    for (const channel of channels) {
      // each state happens at most once per order, so (order, type, recipient, channel) identifies the event
      const key = `${kind}:${order._id}:${type}:${recipient}:${channel}`;
      try {
        await SurplusNotificationOutbox.create({
          kind, eventType: type, order: order._id, recipient, channel, key,
          payload: { title: m.title, body: m.body, data: { surplusOrderId: String(order._id), ref: order.ref, eventType: type, screen: m.to === "student" ? "SurpriseBoxOrder" : "SurpriseBoxOrders" } },
          expiresAt: kind === "reminder" ? order.pickupEnd : null,
        });
        queued += 1;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
  }
  if (drainNow) await drain({ limit: 10 });
  return queued;
}

const providers = {
  async push(row) {
    const gateway = require("../engagement/pushGateway");
    const r = await gateway.send(row.recipient, { type: "nearby_deal", pref: "deals", essential: true, title: row.payload.title, body: row.payload.body, data: row.payload.data });
    if (r?.sent) return { status: "sent" };
    if (r?.reason === "quiet_hours") return { status: "defer", error: "quiet_hours" };
    return { status: "skipped", error: r?.reason || "not sent" };
  },
  async inapp(row) {
    await Notification.create({ recipient: row.recipient, title: row.payload.title, description: row.payload.body, type: "Offer", metadata: { ...row.payload.data, skipPush: true, surplusOutboxId: String(row._id) } });
    return { status: "sent" };
  },
};

async function deliver(rowId, now = new Date()) {
  const row = await SurplusNotificationOutbox.findOneAndUpdate(
    { _id: rowId, status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
    { $set: { status: "sending" }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!row) return null;
  let r;
  try {
    if (row.expiresAt && now >= new Date(row.expiresAt)) r = { status: "skipped", error: "expired" };
    else if (row.kind === "reminder" && !policy.AWAITING_PICKUP.includes((await SurplusOrder.findById(row.order).select("state").lean())?.state)) r = { status: "skipped", error: "order changed" };
    else r = await providers[row.channel](row);
  } catch (err) {
    r = { status: "retry", error: err.message };
  }
  const update = r.status === "sent" ? { status: "sent", sentAt: now, lastError: "" }
    : r.status === "skipped" ? { status: "skipped", lastError: String(r.error || "").slice(0, 200) }
      : r.status === "defer" ? { status: "pending", lastError: String(r.error || ""), nextAttemptAt: new Date(now.getTime() + 30 * MIN), attempts: row.attempts - 1 }
        : { status: "failed", lastError: String(r.error || "").slice(0, 200), nextAttemptAt: new Date(now.getTime() + backoff(row.attempts)) };
  await SurplusNotificationOutbox.updateOne({ _id: row._id }, { $set: update });
  return { ...row, ...update };
}

async function drain({ limit = 25, now = new Date() } = {}) {
  const due = await SurplusNotificationOutbox.find({ status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select("_id").lean();
  const out = [];
  for (const d of due) out.push(await deliver(d._id, now));
  return out.filter(Boolean);
}

module.exports = { messagesFor, onOrderEvent, deliver, drain, providers, MAX_ATTEMPTS };
