// services/adminSessions.js
// Plan A-8 (owner: the admin session record): flag adminSessionsV1 (server only, off). On:
//   - an admin signs in from a new device (the portal sends X-Device-Id), or 30 days after the device's last code:
//     a 6-digit code is e-mailed (OtpCode purpose "admin-login"); the token comes after the code
//   - every admin token carries its session id (sid); a request after 12 hours without one ends the session
//     (401 ADMIN_SESSION_IDLE); a revoked session (signed out, suspended, removed) answers 401 ADMIN_SESSION_ENDED; an
//     admin token without a session (from before the flag) answers 401 ADMIN_SESSION_REQUIRED (sign in again)
//   - login history: every session row (time, device known or new, browser, revoked and why)
// Off: admins sign in and stay signed in exactly as before (nothing here runs).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const FLAG = "adminSessionsV1";
const IDLE_MS = 12 * 60 * 60 * 1000;
const DEVICE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SEEN_EVERY_MS = 60 * 1000; // lastSeenAt is written at most once a minute

const enabled = () => require("../config/featureFlags").isEnabled(FLAG, null);
const isAdmin = (u) => require("./adminAccess").isAdminAccount(u);
const salt = () => process.env.JWT_SECRET || "tdc";
const hash = (v) => crypto.createHash("sha256").update(`${v}:${salt()}`).digest("hex");
// the portal sends deviceId in the login body (no extra header, so no cross-origin preflight change); a header works too
const deviceOf = (req) => { const d = String(req.body?.deviceId || req.get?.("X-Device-Id") || "").trim(); return /^[A-Za-z0-9_-]{16,80}$/.test(d) ? hash(`device:${d}`) : null; };
const ipOf = (req) => { try { return hash(`ip:${require("./loginGuard").clientIp(req)}`).slice(0, 16); } catch { return null; } };
const maskEmail = (e = "") => { const [a, d] = String(e).split("@"); return d ? `${a.slice(0, 2)}••@${d}` : ""; };

function tokenFor(user, session) {
  return jwt.sign({ id: user._id, role: user.role, sid: String(session._id) }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

async function sendCode(user, session) {
  const OtpCode = require("../models/OtpCode");
  const code = crypto.randomInt(100000, 1000000).toString();
  await OtpCode.deleteMany({ user: user._id, purpose: "admin-login" });
  await OtpCode.create({ user: user._id, purpose: "admin-login", codeHash: hash(`otp:${session._id}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  try {
    await require("../utils/mailer").sendMail({
      to: user.email,
      subject: "your tdc admin sign-in code",
      html: `<p>your code: <b style="font-size:20px;letter-spacing:3px">${code}</b></p><p>it works for 10 minutes. if this wasn't you, tell a super admin.</p>`,
    });
    return true;
  } catch (e) {
    console.error("[admin-sessions] code e-mail failed:", e.message);
    return false;
  }
}

/**
 * At /login, after the password and the usual checks. null: not an admin or the flag is off (sign in as before).
 * → { body } to send: { token, user } for a known device, or { requiresAdminCode, sessionId, email, emailSent }
 */
async function startLogin(user, req) {
  if (!enabled() || !isAdmin(user)) return null;
  const AdminSession = require("../models/AdminSession");
  const deviceHash = deviceOf(req);
  const known = deviceHash ? await AdminSession.findOne({ user: user._id, deviceHash, verifiedAt: { $gte: new Date(Date.now() - DEVICE_DAYS_MS) } }).sort({ verifiedAt: -1 }).lean() : null;
  const base = { user: user._id, deviceHash, ipHash: ipOf(req), userAgent: String(req.get?.("user-agent") || "").slice(0, 160) };
  if (known) {
    const s = await AdminSession.create({ ...base, verifiedAt: known.verifiedAt, newDevice: false, lastSeenAt: new Date() });
    return { body: { token: tokenFor(user, s), user } };
  }
  const s = await AdminSession.create({ ...base, newDevice: true });
  const sent = await sendCode(user, s);
  return { body: { requiresAdminCode: true, sessionId: String(s._id), email: maskEmail(user.email), emailSent: sent, message: sent ? "we e-mailed you a 6-digit code." : "we couldn't e-mail your code. try again." } };
}

/** POST /api/auth/admin/verify-code { sessionId, code } → { status, body } */
async function verifyCode(sessionId, code) {
  const AdminSession = require("../models/AdminSession");
  const User = require("../models/User");
  const OtpCode = require("../models/OtpCode");
  const clean = String(code || "").replace(/\D/g, "");
  if (!/^[0-9a-f]{24}$/i.test(String(sessionId || "")) || clean.length !== 6) return { status: 400, body: { message: "enter the 6-digit code." } };
  const s = await AdminSession.findById(sessionId);
  if (!s || s.verifiedAt || s.revokedAt) return { status: 400, body: { message: "this sign-in has ended. sign in again." } };
  if (s.codeAttempts >= MAX_ATTEMPTS) return { status: 429, body: { message: "too many wrong codes. sign in again." } };
  const row = await OtpCode.findOne({ user: s.user, purpose: "admin-login" }).lean();
  if (!row || new Date(row.expiresAt) < new Date()) return { status: 400, body: { message: "the code has expired. sign in again." } };
  if (row.codeHash !== hash(`otp:${s._id}:${clean}`)) {
    await AdminSession.updateOne({ _id: s._id }, { $inc: { codeAttempts: 1 } });
    return { status: 400, body: { message: `wrong code. ${Math.max(0, MAX_ATTEMPTS - s.codeAttempts - 1)} tries left.` } };
  }
  await OtpCode.deleteMany({ user: s.user, purpose: "admin-login" });
  const now = new Date();
  await AdminSession.updateOne({ _id: s._id }, { $set: { verifiedAt: now, lastSeenAt: now } });
  const user = await User.findById(s.user);
  if (!user || !isAdmin(user)) return { status: 400, body: { message: "this sign-in has ended. sign in again." } };
  const out = user.toObject(); delete out.password;
  return { status: 200, body: { token: tokenFor(user, s), user: out } };
}

/** In the auth middleware, for an admin account. → { ok } or { ok: false, code, message } (401) */
async function check(decoded, user) {
  if (!enabled() || !isAdmin(user)) return { ok: true };
  if (!decoded?.sid || !/^[0-9a-f]{24}$/i.test(String(decoded.sid))) return { ok: false, code: "ADMIN_SESSION_REQUIRED", message: "please sign in again." };
  const AdminSession = require("../models/AdminSession");
  const s = await AdminSession.findOne({ _id: decoded.sid, user: user._id }).lean();
  if (!s || !s.verifiedAt || s.revokedAt) return { ok: false, code: "ADMIN_SESSION_ENDED", message: "you were signed out. sign in again." };
  const now = Date.now();
  if (now - new Date(s.lastSeenAt || s.verifiedAt).getTime() > IDLE_MS) {
    await AdminSession.updateOne({ _id: s._id }, { $set: { revokedAt: new Date(), revokedReason: "idle" } });
    return { ok: false, code: "ADMIN_SESSION_IDLE", message: "you were signed out after 12 hours without activity. sign in again." };
  }
  if (now - new Date(s.lastSeenAt || 0).getTime() > SEEN_EVERY_MS) {
    await AdminSession.updateOne({ _id: s._id }, { $set: { lastSeenAt: new Date() } });
    await require("../models/User").updateOne({ _id: user._id, "adminAccess.level": { $exists: true } }, { $set: { "adminAccess.lastActiveAt": new Date() } });
  }
  return { ok: true };
}

/** For a route file's own sign-in (it has only the token): the same check, the account loaded while the flag is on */
async function checkToken(decoded) {
  if (!enabled() || !decoded?.id || !/^[0-9a-f]{24}$/i.test(String(decoded.id))) return { ok: true };
  const user = await require("../models/User").findById(decoded.id).select("role").lean();
  return check(decoded, user);
}

/** End every open session of an admin (suspended, removed, "sign out everywhere"). → number ended */
async function revokeAll(userId, reason) {
  const r = await require("../models/AdminSession").updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  return r.modifiedCount ?? r.nModified ?? 0;
}

/** The login history: newest first, no hashes */
async function history(userId, limit = 50) {
  const rows = await require("../models/AdminSession").find({ user: userId }).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 50)).lean();
  return rows.map((s) => ({
    id: String(s._id), at: s.createdAt, device: s.newDevice ? "new device (code)" : "known device", browser: s.userAgent || "",
    verified: !!s.verifiedAt, lastSeenAt: s.lastSeenAt, endedAt: s.revokedAt, endedBecause: s.revokedReason,
    open: !!s.verifiedAt && !s.revokedAt && Date.now() - new Date(s.lastSeenAt || s.verifiedAt).getTime() <= IDLE_MS,
  }));
}

module.exports = { FLAG, IDLE_MS, enabled, startLogin, verifyCode, check, checkToken, revokeAll, history, _test: { hash } };
