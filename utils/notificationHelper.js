// backend/utils/notificationHelper.js
// ✅ COMPLETE with auto deep-link generation

const Notification = require('../models/Notification');
const User = require('../models/User');
const axios = require('axios');
const { buildLink } = require('./deepLink');

/**
 * Send push notification via Expo
 */
const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken) {
    console.log('[Push] No token provided, skipping push notification');
    return;
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
          'Accept': 'application/json',
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

/**
 * Create a notification and send push
 * ✅ AUTO-BUILDS deep link if not provided
 */
const createAndSendNotification = async ({
  recipientId,
  senderId = null,
  title,
  description,
  type = 'System',
  metadata = {},
  link = '',
  webLink = '',
}) => {
  try {
    // Don't send notification to yourself
    if (senderId && recipientId && senderId.toString() === recipientId.toString()) {
      console.log('[Notification] Skipping self-notification');
      return null;
    }

    // ✅ Auto-build link if not provided
    if (!link) {
      const built = buildLink(type, {
        postId: metadata.postId,
        conversationId: metadata.conversationId,
        senderId,
        eventId: metadata.eventId,
        offerId: metadata.offerId,
        listingId: metadata.listingId,
        matchId: metadata.matchId,
        threadId: metadata.threadId,
      });
      link = built.link;
      webLink = built.webLink;
      console.log('[Notification] Auto-built link:', link);
    }

    // Create notification in DB
    const notification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      title,
      description,
      type,
      metadata,
      link,
      webLink,
      readBy: [],
      deletedBy: [],
    });

    console.log('[Notification] Created:', notification._id, 'for user:', recipientId);

    // Get recipient's push token
    const recipient = await User.findById(recipientId).select('expoPushToken');

    if (recipient?.expoPushToken) {
      await sendPushNotification(
        recipient.expoPushToken,
        title,
        description,
        {
          notificationId: notification._id.toString(),
          type,
          link,
          webLink,
          senderId: senderId ? String(senderId) : null,
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

/**
 * Notification templates for SkillShare
 */
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
    description: preview.length > 60 ? preview.slice(0, 60) + '...' : preview,
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

module.exports = {
  sendPushNotification,
  createAndSendNotification,
  NotificationTemplates,
};