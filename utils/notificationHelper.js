// utils/notificationHelper.js - UPDATED
const Notification = require('../models/SocialNotification');

const createNotification = async (recipientId, senderId, type, text, relatedId = null) => {
  try {
    // Don't send notification to self
    if (recipientId.toString() === senderId.toString()) {
      return null;
    }

    // For connection requests, check if there's already a pending notification
    if (type === 'request') {
      const existingPending = await Notification.findOne({
        recipient: recipientId,
        sender: senderId,
        type: 'request',
        status: 'pending',
        isProcessed: false
      });

      if (existingPending) {
        existingPending.text = text || existingPending.text;
        existingPending.createdAt = new Date();
        await existingPending.save();
        return existingPending;
      }
    }

    // For connection results, update existing if any
    if (type === 'connection_accepted' || type === 'request_declined') {
      const existingResult = await Notification.findOne({
        recipient: recipientId,
        sender: senderId,
        type: type,
        isProcessed: true
      });

      if (existingResult) {
        existingResult.text = text || existingResult.text;
        existingResult.createdAt = new Date();
        await existingResult.save();
        return existingResult;
      }
    }

    // Create new notification
    const notification = new Notification({
      recipient: recipientId,
      sender: senderId,
      type: type,
      text: text,
      relatedId: relatedId,
      status: type === 'request' ? 'pending' : 'accepted',
      isProcessed: false,
      readBy: []
    });

    await notification.save();
    return notification;

  } catch (error) {
    console.error('Create Notification Error:', error);
    return null;
  }
};

module.exports = createNotification;