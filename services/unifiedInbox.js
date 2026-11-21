// services/unifiedInbox.js
// Plan N-4 (flag unifiedInbox, off): one inbox for the bell (Notification) and social (SocialNotification) lists,
// read-only, no data migration. Tabs (owner): "for you" (about you: social activity, your applications, tickets,
// bookings, payments, messages), "campus" (offers, jobs, scholarships, courses, programmes, promotions) and "system"
// (account and app messages). The old endpoints stay as they are for older apps; reads, deletes and clears keep using
// each list's own endpoint (the app knows an item's source). Event creators' notices (EventNotification) are separate
// (owner) and not part of this.
const Notification = require("../models/Notification");
const SocialNotification = require("../models/SocialNotification");

const TABS = ["for_you", "campus", "system"];
const BELL_TAB = {
  Message: "for_you", "Application Status": "for_you", Interview: "for_you", "Job Application": "for_you",
  Booking: "for_you", Payment: "for_you", Card: "for_you", Event: "for_you",
  Offer: "campus", Brand: "campus", Promotion: "campus", "Job Posting": "campus", Jobs: "campus",
  Scholarship: "campus", Course: "campus", Exchange: "campus",
  System: "system", Welcome: "system", Security: "system", Alert: "system", Reminder: "system", Update: "system",
};
const bellTab = (type) => BELL_TAB[type] || "system";
// chat messages have their own badge and screen (as in the app's social list today)
const SOCIAL_EXCLUDED = ["message"];

const isReadBy = (doc, uid) => Array.isArray(doc.readBy) && doc.readBy.some((id) => String(id) === String(uid));
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || null;

function fromBell(n, uid) {
  return {
    id: String(n._id), source: "bell", tab: bellTab(n.type), type: n.type || "System",
    title: n.title || "", body: n.description || "", mood: n.mood || "sorted", createdAt: n.createdAt,
    isRead: isReadBy(n, uid), link: n.link || null, metadata: n.metadata || {},
  };
}
function fromSocial(n, uid) {
  const s = n.sender && typeof n.sender === "object" ? n.sender : null;
  return {
    id: String(n._id), source: "social", tab: "for_you", type: n.type,
    title: "", body: n.text || "", mood: n.mood || "sorted", createdAt: n.createdAt,
    isRead: isReadBy(n, uid), link: n.postId ? `/post/${n.postId?._id || n.postId}` : n.link || null,
    metadata: n.metadata || {}, conversationId: n.conversationId || null,
    postId: n.postId ? String(n.postId?._id || n.postId) : null,
    // the same sender fields the social list shows today
    sender: s ? { _id: String(s._id), name: s.name || null, firstName: firstName(s.name), profileImage: s.profileImage || null, username: s.username || null } : null,
    status: n.status || null, isProcessed: !!n.isProcessed,
  };
}

/** { items (newest first, up to limit), unread: { all, for_you, campus, system } } for one account */
async function inbox(uid, { limit = 80 } = {}) {
  const lim = Math.max(1, Math.min(150, Number(limit) || 80));
  const [bell, social] = await Promise.all([
    Notification.find({ recipient: uid, deletedBy: { $ne: uid } }).sort({ createdAt: -1 }).limit(lim).lean(),
    SocialNotification.find({ recipient: uid, type: { $nin: SOCIAL_EXCLUDED } }).populate("sender", "name profileImage username").sort({ createdAt: -1 }).limit(lim).lean(),
  ]);
  const items = [...bell.map((n) => fromBell(n, uid)), ...social.map((n) => fromSocial(n, uid))]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, lim);
  return { items, unread: await unread(uid) };
}

/** Unread counts over both lists (not only the loaded page) */
async function unread(uid) {
  const [bellRows, social] = await Promise.all([
    Notification.find({ recipient: uid, deletedBy: { $ne: uid }, readBy: { $ne: uid } }).select("type").lean(),
    SocialNotification.countDocuments({ recipient: uid, type: { $nin: SOCIAL_EXCLUDED }, readBy: { $ne: uid } }),
  ]);
  const out = { all: 0, for_you: social, campus: 0, system: 0 };
  for (const n of bellRows) out[bellTab(n.type)] += 1;
  out.all = out.for_you + out.campus + out.system;
  return out;
}

module.exports = { TABS, BELL_TAB, bellTab, inbox, unread, SOCIAL_EXCLUDED };
