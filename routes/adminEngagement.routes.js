// routes/adminEngagement.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const DailyDrop = require('../models/DailyDrop');
const DropReaction = require('../models/DropReaction');
const Reward = require('../models/Reward');
const RewardRedemption = require('../models/RewardRedemption');
const EngagementProfile = require('../models/EngagementProfile');
const EngagementEvent = require('../models/EngagementEvent');
const UserBadge = require('../models/UserBadge');
const PointsLedger = require('../models/PointsLedger');
const PushLog = require('../models/PushLog');
const User = require('../models/User');

const pushGateway = require('../services/engagement/pushGateway');

const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (user && user.role === 'admin') next();
    else res.status(403).json({ message: 'Access denied. Admins only.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
function timeAgo(date) {
  if (!date) return 'never';
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

router.use(auth, isAdmin);

// ═══════════════════════════════════════════════
// TEST PUSH — single / by role / all
// ═══════════════════════════════════════════════
router.post('/test-push', async (req, res) => {
  try {
    const { audience = 'single', userId, copyKey, title, body } = req.body || {};

    let targetUsers = [];

    if (audience === 'single') {
      if (!userId) return res.status(400).json({ message: 'userId required' });
      const user = await User.findById(userId).select('_id name email pushTokens').lean();
      if (!user) return res.status(404).json({ message: 'user not found' });
      targetUsers = [user];
    } else if (audience === 'all') {
      targetUsers = await User.find({ 'pushTokens.0': { $exists: true } })
        .select('_id name email pushTokens').limit(10000).lean();
    } else if (['student', 'brand', 'traveler', 'employee', 'admin'].includes(audience)) {
      targetUsers = await User.find({ role: audience, 'pushTokens.0': { $exists: true } })
        .select('_id name email pushTokens').limit(10000).lean();
    } else {
      return res.status(400).json({ message: `unknown audience: ${audience}` });
    }

    if (targetUsers.length === 0) {
      return res.json({
        ok: true, sent: 0, total: 0, failed: 0, skipped: 0,
        reason: 'no users with push tokens in this audience',
      });
    }

    // Resolve copy. Mood (= emoji, picture, sound) ALWAYS comes from the copy
    // key, also when the admin types a custom title/body, so the phone shows
    // exactly what the admin preview shows.
    const COPY_LABELS = {
      daily_drop: 'daily drop', streak_warning: 'streak at risk', streak_broken: 'streak broke',
      freeze_used: 'freeze saved', badge_earned: 'badge earned', tier_unlocked: 'level up',
      referral_joined: 'referral joined', win_back_soft: 'we kept your seat warm',
      welcome_back: 'welcome back', exclusive_offer: 'exclusive offer', win_back_ghost: 'we miss you',
      new_offer: 'new offer', new_for_you: 'new for you', app_update: 'app update',
      freeze_reset: 'freeze reset', transactional: 'tdc',
    };
    const key = copyKey || 'daily_drop';
    let resolvedTitle = title || COPY_LABELS[key] || 'tdc';
    let resolvedBody = body;
    let resolvedMood = 'sorted';
    try {
      const copy = require('../services/engagement/copy');
      const filled = copy.fill(key, {});
      resolvedMood = filled.mood || 'sorted';
      if (!resolvedBody) resolvedBody = filled.body || 'new notification';
    } catch {
      if (!resolvedBody) resolvedBody = 'new notification';
    }

    // Send
    const results = { sent: 0, failed: 0, skipped: 0, logIds: [], errors: [], reasons: {}, legacyDevices: 0, details: [] };

    for (const u of targetUsers) {
      try {
        const result = await pushGateway.sendPushToUser(u._id, {
          type: key,
          title: resolvedTitle,
          body: resolvedBody,
          mood: resolvedMood,
          data: { route: 'Home', params: {}, audience },
        });
        if (result?.sent) {
          results.sent++;
          results.legacyDevices += result.legacyDevices || 0;
          if (result.logId) results.logIds.push(result.logId);
        } else {
          results.skipped++;
          const r = result?.reason || 'unknown';
          results.reasons[r] = (results.reasons[r] || 0) + 1;
          const tokenCount = (u.pushTokens || []).length;
          console.warn(`[test-push] ✗ not sent → ${u.email || u._id} | reason=${r} | tokens=${tokenCount}${result?.error ? ` | ${result.error}` : ''}`);
          if (results.details.length < 20) {
            results.details.push({ email: u.email || String(u._id), reason: r, tokens: tokenCount, error: result?.error || null });
          }
        }
      } catch (e) {
        results.failed++;
        if (results.errors.length < 5) results.errors.push(`${u._id}: ${e.message}`);
      }
    }

    console.log(`[test-push] ${audience} sent=${results.sent} skip=${results.skipped} fail=${results.failed}`, results.reasons);

    // Plain-English reason so the admin panel can show why a user was skipped
    const REASON_TEXT = {
      no_token: 'user has no push token (not logged in on the new app build, or notifications denied)',
      no_valid_token: 'user only has old/invalid tokens. ask them to open the app and log in again',
      DeviceNotRegistered: 'app was uninstalled or reinstalled. token removed, user must open the app again',
      InvalidCredentials: 'FCM V1 key missing in EAS. run: eas credentials',
      MismatchSenderId: 'FCM key is from a different Firebase project than google-services.json',
      no_profile: 'user has no engagement profile',
      pref_off: 'user turned this notification type off',
      send_failed: 'Expo rejected the request (see Railway log line [test-push] ✗ for the exact error)',
      SEND_FAILED: 'Expo rejected the request (see Railway log line [test-push] ✗ for the exact error)',
      UNAUTHORIZED: 'Expo needs an access token: set EXPO_ACCESS_TOKEN in Railway (Enhanced Push Security is on)',
      PUSH_TOO_MANY_EXPERIENCE_IDS: 'user has tokens from Expo Go and the APK. Retried per app',
      expo_rejected: 'Expo rejected every device for this user',
      exception: 'server error while sending (see Railway log)',
    };
    const topReason = Object.keys(results.reasons).sort((a, b) => results.reasons[b] - results.reasons[a])[0];

    res.json({
      ok: results.sent > 0 || targetUsers.length === 0,
      audience,
      sent: results.sent, failed: results.failed,
      skipped: results.skipped, total: targetUsers.length,
      reasons: results.reasons,
      message: results.sent === 0 && topReason ? (REASON_TEXT[topReason] || topReason) : undefined,
      legacyDevices: results.legacyDevices,
      details: results.details,
      note: results.legacyDevices
        ? `${results.legacyDevices} device(s) still run an old app build: they get the general sound. Uninstall + install the new build.`
        : undefined,
      logIds: results.logIds.slice(0, 20),
      errors: results.errors,
    });
  } catch (err) {
    console.error('[test-push]', err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// BROADCAST — App Update
// ═══════════════════════════════════════════════
router.post('/broadcast/app-update', async (req, res) => {
  try {
    const { title, body, version, forceUpdate } = req.body;
    const result = await pushGateway.broadcastToAll({
      copyKey: 'app_update',
      title: title || 'tdc just got better',
      body: body || 'new features live. update now.',
      mood: 'sorted',
      data: {
        route: 'Home',
        params: { version, forceUpdate },
        screen: 'AppUpdate',
        version,
      },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// BROADCAST — Freeze reset (all students)
// ═══════════════════════════════════════════════
router.post('/broadcast/freeze-reset', async (req, res) => {
  try {
    const result = await pushGateway.broadcastToRole('student', {
      copyKey: 'freeze_reset',
      mood: 'sorted',
      data: { route: 'Home', params: {} },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// BROADCAST — Custom
// ═══════════════════════════════════════════════
router.post('/broadcast/custom', async (req, res) => {
  try {
    const { audience = 'all', title, body, data = {} } = req.body;
    if (!title || !body) {
      return res.status(400).json({ message: 'title and body required' });
    }

    let result;
    if (audience === 'all') {
      result = await pushGateway.broadcastToAll({ title, body, mood: 'sorted', data });
    } else if (['student', 'brand', 'traveler', 'employee', 'admin'].includes(audience)) {
      result = await pushGateway.broadcastToRole(audience, { title, body, mood: 'sorted', data });
    } else {
      return res.status(400).json({ message: 'invalid audience' });
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// NUDGE — manual triggers for testing
// ═══════════════════════════════════════════════
router.post('/nudge/feature/:userId', async (req, res) => {
  try {
    const nudges = require('../services/engagement/nudges');
    const result = await nudges.sendFeatureNudge(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/nudge/win-back/:userId', async (req, res) => {
  try {
    const inactivity = require('../services/engagement/inactivity');
    const days = parseInt(req.body?.days) || 7;
    const result = await inactivity.sendWinBack(req.params.userId, days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// PUSH LOGS — activity feed
// ═══════════════════════════════════════════════
router.get('/push-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const filter = {};
    if (req.query.userId) filter.user = req.query.userId;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const items = await PushLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'name email role')
      .lean();

    res.json({
      items: items.map((l) => ({
        _id: l._id,
        user: l.user ? { _id: l.user._id, name: l.user.name, role: l.user.role } : null,
        userName: l.user?.name || 'unknown',
        type: l.type,
        title: l.title,
        body: l.body,
        mood: l.mood,
        status: l.status,
        receiptStatus: l.receiptStatus,
        sentAt: l.sentAt,
        deliveredAt: l.deliveredAt,
        openedAt: l.openedAt,
        createdAt: l.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// DROPS + METRICS + REWARDS (unchanged, from before)
// ═══════════════════════════════════════════════
router.get('/drops', async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = {};
    if (from && to) filter.dayKey = { $gte: from, $lte: to };
    const list = await DailyDrop.find(filter).sort({ dayKey: 1 }).lean();
    res.json(list);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Daily Drops go to everyone, so a campus-only confession can never be one
async function campusConfessionError(payload) {
  const ref = payload?.contentRef;
  const isConfessionDrop =
    ['confession', 'best_confession'].includes(payload?.type) || ref?.kind === 'confession';
  if (!isConfessionDrop || !ref?.id) return null;
  try {
    const Confession = require('../models/Confession');
    const c = await Confession.findById(ref.id).select('visibility').lean();
    if (c?.visibility === 'campus') {
      return 'This confession is campus-only. Pick a public confession for a Daily Drop.';
    }
  } catch (e) {}
  return null;
}

router.post('/drops', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.dayKey) return res.status(400).json({ message: 'dayKey required' });
    const campusErr = await campusConfessionError(payload);
    if (campusErr) return res.status(400).json({ message: campusErr });
    const existing = await DailyDrop.findOne({ dayKey: payload.dayKey });
    if (existing) {
      const updated = await DailyDrop.findOneAndUpdate({ dayKey: payload.dayKey }, { $set: payload }, { new: true });
      return res.json(updated);
    }
    const drop = await DailyDrop.create(payload);
    res.status(201).json(drop);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/drops/:dayKey', async (req, res) => {
  try {
    const campusErr = await campusConfessionError(req.body);
    if (campusErr) return res.status(400).json({ message: campusErr });
    const drop = await DailyDrop.findOneAndUpdate(
      { dayKey: req.params.dayKey },
      { $set: req.body },
      { new: true, upsert: true }
    );
    res.json(drop);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/drops/:dayKey/publish-now', async (req, res) => {
  try {
    const drop = await DailyDrop.findOneAndUpdate(
      { dayKey: req.params.dayKey },
      { $set: { status: 'live', publishedAt: new Date(), pushedAt: new Date() } },
      { new: true }
    );
    if (!drop) return res.status(404).json({ message: 'drop not found' });
    try {
      if (typeof pushGateway.sendDailyDropPush === 'function') {
        await pushGateway.sendDailyDropPush(drop);
      }
    } catch (e) { console.warn('[publish] push failed:', e.message); }
    res.json(drop);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/drops/:dayKey', async (req, res) => {
  try {
    await DailyDrop.deleteOne({ dayKey: req.params.dayKey });
    res.status(204).end();
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/drops/:dayKey/results', async (req, res) => {
  try {
    const drop = await DailyDrop.findOne({ dayKey: req.params.dayKey });
    if (!drop) return res.status(404).json({ message: 'drop not found' });
    const counts = {};
    for (const opt of drop.action?.options || []) counts[opt] = 0;
    const agg = await DropReaction.aggregate([
      { $match: { drop: drop._id } },
      { $group: { _id: '$choice', n: { $sum: 1 } } },
    ]);
    for (const row of agg) counts[row._id] = row.n;
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    res.json({ dayKey: drop.dayKey, counts, total });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/metrics', async (req, res) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks) || 8, 26);
    const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalProfiles, activeUsers, badgesEarned, pushSent, pushOpened,
      rewardsRedeemed, totalDrops, totalDropReactions, fullySortedCount,
      examModeActive, totalReferrals,
      weeklyUsers, missionAgg, levelAgg, topBadgesAgg, eventBreakdownAgg,
      pointsAgg, streakAgg,
    ] = await Promise.all([
      EngagementProfile.countDocuments({}),
      EngagementProfile.countDocuments({ 'stats.lastActiveAt': { $gte: thirtyDaysAgo } }),
      UserBadge.countDocuments({ earnedAt: { $gte: since } }),
      PushLog.countDocuments({ createdAt: { $gte: since } }),
      PushLog.countDocuments({ createdAt: { $gte: since }, openedAt: { $ne: null } }),
      RewardRedemption.countDocuments({ createdAt: { $gte: since } }),
      DailyDrop.countDocuments({ createdAt: { $gte: since } }),
      DropReaction.countDocuments({ createdAt: { $gte: since } }),
      EngagementProfile.countDocuments({ sortedCount: 8 }),
      EngagementProfile.countDocuments({ 'streak.examModeUntil': { $gte: new Date().toISOString().slice(0, 10) } }),
      User.countDocuments({ referralCount: { $gt: 0 } }),
      EngagementEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { week: { $isoWeek: '$createdAt' }, year: { $isoWeekYear: '$createdAt' } }, users: { $addToSet: '$user' } } },
        { $project: { _id: 1, users: { $size: '$users' } } },
        { $sort: { '_id.year': 1, '_id.week': 1 } },
      ]),
      EngagementProfile.aggregate([
        { $group: {
          _id: null,
          discounts: { $sum: { $cond: [{ $ne: ['$sorted.discounts', null] }, 1, 0] } },
          resume: { $sum: { $cond: [{ $ne: ['$sorted.resume', null] }, 1, 0] } },
          jobs: { $sum: { $cond: [{ $ne: ['$sorted.jobs', null] }, 1, 0] } },
          social: { $sum: { $cond: [{ $ne: ['$sorted.social', null] }, 1, 0] } },
          events: { $sum: { $cond: [{ $ne: ['$sorted.events', null] }, 1, 0] } },
          scholarship: { $sum: { $cond: [{ $ne: ['$sorted.scholarship', null] }, 1, 0] } },
          skillshare: { $sum: { $cond: [{ $ne: ['$sorted.skillshare', null] }, 1, 0] } },
          traveling: { $sum: { $cond: [{ $ne: ['$sorted.traveling', null] }, 1, 0] } },
        } },
      ]),
      EngagementProfile.aggregate([
        { $group: { _id: '$level.id', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      UserBadge.aggregate([
        { $match: { earnedAt: { $gte: since } } },
        { $group: { _id: '$badgeId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      EngagementEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$name', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      PointsLedger.aggregate([
        { $match: { createdAt: { $gte: since }, delta: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$delta' } } },
      ]),
      EngagementProfile.aggregate([
        { $group: { _id: null, avgStreak: { $avg: '$streak.count' }, longestStreak: { $max: '$streak.best' } } },
      ]),
    ]);

    const missionBreakdown = missionAgg[0]
      ? Object.fromEntries(Object.entries(missionAgg[0]).filter(([k]) => k !== '_id').map(([k, v]) => [k, v || 0]))
      : {};
    const levelBreakdown = {};
    levelAgg.forEach((row) => { levelBreakdown[row._id || 'member'] = row.count; });
    const topBadges = topBadgesAgg.map((row) => ({ badgeId: row._id, count: row.count }));
    const eventBreakdown = {};
    eventBreakdownAgg.forEach((row) => { eventBreakdown[row._id] = row.count; });
    const totalPointsAwarded = pointsAgg[0]?.total || 0;
    const streakStats = streakAgg[0] || { avgStreak: 0, longestStreak: 0 };

    res.json({
      totalProfiles, activeUsers, badgesEarned, pushSent, pushOpened,
      pushOpenRate: pushSent > 0 ? pushOpened / pushSent : 0,
      rewardsRedeemed, totalDrops, totalDropReactions, totalPointsAwarded,
      fullySortedCount, examModeActive, totalReferrals,
      avgStreak: streakStats.avgStreak || 0,
      longestStreak: streakStats.longestStreak || 0,
      weeklyUsers, missionBreakdown, levelBreakdown, topBadges, eventBreakdown,
    });
  } catch (err) {
    console.error('[admin/metrics]', err);
    res.status(500).json({ message: err.message });
  }
});

router.get('/rewards', async (req, res) => {
  try {
    const rewards = await Reward.find({}).populate('brand', 'name brandName logo').sort({ costPoints: 1 }).lean();
    const withStats = await Promise.all(rewards.map(async (r) => {
      const redeemed = await RewardRedemption.countDocuments({ reward: r._id });
      return { ...r, redeemedCount: redeemed };
    }));
    res.json(withStats);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/rewards', async (req, res) => {
  try {
    const reward = await Reward.create(req.body);
    res.status(201).json(reward);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/rewards/:id', async (req, res) => {
  try {
    const reward = await Reward.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!reward) return res.status(404).json({ message: 'reward not found' });
    res.json(reward);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/rewards/:id', async (req, res) => {
  try {
    await Reward.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/points/adjust', async (req, res) => {
  try {
    const { userId, delta, note } = req.body || {};
    if (!userId || delta === undefined) return res.status(400).json({ message: 'userId and delta required' });
    const { award } = require('../services/engagement/points');
    const result = await award(userId, Number(delta), 'admin_adjust', 'admin', req.userId, `admin_adjust:${userId}:${Date.now()}`);
    res.json({ ...result, note: note || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/badges/award', async (req, res) => {
  try {
    const { userId, badgeId } = req.body;
    if (!userId || !badgeId) return res.status(400).json({ message: 'userId and badgeId required' });
    const { grant } = require('../services/engagement/badges');
    const ok = await grant(userId, badgeId);
    res.json({ awarded: ok });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/users/:userId/ledger', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const items = await PointsLedger.find({ user: req.params.userId }).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
// ═══════════════════════════════════════════════════════════
// GET /admin/engagement/profiles
// Returns every engagement profile with user details
// ═══════════════════════════════════════════════════════════
router.get('/profiles', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    const items = await EngagementProfile.find({})
      .populate('user', 'name email rollNo role university')
      .sort({ 'stats.lastActiveAt': -1 })
      .limit(limit)
      .lean();

    res.json({ items, total: items.length });
  } catch (err) {
    console.error('[admin/profiles]', err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /admin/engagement/nudge/streak/:userId
// Manual streak warning
// ═══════════════════════════════════════════════════════════
router.post('/nudge/streak/:userId', async (req, res) => {
  try {
    const profile = await EngagementProfile.findOne({ user: req.params.userId });
    if (!profile || profile.streak?.count < 2) {
      return res.status(400).json({ message: 'no at-risk streak' });
    }

    const result = await pushGateway.sendFromCopy(
      req.params.userId,
      'streak_warning',
      'streaks',
      { count: profile.streak.count },
      { route: 'Home', params: {} }
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /admin/engagement/drilldown
// Returns users behind any metric
// ?kind=event|mission|level|badge|week|metric
// ?key=<value>
// ?weeks=8
// ═══════════════════════════════════════════════════════════
router.get('/drilldown', async (req, res) => {
  try {
    const { kind, key } = req.query;
    const weeks = Math.min(parseInt(req.query.weeks) || 8, 26);
    const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let items = [];

    switch (kind) {
      // ─── EVENT: users who triggered this event ───
      case 'event': {
        const events = await EngagementEvent.find({
          name: key,
          createdAt: { $gte: since },
        })
          .sort({ createdAt: -1 })
          .limit(500)
          .populate('user', 'name email role rollNo')
          .lean();

        // Dedupe by user, but keep latest + count
        const byUser = new Map();
        for (const e of events) {
          const uid = String(e.user?._id || e.user);
          if (!uid) continue;
          const existing = byUser.get(uid);
          if (!existing) {
            byUser.set(uid, {
              _id: uid,
              name: e.user?.name || 'unknown',
              email: e.user?.email || '—',
              role: e.user?.role || '—',
              rollNo: e.user?.rollNo,
              when: e.createdAt,
              detail: `1× ${e.name}`,
              count: 1,
            });
          } else {
            existing.count += 1;
            existing.detail = `${existing.count}× ${e.name}`;
          }
        }
        items = Array.from(byUser.values()).sort(
          (a, b) => b.count - a.count
        );
        break;
      }

      // ─── MISSION: users who sorted this feature ───
      case 'mission': {
        const profiles = await EngagementProfile.find({
          [`sorted.${key}`]: { $ne: null },
        })
          .limit(500)
          .populate('user', 'name email role rollNo')
          .lean();

        items = profiles
          .filter((p) => p.user)
          .map((p) => ({
            _id: String(p.user._id),
            name: p.user.name,
            email: p.user.email,
            role: p.user.role,
            rollNo: p.user.rollNo,
            when: p.sorted?.[key],
            detail: `sorted ${key}`,
          }))
          .sort((a, b) => new Date(b.when) - new Date(a.when));
        break;
      }

      // ─── LEVEL: users in this level ───
      case 'level': {
        const profiles = await EngagementProfile.find({
          'level.id': key,
        })
          .limit(500)
          .populate('user', 'name email role rollNo')
          .lean();

        items = profiles
          .filter((p) => p.user)
          .map((p) => ({
            _id: String(p.user._id),
            name: p.user.name,
            email: p.user.email,
            role: p.user.role,
            rollNo: p.user.rollNo,
            when: p.level?.reachedAt,
            detail: `${p.points?.lifetime || 0} lifetime pts`,
          }))
          .sort((a, b) => new Date(b.when) - new Date(a.when));
        break;
      }

      // ─── BADGE: users who earned this badge ───
      case 'badge': {
        const badges = await UserBadge.find({
          badgeId: key,
          earnedAt: { $gte: since },
        })
          .sort({ earnedAt: -1 })
          .limit(500)
          .populate('user', 'name email role rollNo')
          .lean();

        items = badges
          .filter((b) => b.user)
          .map((b) => ({
            _id: String(b.user._id),
            name: b.user.name,
            email: b.user.email,
            role: b.user.role,
            rollNo: b.user.rollNo,
            when: b.earnedAt,
            detail: `earned ${key.replace(/_/g, ' ')}`,
          }));
        break;
      }

      // ─── WEEK: users active in that ISO week ───
      case 'week': {
        // key = "2026-W39"
        const [year, wStr] = String(key).split('-W');
        const weekNum = parseInt(wStr);
        const yearNum = parseInt(year);

        // Approximate range: start from ISO week's Monday
        const jan4 = new Date(Date.UTC(yearNum, 0, 4));
        const jan4DayNum = jan4.getUTCDay() || 7;
        const weekStart = new Date(jan4);
        weekStart.setUTCDate(jan4.getUTCDate() - jan4DayNum + 1 + (weekNum - 1) * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

        const events = await EngagementEvent.find({
          createdAt: { $gte: weekStart, $lt: weekEnd },
        })
          .limit(2000)
          .populate('user', 'name email role rollNo')
          .lean();

        const byUser = new Map();
        for (const e of events) {
          const uid = String(e.user?._id || e.user);
          if (!uid || !e.user) continue;
          const existing = byUser.get(uid);
          if (!existing) {
            byUser.set(uid, {
              _id: uid,
              name: e.user.name,
              email: e.user.email,
              role: e.user.role,
              rollNo: e.user.rollNo,
              when: e.createdAt,
              detail: '1 action',
              count: 1,
            });
          } else {
            existing.count += 1;
            existing.detail = `${existing.count} actions`;
          }
        }
        items = Array.from(byUser.values()).sort(
          (a, b) => b.count - a.count
        );
        break;
      }

      // ─── METRIC: general stats ───
      case 'metric': {
        switch (key) {
          case 'totalProfiles': {
            const profiles = await EngagementProfile.find({})
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = profiles
              .filter((p) => p.user)
              .map((p) => ({
                _id: String(p.user._id),
                name: p.user.name,
                email: p.user.email,
                role: p.user.role,
                rollNo: p.user.rollNo,
                when: p.createdAt,
                detail: `${p.sortedCount || 0}/8 sorted`,
              }));
            break;
          }

          case 'activeUsers': {
            const profiles = await EngagementProfile.find({
              'stats.lastActiveAt': { $gte: thirtyDaysAgo },
            })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = profiles
              .filter((p) => p.user)
              .map((p) => ({
                _id: String(p.user._id),
                name: p.user.name,
                email: p.user.email,
                role: p.user.role,
                rollNo: p.user.rollNo,
                when: p.stats?.lastActiveAt,
                detail: `last active ${timeAgo(p.stats?.lastActiveAt)}`,
              }))
              .sort((a, b) => new Date(b.when) - new Date(a.when));
            break;
          }

          case 'badgesEarned': {
            const badges = await UserBadge.find({ earnedAt: { $gte: since } })
              .sort({ earnedAt: -1 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = badges
              .filter((b) => b.user)
              .map((b) => ({
                _id: String(b.user._id),
                name: b.user.name,
                email: b.user.email,
                role: b.user.role,
                rollNo: b.user.rollNo,
                when: b.earnedAt,
                detail: b.badgeId.replace(/_/g, ' '),
              }));
            break;
          }

          case 'pushSent':
          case 'pushOpened': {
            const filter = { createdAt: { $gte: since } };
            if (key === 'pushOpened') filter.openedAt = { $ne: null };
            const logs = await PushLog.find(filter)
              .sort({ createdAt: -1 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = logs
              .filter((l) => l.user)
              .map((l) => ({
                _id: String(l.user._id),
                name: l.user.name,
                email: l.user.email,
                role: l.user.role,
                rollNo: l.user.rollNo,
                when: key === 'pushOpened' ? l.openedAt : l.sentAt,
                detail: `${l.type} · ${l.title || l.body?.slice(0, 40) || ''}`,
              }));
            break;
          }

          case 'rewardsRedeemed': {
            const redemptions = await RewardRedemption.find({
              createdAt: { $gte: since },
            })
              .sort({ createdAt: -1 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .populate('reward', 'title costPoints')
              .lean();
            items = redemptions
              .filter((r) => r.user)
              .map((r) => ({
                _id: String(r.user._id),
                name: r.user.name,
                email: r.user.email,
                role: r.user.role,
                rollNo: r.user.rollNo,
                when: r.createdAt,
                detail: `redeemed ${r.reward?.title || 'reward'} (${r.costPoints} pts)`,
              }));
            break;
          }

          case 'fullySortedCount': {
            const profiles = await EngagementProfile.find({ sortedCount: 8 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = profiles
              .filter((p) => p.user)
              .map((p) => ({
                _id: String(p.user._id),
                name: p.user.name,
                email: p.user.email,
                role: p.user.role,
                rollNo: p.user.rollNo,
                when: p.fullySortedAt,
                detail: 'all 8 sorted',
              }))
              .sort((a, b) => new Date(b.when) - new Date(a.when));
            break;
          }

          case 'streaks': {
            const profiles = await EngagementProfile.find({
              'streak.count': { $gt: 0 },
            })
              .sort({ 'streak.count': -1 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = profiles
              .filter((p) => p.user)
              .map((p) => ({
                _id: String(p.user._id),
                name: p.user.name,
                email: p.user.email,
                role: p.user.role,
                rollNo: p.user.rollNo,
                when: p.streak?.lastActionDay,
                detail: `streak ${p.streak.count}d · best ${p.streak.best}d`,
              }));
            break;
          }

          case 'examModeActive': {
            const today = new Date().toISOString().slice(0, 10);
            const profiles = await EngagementProfile.find({
              'streak.examModeUntil': { $gte: today },
            })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = profiles
              .filter((p) => p.user)
              .map((p) => ({
                _id: String(p.user._id),
                name: p.user.name,
                email: p.user.email,
                role: p.user.role,
                rollNo: p.user.rollNo,
                when: p.streak?.examModeUntil,
                detail: `exam until ${p.streak.examModeUntil}`,
              }));
            break;
          }

          case 'totalReferrals': {
            const users = await User.find({ referralCount: { $gt: 0 } })
              .sort({ referralCount: -1 })
              .limit(500)
              .select('name email role rollNo referralCount createdAt')
              .lean();
            items = users.map((u) => ({
              _id: String(u._id),
              name: u.name,
              email: u.email,
              role: u.role,
              rollNo: u.rollNo,
              when: u.createdAt,
              detail: `${u.referralCount} referrals`,
            }));
            break;
          }

          case 'totalDrops': {
            const drops = await DailyDrop.find({ createdAt: { $gte: since } })
              .sort({ createdAt: -1 })
              .limit(500)
              .lean();
            items = drops.map((d) => ({
              _id: String(d._id),
              name: d.title || 'untitled drop',
              email: d.dayKey,
              role: d.type,
              detail: `${d.action?.options?.length || 0} options`,
              when: d.createdAt,
            }));
            break;
          }

          case 'totalPointsAwarded': {
            const ledger = await PointsLedger.find({
              createdAt: { $gte: since },
              delta: { $gt: 0 },
            })
              .sort({ createdAt: -1 })
              .limit(500)
              .populate('user', 'name email role rollNo')
              .lean();
            items = ledger
              .filter((l) => l.user)
              .map((l) => ({
                _id: String(l.user._id),
                name: l.user.name,
                email: l.user.email,
                role: l.user.role,
                rollNo: l.user.rollNo,
                when: l.createdAt,
                detail: `+${l.delta} pts · ${l.reason?.replace(/_/g, ' ')}`,
              }));
            break;
          }

          default:
            items = [];
        }
        break;
      }

      default:
        items = [];
    }

    res.json({ kind, key, items, count: items.length });
  } catch (err) {
    console.error('[admin/drilldown]', err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// ADMIN — Rewards CRUD (upgrade of existing)
// ═══════════════════════════════════════════════

// GET /admin/engagement/rewards — with redeemed stats
router.get('/rewards', async (req, res) => {
  try {
    const rewards = await Reward.find({})
      .populate('brand', 'name brandName logo')
      .sort({ createdAt: -1 })
      .lean();

    const withStats = await Promise.all(
      rewards.map(async (r) => {
        const [redeemed, active, used, expired] = await Promise.all([
          RewardRedemption.countDocuments({ reward: r._id }),
          RewardRedemption.countDocuments({ reward: r._id, status: 'active' }),
          RewardRedemption.countDocuments({ reward: r._id, status: 'used' }),
          RewardRedemption.countDocuments({ reward: r._id, status: 'expired' }),
        ]);
        const stockLeft =
          typeof r.stock === 'number' ? Math.max(0, r.stock - redeemed) : null;
        return { ...r, stats: { redeemed, active, used, expired, stockLeft } };
      })
    );

    res.json(withStats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/engagement/rewards
router.post('/rewards', async (req, res) => {
  try {
    const reward = await Reward.create(req.body);
    res.status(201).json(reward);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /admin/engagement/rewards/:id
router.put('/rewards/:id', async (req, res) => {
  try {
    const reward = await Reward.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!reward) return res.status(404).json({ message: 'reward not found' });
    res.json(reward);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /admin/engagement/rewards/:id
router.delete('/rewards/:id', async (req, res) => {
  try {
    await Reward.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/engagement/rewards/:id/redemptions — who redeemed it
router.get('/rewards/:id/redemptions', async (req, res) => {
  try {
    const items = await RewardRedemption.find({ reward: req.params.id })
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('user', 'name email rollNo role')
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/engagement/redemptions/:id/cancel — refund points
router.post('/redemptions/:id/cancel', async (req, res) => {
  try {
    const redemption = await RewardRedemption.findById(req.params.id);
    if (!redemption) return res.status(404).json({ message: 'not found' });
    if (redemption.status !== 'active') {
      return res.status(400).json({ message: `cannot cancel a ${redemption.status} redemption` });
    }

    redemption.status = 'cancelled';
    redemption.cancelledAt = new Date();
    await redemption.save();

    const { award } = require('../services/engagement/points');
    await award(
      redemption.user,
      redemption.costPoints,
      'reward_refund',
      'admin',
      req.userId,
      `refund:${redemption._id}`
    );

    res.json({ ok: true, refunded: redemption.costPoints });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
module.exports = router;