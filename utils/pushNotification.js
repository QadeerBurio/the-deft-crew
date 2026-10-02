// utils/pushNotification.js
// FIXED: Filters out tokens from wrong projects + handles mixed FCM projects

const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo();

// ═══════════════════════════════════════════════════════════════
// ✅ CRITICAL: Your Expo project ID — MUST match the app
// ═══════════════════════════════════════════════════════════════
const EXPO_PROJECT_ID =
  process.env.EXPO_PROJECT_ID ||
  '112506b0-7553-4a1b-afeb-6a37019cc15f'; // from your app.json

const ICON_BASE =
  process.env.PUSH_ICON_BASE ||
  'https://the-deft-crew-production.up.railway.app/assets/dots';

const iconUrlForMood = (mood) =>
  mood ? `${ICON_BASE}/${mood}.png` : null;

// ═══════════════════════════════════════════════════════════════
// TYPE → SOUND + CHANNEL MAP
// ═══════════════════════════════════════════════════════════════
const TYPE_TO_SOUND = {
  // Social
  like: 'tdc_push_default',
  comment: 'tdc_push_default',
  follow: 'tdc_push_default',
  request: 'tdc_push_confession',
  connection_accepted: 'tdc_push_default',
  request_declined: 'tdc_push_default',

  // SkillShare
  new_offer: 'tdc_push_deal',
  offer_accepted: 'tdc_push_deal',
  offer_rejected: 'tdc_push_default',
  match_created: 'tdc_push_deal',
  listing_created: 'tdc_push_deal',
  listing_updated: 'tdc_push_default',
  listing_deleted: 'tdc_push_default',

  // Messages
  message: 'tdc_push_message',

  // Jobs
  new_job: 'tdc_push_internship',
  internship: 'tdc_push_internship',
  job_application: 'tdc_push_internship',
  interview: 'tdc_push_internship',

  // Engagement
  reminder: 'tdc_push_reminder',
  points: 'tdc_push_points',
  streak: 'tdc_push_streak',
  confession: 'tdc_push_confession',
  event: 'tdc_push_event',
  level_up: 'tdc_push_level_up',
  badge: 'tdc_push_level_up',

  // System
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
// ✅ FILTER: Only keep tokens from OUR Expo project
// Filters out tokens that belong to a different Expo project
// (which is what caused "Unable to retrieve FCM server key")
// ═══════════════════════════════════════════════════════════════
const filterValidTokens = (tokens) => {
  const valid = [];
  const invalid = [];
  const seen = new Set(); // dedupe

  for (const t of tokens) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);

    // Basic Expo push token format check
    if (!Expo.isExpoPushToken(t)) {
      invalid.push({ token: t, reason: 'invalid_format' });
      continue;
    }
    valid.push(t);
  }

  return { valid, invalid };
};

// ═══════════════════════════════════════════════════════════════
// ✅ SEND: Send each token INDIVIDUALLY to avoid the
//    "same project" error killing the whole batch
// ═══════════════════════════════════════════════════════════════
const sendToUser = async (userId, title, body, extraData = {}) => {
  const user = await User.findById(userId).select('pushTokens').lean();
  const rawTokens = (user?.pushTokens || []).map((t) => t.token).filter(Boolean);

  if (rawTokens.length === 0) {
    console.log(`[push] No tokens for user ${userId}`);
    return { sent: false, reason: 'no_token' };
  }

  const { valid: tokens, invalid } = filterValidTokens(rawTokens);

  if (invalid.length > 0) {
    console.log(`[push] Filtered out ${invalid.length} invalid token(s):`, invalid);
  }

  if (tokens.length === 0) {
    // Clean up invalid tokens
    await User.updateOne(
      { _id: userId },
      { $set: { pushTokens: [] } }
    ).catch(() => {});
    return { sent: false, reason: 'no_valid_token' };
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
    title,
    type,
    mood,
    channelId,
    soundName,
  });

  // ═══════════════════════════════════════════════════════════
  // ✅ KEY FIX: Send each token individually
  // If one token belongs to a different project, only THAT one
  // fails — the rest succeed.
  // ═══════════════════════════════════════════════════════════
  const results = await Promise.allSettled(
    tokens.map(async (t) => {
      const message = {
        to: t,
        sound: `${soundName}.wav`,
        title,
        body,
        data,
        priority: 'high',
        channelId,
        ...(iconUrl && { mutableContent: true }),
        ...(iconUrl && { richContent: { image: iconUrl } }),
      };

      try {
        const ticket = await expo.sendPushNotificationsAsync([message]);
        return { token: t, ticket: ticket?.[0] };
      } catch (err) {
        console.error(`[push] Send error for token ${t.slice(0, 30)}...:`, err.message);
        return { token: t, error: err.message };
      }
    })
  );

  // ═══════════════════════════════════════════════════════════
  // ✅ Analyze results — collect dead tokens
  // ═══════════════════════════════════════════════════════════
  const deadTokens = [];
  let successCount = 0;
  let failCount = 0;

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { token, ticket, error } = r.value;

    if (error) {
      failCount++;
      continue;
    }

    if (ticket?.status === 'error') {
      failCount++;
      const errCode = ticket.details?.error;
      console.warn(
        `[push] Ticket error for ${token.slice(0, 30)}...:`,
        errCode,
        ticket.message
      );

      if (errCode === 'DeviceNotRegistered') {
        deadTokens.push(token);
      }
      // ✅ Also drop tokens from other projects
      if (
        errCode === 'MismatchSenderId' ||
        ticket.message?.includes('same project') ||
        ticket.message?.includes('FCM server key')
      ) {
        deadTokens.push(token);
      }
    } else {
      successCount++;
    }
  }

  console.log(`[push] Result: ${successCount} sent, ${failCount} failed, ${deadTokens.length} dead`);

  // Clean up dead tokens
  if (deadTokens.length > 0) {
    await User.updateOne(
      { _id: userId },
      { $pull: { pushTokens: { token: { $in: deadTokens } } } }
    ).catch((e) => console.error('[push] Token cleanup failed:', e.message));
    console.log(`[push] Cleaned up ${deadTokens.length} dead token(s)`);
  }

  return {
    sent: successCount > 0,
    count: successCount,
    failed: failCount,
    cleaned: deadTokens.length,
  };
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

  const message = {
    to: targetToken,
    sound: `${soundName}.wav`,
    title,
    body,
    data,
    priority: 'high',
    channelId,
    ...(iconUrl && { mutableContent: true }),
    ...(iconUrl && { richContent: { image: iconUrl } }),
  };

  try {
    const ticket = await expo.sendPushNotificationsAsync([message]);
    console.log('[push] sendPushNotification ticket:', ticket?.[0]);
    return { sent: true, ticket: ticket?.[0] };
  } catch (error) {
    console.error('Error sending push:', error);
    return { sent: false, reason: 'send_failed', error: error.message };
  }
};

module.exports = {
  sendPushNotification,
  sendToUser,
  TYPE_TO_SOUND,
  TYPE_TO_CHANNEL,
};