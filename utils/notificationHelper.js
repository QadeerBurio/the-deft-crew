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

  // SkillShare
  new_offer: 'shook',
  offer_accepted: 'hype',
  offer_rejected: 'sleepy',
  match_created: 'hype',

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
const createNotification = async (
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
    console.error('[createNotification]', error.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════
// createAndSendNotification — persists + fires push to device
// Called from routes with a structured payload
// ═══════════════════════════════════════════════════════════════
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

    // Resolve mood (explicit > type-based > default)
    const resolvedMood = mood || TYPE_TO_MOOD[type] || 'sorted';

    // 1. Save the notification
    const notification = await createNotification(
      recipientId,
      senderId,
      type,
      description,
      metadata?.relatedId || null,
      resolvedMood
    );

    if (!notification) return null;

    // 2. Fire device push (fire-and-forget)
    setImmediate(async () => {
      try {
        const pushData = {
          notificationId: notification._id.toString(),
          type,
          mood: resolvedMood,
          screen: metadata?.screen || null,
          link: link || null,
          ...metadata,
        };

        await sendToUser(
          recipientId,
          title || 'notification',
          description || '',
          pushData
        );
        console.log(
          `[createAndSendNotification] push sent → ${recipientId} (${type}/${resolvedMood})`
        );
      } catch (err) {
        console.error('[createAndSendNotification] push error:', err.message);
      }
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