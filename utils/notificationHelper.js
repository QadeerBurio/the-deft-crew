// utils/notificationHelper.js
// Creates SocialNotification docs + fires device pushes.
// Exports:
//   • createNotification (default — backward compatible)
//   • createAndSendNotification (named)
//   • NotificationTemplates (named)
//   • TYPE_TO_MOOD (named)

const Notification = require('../models/SocialNotification');
const { sendToUser } = require('./pushNotification');

// ═══════════════════════════════════════════════════════════════
// MOOD MAP — each notification type → banner emoji mood
// ═══════════════════════════════════════════════════════════════
const TYPE_TO_MOOD = {
  // Social
  like: 'excited',
  comment: 'cheeky',
  follow: 'excited',
  request: 'sus',
  connection_accepted: 'hype',
  request_declined: 'sleepy',
  reply: 'cheeky',
  mention: 'sus',
  alert: 'urgent',

  // SkillShare
  new_offer: 'shook',
  offer_accepted: 'hype',
  offer_rejected: 'sleepy',
  match_created: 'hype',
  listing_created: 'excited',
  listing_updated: 'sorted',
  listing_deleted: 'sleepy',

  // Messages
  message: 'cheeky',

  // System
  System: 'sorted',
  system: 'sorted',
  transaction: 'sorted',
};

// ═══════════════════════════════════════════════════════════════
// TEMPLATES — named factories for each notification type
// ═══════════════════════════════════════════════════════════════
const NotificationTemplates = {
  // ── Social ──
  newLike: (userName, postPreview) => ({
    title: 'new like ❤️',
    description: `${userName} liked your post${postPreview ? `: "${postPreview.slice(0, 40)}..."` : ''}`,
    type: 'like',
  }),
  newComment: (userName, commentText) => ({
    title: 'new comment 💬',
    description: `${userName} commented: "${(commentText || '').slice(0, 60)}"`,
    type: 'comment',
  }),
  newFollower: (userName) => ({
    title: 'new follower 🌟',
    description: `${userName} started following you`,
    type: 'follow',
  }),
  connectionRequest: (userName) => ({
    title: 'connection request 👤',
    description: `${userName} wants to connect with you`,
    type: 'request',
  }),
  connectionAccepted: (userName) => ({
    title: 'connection accepted 🎉',
    description: `${userName} accepted your connection request`,
    type: 'connection_accepted',
  }),

  // ── SkillShare ──
  newOffer: (offerorName, listingTitle) => ({
    title: 'new offer 💼',
    description: `${offerorName} made an offer on "${listingTitle}"`,
    type: 'new_offer',
  }),
  offerAccepted: (ownerName, listingTitle) => ({
    title: 'offer accepted 🎉',
    description: `${ownerName} accepted your offer on "${listingTitle}"`,
    type: 'offer_accepted',
  }),
  offerRejected: (ownerName, listingTitle) => ({
    title: 'offer declined',
    description: `${ownerName} declined your offer on "${listingTitle}"`,
    type: 'offer_rejected',
  }),

  // ── System ──
  system: (title, description) => ({
    title: title || 'notification',
    description: description || '',
    type: 'System',
  }),
};

// ═══════════════════════════════════════════════════════════════
// createNotification — persists a SocialNotification (no push)
// Kept as default export for backward compat
// ═══════════════════════════════════════════════════════════════
const persistNotification = async (
  recipientId,
  senderId,
  type,
  text,
  relatedId = null,
  mood = 'sorted'
) => {
  try {
    if (recipientId.toString() === senderId.toString()) return null;

    // Connection request → update existing pending
    if (type === 'request') {
      const existingPending = await Notification.findOne({
        recipient: recipientId,
        sender: senderId,
        type: 'request',
        status: 'pending',
        isProcessed: false,
      });
      if (existingPending) {
        existingPending.text = text || existingPending.text;
        existingPending.mood = mood || existingPending.mood || 'sorted';
        existingPending.createdAt = new Date();
        await existingPending.save();
        return existingPending;
      }
    }

    // Connection result → update existing
    if (type === 'connection_accepted' || type === 'request_declined') {
      const existingResult = await Notification.findOne({
        recipient: recipientId,
        sender: senderId,
        type,
        isProcessed: true,
      });
      if (existingResult) {
        existingResult.text = text || existingResult.text;
        existingResult.mood = mood || existingResult.mood || 'sorted';
        existingResult.createdAt = new Date();
        await existingResult.save();
        return existingResult;
      }
    }

    // Fresh notification
    const notification = new Notification({
      recipient: recipientId,
      sender: senderId,
      type,
      text,
      relatedId,
      mood: mood || 'sorted',
      status: type === 'request' ? 'pending' : 'accepted',
      isProcessed: false,
      readBy: [],
    });
    await notification.save();
    return notification;
  } catch (error) {
    console.error('[persistNotification]', error.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════
// Push title per type (emoji shows in the system notification too)
// ═══════════════════════════════════════════════════════════════
const TYPE_TO_TITLE = {
  like: 'new like ❤️',
  comment: 'new comment 💬',
  reply: 'new reply 💬',
  mention: 'you got mentioned 👀',
  follow: 'new follower 🌟',
  request: 'connection request 👤',
  connection_accepted: 'connection accepted 🎉',
  request_declined: 'connection update',
  alert: 'heads up ⚠️',
  message: 'new message 💬',
};

// Where a tap on the system notification should open
const routeForType = (type, relatedId) => {
  if (['like', 'comment', 'reply', 'mention'].includes(type) && relatedId) {
    return { route: 'PostDetailScreen', params: { postId: String(relatedId) } };
  }
  if (type === 'message') return { route: 'MessagesScreen', params: {} };
  return { route: 'Notifications', params: {} };
};

// Fire-and-forget device push for a saved notification
const pushForNotification = (notification, { title, body, type, mood, metadata = {}, link = null }) => {
  setImmediate(async () => {
    try {
      const nav = routeForType(type, notification.relatedId);
      await sendToUser(notification.recipient, title, body, {
        notificationId: notification._id.toString(),
        senderId: notification.sender ? String(notification.sender) : null,
        type,
        mood,
        link,
        route: nav.route,
        params: nav.params,
        ...(notification.relatedId ? { postId: String(notification.relatedId) } : {}),
        ...metadata,
      });
    } catch (err) {
      console.error('[pushForNotification]', err.message);
    }
  });
};

// ═══════════════════════════════════════════════════════════════
// createNotification — saves the notification AND pushes it to the
// device so it shows when the app is in background / killed.
// Same signature as before, so every existing caller gets push.
// ═══════════════════════════════════════════════════════════════
const createNotification = async (
  recipientId,
  senderId,
  type,
  text,
  relatedId = null,
  mood = null
) => {
  const resolvedMood = mood || TYPE_TO_MOOD[type] || 'sorted';
  const notification = await persistNotification(recipientId, senderId, type, text, relatedId, resolvedMood);
  if (notification) {
    pushForNotification(notification, {
      title: TYPE_TO_TITLE[type] || 'TDC',
      body: text || '',
      type,
      mood: resolvedMood,
    });
  }
  return notification;
};

// ═══════════════════════════════════════════════════════════════
// createAndSendNotification — persists + fires push to device
// Called from routes with a structured payload
// ═══════════════════════════════════════════════════════════════
// utils/notificationHelper.js — FIXED: Complete metadata in push
const createAndSendNotification = async ({
  recipientId,
  senderId,
  title,
  description,
  type = 'System',
  mood = null,
  metadata = {},
  link = null,
} = {}) => {
  try {
    if (!recipientId || !senderId) {
      console.warn('[createAndSendNotification] missing recipient/sender');
      return null;
    }

    if (String(recipientId) === String(senderId)) return null;

    const resolvedMood = mood || TYPE_TO_MOOD[type] || 'sorted';

    // 1. Save the notification (no push yet)
    const notification = await persistNotification(
      recipientId,
      senderId,
      type,
      description,
      metadata?.relatedId || null,
      resolvedMood
    );

    if (!notification) return null;

    // 2. Push to device with the caller's title + navigation metadata
    pushForNotification(notification, {
      title: title || 'notification',
      body: description || '',
      type,
      mood: resolvedMood,
      link,
      metadata: {
        ...(metadata?.screen ? { screen: metadata.screen, route: metadata.route || metadata.screen } : {}),
        ...metadata,
      },
    });

    return notification;
  } catch (error) {
    console.error('[createAndSendNotification]', error.message);
    return null;
  }
};

module.exports = createNotification;
module.exports.createNotification = createNotification;
module.exports.createAndSendNotification = createAndSendNotification;
module.exports.NotificationTemplates = NotificationTemplates;
module.exports.TYPE_TO_MOOD = TYPE_TO_MOOD;
module.exports.persistNotification = persistNotification;
module.exports.pushForNotification = pushForNotification;