// services/confessionStrikes.js
// Automatic enforcement for confessions (plan P4-1b; no moderation team). Per account, over 90 days:
//   blocked at the pre-check            warning only, no strike
//   3 blocked attempts in 24 h          24 h confession ban + 1 strike
//   confirmed breach (report re-check)  content removed + 1 strike
//   strike 1 → 24 h ban · strike 2 → 7-day ban · strike 3 → account suspended + safety e-mail
//   severe (threat, sexual content involving minors, doxxing) confirmed → account suspended at once + safety e-mail
// A confession ban stops new confessions and confession comments. A suspension sets User.accountStatus =
// "suspended" (it locks the account out only while FLAG_ACCOUNT_STATUS_ENFORCE is on, plan P0-6) and also a long
// confession ban, so confessions stop either way. Admins are never suspended.
// False reports: 3 rejected reports in 30 days → no reporting for 30 days.
const User = require("../models/User");
const alerts = require("./safetyAlerts");

const H = 3600e3;
const D = 24 * H;
const STRIKE_WINDOW = 90 * D;
const LONG_BAN = 3650 * D; // stays until an admin restores the account

const until = (ms) => new Date(Date.now() + ms);
const later = (a, b) => (a && (!b || a > b) ? a : b);

/** Is this account banned from confessions now? (user: a document with confessionBanUntil) */
const bannedUntil = (user) => (user?.confessionBanUntil && new Date(user.confessionBanUntil) > new Date() ? new Date(user.confessionBanUntil) : null);

async function setBan(userId, ms, current) {
  const next = later(until(ms), current ? new Date(current) : null);
  await User.updateOne({ _id: userId }, { $set: { confessionBanUntil: next } });
  return next;
}

/**
 * Add one strike. { reason, ref, severe, content, evidence, contentId } → { strikes, action, banUntil }
 * action: "ban_24h" | "ban_7d" | "suspended"
 */
async function addStrike(userId, { reason = "", ref = "", severe = false, content = "", evidence = "", contentId = "" } = {}) {
  const now = Date.now();
  await User.updateOne({ _id: userId }, { $push: { confessionStrikes: { at: new Date(), reason: String(reason).slice(0, 120), ref: String(ref).slice(0, 64) } } });
  const u = await User.findById(userId).select("+confessionStrikes role confessionBanUntil accountStatus").lean();
  if (!u) return { strikes: 0, action: null, banUntil: null };
  const strikes = (u.confessionStrikes || []).filter((s) => s.at && now - new Date(s.at).getTime() <= STRIKE_WINDOW).length;
  if ((severe || strikes >= 3) && !require("./adminAccess").isAdminAccount(u)) {
    const banUntil = await setBan(userId, LONG_BAN, u.confessionBanUntil);
    await User.updateOne({ _id: userId }, { $set: { accountStatus: "suspended", suspensionReason: severe ? `confession safety: ${reason}` : "confession safety: 3 strikes", suspensionExpiry: null } });
    await alerts.send(severe ? "severe" : "suspension", { userId, reason: severe ? reason : `3 strikes (latest: ${reason})`, content, evidence, contentId });
    return { strikes, action: "suspended", banUntil };
  }
  const ms = strikes >= 2 ? 7 * D : D;
  const banUntil = await setBan(userId, ms, u.confessionBanUntil);
  return { strikes, action: strikes >= 2 ? "ban_7d" : "ban_24h", banUntil };
}

/** A post / comment was stopped by the pre-check (warning). 3 in 24 h → 24 h ban + a strike. */
async function noteBlocked(userId, { reason = "", content = "" } = {}) {
  const now = Date.now();
  await User.updateOne({ _id: userId }, { $push: { confessionBlocks: new Date() } });
  const u = await User.findById(userId).select("+confessionBlocks").lean();
  const recent = (u?.confessionBlocks || []).filter((t) => now - new Date(t).getTime() <= D);
  // keep only the last 24 h
  await User.updateOne({ _id: userId }, { $set: { confessionBlocks: recent } });
  if (recent.length >= 3) {
    await User.updateOne({ _id: userId }, { $set: { confessionBlocks: [] } });
    const r = await addStrike(userId, { reason: `3 blocked attempts in 24 h (latest: ${reason})`, content });
    return { warned: true, ...r };
  }
  return { warned: true, strikes: null, action: null };
}

/** A report was rejected as false. 3 in 30 days → no reporting for 30 days. */
async function markFalseReport(userId) {
  const now = Date.now();
  await User.updateOne({ _id: userId }, { $push: { falseReportMarks: new Date() } });
  const u = await User.findById(userId).select("+falseReportMarks reportingBlockedUntil").lean();
  const recent = (u?.falseReportMarks || []).filter((t) => now - new Date(t).getTime() <= 30 * D);
  if (recent.length >= 3) {
    const blocked = until(30 * D);
    await User.updateOne({ _id: userId }, { $set: { reportingBlockedUntil: blocked, falseReportMarks: [] } });
    return { marks: recent.length, reportingBlockedUntil: blocked };
  }
  return { marks: recent.length, reportingBlockedUntil: null };
}

/** Restore (admin / e-mail link): active again, strikes and bans cleared. */
async function restore(userId) {
  await User.updateOne({ _id: userId }, { $set: { accountStatus: "active", suspensionReason: "", suspensionExpiry: null, confessionBanUntil: null, confessionStrikes: [], confessionBlocks: [] } });
}

module.exports = { addStrike, noteBlocked, markFalseReport, restore, bannedUntil, STRIKE_WINDOW };
