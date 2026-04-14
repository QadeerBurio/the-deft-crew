const SocialNotification = require('../models/SocialNotification');

/**
 * @param {String} recipient - User receiving the notification
 * @param {String} sender - User who triggered it
 * @param {String} type - Must be 'like', 'comment', 'request', or 'alert'
 * @param {String} text - The message to display
 * @param {String} postId - (Optional) ID of the post for like/comment notifications
 */
const createNotification = async (recipient, sender, type, text, postId = null) => {
  try {
    // 1. Prevent self-notifications
    if (!recipient || !sender || recipient.toString() === sender.toString()) return null;

    // 2. Map custom strings to allowed Schema Enums
    let validTypes = ['like', 'comment', 'request', 'alert'];
    let notificationType = type.toLowerCase();

    if (notificationType.includes('request')) notificationType = 'request';
    if (!validTypes.includes(notificationType)) notificationType = 'alert';

    const notificationData = {
      recipient,
      sender,
      type: notificationType,
      text,
      readBy: []
    };

    // Store postId for like and comment notifications
    if ((notificationType === 'like' || notificationType === 'comment') && postId) {
      notificationData.postId = postId;
      notificationData.relatedId = postId; // For backward compatibility
    }

    const newNotification = new SocialNotification(notificationData);
    await newNotification.save();
    
    console.log(`✅ Notification saved: ${text} for ${notificationType}`);
    return newNotification;
  } catch (err) {
    console.error("❌ Notification Helper Error:", err.message);
    return null;
  }
};

module.exports = createNotification;