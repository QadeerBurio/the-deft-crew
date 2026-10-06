// utils/pushNotification.js
// Sends Expo push notifications that show as a system popup when the
// app is in background or killed.
//
// Why the old version failed outside the app:
//   1. It sent an `android: {...}` object. That is NOT an Expo push field.
//      Expo validates payloads, so the whole chunk could be rejected and
//      nothing reached the phone (in-app still worked through sockets).
//   2. Mood image URL pointed to /assets/dots/*.png which the server never
//      served, so the emoji image in the system notification was a 404.
//   3. Dead-token cleanup read `ticket.to`, which tickets don't have.

const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {}
);

// Public base URL of this backend. Mood PNGs are served at /assets/dots/<mood>.png
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'https://the-deft-crew-production.up.railway.app'
).replace(/\/$/, '');

const ICON_BASE = (process.env.PUSH_ICON_BASE || `${PUBLIC_BASE_URL}/assets/dots`).replace(/\/$/, '');

const VALID_MOODS = new Set([
  'sorted', 'excited', 'sleepy', 'panic', 'sus', 'cheeky', 'shook', 'hype',
  'smug', 'shock', 'broke', 'money', 'ghost', 'urgent',
]);

// 256px circle versions of the in-app banner icons (public/dots/push)
const iconUrlForMood = (mood) => {
  const m = VALID_MOODS.has(mood) ? mood : 'sorted';
  return `${ICON_BASE}/push/${m}.png`;
};

// Same emoji the in-app banner uses (app/src/utils/notificationIcon.js)
const MOOD_EMOJI = {
  sorted: '😊',
  panic: '😰',
  excited: '🤩',
  broke: '😢',
  sleepy: '😴',
  shook: '😮',
  sus: '😒',
  cheeky: '😜',
  hype: '😆',
  smug: '😏',
  shock: '😳',
  urgent: '😨',
  money: '🤑',
  ghost: '😑',
};
const EMOJI_RE = /\p{Extended_Pictographic}/u;

// Adds the mood emoji in front of the title, unless it already has one
const titleWithEmoji = (title, mood) => {
  const t = title || 'TDC';
  if (EMOJI_RE.test(t)) return t;
  return `${MOOD_EMOJI[mood] || '✨'} ${t}`;
};

// ═══════════════════════════════════════════════════════════════
// SOUND: exact copy of the in-app rule (app/src/lib/tdcSounds.js
// playSoundForNotification): mood sound first, else type sound.
// Each sound has its own Android channel "snd_<sound>", because on
// Android the sound of a background notification comes from its channel.
// ═══════════════════════════════════════════════════════════════
const MOOD_SOUND = {
  sorted: 'tdc_mood_sorted', excited: 'tdc_mood_excited', panic: 'tdc_mood_panic',
  broke: 'tdc_mood_broke', sleepy: 'tdc_mood_sleepy', shook: 'tdc_mood_shook',
  sus: 'tdc_mood_sus', cheeky: 'tdc_mood_cheeky', rs: 'tdc_mood_rs',
};

const TYPE_SOUND = {
  like: 'tdc_like', comment: 'tdc_like',
  follow: 'tdc_push_message', request: 'tdc_push_message', connection_accepted: 'tdc_push_message',
  message: 'tdc_push_message', Message: 'tdc_push_message',
  new_offer: 'tdc_push_deal', offer_accepted: 'tdc_push_deal', match_created: 'tdc_push_deal',
  offer_rejected: 'tdc_nope', request_declined: 'tdc_nope',
  new_job: 'tdc_push_internship', internship: 'tdc_push_internship',
  confession: 'tdc_push_confession',
  event: 'tdc_push_event',
  streak: 'tdc_push_streak',
  points: 'tdc_push_points', rs: 'tdc_push_points',
  level_up: 'tdc_push_level_up', badge: 'tdc_push_level_up',
  reminder: 'tdc_push_reminder',
};

const resolveSoundKey = (type, mood) => MOOD_SOUND[mood] || TYPE_SOUND[type] || 'tdc_push_default';
const channelForSound = (soundKey) => `snd_${soundKey}`;

// Old app builds only have these channels. Sending to a channel that doesn't
// exist on the phone makes Android fall back to the default channel, which is
// why most pushes played the general sound.
const LEGACY_CHANNEL_FOR_SOUND = {
  tdc_push_deal: 'deals',
  tdc_push_message: 'messages',
  tdc_mood_cheeky: 'messages',
  tdc_push_internship: 'jobs',
  tdc_push_reminder: 'reminders',
  tdc_push_points: 'points',
  tdc_mood_rs: 'points',
  tdc_push_streak: 'streaks',
  tdc_push_confession: 'confessions',
  tdc_push_event: 'events',
  tdc_push_level_up: 'levelup',
};

// Pick the channel per device: new builds get the exact sound channel,
// old builds get the closest channel they actually have.
const channelForToken = (entry, soundKey) =>
  entry?.channels === 'snd_v1'
    ? channelForSound(soundKey)
    : LEGACY_CHANNEL_FOR_SOUND[soundKey] || 'engagement';

// ═══════════════════════════════════════════════════════════════
// TYPE → SOUND + CHANNEL
// Channel IDs MUST match the channels the app creates in
// app/src/utils/pushNotifications.js, otherwise Android drops them.
// ═══════════════════════════════════════════════════════════════
const TYPE_TO_SOUND = {
  like: 'tdc_push_default',
  comment: 'tdc_push_default',
  reply: 'tdc_push_default',
  mention: 'tdc_push_default',
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
  Message: 'tdc_push_message',
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
  Message: 'messages',
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

// Every channel the app creates. Anything else falls back to "engagement".
const KNOWN_CHANNELS = new Set([
  'engagement', 'default', 'deals', 'messages', 'jobs', 'reminders',
  'points', 'streaks', 'confessions', 'events', 'levelup',
]);

const resolveSound = (type) => TYPE_TO_SOUND[type] || 'tdc_push_default';
const resolveChannel = (type, requested) => {
  if (requested && KNOWN_CHANNELS.has(requested) && requested !== 'default') return requested;
  return TYPE_TO_CHANNEL[type] || 'engagement';
};

// ═══════════════════════════════════════════════════════════════
// BUILD A VALID EXPO MESSAGE (only documented Expo fields)
// ═══════════════════════════════════════════════════════════════
function buildMessage(token, { title, body, data, soundName, channelId, iconUrl }) {
  const msg = {
    to: token,
    title: title || 'TDC',
    body: body || '',
    data,
    sound: `${soundName}.wav`, // iOS custom sound. Android uses the channel's sound.
    priority: 'high',          // wakes the device when the app is killed
    channelId,                 // Android: heads-up popup comes from the channel importance
    ttl: 60 * 60 * 24,         // keep trying for 24h if the phone is offline
  };

  if (iconUrl) {
    // Android: shows the mood emoji as the notification image.
    // iOS: needs a Notification Service Extension to render it.
    msg.richContent = { image: iconUrl };
    msg.mutableContent = true;
  }

  return msg;
}

// ═══════════════════════════════════════════════════════════════
// SEND + RECEIPT CLEANUP
// ═══════════════════════════════════════════════════════════════
async function sendMessages(messages, userIdForCleanup = null) {
  const pairs = []; // { ticket, token }
  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        const token = chunk[i]?.to;
        pairs.push({ ticket, token });
        if (ticket.status === 'error') {
          console.error('[push] ❌ ticket error:', ticket.message, ticket.details || '');
        } else {
          console.log('[push] ✅ ticket ok:', ticket.id);
        }
      });
    } catch (err) {
      // A 400 here usually means the payload is invalid. Log the body so it's visible.
      console.error('[push] send failed:', err.message, err.statusCode || '', err.body || '');
    }
  }

  // Tokens rejected immediately
  const deadNow = pairs
    .filter((p) => p.ticket.status === 'error' && p.ticket.details?.error === 'DeviceNotRegistered')
    .map((p) => p.token);

  // Receipts arrive a bit later; check after 15s
  const okPairs = pairs.filter((p) => p.ticket.status === 'ok' && p.ticket.id);
  setTimeout(async () => {
    const dead = new Set(deadNow);
    try {
      if (okPairs.length) {
        const receiptChunks = expo.chunkPushNotificationReceiptIds(okPairs.map((p) => p.ticket.id));
        for (const ids of receiptChunks) {
          const receipts = await expo.getPushNotificationReceiptsAsync(ids);
          for (const [id, receipt] of Object.entries(receipts)) {
            if (receipt.status !== 'error') continue;
            console.error('[push] ❌ receipt error:', receipt.message, receipt.details || '');
            if (receipt.details?.error === 'DeviceNotRegistered') {
              const pair = okPairs.find((p) => p.ticket.id === id);
              if (pair?.token) dead.add(pair.token);
            }
          }
        }
      }
      if (dead.size) {
        const tokens = [...dead];
        const filter = userIdForCleanup ? { _id: userIdForCleanup } : { 'pushTokens.token': { $in: tokens } };
        await User.updateMany(filter, { $pull: { pushTokens: { token: { $in: tokens } } } });
        console.log('[push] removed dead tokens:', tokens.length);
      }
    } catch (err) {
      console.error('[push] receipt check error:', err.message);
    }
  }, 15000);

  return pairs;
}

function buildData(type, extraData) {
  const mood = VALID_MOODS.has(extraData.mood) || extraData.mood === 'rs' ? extraData.mood : 'sorted';
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);
  const soundKey = resolveSoundKey(type, mood);
  const channelId = channelForSound(soundKey);
  const data = {
    ...extraData,
    type,
    mood,
    iconUrl,
    channelId,
    soundKey,
    screen: extraData.screen || extraData.route || null,
    route: extraData.route || extraData.screen || null,
  };
  // Expo data must be JSON-serializable: stringify ObjectIds
  return { data: JSON.parse(JSON.stringify(data)), mood, iconUrl, channelId, soundKey };
}

// ═══════════════════════════════════════════════════════════════
// SEND TO USER (all their devices)
// ═══════════════════════════════════════════════════════════════
const sendToUser = async (userId, title, body, extraData = {}) => {
  try {
    const user = await User.findById(userId).select('pushTokens').lean();
    const seen = new Set();
    const entries = (user?.pushTokens || []).filter((e) => {
      if (!e?.token || seen.has(e.token) || !Expo.isExpoPushToken(e.token)) return false;
      seen.add(e.token);
      return true;
    });

    if (entries.length === 0) {
      console.log(`[push] no valid tokens for user ${userId}`);
      return { sent: false, reason: 'no_token' };
    }

    const type = extraData.type || 'System';
    const { data, iconUrl, soundKey, mood } = buildData(type, extraData);
    const fullTitle = titleWithEmoji(title, mood);
    const tokens = entries.map((e) => e.token);
    const channelId = channelForSound(soundKey);

    const messages = entries.map((e) =>
      buildMessage(e.token, {
        title: fullTitle,
        body,
        data: { ...data, channelId: channelForToken(e, soundKey) },
        soundName: soundKey,
        channelId: channelForToken(e, soundKey),
        iconUrl,
      })
    );

    console.log(`[push] → user ${userId}: ${tokens.length} device(s)`, { title, type, channelId });
    const pairs = await sendMessages(messages, userId);
    const ok = pairs.filter((p) => p.ticket.status === 'ok').length;
    return { sent: ok > 0, count: ok };
  } catch (err) {
    console.error('[push] sendToUser error:', err.message);
    return { sent: false, reason: 'exception', error: err.message };
  }
};

// ═══════════════════════════════════════════════════════════════
// SEND TO SINGLE TOKEN
// ═══════════════════════════════════════════════════════════════
const sendPushNotification = async (targetToken, title, body, extraData = {}) => {
  if (!Expo.isExpoPushToken(targetToken)) return { sent: false, reason: 'invalid_token' };

  const type = extraData.type || 'System';
  const { data, iconUrl, channelId, soundKey, mood } = buildData(type, extraData);
  const message = buildMessage(targetToken, {
    title: titleWithEmoji(title, mood), body, data, soundName: soundKey, channelId, iconUrl,
  });

  const pairs = await sendMessages([message]);
  const ok = pairs.some((p) => p.ticket.status === 'ok');
  return ok ? { sent: true } : { sent: false, reason: 'send_failed' };
};

module.exports = {
  sendPushNotification,
  sendToUser,
  sendMessages,
  buildMessage,
  iconUrlForMood,
  titleWithEmoji,
  resolveSoundKey,
  channelForSound,
  channelForToken,
  MOOD_EMOJI,
  MOOD_SOUND,
  TYPE_SOUND,
  resolveChannel,
  resolveSound,
  TYPE_TO_SOUND,
  TYPE_TO_CHANNEL,
};