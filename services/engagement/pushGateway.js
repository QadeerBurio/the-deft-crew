// services/engagement/pushGateway.js
const { Expo } = require('expo-server-sdk');
const EngagementProfile = require('../../models/EngagementProfile');
const User = require('../../models/User');
const PushLog = require('../../models/PushLog');
const cfg = require('../../config/engagement.config');
const { dayKey, weekKey, isQuietHour } = require('../../utils/karachiTime');
const copy = require('./copy');

const expo = new Expo();

const { iconUrlForMood, titleWithEmoji, resolveSoundKey, channelForToken } = require('../../utils/pushNotification');

// ── CORE SEND ──
async function send(userId, msg) {
  const {
    type, pref = null, title, body, mood = 'sorted', data = {},
    priority = 0, skipCaps = false,
  } = msg;

  try {
    // Admin/system pushes (skipCaps) don't need an engagement profile.
    // Many users never got one, which made test pushes silently skip them.
    const profile = (await EngagementProfile.findOne({ user: userId })) || (skipCaps ? {} : null);
    if (!profile) return { sent: false, reason: 'no_profile' };

    if (pref && profile.notifPrefs && profile.notifPrefs[pref] === false) {
      return { sent: false, reason: 'pref_off' };
    }

    if (!skipCaps && isQuietHour(new Date(), cfg.push)) {
      return { sent: false, reason: 'quiet_hours' };
    }

    const today = dayKey();
    const thisWeek = weekKey();

    if (!skipCaps && profile.push?.lastPushDay === today) {
      return { sent: false, reason: 'daily_cap' };
    }

    const weeklyCap = cfg.push.weeklyCap(cfg.STAGE);
    if (!skipCaps) {
      const sentThisWeek =
        profile.push?.weekKey === thisWeek ? profile.push.sentThisWeek || 0 : 0;
      if (sentThisWeek >= weeklyCap) return { sent: false, reason: 'weekly_cap' };
    }

    const user = await User.findById(userId).select('pushTokens').lean();
    const entries = (user?.pushTokens || []).filter((t) => t?.token);
    if (entries.length === 0) return { sent: false, reason: 'no_token' };

    // Same emoji image, emoji title and sound as the in-app banner
    const moodImage = iconUrlForMood(mood);
    const soundKey = resolveSoundKey(type, mood);
    const fullTitle = titleWithEmoji(title || 'tdc', mood);

    const messages = entries
      .filter((e) => Expo.isExpoPushToken(e.token))
      .map((e) => ({ e, channelId: channelForToken(e, soundKey) }))
      .map(({ e, channelId }) => ({
        to: e.token,
        title: fullTitle,
        body: body || '',
        sound: `${soundKey}.wav`,
        channelId,
        priority: 'high',
        ttl: 60 * 60 * 24,
        richContent: { image: moodImage },
        mutableContent: true,
        data: {
          v: 1,
          type,
          mood,
          iconUrl: moodImage,
          channelId,
          soundKey,
          ...data,
        },
      }));

    if (messages.length === 0) return { sent: false, reason: 'no_valid_token' };

    const log = await PushLog.create({
      user: userId, type, priority,
      title: title || '', body: body || '', mood,
      dayKey: today, weekKey: thisWeek, data,
      tokens: messages.map((m) => m.to),
      status: 'queued',
    });

    const ticketIds = [];
    const ticketErrors = [];
    try {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          if (ticket.status === 'error') {
            console.warn('[pushGateway] ticket error:', ticket.message);
            ticketErrors.push(ticket.details?.error || ticket.message || 'expo_error');
          } else if (ticket.id) {
            ticketIds.push(ticket.id);
          }
        }
      }
    } catch (err) {
      await PushLog.updateOne(
        { _id: log._id },
        { $set: { status: 'failed', receiptError: err.message } }
      );
      return { sent: false, reason: 'send_failed', error: err.message };
    }

    // Every device rejected it (dead token, missing FCM key...): report, don't count as sent
    if (ticketIds.length === 0) {
      const why = ticketErrors[0] || 'expo_rejected';
      await PushLog.updateOne(
        { _id: log._id },
        { $set: { status: 'failed', receiptError: why } }
      );
      if (ticketErrors.includes('DeviceNotRegistered')) {
        await User.updateOne(
          { _id: userId },
          { $pull: { pushTokens: { token: { $in: messages.map((m) => m.to) } } } }
        );
      }
      return { sent: false, reason: why };
    }

    await PushLog.updateOne(
      { _id: log._id },
      {
        $set: {
          status: 'sent',
          ticketId: ticketIds[0] || null,
          sentAt: new Date(),
        },
      }
    );

    const sentIncrement = skipCaps ? 0 : 1;
    await EngagementProfile.updateOne(
      { user: userId },
      {
        $set: {
          'push.lastPushDay': today,
          'push.lastPushAt': new Date(),
          'push.weekKey': thisWeek,
        },
        ...(sentIncrement ? { $inc: { 'push.sentThisWeek': sentIncrement } } : {}),
      }
    );

    return { sent: true, logId: log._id.toString(), tickets: ticketIds };
  } catch (err) {
    console.error('[pushGateway] fatal error:', err);
    return { sent: false, reason: 'exception', error: err.message };
  }
}

// ── COPY-BANK + USER-ID-AWARE VARIANT ──
async function sendFromCopy(userId, type, pref, vars, data) {
  const { body, mood } = copy.fill(type, vars, userId);
  return send(userId, { type, pref, body, mood, data });
}

// ── ADMIN / SYSTEM PUSH (bypass caps) ──
async function sendPushToUser(userId, payload) {
  const { title, body, data = {}, type = 'transactional', mood = 'sorted' } = payload;
  return send(userId, {
    type, title, body, mood, data, skipCaps: true,
  });
}

// ── DAILY DROP BROADCAST ──
async function sendDailyDropPush(drop) {
  if (!drop || !drop._id) return { sent: 0 };

  const profiles = await EngagementProfile.find({
    'notifPrefs.dailyDrop': { $ne: false },
  })
    .select('user')
    .limit(5000)
    .lean();

  let sent = 0;
  for (const p of profiles) {
    try {
      const result = await sendFromCopy(
        p.user,
        'daily_drop',
        'dailyDrop',
        {},
        {
          route: 'Home',
          params: { dayKey: drop.dayKey },
          dropId: drop._id.toString(),
        }
      );
      if (result.sent) sent++;
    } catch (e) {
      console.warn('[sendDailyDropPush] user failed:', p.user, e.message);
    }
  }

  return { sent, total: profiles.length };
}

// ── RECEIPTS ──
async function checkReceipts() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await PushLog.find({
      status: 'sent',
      receiptStatus: 'pending',
      ticketId: { $ne: null },
      sentAt: { $gte: cutoff },
    }).limit(500).lean();

    if (logs.length === 0) return { checked: 0 };

    const ticketIds = logs.map((l) => l.ticketId).filter(Boolean);
    if (ticketIds.length === 0) return { checked: 0 };

    const receipts = await expo.getPushNotificationReceiptsAsync(ticketIds);
    let ok = 0;
    let errCount = 0;
    const deadTokens = new Set();

    for (const log of logs) {
      const receipt = receipts[log.ticketId];
      if (!receipt) continue;

      if (receipt.status === 'ok') {
        ok++;
        await PushLog.updateOne(
          { _id: log._id },
          { $set: { receiptStatus: 'ok', deliveredAt: new Date() } }
        );
      } else if (receipt.status === 'error') {
        errCount++;
        await PushLog.updateOne(
          { _id: log._id },
          { $set: { receiptStatus: 'error', receiptError: receipt.message || 'unknown' } }
        );

        if (receipt.details?.error === 'DeviceNotRegistered') {
          for (const tok of log.tokens || []) deadTokens.add(tok);
        }
      }
    }

    if (deadTokens.size > 0) {
      const tokensArr = Array.from(deadTokens);
      await User.updateMany(
        { 'pushTokens.token': { $in: tokensArr } },
        { $pull: { pushTokens: { token: { $in: tokensArr } } } }
      );
    }

    return { checked: logs.length, ok, error: errCount };
  } catch (err) {
    console.error('[pushGateway] checkReceipts error:', err.message);
    return { checked: 0, error: err.message };
  }
}

async function markOpened(logId) {
  if (!logId) return false;
  try {
    await PushLog.updateOne({ _id: logId }, { $set: { openedAt: new Date() } });
    return true;
  } catch (err) {
    console.error('[pushGateway] markOpened error:', err.message);
    return false;
  }
}

// ── BROADCASTS ──
async function broadcastToAll({ copyKey, title, body, mood = 'sorted', data = {} }) {
  const users = await User.find({ 'pushTokens.0': { $exists: true } })
    .select('_id').limit(10000).lean();

  let sent = 0, failed = 0;

  for (const u of users) {
    try {
      let resolvedBody = body;
      let resolvedMood = mood;

      if (!resolvedBody && copyKey) {
        const filled = copy.fill(copyKey, {}, u._id.toString());
        resolvedBody = filled.body;
        resolvedMood = filled.mood || mood;
      }

      const result = await send(u._id, {
        type: copyKey || 'transactional',
        title,
        body: resolvedBody,
        mood: resolvedMood,
        data,
        skipCaps: true,
      });

      if (result?.sent) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  return { sent, failed, total: users.length };
}

async function broadcastToRole(role, { copyKey, title, body, mood = 'sorted', data = {} }) {
  const users = await User.find({
    role,
    'pushTokens.0': { $exists: true },
  }).select('_id').limit(10000).lean();

  let sent = 0, failed = 0;

  for (const u of users) {
    try {
      let resolvedBody = body;
      let resolvedMood = mood;

      if (!resolvedBody && copyKey) {
        const filled = copy.fill(copyKey, {}, u._id.toString());
        resolvedBody = filled.body;
        resolvedMood = filled.mood || mood;
      }

      const result = await send(u._id, {
        type: copyKey || 'transactional',
        title,
        body: resolvedBody,
        mood: resolvedMood,
        data,
        skipCaps: true,
      });

      if (result?.sent) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  return { sent, failed, total: users.length };
}

async function broadcastNewOffer(offer) {
  if (!offer || !offer._id) return { sent: 0 };

  const brand = await User.findById(offer.brand).select('name brandName').lean();
  const brandName = brand?.brandName || brand?.name || 'a brand';

  const students = await User.find({
    role: 'student',
    'pushTokens.0': { $exists: true },
  }).select('_id').limit(10000).lean();

  let sent = 0;
  for (const s of students) {
    try {
      const result = await sendFromCopy(
        s._id,
        'new_offer',
        'deals',
        { brand: brandName, discount: offer.discountPercentage || 0 },
        {
          route: 'OfferScreen',
          params: { offerId: offer._id.toString() },
          offerId: offer._id.toString(),
        }
      );
      if (result?.sent) sent++;
    } catch (e) {}
  }

  return { sent, total: students.length };
}

module.exports = {
  send,
  sendFromCopy,
  sendPushToUser,
  sendDailyDropPush,
  checkReceipts,
  markOpened,
  broadcastToAll,
  broadcastToRole,
  broadcastNewOffer,
};