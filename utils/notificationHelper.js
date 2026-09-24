// backend/utils/notificationHelper.js
// ✅ COMPLETE — supports BOTH positional and object signatures
// ✅ Saves to SocialNotification model
// ✅ Sends Expo push notification

const Notification = require('../models/SocialNotification');
const User = require('../models/User');
const axios = require('axios');

// ---------- Default titles per type ----------
const DEFAULT_TITLES = {
  like: '❤️ New Like',
  comment: '💬 New Comment',
  reply: '↩️ New Reply',
  mention: '@ Mention',
  message: '💬 New Message',
  request: '👤 Connection Request',
  connection_accepted: '🎉 Connection Accepted',
  request_declined: 'Request Declined',
  alert: '⚠️ Alert',
  Event: '📅 Event',
  Offer: '📬 Offer',
  Exchange: '🤝 Exchange',
  System: '🔔 Notification',
};

// ============================================================
// Send push via Expo
// ============================================================
const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken) {
    console.log('[Push] No token provided, skipping push notification');
    return null;
  }

  try {
    const message = {
      to: expoPushToken,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'default',
    };

    const response = await axios.post(
      'https://exp.host/--/api/v2/push/send',
      message,
      {
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('[Push] Notification sent:', response.data);
    return response.data;
  } catch (error) {
    console.error('[Push] Error sending notification:', error.message);
    return null;
  }
};

// ============================================================
// Core: create + save + push (object signature only)
// ============================================================
const _createInternal = async ({
  recipientId,
  senderId,
  type = 'System',
  text,
  relatedId = null,
  metadata = {},
  title,
}) => {
  try {
    // Don't notify yourself
    if (
      senderId &&
      recipientId &&
      senderId.toString() === recipientId.toString()
    ) {
      return null;
    }

    // ----- Dedup logic for connection requests -----
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
        existingPending.createdAt = new Date();
        await existingPending.save();
        return existingPending;
      }
    }

    if (type === 'connection_accepted' || type === 'request_declined') {
      const existingResult = await Notification.findOne({
        recipient: recipientId,
        sender: senderId,
        type,
        isProcessed: true,
      });

      if (existingResult) {
        existingResult.text = text || existingResult.text;
        existingResult.createdAt = new Date();
        await existingResult.save();
        return existingResult;
      }
    }

    // ----- Save -----
    const notification = new Notification({
      recipient: recipientId,
      sender: senderId,
      type,
      text,
      relatedId: relatedId || undefined,
      status: type === 'request' ? 'pending' : 'accepted',
      isProcessed: false,
      readBy: [],
    });

    await notification.save();

    console.log(
      '[Notification] Created:',
      notification._id,
      '| type:',
      type,
      '| for:',
      recipientId
    );

    // ----- Push -----
    const recipient = await User.findById(recipientId).select('expoPushToken');

    if (recipient?.expoPushToken) {
      await sendPushNotification(
        recipient.expoPushToken,
        title || DEFAULT_TITLES[type] || 'Notification',
        text || '',
        {
          notificationId: notification._id.toString(),
          type,
          senderId: senderId ? String(senderId) : null,
          postId: relatedId ? String(relatedId) : null,
          ...metadata,
        }
      );
    } else {
      console.log('[Notification] No push token for user:', recipientId);
    }

    return notification;
  } catch (error) {
    console.error('[Notification] Error creating notification:', error);
    return null;
  }
};

// ============================================================
// ✅ createNotification — accepts BOTH signatures
//
//  OLD positional (your routes use this):
//    createNotification(recipientId, senderId, type, text, relatedId)
//
//  NEW object:
//    createNotification({ recipientId, senderId, type, text, relatedId, metadata })
// ============================================================
const createNotification = async (arg1, arg2, arg3, arg4, arg5, arg6) => {
  // Object signature
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    return _createInternal(arg1);
  }

  // Positional signature
  // arg1 = recipientId
  // arg2 = senderId
  // arg3 = type
  // arg4 = text
  // arg5 = relatedId (postId / commentId / conversationId)
  // arg6 = metadata (optional)
  const [recipientId, senderId, type, text, relatedId, metadata] = [
    arg1,
    arg2,
    arg3,
    arg4,
    arg5,
    arg6,
  ];

  return _createInternal({
    recipientId,
    senderId,
    type: type || 'System',
    text: text || '',
    relatedId: relatedId || null,
    metadata: metadata || {},
    title: DEFAULT_TITLES[type] || 'Notification',
  });
};

// ============================================================
// Alias for object-style callers
// ============================================================
const createAndSendNotification = _createInternal;

// ============================================================
// Templates (kept for SkillShare etc.)
// ============================================================
const NotificationTemplates = {
  newOffer: (offerorName, listingTitle) => ({
    title: '📬 New Offer Received',
    description: `${offerorName} made an offer on "${listingTitle}"`,
    type: 'Offer',
  }),
  offerAccepted: (ownerName, listingTitle) => ({
    title: '🎉 Offer Accepted!',
    description: `${ownerName} accepted your offer on "${listingTitle}"`,
    type: 'Application Status',
  }),
  offerRejected: (ownerName, listingTitle) => ({
    title: '❌ Offer Declined',
    description: `${ownerName} declined your offer on "${listingTitle}"`,
    type: 'Application Status',
  }),
  newInquiry: (inquirerName, listingTitle) => ({
    title: '💬 New Question',
    description: `${inquirerName} asked a question about "${listingTitle}"`,
    type: 'Message',
  }),
  newMessage: (senderName, preview) => ({
    title: `💬 ${senderName}`,
    description:
      preview.length > 60 ? preview.slice(0, 60) + '...' : preview,
    type: 'Message',
  }),
  newMatch: (otherName, listingTitle) => ({
    title: '🤝 New Match!',
    description: `You matched with ${otherName} for "${listingTitle}"`,
    type: 'Exchange',
  }),
  listingClosed: (listingTitle) => ({
    title: '📋 Listing Closed',
    description: `Your listing "${listingTitle}" has been closed`,
    type: 'System',
  }),
};

// ============================================================
// ✅ EXPORT — works with BOTH import styles
// ============================================================
module.exports = createNotification;
module.exports.createNotification = createNotification;
module.exports.createAndSendNotification = createAndSendNotification;
module.exports.sendPushNotification = sendPushNotification;
module.exports.NotificationTemplates = NotificationTemplates;