// utils/pushNotification.js
// ✅ FIXED: nested android object → heads-up popup when app is KILLED
// Works: Expo Go (foreground) + APK (background + killed)

const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo();

const ICON_BASE =
  process.env.PUSH_ICON_BASE ||
  'https://the-deft-crew-production.up.railway.app/assets/dots';

const iconUrlForMood = (mood) =>
  mood ? `${ICON_BASE}/${mood}.png` : null;

// ═══════════════════════════════════════════════════════════════
// TYPE → SOUND + CHANNEL
// ═══════════════════════════════════════════════════════════════
const TYPE_TO_SOUND = {
  like: 'tdc_push_default',
  comment: 'tdc_push_default',
  follow: 'tdc_push_default',
  request: 'tdc_push_confession',
  connection_accepted: 'tdc_push_default',
  request_declined: 'tdc_push_default',
  new_offer: 'tdc_push_deal',
  offer_accepted: 'tdc_push_deal',
  offer_rejected: 'tdc_push_default',
  match_created: 'tdc_push_deal',
  listing_created: 'tdc_push_deal',
  listing_updated: 'tdc_push_default',
  listing_deleted: 'tdc_push_default',
  message: 'tdc_push_message',
  new_job: 'tdc_push_internship',
  internship: 'tdc_push_internship',
  job_application: 'tdc_push_internship',
  interview: 'tdc_push_internship',
  reminder: 'tdc_push_reminder',
  points: 'tdc_push_points',
  streak: 'tdc_push_streak',
  confession: 'tdc_push_confession',
  event: 'tdc_push_event',
  level_up: 'tdc_push_level_up',
  badge: 'tdc_push_level_up',
  System: 'tdc_push_default',
  system: 'tdc_push_default',
  transaction: 'tdc_push_default',
};

const TYPE_TO_CHANNEL = {
  new_offer: 'deals',
  offer_accepted: 'deals',
  match_created: 'deals',
  listing_created: 'deals',
  message: 'messages',
  new_job: 'jobs',
  internship: 'jobs',
  job_application: 'jobs',
  interview: 'jobs',
  reminder: 'reminders',
  points: 'points',
  streak: 'streaks',
  confession: 'confessions',
  event: 'events',
  level_up: 'levelup',
  badge: 'levelup',
};

const resolveSound = (type) => TYPE_TO_SOUND[type] || 'tdc_push_default';
const resolveChannel = (type) => TYPE_TO_CHANNEL[type] || 'engagement';

// ═══════════════════════════════════════════════════════════════
// ✅ THE KEY FIX — build message with NESTED android object
//    Without this block, Android will not show heads-up popup
//    when the app is killed.
// ═══════════════════════════════════════════════════════════════
function buildMessage(token, { title, body, data, soundName, channelId, iconUrl }) {
  return {
    to: token,

    // iOS sound — Android ignores this, uses channel sound
    sound: `${soundName}.wav`,
    title,
    body,
    data,

    // iOS priority
    priority: 'high',

    // Expo top-level channel (safe fallback)
    channelId,

    // ═══════════════════════════════════════════════════════════
    // ✅ CRITICAL: NESTED ANDROID OBJECT
    // This is what triggers heads-up popup when app is killed
    // ═══════════════════════════════════════════════════════════
    android: {
      priority: 'max',              // MAX = heads-up popup even when killed
      channelId,                    // routes to correct channel (with sound)
      sound: `${soundName}.wav`,    // sound file in res/raw/
      visibility: 'public',         // show on lock screen
    },

    // iOS rich content (mood icon)
    ...(iconUrl && { mutableContent: true }),
    ...(iconUrl && { richContent: { image: iconUrl } }),
  };
}

// ═══════════════════════════════════════════════════════════════
// SEND TO USER (multi-device)
// ═══════════════════════════════════════════════════════════════
const sendToUser = async (userId, title, body, extraData = {}) => {
  const user = await User.findById(userId).select('pushTokens').lean();
  const tokens = (user?.pushTokens || []).map((t) => t.token).filter(Boolean);

  if (tokens.length === 0) {
    console.log(`[push] No tokens for user ${userId}`);
    return { sent: false, reason: 'no_token' };
  }

  const mood = extraData.mood || 'sorted';
  const type = extraData.type || 'System';
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);
  const soundName = resolveSound(type);
  const channelId = extraData.channelId || resolveChannel(type);

  const data = {
    ...extraData,
    mood,
    iconUrl,
    type,
    channelId,
    screen: extraData.screen || extraData.route || null,
    route: extraData.route || extraData.screen || null,
  };

  console.log(`[push] Sending to ${tokens.length} token(s)`, {
    title, type, mood, channelId, soundName,
  });

  const messages = tokens
    .filter((t) => Expo.isExpoPushToken(t))
    .map((t) => buildMessage(t, { title, body, data, soundName, channelId, iconUrl }));

  if (messages.length === 0) {
    return { sent: false, reason: 'no_token' };
  }

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];

  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res);

      // ✅ Log ticket details so you can verify it worked
      res.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          console.error(`[push] ❌ Ticket error ${i}:`, ticket.message, ticket.details);
        } else {
          console.log(`[push] ✅ Ticket OK ${i}: id=${ticket.id}`);
        }
      });

      console.log(`[push] Sent ${res.length} notifications`);
    } catch (err) {
      console.error('sendToUser send error:', err.message);
    }
  }

  // Dead-token cleanup
  setImmediate(async () => {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(
        tickets.map((t) => t.id).filter(Boolean)
      );
      const dead = [];
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
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
        }
      }
    } catch (err) {
      console.error('Receipt cleanup error:', err.message);
    }
  });

  return { sent: true, count: tickets.length };
};

// ═══════════════════════════════════════════════════════════════
// SEND TO SINGLE TOKEN
// ═══════════════════════════════════════════════════════════════
const sendPushNotification = async (targetToken, title, body, extraData = {}) => {
  if (!Expo.isExpoPushToken(targetToken)) {
    return { sent: false, reason: 'invalid_token' };
  }

  const mood = extraData.mood || 'sorted';
  const type = extraData.type || 'System';
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);
  const soundName = resolveSound(type);
  const channelId = extraData.channelId || resolveChannel(type);

  const data = {
    ...extraData,
    mood,
    iconUrl,
    type,
    channelId,
    screen: extraData.screen || extraData.route || null,
    route: extraData.route || extraData.screen || null,
  };

  const message = buildMessage(targetToken, {
    title, body, data, soundName, channelId, iconUrl,
  });

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const res = await expo.sendPushNotificationsAsync(chunk);
      res.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          console.error(`[push] ❌ Ticket error ${i}:`, ticket.message, ticket.details);
        } else {
          console.log(`[push] ✅ Ticket OK ${i}: id=${ticket.id}`);
        }
      });
    }
    return { sent: true };
  } catch (error) {
    console.error('Error sending push:', error);
    return { sent: false, reason: 'send_failed' };
  }
};

module.exports = {
  sendPushNotification,
  sendToUser,
  TYPE_TO_SOUND,
  TYPE_TO_CHANNEL,
};