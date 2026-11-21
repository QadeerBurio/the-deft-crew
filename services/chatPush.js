// services/chatPush.js
// CHAT-1: a device push when someone gets a chat message (social DMs, SkillShare match and inquiry chats). Called from
// socket/chatHandlers.js after send_message saves the message.
//
// Why this file exists: on 5 Oct 2026 the push moved out of POST /notifications/create-message-notif into
// socket/chatSocket.js (pushChatMessage), but that file has never been loaded (server.js ran its own socket handlers,
// now socket/chatHandlers.js), so chat pushes stopped. This is that logic, wired into the handlers that run.
//
// Per recipient (every participant except the sender):
//   - flag chatPushV1 on for the recipient (off = nothing, exactly as since 5 Oct)
//   - not looking at that chat right now (no socket of theirs in the conversation's room)
//   - their "messages" notification switch is on (notifPrefs.messages; missing = on)
//   - they haven't blocked the sender
//   - not in quiet hours, 23:00–09:00 Karachi (CHAT_PUSH_QUIET_HOURS=off sends at night too); skipped, not queued
//   - at most one push per conversation per recipient every 20 s (a burst of messages buzzes once)
// Push budget (Phase N): "personal", no daily cap. Never throws.
const { Conversation } = require("../models/Chat");
const User = require("../models/User");
const flags = require("../config/featureFlags");
const { isQuietHour } = require("../utils/karachiTime");

const THROTTLE_MS = 20 * 1000;
const lastSent = new Map(); // `${recipient}:${conversation}` → time
let send = null; // tests swap sendToUser
const sender = () => send || require("../utils/pushNotification").sendToUser;
const quietOn = () => String(process.env.CHAT_PUSH_QUIET_HOURS || "").trim().toLowerCase() !== "off";

/** Which screen a tap opens, and its params (as pushChatMessage decided). */
async function target(conversationId, senderId) {
  let route = "MessagesScreen";
  let params = { conversationId: String(conversationId) };
  try {
    const Match = require("../models/Match");
    const match = await Match.findOne({ conversationId }).select("_id listingId").lean();
    if (match) {
      route = "MatchChat";
      params = { matchId: String(match._id), listingId: match.listingId ? String(match.listingId) : undefined };
    } else {
      const Inquiry = require("../models/Inquiry");
      const inquiry = await Inquiry.findOne({ conversationId }).select("_id listingId").lean();
      if (inquiry) {
        route = "InquiryChat";
        params = { threadId: String(conversationId), listingId: inquiry.listingId ? String(inquiry.listingId) : undefined, otherParticipantId: String(senderId) };
      }
    }
  } catch (e) { /* MessagesScreen */ }
  return { route, params };
}

/** Accounts with a socket in the conversation's room (reading it now). */
function viewers(io, conversationId) {
  const out = new Set();
  const room = io?.sockets?.adapter?.rooms?.get(String(conversationId));
  if (!room) return out;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    const id = s?.data?.verified?.id || s?.userId;
    if (id) out.add(String(id));
  }
  return out;
}

/**
 * → { sent: [userIds], skipped: { userId: reason } }
 * reasons: flag_off | viewing | pref_off | blocked | quiet_hours | throttled | send_failed
 */
async function pushChatMessage(io, conversationId, senderId, displayMsg, now = new Date()) {
  const result = { sent: [], skipped: {} };
  try {
    const convo = await Conversation.findById(conversationId).select("participants").lean();
    const recipients = (convo?.participants || []).map(String).filter((id) => id !== String(senderId));
    if (!recipients.length) return result;
    const from = await User.findById(senderId).select("name").lean();
    const senderName = from?.name || "someone";
    const looking = viewers(io, conversationId);
    const preview = String(displayMsg || "new message");
    const body = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
    let where = null;

    for (const rid of recipients) {
      const r = await User.findById(rid).select("_id role").lean();
      if (!r) continue;
      if (!flags.isEnabled("chatPushV1", { id: rid, role: r.role || "student" })) { result.skipped[rid] = "flag_off"; continue; }
      if (looking.has(rid)) { result.skipped[rid] = "viewing"; continue; }
      const EngagementProfile = require("../models/EngagementProfile");
      const prof = await EngagementProfile.findOne({ user: rid }).select("notifPrefs").lean();
      if (prof?.notifPrefs?.messages === false) { result.skipped[rid] = "pref_off"; continue; }
      const BlockedUser = require("../models/BlockedUser");
      if (await BlockedUser.exists({ userId: rid, blockedUserId: senderId })) { result.skipped[rid] = "blocked"; continue; }
      if (quietOn() && isQuietHour(now)) { result.skipped[rid] = "quiet_hours"; continue; }
      const key = `${rid}:${conversationId}`;
      if (now.getTime() - (lastSent.get(key) || 0) < THROTTLE_MS) { result.skipped[rid] = "throttled"; continue; }
      lastSent.set(key, now.getTime());
      where = where || (await target(conversationId, senderId));
      try {
        await sender()(rid, `${senderName} 💬`, body, {
          type: "message", mood: "cheeky", senderId: String(senderId), conversationId: String(conversationId), route: where.route, params: where.params,
        });
        result.sent.push(rid);
      } catch (e) {
        result.skipped[rid] = "send_failed";
        console.error(`[chat push] not sent (${e.name})`);
      }
    }
  } catch (e) {
    console.error(`[chat push] error (${e.name})`);
  }
  return result;
}

module.exports = { pushChatMessage, viewers, THROTTLE_MS, _setSendForTests: (fn) => { send = fn; }, _resetThrottle: () => lastSent.clear() };
