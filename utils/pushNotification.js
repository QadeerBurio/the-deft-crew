// utils/pushNotification.js — FIXED: Complete push payload
const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo();

const ICON_BASE =
  process.env.PUSH_ICON_BASE ||
  'https://the-deft-crew-production.up.railway.app/assets/dots';

const iconUrlForMood = (mood) =>
  mood ? `${ICON_BASE}/${mood}.png` : null;

/**
 * Send to every push token on a user document. Removes dead tokens.
 */
const sendToUser = async (userId, title, body, extraData = {}) => {
  const user = await User.findById(userId).select('pushTokens').lean();
  const tokens = (user?.pushTokens || []).map((t) => t.token).filter(Boolean);
  
  if (tokens.length === 0) {
    console.log(`[push] No tokens for user ${userId}`);
    return { sent: false, reason: 'no_token' };
  }

  // Resolve mood
  const mood = extraData.mood || 'sorted';
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);

  // Build complete data payload
  const data = {
    ...extraData,
    mood,
    iconUrl,
    // Ensure these are always present
    type: extraData.type || 'System',
    channelId: extraData.channelId || 'default',
  };

  console.log(`[push] Sending to ${tokens.length} token(s)`, {
    title,
    body: body?.slice(0, 50),
    type: data.type,
    mood: data.mood,
    hasScreen: !!data.screen,
  });

  const messages = tokens
    .filter((t) => Expo.isExpoPushToken(t))
    .map((t) => ({
      to: t,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: data.channelId,
      
      // iOS rich content
      ...(iconUrl && {
        richContent: {
          image: iconUrl,
        },
      }),
      
      // Android
      ...(iconUrl && {
        mutableContent: true,
      }),
    }));

  if (messages.length === 0) {
    console.log('[push] No valid Expo tokens');
    return { sent: false, reason: 'no_token' };
  }

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  
  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res);
      console.log(`[push] Sent ${res.length} notifications`);
    } catch (err) {
      console.error('sendToUser send error:', err.message);
    }
  }

  // Clean dead tokens
  setImmediate(async () => {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(
        tickets.map((t) => t.id).filter(Boolean)
      );
      const dead = [];
      for (const [id, receipt] of Object.entries(receipts)) {
        if (
          receipt.status === 'error' &&
          receipt.details?.error === 'DeviceNotRegistered'
        ) {
          dead.push(id);
        }
      }
      if (dead.length) {
        const tokenById = Object.fromEntries(tickets.map((t) => [t.id, t.to]));
        const deadTokens = dead.map((id) => tokenById[id]).filter(Boolean);
        if (deadTokens.length) {
          await User.updateOne(
            { _id: userId },
            { $pull: { pushTokens: { token: { $in: deadTokens } } } }
          );
          console.log(`[push] Removed ${deadTokens.length} dead tokens`);
        }
      }
    } catch (err) {
      console.error('Receipt cleanup error:', err.message);
    }
  });

  return { sent: true, count: tickets.length };
};

/**
 * Single token send — kept for compatibility.
 */
const sendPushNotification = async (
  targetToken,
  title,
  body,
  extraData = {}
) => {
  if (!Expo.isExpoPushToken(targetToken)) {
    console.error('Invalid Expo push token:', targetToken);
    return { sent: false, reason: 'invalid_token' };
  }

  const mood = extraData.mood || 'sorted';
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);

  const data = {
    ...extraData,
    mood,
    iconUrl,
    type: extraData.type || 'System',
    channelId: extraData.channelId || 'default',
  };

  const messages = [
    {
      to: targetToken,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: data.channelId,
      ...(iconUrl && { richContent: { image: iconUrl } }),
    },
  ];

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    return { sent: true };
  } catch (error) {
    console.error('Error sending push:', error);
    return { sent: false, reason: 'send_failed' };
  }
};

module.exports = { sendPushNotification, sendToUser };