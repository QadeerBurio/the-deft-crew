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
// two EAS projects: each project's batch is sent with its own access token
const { sendByProject, getReceipts, projectOfEntries } = require('./expoProjects');

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
// The images must be committed in public/dots/push. If the folder is missing
// on the server, skip the image instead of sending a broken (404) link.
// public/dots/push or uploads/dots/push (both are served at /assets/dots/push)
const PUSH_IMG_DIR = ['public', 'uploads']
  .map((base) => require('path').join(__dirname, '..', base, 'dots', 'push'))
  .find((dir) => require('fs').existsSync(dir));
const HAS_LOCAL_IMAGES = !!PUSH_IMG_DIR;
if (HAS_LOCAL_IMAGES) console.log('🖼️  [push] mood images from', PUSH_IMG_DIR);
if (!HAS_LOCAL_IMAGES && !process.env.PUSH_ICON_BASE) {
  console.warn('⚠️  [push] dots/push not found in public/ or uploads/: push images are OFF. Run: git add public && git commit && git push');
}

const iconUrlForMood = (mood) => {
  if (!HAS_LOCAL_IMAGES && !process.env.PUSH_ICON_BASE) return null;
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

// Feature decides the sound (new offer = deal sound, message = message sound...),
// mood sound only for generic/unknown types. Same rule in the app + admin.
const { featureMood, featureSound, FEATURES } = require('./notificationFeatures');
const resolveSoundKey = (type, mood) =>
  FEATURES[type] ? featureSound(type, mood) : MOOD_SOUND[mood] || TYPE_SOUND[type] || 'tdc_push_default';
const channelForSound = (soundKey) => `snd_${soundKey}`;

// The 21 sounds the app creates a channel for (app/src/utils/pushNotifications.js
// SOUND_CHANNELS + app.json sounds). Anything else would land on a channel the phone
// doesn't have, so it falls back to the default sound.
const APP_SOUND_KEYS = new Set([
  'tdc_mood_sorted', 'tdc_mood_excited', 'tdc_mood_panic', 'tdc_mood_broke', 'tdc_mood_sleepy',
  'tdc_mood_shook', 'tdc_mood_sus', 'tdc_mood_cheeky', 'tdc_mood_rs',
  'tdc_push_default', 'tdc_push_deal', 'tdc_push_message', 'tdc_push_internship',
  'tdc_push_reminder', 'tdc_push_points', 'tdc_push_streak', 'tdc_push_confession',
  'tdc_push_event', 'tdc_push_level_up', 'tdc_like', 'tdc_nope',
]);
const safeSoundKey = (key) => (APP_SOUND_KEYS.has(key) ? key : 'tdc_push_default');

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
// snd_v2 = fresh "tdc2_<sound>" channels (new build). Android locks a
// channel's sound forever once created, so new IDs guarantee correct sounds.
const channelForToken = (entry, soundKey) => {
  if (entry?.channels === 'snd_v2') return `tdc2_${soundKey}`;
  if (entry?.channels === 'snd_v1') return channelForSound(soundKey);
  return LEGACY_CHANNEL_FOR_SOUND[soundKey] || 'engagement';
};

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

// ═══════════════════════════════════════════════════════════════
// SAFE SEND (utils/expoProjects.js): phones come from two EAS projects. Each project's
// batch goes with its own access token; mixed batches are split by project. One ticket
// per message, in order. Projects learned from Expo are stored on the token entry.
// ═══════════════════════════════════════════════════════════════

// store what Expo told us, so the next send knows the project (never throws)
function rememberProjects(learned) {
  const entries = Object.entries(learned || {});
  if (!entries.length) return;
  // inside a promise: nothing here can break the send that just happened
  Promise.resolve()
    .then(() => Promise.all(entries.map(([token, projectId]) =>
      User.updateMany({ 'pushTokens.token': token }, { $set: { 'pushTokens.$.projectId': projectId } })
    )))
    .then(() => console.log(`[push] learned the project of ${entries.length} device(s)`))
    .catch((e) => console.warn('[push] could not store learned projects:', e.message));
}

// (client is ignored: kept so older callers keep working)
async function sendAllSafe(client, messages, projectOf = {}) {
  const { tickets, learned } = await sendByProject(messages, projectOf);
  rememberProjects(learned);
  return tickets;
}

// Expo ticket / receipt error codes → what it means, in words (Railway log)
const PUSH_ERROR_REASONS = {
  DeviceNotRegistered: 'the app was uninstalled or the token is dead → token removed',
  InvalidCredentials: 'no FCM V1 key for this EAS project (config: eas credentials → Android → FCM V1)',
  MismatchSenderId: 'google-services.json is from another Firebase project than the FCM key in EAS (config)',
  MessageTooBig: 'payload over 4 KB → shorten title / body / data',
  MessageRateExceeded: 'too many pushes to this device right now → skipped, try later',
  PUSH_TOO_MANY_EXPERIENCE_IDS: 'tokens from several Expo projects in one request → sent per project',
  UNAUTHORIZED: "Expo refused the access token for this phone's EAS project (config: EXPO_ACCESS_TOKEN_<first 8 of the project id> or EXPO_ACCESS_TOKEN from the account that owns it)",
  SEND_FAILED: 'Expo did not accept the request (network or Expo outage)',
};
const describePushError = (code, message) => PUSH_ERROR_REASONS[code] || message || code || 'unknown error';
const shortToken = (t) => String(t || '').replace(/^ExponentPushToken\[/, '').replace(/\]$/, '').slice(0, 10) + '…';

// One readable line per failed ticket / receipt, then remove ONLY the dead tokens.
// tickets[i] belongs to messages[i]. Never throws.
async function handleTickets(messages, tickets, userId = null, tag = '[push]') {
  const dead = new Set();
  const ok = [];
  tickets.forEach((ticket, i) => {
    const token = messages[i]?.to;
    if (ticket?.status === 'ok') {
      // the project travels with the ticket: its receipt is asked with that project's token
      if (ticket.id) ok.push({ id: ticket.id, token, projectId: ticket.projectId });
      return;
    }
    const code = ticket?.details?.error || 'SEND_FAILED';
    console.warn(`${tag} ✗ not sent → user ${userId || '?'} device ${shortToken(token)} | ${code}: ${describePushError(code, ticket?.message)}`);
    if (code === 'DeviceNotRegistered' && token) dead.add(token);
  });
  await removeDeadTokens([...dead], userId, tag);
  // receipts arrive a bit later (delivery by FCM / APNs)
  if (ok.length) {
    const timer = setTimeout(() => {
      checkReceiptsFor(ok, userId, tag).catch((e) => console.warn(`${tag} receipt check error:`, e.message));
    }, 15000);
    if (timer.unref) timer.unref();
  }
  return { ok: ok.length, failed: tickets.length - ok.length, dead: dead.size };
}

async function checkReceiptsFor(okPairs, userId, tag = '[push]') {
  const dead = new Set();
  let receipts = {};
  try {
    // receipts from both projects: each ticket asked with its own project's token
    receipts = await getReceipts(
      okPairs.map((p) => p.id),
      Object.fromEntries(okPairs.map((p) => [p.id, p.projectId]))
    );
  } catch (err) {
    console.warn(`${tag} receipts not available:`, err.message);
    return;
  }
  for (const [id, receipt] of Object.entries(receipts)) {
    if (receipt?.status !== 'error') continue;
    const pair = okPairs.find((p) => p.id === id);
    const code = receipt.details?.error || 'SEND_FAILED';
    console.warn(`${tag} ✗ not delivered → user ${userId || '?'} device ${shortToken(pair?.token)} | ${code}: ${describePushError(code, receipt.message)}`);
    if (code === 'DeviceNotRegistered' && pair?.token) dead.add(pair.token);
  }
  await removeDeadTokens([...dead], userId, tag);
}

// remove exactly these tokens (from this user if known, else from whoever has them)
async function removeDeadTokens(tokens, userId, tag = '[push]') {
  if (!tokens.length) return;
  try {
    const filter = userId ? { _id: userId } : { 'pushTokens.token': { $in: tokens } };
    await User.updateMany(filter, { $pull: { pushTokens: { token: { $in: tokens } } } });
    console.log(`${tag} removed ${tokens.length} dead token(s)`);
  } catch (err) {
    console.warn(`${tag} dead token cleanup failed:`, err.message);
  }
}

async function sendMessages(messages, userIdForCleanup = null, projectOf = {}) {
  // each EAS project with its own access token; projects learned here are stored
  const tickets = await sendAllSafe(null, messages, projectOf);
  await handleTickets(messages, tickets, userIdForCleanup, '[push]');
  return tickets.map((ticket, i) => ({ ticket, token: messages[i]?.to }));
}

function buildData(type, extraData) {
  const given = VALID_MOODS.has(extraData.mood) || extraData.mood === 'rs' ? extraData.mood : null;
  const mood = featureMood(type, given);
  const iconUrl = extraData.iconUrl || iconUrlForMood(mood);
  // a caller's soundKey is used only if the app has a channel for it
  const soundKey = safeSoundKey(extraData.soundKey || resolveSoundKey(type, mood));
  // current builds (snd_v2) have the tdc2_<sound> channels; snd_<sound> ones are deleted
  const channelId = channelForToken({ channels: 'snd_v2' }, soundKey);
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
// The "social" switch in the app (likes, comments, mentions). Other types (messages,
// connection requests, offers on your listing) are direct and always sent.
const SOCIAL_PREF_TYPES = new Set(['like', 'comment', 'reply', 'mention']);
async function socialPushOff(userId, type) {
  if (!SOCIAL_PREF_TYPES.has(type)) return false;
  try {
    const EngagementProfile = require('../models/EngagementProfile');
    const p = await EngagementProfile.findOne({ user: userId }).select('notifPrefs').lean();
    return p?.notifPrefs?.social === false;
  } catch {
    return false;
  }
}

const sendToUser = async (userId, title, body, extraData = {}) => {
  try {
    if (await socialPushOff(userId, extraData.type || 'System')) {
      return { sent: false, reason: 'pref_off' };
    }
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
    const channelId = channelForToken({ channels: 'snd_v2' }, soundKey);

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
    const pairs = await sendMessages(messages, userId, projectOfEntries(entries));
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

  // the stored project of this token, if the app sent one
  const owner = await User.findOne({ 'pushTokens.token': targetToken }, { 'pushTokens.$': 1 }).lean().catch(() => null);
  const pairs = await sendMessages([message], null, projectOfEntries(owner?.pushTokens));
  const ok = pairs.some((p) => p.ticket.status === 'ok');
  return ok ? { sent: true } : { sent: false, reason: 'send_failed' };
};

module.exports = {
  sendAllSafe,
  handleTickets,
  describePushError,
  removeDeadTokens,
  APP_SOUND_KEYS,
  safeSoundKey,
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
  featureMood,
  TYPE_SOUND,
  resolveChannel,
  resolveSound,
  TYPE_TO_SOUND,
  TYPE_TO_CHANNEL,
};