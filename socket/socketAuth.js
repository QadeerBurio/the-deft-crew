// socket/socketAuth.js
// SEC-1: who is acting on a socket.io event. The user always comes from a verified sign-in token, never from an id the
// client sends.
//   The token arrives at the handshake (io(url, { auth: { token } })), with 'authenticate' (token), or as the 2nd
//   argument of 'user_online' (id, token). Each starts a check (socket.data.identifying) that later events wait for, so
//   "authenticate, then join_chat" sent back to back is judged with the identity.
//   Stage 1 (now): with a verified token, a different client-sent id is ignored and logged ("mismatch"). Without a
//   token, older apps keep working on the client-sent id, and it is logged ("legacy", once per socket and event).
//   Stage 2 (flag socketTokenRequired, server only, off): an event without a verified token is refused; the client
//   gets 'auth_required' { event }.
// A suspended / banned account (while FLAG_ACCOUNT_STATUS_ENFORCE is on) is never verified, and with a token it is
// refused even in stage 1. Logs carry event names and ids only (no names, e-mails or tokens).
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const flags = require("../config/featureFlags");
const { lockOf } = require("../services/accountStatus");

const stats = { verified: 0, mismatch: 0, legacy: 0, refused: 0, locked: 0, badToken: 0 };

async function verifyToken(token) {
  if (!token || typeof token !== "string" || token === "guest-token-2024") return { none: true };
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return { bad: true }; }
  if (!decoded?.id || !mongoose.Types.ObjectId.isValid(String(decoded.id))) return { bad: true };
  const User = require("../models/User");
  const u = await User.findById(decoded.id).select("_id role name accountStatus suspensionExpiry suspensionReason").lean();
  if (!u) return { bad: true };
  if (lockOf(u).locked) return { locked: true, id: String(u._id) };
  return { user: { id: String(u._id), role: u.role || "student", name: u.name || "" } };
}

/** Start (or replace) the socket's identity check with this token. Returns the promise. */
function identify(socket, token) {
  const p = verifyToken(token).then((r) => {
    if (r.user) { socket.data.verified = r.user; stats.verified++; }
    else if (r.locked) { socket.data.locked = true; stats.locked++; }
    else if (r.bad) { stats.badToken++; }
    return r;
  }).catch((e) => { console.warn(`[sec-1] identity check failed (${e.name})`); return { bad: true }; });
  socket.data.identifying = p;
  return p;
}

const tokenRequired = () => flags.isEnabled("socketTokenRequired");

/**
 * The actor for an event: { id, verified, name } or null when the event must be refused.
 * clientId: the id the client claims (senderId / userId), if any.
 */
async function actorOf(socket, event, clientId) {
  if (socket.data.identifying) await socket.data.identifying;
  const v = socket.data.verified;
  if (v) {
    if (clientId != null && clientId !== "" && String(clientId) !== v.id) {
      stats.mismatch++;
      console.warn(`[sec-1] ${event}: client id ${String(clientId).slice(0, 40)} ≠ token ${v.id}; using the token`);
    }
    return { id: v.id, verified: true, name: v.name, role: v.role };
  }
  if (socket.data.locked || tokenRequired()) {
    stats.refused++;
    socket.emit("auth_required", { event });
    return null;
  }
  // older apps (stage 1): as before, on what the client says; logged once per socket and event
  socket.data.legacyLogged = socket.data.legacyLogged || new Set();
  if (!socket.data.legacyLogged.has(event)) {
    socket.data.legacyLogged.add(event);
    stats.legacy++;
    console.warn(`[sec-1] ${event} without a token (older app), socket ${socket.id}`);
  }
  const id = clientId != null && clientId !== "" ? String(clientId) : socket.userId ? String(socket.userId) : null;
  return { id, verified: false, name: null, role: null };
}

/** Is this account a participant of the conversation? (cached per socket) */
async function isMember(socket, conversationId, userId) {
  if (!conversationId || !userId || !mongoose.Types.ObjectId.isValid(String(conversationId))) return false;
  socket.data.memberOf = socket.data.memberOf || new Set();
  const key = String(conversationId);
  if (socket.data.memberOf.has(key)) return true;
  const { Conversation } = require("../models/Chat");
  const c = await Conversation.findOne({ _id: conversationId, participants: userId }).select("_id").lean();
  if (c) socket.data.memberOf.add(key);
  return !!c;
}

module.exports = { identify, actorOf, isMember, verifyToken, tokenRequired, stats };
