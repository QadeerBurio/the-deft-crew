// services/engagement/pushGateway.js
const { Expo } = require('expo-server-sdk');
const EngagementProfile = require('../../models/EngagementProfile');
const User = require('../../models/User');
const PushLog = require('../../models/PushLog');
const cfg = require('../../config/engagement.config');
const { dayKey, weekKey, isQuietHour } = require('../../utils/karachiTime');
const copy = require('./copy');

// each EAS project is sent with its own access token (utils/expoProjects.js)
const { getReceipts, projectOfEntries } = require('../../utils/expoProjects');

const { iconUrlForMood, titleWithEmoji, resolveSoundKey, channelForToken, sendAllSafe, featureMood, handleTickets, safeSoundKey, describePushError } = require('../../utils/pushNotification');

// ── CORE SEND ──
async function send(userId, msg) {
  const {
    type, pref = null, title, body, data = {},
    priority = 0, skipCaps = false,
    // essential: a reminder the user asked for (streak about to expire / just broke). It skips the
    // daily and weekly marketing caps and does not use them up, but keeps the pref and quiet hours.
    essential = false,
    // N-2: the sender's class for the push budget (personal / relevant / broadcast); default from the type
    budgetClass = null,
  } = msg;
  // Emoji / dot / sound follow the feature (new offer = 🤑 + deal sound)
  const mood = featureMood(type, msg.mood);

  try {
    // Admin/system pushes (skipCaps) don't need an engagement profile.
    // Many users never got one, which made test pushes silently skip them.
    let profile = (await EngagementProfile.findOne({ user: userId })) || (skipCaps ? {} : null);
    if (!profile) {
      // No engagement profile (accounts from before profiles were made at signup): make the default one now, the
      // same as signup does (engine.ensureProfile), and go on. Caps, quiet hours and opt-outs then apply as usual.
      // Never for an account that doesn't exist. (required here: engine.js requires this file)
      if (!(await User.exists({ _id: userId }))) return { sent: false, reason: 'no_user' };
      profile = await require('./engine').ensureProfile(userId);
      if (!profile) return { sent: false, reason: 'no_profile' };
    }

    if (pref && profile.notifPrefs && profile.notifPrefs[pref] === false) {
      return { sent: false, reason: 'pref_off' };
    }

    // N-2 (pushBudgetV1 on for this student): the one budget across senders replaces this gateway's quiet hours
    // and daily / weekly caps (checked below, once the push can actually be sent). Off: exactly as before.
    // N-5 (notifSettingsV2): the student's mode and digest are checked at the same point; only the budget replaces
    // this gateway's own quiet hours and caps
    const budget = require('../pushBudget');
    let budgetUser = null;
    let budgetCaps = false;
    if (!skipCaps && budget.configured()) {
      const u = await User.findById(userId).select('role').lean();
      if (u && budget.onFor({ _id: userId, role: u.role })) {
        budgetUser = { _id: userId, role: u.role };
        budgetCaps = budget.budgetOn(budgetUser);
      }
    }

    if (!budgetCaps && !skipCaps && isQuietHour(new Date(), cfg.push)) {
      return { sent: false, reason: 'quiet_hours' };
    }

    const today = dayKey();
    const thisWeek = weekKey();

    if (!budgetCaps && !skipCaps && !essential && profile.push?.lastPushDay === today) {
      return { sent: false, reason: 'daily_cap' };
    }

    const weeklyCap = cfg.push.weeklyCap(cfg.STAGE);
    if (!budgetCaps && !skipCaps && !essential) {
      const sentThisWeek =
        profile.push?.weekKey === thisWeek ? profile.push.sentThisWeek || 0 : 0;
      if (sentThisWeek >= weeklyCap) return { sent: false, reason: 'weekly_cap' };
    }

    const user = await User.findById(userId).select('pushTokens role').lean();
    // N-6 (pushOpenTracking): this row's id travels in the push so the tap can be recorded
    const tracking = require('../pushTracking');
    const trackedId = tracking.forUser({ _id: userId, role: user?.role }) ? new (require('mongoose').Types.ObjectId)() : null;
    const seen = new Set();
    const entries = (user?.pushTokens || []).filter((t) => {
      if (!t?.token || seen.has(t.token)) return false; // one push per device
      seen.add(t.token);
      return true;
    });
    if (entries.length === 0) return { sent: false, reason: 'no_token' };

    // Same emoji image, emoji title and sound as the in-app banner
    const moodImage = iconUrlForMood(mood);
    const soundKey = safeSoundKey(resolveSoundKey(type, mood));
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
        ...(moodImage ? { richContent: { image: moodImage }, mutableContent: true } : {}),
        data: {
          v: 1,
          type,
          mood,
          iconUrl: moodImage || null,
          channelId,
          soundKey,
          ...data,
          ...(trackedId ? { pushLogId: String(trackedId) } : {}),
        },
      }));

    if (messages.length === 0) return { sent: false, reason: 'no_valid_token' };

    if (budgetUser) {
      const b = await budget.allow(budgetUser, budgetClass || budget.classify(type));
      if (!b.ok) return { sent: false, reason: b.reason, budgetClass: b.cls };
    }

    const log = await PushLog.create({
      ...(trackedId ? { _id: trackedId, tracked: true, sender: 'gateway' } : {}),
      user: userId, type, priority,
      title: title || '', body: body || '', mood,
      dayKey: today, weekKey: thisWeek, data,
      tokens: messages.map((m) => m.to),
      status: 'queued',
    });

    const ticketIds = [];
    const ticketErrors = [];
    const ticketMessages = [];
    try {
      {
        const tickets = await sendAllSafe(null, messages, projectOfEntries(entries));
        for (const ticket of tickets) {
          if (ticket.status === 'error') {
            ticketErrors.push(ticket.details?.error || 'SEND_FAILED');
            ticketMessages.push(describePushError(ticket.details?.error, ticket.message));
          } else if (ticket.id) {
            ticketIds.push(ticket.id);
          }
        }
        // readable log per failed device; removes ONLY the dead tokens; receipts per device
        await handleTickets(messages, tickets, userId, '[pushGateway]');
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
        { $set: { status: 'failed', receiptError: `${why}: ${describePushError(why)}` } }
      );
      // dead tokens were removed one by one in handleTickets (healthy ones stay)
      return { sent: false, reason: why, error: ticketMessages[0] || why };
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

    const sentIncrement = skipCaps || essential ? 0 : 1;
    await EngagementProfile.updateOne(
      { user: userId },
      essential
        ? { $set: { 'push.lastPushAt': new Date() } } // reminders leave the caps for other pushes
        : {
            $set: {
              'push.lastPushDay': today,
              'push.lastPushAt': new Date(),
              'push.weekKey': thisWeek,
            },
            ...(sentIncrement ? { $inc: { 'push.sentThisWeek': sentIncrement } } : {}),
          }
    );

    // Phones on an old app build only have the old channels → generic sound
    const legacyDevices = messages.filter((m) => !String(m.channelId || '').startsWith('tdc2_')).length;
    return { sent: true, logId: log._id.toString(), tickets: ticketIds, legacyDevices };
  } catch (err) {
    console.error('[pushGateway] fatal error:', err);
    return { sent: false, reason: 'exception', error: err.message };
  }
}

// ── COPY-BANK + USER-ID-AWARE VARIANT ──
// opts.copyKey picks another copy bank for the line while the push keeps its type
async function sendFromCopy(userId, type, pref, vars, data, opts = {}) {
  // N-7 (pushCopyV2 on for this student): specific copy with real numbers only; nothing to say → no push
  if (require('../../config/featureFlags').isEnabled('pushCopyV2', { id: String(userId), role: 'student' })) {
    const v2 = copy.fillV2(opts.copyKey || type, vars, userId);
    if (!v2) return { sent: false, reason: 'no_specific_copy' };
    return send(userId, { type, pref, body: v2.body, mood: v2.mood, data, essential: !!opts.essential });
  }
  const { body, mood } = copy.fill(opts.copyKey || type, vars, userId);
  return send(userId, { type, pref, body, mood, data, essential: !!opts.essential });
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

  // Tap opens the drop's content (job, offer, event...) or Home for polls
  const { resolveTargetAsync } = require('./drops');
  const target = await resolveTargetAsync(drop.contentRef, drop.type).catch(() => null);

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
        { title: drop.title }, // N-7 (pushCopyV2): the drop names itself; today's variants have no {title}
        {
          route: target?.route || 'Home',
          params: { ...(target?.params || {}), dayKey: drop.dayKey },
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

    const receipts = await getReceipts(ticketIds);
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
          { $set: { receiptStatus: 'error', receiptError: `${receipt.details?.error || 'error'}: ${describePushError(receipt.details?.error, receipt.message)}` } }
        );

        // the log keeps one ticket for several devices: only remove when it's unambiguous.
        // (each device's receipt is also checked right after sending, in handleTickets)
        if (receipt.details?.error === 'DeviceNotRegistered' && (log.tokens || []).length === 1) {
          deadTokens.add(log.tokens[0]);
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

// the first tap only, and only by the push's own recipient (N-6)
async function markOpened(logId, userId = null) {
  if (!logId || !require('mongoose').Types.ObjectId.isValid(String(logId))) return false;
  try {
    const r = await PushLog.updateOne({ _id: logId, ...(userId ? { user: userId } : {}), openedAt: null }, { $set: { openedAt: new Date() } });
    return (r.matchedCount ?? r.n ?? 0) > 0;
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