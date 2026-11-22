// socket/socketIdentity.js
// Who is this socket.io client? (plan P4-1b, before FLAG_ACCOUNT_STATUS_ENFORCE can be switched on)
// The user id comes from the sign-in token, never from what the client says:
//   - the token: socket.handshake.auth.token (io(url, { auth: { token } })), or a token sent as the second argument
//     of 'user_online' (newer apps: emit('user_online', userId, token); older servers ignore the extra argument)
//   - a valid token → that account's id (the client-sent id is ignored); a suspended / banned account (while the
//     flag is on) → refused
//   - no valid token: older apps send only an id. While accountStatusEnforce is off they keep working as before (the
//     client-sent id is used); once it is on, they are refused.
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const flags = require("../config/featureFlags");
const { lockOf } = require("../services/accountStatus");

/**
 * → { userId, verified: true } | { refused: true, why } | { userId: clientId, verified: false } (legacy, flag off)
 */
async function resolveOnline(socket, clientUserId, tokenArg) {
  const token = (typeof tokenArg === "string" && tokenArg) || socket?.handshake?.auth?.token || null;
  let decoded = null;
  if (token && token !== "guest-token-2024") {
    try { decoded = jwt.verify(String(token), process.env.JWT_SECRET); } catch { decoded = null; }
  }
  if (decoded?.id && mongoose.Types.ObjectId.isValid(String(decoded.id))) {
    const User = require("../models/User");
    const u = await User.findById(decoded.id).select("_id role accountStatus suspensionExpiry suspensionReason").lean();
    if (!u) return { refused: true, why: "unknown account" };
    if (lockOf(u).locked) return { refused: true, why: "account locked" };
    return { userId: String(u._id), verified: true };
  }
  if (flags.isEnabled("accountStatusEnforce")) return { refused: true, why: "no valid token" };
  const legacy = String(clientUserId || "");
  if (!mongoose.Types.ObjectId.isValid(legacy)) return { refused: true, why: "no valid id" };
  return { userId: legacy, verified: false };
}

module.exports = { resolveOnline };
