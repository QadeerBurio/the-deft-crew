// services/pushTracking.js
// Plan N-6 (owner): measure pushes before reporting on them. Flag pushOpenTracking, per recipient, off by default.
// For an account with the flag on, every push it gets (any sender: engagement, bell, social, chat, career,
// loyalty, surplus, admin) has one PushLog row per send, the row's id travels in the push data (pushLogId), the
// app reports the tap (POST /api/notifications/push-opened/:logId) and the receipt marks it delivered.
// Flag off for everyone (not configured anywhere): nothing here runs (no lookup, no row, no extra data), so
// pushes are byte-for-byte as before. Older apps ignore the extra data field.
//   stamp(messages)               before sending (utils/pushNotification.js sendAllSafe)
//   afterSend(messages, tickets)  after sending: sent / failed and the first ticket id per row
//   markDelivered(okTicketIds)    from the receipt check: deliveredAt for tracked rows
//   forUser(user)                 the engagement gateway, which writes its own row (pushGateway.js)
const mongoose = require("mongoose");
const flags = require("../config/featureFlags");

const FLAG = "pushOpenTracking";
const configured = () => flags.pilotConfigured(FLAG);
const forUser = (user) => !!user && flags.isEnabled(FLAG, { id: String(user._id || user.id), role: user.role });
const typeOf = (data) => String(data?.type || data?.notificationType || "unknown").slice(0, 60);

/**
 * Adds pushLogId to the data of every message whose recipient has the flag on (and that doesn't carry one yet),
 * writing one PushLog row per recipient for this send. Returns the context afterSend needs. Never throws.
 */
async function stamp(messages) {
  const ctx = { rows: new Map() }; // logId → message indexes
  try {
    if (!configured() || !messages?.length) return ctx;
    const todo = messages.map((m, i) => ({ m, i })).filter(({ m }) => m?.to && !m.data?.pushLogId);
    if (!todo.length) return ctx;
    const User = require("../models/User");
    const tokens = [...new Set(todo.map(({ m }) => m.to))];
    const users = await User.find({ "pushTokens.token": { $in: tokens } }).select("_id role pushTokens.token").lean();
    const owner = new Map();
    for (const u of users) for (const t of u.pushTokens || []) if (tokens.includes(t.token)) owner.set(t.token, u);
    const byUser = new Map();
    for (const { m, i } of todo) {
      const u = owner.get(m.to);
      if (!u || !forUser(u)) continue;
      const k = String(u._id);
      if (!byUser.has(k)) byUser.set(k, { u, idx: [] });
      byUser.get(k).idx.push(i);
    }
    if (!byUser.size) return ctx;
    const PushLog = require("../models/PushLog");
    const { dayKey, weekKey } = require("../utils/karachiTime");
    const docs = [];
    for (const { u, idx } of byUser.values()) {
      const first = messages[idx[0]];
      const _id = new mongoose.Types.ObjectId();
      docs.push({
        _id, user: u._id, type: typeOf(first.data), sender: "send", tracked: true,
        title: String(first.title || "").slice(0, 200), body: String(first.body || "").slice(0, 300),
        mood: first.data?.mood || "sorted", dayKey: dayKey(), weekKey: weekKey(),
        data: { route: first.data?.route || null }, tokens: idx.map((i) => messages[i].to), status: "queued",
      });
      for (const i of idx) messages[i] = { ...messages[i], data: { ...(messages[i].data || {}), pushLogId: String(_id) } };
      ctx.rows.set(String(_id), idx);
    }
    await PushLog.insertMany(docs);
  } catch (e) {
    console.warn("[push-tracking] could not log this send:", e.message);
  }
  return ctx;
}

/** sent (with the first ok ticket) or failed, per row stamped in this send. Never throws. */
async function afterSend(ctx, tickets) {
  try {
    if (!ctx?.rows?.size) return;
    const PushLog = require("../models/PushLog");
    for (const [id, idx] of ctx.rows) {
      const ok = idx.map((i) => tickets?.[i]).find((t) => t?.status === "ok" && t.id);
      await PushLog.updateOne({ _id: id }, ok
        ? { $set: { status: "sent", ticketId: ok.id, sentAt: new Date() } }
        : { $set: { status: "failed", receiptError: tickets?.[idx[0]]?.details?.error || "SEND_FAILED" } });
    }
  } catch (e) {
    console.warn("[push-tracking] could not update the log:", e.message);
  }
}

/** Receipt ok for these tickets: tracked rows delivered. Never throws. */
async function markDelivered(ticketIds) {
  try {
    if (!ticketIds?.length || !configured()) return;
    await require("../models/PushLog").updateMany(
      { ticketId: { $in: ticketIds }, tracked: true, deliveredAt: null },
      { $set: { receiptStatus: "ok", deliveredAt: new Date() } }
    );
  } catch (e) {
    console.warn("[push-tracking] could not mark delivered:", e.message);
  }
}

module.exports = { FLAG, configured, forUser, stamp, afterSend, markDelivered };
