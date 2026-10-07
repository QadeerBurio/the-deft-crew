// routes/engagement.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const EngagementProfile = require('../models/EngagementProfile');
const UserBadge = require('../models/UserBadge');
const Reward = require('../models/Reward');
const RewardRedemption = require('../models/RewardRedemption');
const PointsLedger = require('../models/PointsLedger');
const SavedItem = require('../models/SavedItem');
const User = require('../models/User');
const cfg = require('../config/engagement.config');
const missions = require('../services/engagement/missions');
const streakSvc = require('../services/engagement/streak');
const drops = require('../services/engagement/drops');
const { track } = require('../services/engagement');
const { dayKey, semesterKey } = require('../utils/karachiTime');
const CodeGenerator = require('../services/codeGenerator');
const mongoose = require('mongoose');   // 🆕
const { total: totalBadges } = require('../config/badges'); // ✅ FIXED

function requireAuth(req, res, next) {
  if (req.isGuest) return res.status(401).json({ message: 'Authentication required' });
  next();
}
// ============================================================
// BRAND REDEMPTION — verification + marking used
// Rule:
//   • If reward.brand is set  → only that brand can redeem
//   • If reward.brand is null → ANY brand can redeem (platform-wide)
// ============================================================

// Helper: ensure the caller is a brand
async function requireBrand(req, res, next) {
  if (req.isGuest) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  const user = await User.findById(req.userId).select('role').lean();
  if (!user || user.role !== 'brand') {
    return res.status(403).json({ message: 'Brand access required' });
  }
  next();
}

// Helper: can this brand redeem this reward?
// Returns { allowed: bool, reason?: string }
function canBrandRedeem(brandId, reward) {
  const rewardBrandId = reward?.brand?._id || reward?.brand;
  if (!rewardBrandId) {
    // platform-wide reward → any brand can redeem
    return { allowed: true };
  }
  if (String(rewardBrandId) === String(brandId)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'this code is not for your brand' };
}

// ────────────────────────────────────────────────────────────
// POST /api/engagement/brand/redemptions/lookup
// Brand staff enters a code → returns validity + details
// ────────────────────────────────────────────────────────────
router.post('/brand/redemptions/lookup', auth, requireBrand, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ valid: false, reason: 'code required' });
    }

    const normalized = String(code).trim().toUpperCase();

    const redemption = await RewardRedemption.findOne({ code: normalized })
      .populate('user', 'name email rollNo profileImage university')
      .populate({
        path: 'reward',
        select: 'title description costPoints kind brand validDays',
        populate: { path: 'brand', select: 'name brandName logo' },
      })
      .lean();

    if (!redemption) {
      return res.status(404).json({ valid: false, reason: 'code not found' });
    }

    // ✅ Enforce brand ownership rule
    const check = canBrandRedeem(req.userId, redemption.reward);
    if (!check.allowed) {
      return res.status(403).json({
        valid: false,
        reason: check.reason,
      });
    }

    const expired = new Date(redemption.expiresAt) < new Date();
    const usable = redemption.status === 'active' && !expired;

    // Figure out the brand display name
    const rewardBrandName =
      redemption.reward?.brand?.brandName ||
      redemption.reward?.brand?.name ||
      redemption.snapshot?.brand?.brandName ||
      null;

    res.json({
      valid: usable,
      reason: !usable ? (expired ? 'expired' : redemption.status) : null,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        status: redemption.status,
        costPoints: redemption.costPoints,
        createdAt: redemption.createdAt,
        expiresAt: redemption.expiresAt,
        usedAt: redemption.usedAt,
        user: redemption.user
          ? {
              name: redemption.user.name,
              email: redemption.user.email,
              rollNo: redemption.user.rollNo,
              image: redemption.user.profileImage,
            }
          : null,
        reward: {
          title: redemption.reward?.title || redemption.snapshot?.title,
          description:
            redemption.reward?.description || redemption.snapshot?.description,
          kind: redemption.reward?.kind || redemption.snapshot?.kind,
          brand: rewardBrandName, // null = platform-wide
        },
      },
    });
  } catch (err) {
    console.error('[brand/lookup]', err);
    res.status(500).json({ valid: false, reason: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/engagement/brand/redemptions/:id/use
// Brand marks a code as used
// ────────────────────────────────────────────────────────────
router.post('/brand/redemptions/:id/use', auth, requireBrand, async (req, res) => {
  try {
    const redemption = await RewardRedemption.findById(req.params.id).populate(
      'reward',
      'brand title kind'
    );

    if (!redemption) {
      return res.status(404).json({ message: 'redemption not found' });
    }

    // ✅ Enforce brand ownership rule
    const check = canBrandRedeem(req.userId, redemption.reward);
    if (!check.allowed) {
      return res.status(403).json({ message: check.reason });
    }

    if (redemption.status !== 'active') {
      return res.status(400).json({
        message: `already ${redemption.status}`,
        status: redemption.status,
      });
    }

    if (new Date(redemption.expiresAt) < new Date()) {
      redemption.status = 'expired';
      await redemption.save();
      return res
        .status(400)
        .json({ message: 'code expired', status: 'expired' });
    }

    redemption.status = 'used';
    redemption.usedAt = new Date();
    redemption.usedBy = req.userId; // ✅ audit trail
    await redemption.save();

    res.json({
      ok: true,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        status: redemption.status,
        usedAt: redemption.usedAt,
      },
    });
  } catch (err) {
    console.error('[brand/use]', err);
    res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/engagement/brand/redemptions/auto-expire
// Brand runs this (or cron) to expire past-due codes
// ────────────────────────────────────────────────────────────
router.post('/brand/redemptions/auto-expire', auth, requireBrand, async (req, res) => {
  try {
    // ✅ Only expire codes this brand owns OR this brand used
    const myRewards = await Reward.find({ brand: req.userId })
      .select('_id')
      .lean();
    const myRewardIds = myRewards.map((r) => r._id);

    const result = await RewardRedemption.updateMany(
      {
        $or: [
          { reward: { $in: myRewardIds } },
          { usedBy: req.userId },
        ],
        status: 'active',
        expiresAt: { $lt: new Date() },
      },
      { $set: { status: 'expired' } }
    );
    res.json({ ok: true, expired: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/engagement/brand/redemptions
// Brand sees:
//   • codes for THEIR rewards
//   • codes THIS brand marked as used
// ────────────────────────────────────────────────────────────
router.get('/brand/redemptions', auth, requireBrand, async (req, res) => {
  try {
    const myRewards = await Reward.find({ brand: req.userId })
      .select('_id title costPoints')
      .lean();
    const myRewardIds = myRewards.map((r) => r._id);

    const items = await RewardRedemption.find({
      $or: [
        { reward: { $in: myRewardIds } }, // codes for this brand's rewards
        { usedBy: req.userId },           // codes this brand used
      ],
    })
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('user', 'name email rollNo')
      .populate('reward', 'title costPoints brand')
      .lean();

    const enriched = items.map((r) => ({
      _id: r._id,
      code: r.code,
      status: r.status,
      costPoints: r.costPoints,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      usedAt: r.usedAt,
      user: r.user
        ? { name: r.user.name, email: r.user.email, rollNo: r.user.rollNo }
        : null,
      rewardTitle: r.reward?.title || r.snapshot?.title || 'reward',
    }));

    res.json({ items: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/engagement/brand/redeem-stats
// Stats for codes this brand owns OR used
// ────────────────────────────────────────────────────────────
router.get('/brand/redeem-stats', auth, requireBrand, async (req, res) => {
  try {
    const myRewards = await Reward.find({ brand: req.userId })
      .select('_id costPoints')
      .lean();
    const myRewardIds = myRewards.map((r) => r._id);

    const match = {
      $or: [
        { reward: { $in: myRewardIds } },
        { usedBy: req.userId },
      ],
    };

    const [total, active, used, expired, cancelled] = await Promise.all([
      RewardRedemption.countDocuments(match),
      RewardRedemption.countDocuments({ ...match, status: 'active' }),
      RewardRedemption.countDocuments({ ...match, status: 'used' }),
      RewardRedemption.countDocuments({ ...match, status: 'expired' }),
      RewardRedemption.countDocuments({ ...match, status: 'cancelled' }),
    ]);

    const usedRedemptions = await RewardRedemption.find({
      ...match,
      status: 'used',
    })
      .select('costPoints')
      .lean();
    const pointsLiability = usedRedemptions.reduce(
      (s, r) => s + (r.costPoints || 0),
      0
    );

    res.json({ total, active, used, expired, cancelled, pointsLiability });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ============================================================
// GET /api/engagement/me
// ============================================================
// routes/engagement.routes.js — /me endpoint (COMPLETE FIX)

router.get('/me', auth, async (req, res) => {
  try {
    if (req.isGuest) {
      return res.json({ guest: true, flags: cfg.flags(cfg.STAGE) });
    }

    const userIdObj = new mongoose.Types.ObjectId(req.userId);

    const profile = await EngagementProfile.findOne({ user: req.userId }).lean();
    const today = dayKey();
    const flags = cfg.flags(cfg.STAGE);
    const sortedCount = profile?.sortedCount || 0;
    const total = 8;

    const cards = missions.FEATURES.map((f) => {
      const sorted = !!profile?.sorted?.[f];
      const snooze = (profile?.snoozes || []).find(
        (s) => s.feature === f && new Date(s.until) > new Date()
      );
      return {
        feature: f,
        mood: sorted ? 'sorted' : 'broke',
        sorted,
        sortedAt: profile?.sorted?.[f] || null,
        lineBefore: missions.LINES[f].before,
        lineAfter: missions.LINES[f].after,
        route: missions.ROUTES[f].route,
        params: missions.ROUTES[f].params,
        snoozedUntil: snooze?.until || null,
      };
    });

    const next = missions.nextCard(profile);
    const streakHealth = streakSvc.healthOf(profile?.streak, today);
    const earnedBadges = await UserBadge.countDocuments({ user: req.userId });

    const userDoc = await User.findById(req.userId)
      .select('referralCount referralCode')
      .lean();
    const referralCount = userDoc?.referralCount || 0;
    const referralCode = userDoc?.referralCode || '';

    // ═══════════════════════════════════════════════════════════
    // 🆕 DERIVE ALL POINTS FROM LEDGER (source of truth)
    // ═══════════════════════════════════════════════════════════
    let lifetime = 0;
    let lifetimeReferral = 0;
    let lifetimeActivity = 0;

    try {
      const [lifetimeAgg, referralAgg, activityAgg] = await Promise.all([
        PointsLedger.aggregate([
          { $match: { user: userIdObj, delta: { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: '$delta' } } },
        ]),
        PointsLedger.aggregate([
          {
            $match: {
              user: userIdObj,
              delta: { $gt: 0 },
              reason: { $regex: '^referral' },
            },
          },
          { $group: { _id: null, total: { $sum: '$delta' } } },
        ]),
        PointsLedger.aggregate([
          {
            $match: {
              user: userIdObj,
              delta: { $gt: 0 },
              reason: { $not: { $regex: '^referral' } },
            },
          },
          { $group: { _id: null, total: { $sum: '$delta' } } },
        ]),
      ]);

      lifetime = lifetimeAgg?.[0]?.total || 0;
      lifetimeReferral = referralAgg?.[0]?.total || 0;
      lifetimeActivity = activityAgg?.[0]?.total || 0;
    } catch (e) {
      console.warn('[engagement/me] ledger agg failed:', e.message);
      lifetime = profile?.points?.lifetime || 0;
      lifetimeReferral = profile?.points?.lifetimeReferral || 0;
      lifetimeActivity = Math.max(0, lifetime - lifetimeReferral);
    }

    // Fallback if ledger is empty but profile has values
    if (lifetime === 0 && (profile?.points?.lifetime || 0) > 0) {
      lifetime = profile.points.lifetime;
      lifetimeReferral = profile.points.lifetimeReferral || 0;
      lifetimeActivity = Math.max(0, lifetime - lifetimeReferral);
    }

    const balance = profile?.points?.balance || 0;
    const verifiedReferralCount = profile?.verifiedReferralCount || 0;
    const tiersIssued = profile?.level?.tiersIssued || [];

    let nextTier = null;
    try {
      const { nextTierStatus } = require('../services/engagement/levels');
      const syntheticProfile = {
        ...profile,
        points: { ...(profile?.points || {}), lifetime, lifetimeReferral },
      };
      nextTier = nextTierStatus(syntheticProfile);
    } catch (e) {
      console.warn('[engagement/me] nextTierStatus failed:', e.message);
    }

    let tierDiscount = null;
    const td = profile?.tierDiscount;
    if (td?.validUntil && new Date(td.validUntil) > new Date()) {
      tierDiscount = {
        percent:    td.percent || 0,
        capRs:      td.capRs || 0,
        validUntil: td.validUntil,
        tierId:     td.tierId || null,
      };
    }

    const sk = semesterKey();
    const examUses = (profile?.streak?.examModeUses || []).filter(
      (u) => u.semesterKey === sk
    ).length;
    const examActive = !!(
      profile?.streak?.examModeUntil &&
      profile.streak.examModeUntil >= today
    );

    return res.json({
      flags,
      tour: { completed: !!profile?.tourCompletedAt },
      missions: { sortedCount, total, cards, next },

      streak:
        flags.soloStreak && profile?.streak
          ? {
              count: profile.streak.count || 0,
              best: profile.streak.best || 0,
              health: streakSvc.healthOf(profile.streak, today),
              freezesLeft: profile.streak.freezesLeft ?? 1,
              lastActionDay: profile.streak.lastActionDay || null,
              examModeUntil: profile.streak.examModeUntil || null,
              examModeActive: examActive,
              examModeUsesThisSemester: examUses,
              examModeRemaining: Math.max(0, 2 - examUses),
            }
          : null,

      points: {
        balance,
        lifetime,
        lifetimeReferral,
        activityPoints: lifetimeActivity,
        level: profile?.level?.id || 'member',
      },

      level: {
        id:          profile?.level?.id || 'member',
        reachedAt:   profile?.level?.reachedAt || null,
        tiersIssued,
      },

      tierDiscount,
      nextTier,

      stats: { totalSaved: profile?.stats?.totalSaved || 0 },
      badges: { earned: earnedBadges, total: totalBadges },

      referralCount,
      referralCode,
      verifiedReferralCount,

      popups: (profile?.pendingPopups || [])
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .map((p) => ({
          id: p._id,
          kind: p.kind,
          mood: p.mood,
          line: p.line,
          cta: p.cta,
        })),

      notifPrefs:
        profile?.notifPrefs || {
          streaks: true,
          dailyDrop: true,
          deals: true,
          jobsScholarships: true,
          social: true,
        },

      askPushPermission: !profile?.pushPermissionAskedAt && sortedCount >= 1,
    });
  } catch (err) {
    console.error('[engagement/me] error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET /api/engagement/home
// ============================================================
router.get('/home', auth, async (req, res) => {
  try {
    if (req.isGuest)
      return res.json({ guest: true, drop: null, missions: null, streak: null });

    const profile = await EngagementProfile.findOne({ user: req.userId }).lean();
    const today = dayKey();
    const dropDoc = await drops.todayDrop();
    // Includes my vote + counts + target, so after a reload the card still
    // shows the result and the "view" button
    const dropDTO = dropDoc ? await drops.dropForUser(dropDoc, req.userId) : null;

    const cards = missions.FEATURES.map((f) => ({
      feature: f,
      mood: profile?.sorted?.[f] ? 'sorted' : 'broke',
      sorted: !!profile?.sorted?.[f],
      sortedAt: profile?.sorted?.[f] || null,
      lineBefore: missions.LINES[f].before,
      lineAfter: missions.LINES[f].after,
      route: missions.ROUTES[f].route,
      params: missions.ROUTES[f].params,
    }));

    res.json({
      drop: dropDTO,
      missions: {
        sortedCount: profile?.sortedCount || 0,
        total: 8,
        cards,
        next: missions.nextCard(profile),
      },
      streak: profile?.streak
        ? {
            count: profile.streak.count || 0,
            best: profile.streak.best || 0,
            health: streakSvc.healthOf(profile.streak, today),
            examModeUntil: profile.streak.examModeUntil || null,
          }
        : null,
    });
  } catch (err) {
    console.error('[engagement/home] error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// POST /api/engagement/events
// ============================================================
router.post('/events', auth, async (req, res) => {
  try {
    const { name, meta } = req.body || {};
    const ALLOWED = new Set([
      'app_open', 'tour_completed', 'card_snoozed', 'popup_seen', 'push_opened',
    ]);
    if (!ALLOWED.has(name))
      return res.status(400).json({ message: 'event not allowed from client' });

    if (!req.isGuest) {
      await track(req.userId, name, { meta, source: 'client' });
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// POST /api/engagement/tour/complete
// ============================================================
router.post('/tour/complete', auth, requireAuth, async (req, res) => {
  await EngagementProfile.updateOne(
    { user: req.userId },
    { $set: { tourCompletedAt: new Date() } }
  );
  res.json({ ok: true });
});

// ============================================================
// POST /api/engagement/tooltips/:id/seen
// ============================================================
router.post('/tooltips/:id/seen', auth, requireAuth, async (req, res) => {
  await EngagementProfile.updateOne(
    { user: req.userId },
    { $addToSet: { tooltipsSeen: req.params.id } }
  );
  res.json({ ok: true });
});

// ============================================================
// POST /api/engagement/missions/:feature/snooze
// ============================================================
router.post('/missions/:feature/snooze', auth, requireAuth, async (req, res) => {
  const { feature } = req.params;
  if (!missions.FEATURES.includes(feature))
    return res.status(400).json({ message: 'unknown feature' });

  const profile = await EngagementProfile.findOne({ user: req.userId });
  const existing = (profile.snoozes || []).find((s) => s.feature === feature);
  const count = existing?.count || 0;
  if (count >= 2) return res.status(409).json({ message: 'snooze limit reached' });

  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await EngagementProfile.updateOne(
    { user: req.userId },
    { $pull: { snoozes: { feature } } }
  );
  await EngagementProfile.updateOne(
    { user: req.userId },
    { $push: { snoozes: { feature, until, count: count + 1 } } }
  );

  res.json({ ok: true, until, remainingSnoozes: 2 - (count + 1) });
});

// ============================================================
// POST /api/engagement/popups/:id/ack
// Removes a popup from the user's queue. Idempotent.
// ============================================================
router.post('/popups/:id/ack', auth, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, message: 'popup id required' });
    }

    // Validate ObjectId so we don't silently no-op
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: 'invalid popup id' });
    }

    const result = await EngagementProfile.updateOne(
      { user: req.userId },
      { $pull: { pendingPopups: { _id: new mongoose.Types.ObjectId(id) } } }
    );

    // Return actual removal count so mobile can verify
    return res.json({
      ok: true,
      removed: result.modifiedCount,
      alreadyAcked: result.modifiedCount === 0,
    });
  } catch (err) {
    console.error('[popups/ack]', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ============================================================
// GET /api/engagement/badges
// Re-evaluates live (catches referralCount changes outside events)
// ============================================================
router.get('/badges', auth, requireAuth, async (req, res) => {
  try {
    // 🆕 Live badge evaluation — this is the critical fix for referral tiers
    try {
      const { evaluateBadgesNow } = require('../services/engagement/engine');
      await evaluateBadgesNow(req.userId);
    } catch (e) {
      console.warn('[engagement/badges] live eval failed:', e.message);
    }

    const { badges: all } = require('../config/badges'); // ✅ FIXED
    const earned = await UserBadge.find({ user: req.userId }).lean();
    const earnedById = Object.fromEntries(
      earned.map((b) => [b.badgeId, b.earnedAt])
    );

    res.json(
      all.map((b) => ({
        id: b.id,
        group: b.group,
        title: b.title,
        line: b.line,
        mood: b.mood,
        points: b.points || 0,
        earnedAt: earnedById[b.id] || null,
      }))
    );
  } catch (err) {
    console.error('[engagement/badges]', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET /api/engagement/points/ledger
// ============================================================
router.get('/points/ledger', auth, requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 200);
  const cursor = req.query.cursor;
  const filter = { user: req.userId };
  if (cursor) filter._id = { $lt: cursor };

  const items = await PointsLedger.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? slice[slice.length - 1]._id : null;

  res.json({
    items: slice.map((i) => ({
      _id: i._id,
      delta: i.delta,
      reason: i.reason,
      balanceAfter: i.balanceAfter,
      createdAt: i.createdAt,
    })),
    nextCursor,
  });
});

// ============================================================
// GET /api/engagement/rewards
// ============================================================
// ============================================================
// GET /api/engagement/rewards
// ============================================================
router.get('/rewards', auth, requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const profile = await EngagementProfile.findOne({ user: userId })
      .select('points')
      .lean();
    const balance = profile?.points?.balance || 0;

    const rewards = await Reward.find({ active: true })
      .populate('brand', 'name brandName logo')
      .sort({ costPoints: 1 })
      .lean();

    // compute stockLeft + userRedemptionCount in parallel
    const withMeta = await Promise.all(
      rewards.map(async (r) => {
        let stockLeft = null;
        if (typeof r.stock === 'number') {
          const redeemed = await RewardRedemption.countDocuments({
            reward: r._id,
            status: { $in: ['active', 'used'] },
          });
          stockLeft = Math.max(0, r.stock - redeemed);
        }

        const userRedeemed = await RewardRedemption.countDocuments({
          user: userId,
          reward: r._id,
          status: { $in: ['active', 'used'] },
        });

        return {
          _id: r._id,
          title: r.title,
          description: r.description,
          brand: r.brand
            ? { name: r.brand.name || r.brand.brandName, logo: r.brand.logo }
            : null,
          image: r.image,
          costPoints: r.costPoints,
          kind: r.kind,
          validDays: r.validDays,
          affordable: balance >= r.costPoints,
          stockLeft,
          perUserLimit: r.perUserLimit || 1,
          userRedeemed,
          canRedeem:
            balance >= r.costPoints &&
            (stockLeft === null || stockLeft > 0) &&
            userRedeemed < (r.perUserLimit || 1),
        };
      })
    );

    res.json(withMeta);
  } catch (err) {
    console.error('[rewards GET]', err);
    res.status(500).json({ message: err.message });
  }
});
// ============================================================
// GET /api/engagement/rewards/my-redemptions
// ============================================================
router.get('/rewards/my-redemptions', auth, requireAuth, async (req, res) => {
  try {
    const items = await RewardRedemption.find({ user: req.userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('reward', 'title image costPoints kind')
      .lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// POST /api/engagement/rewards/:id/redeem
// ============================================================
// ============================================================
// POST /api/engagement/rewards/:id/redeem
// ============================================================
router.post('/rewards/:id/redeem', auth, requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const rewardId = req.params.id;

    // 1. load reward
    const reward = await Reward.findById(rewardId);
    if (!reward || !reward.active) {
      return res.status(404).json({ message: 'reward not found' });
    }

    // 2. load profile & check balance
    const profile = await EngagementProfile.findOne({ user: userId });
    if (!profile) {
      return res.status(404).json({ message: 'profile not found' });
    }
    const balance = profile.points?.balance || 0;
    if (balance < reward.costPoints) {
      return res.status(409).json({
        message: 'not enough points',
        balance,
        required: reward.costPoints,
      });
    }

    // 3. stock check (atomic decrement)
    if (reward.stock !== null && reward.stock !== undefined) {
      const updated = await Reward.findOneAndUpdate(
        { _id: reward._id, stock: { $gte: 1 } },
        { $inc: { stock: -1 } },
        { new: true }
      );
      if (!updated) {
        return res.status(409).json({ message: 'out of stock' });
      }
    }

    // 4. per-user limit check
    if (reward.perUserLimit) {
      const mine = await RewardRedemption.countDocuments({
        user: userId,
        reward: reward._id,
        status: { $in: ['active', 'used'] },
      });
      if (mine >= reward.perUserLimit) {
        return res.status(409).json({ message: 'you already redeemed this' });
      }
    }

    // 5. create redemption FIRST so we have an id for idempotency
    const { generateCode } = require('../services/engagement/rewardCodes');
    const code = generateCode('TDC');
    const expiresAt = new Date(
      Date.now() + (reward.validDays || 30) * 24 * 60 * 60 * 1000
    );

   const redemption = await RewardRedemption.create({
  user: userId,
  reward: reward._id,
  rewardBrand: reward.brand || null, // ✅ snapshot the brand at redemption time
  code,
  costPoints: reward.costPoints,
  expiresAt,
  status: 'active',
  promoCode: reward.kind === 'promo_code' ? code : null,
  snapshot: {
    title: reward.title,
    description: reward.description,
    kind: reward.kind,
    brand: reward.brand,
  },
});

    // 6. deduct points (spend wrapper) — idempotent per redemption
    const { spend } = require('../services/engagement/points');
    let spendResult;
    try {
      spendResult = await spend(
        userId,
        reward.costPoints,
        'reward_redeemed',
        'reward',
        reward._id.toString(),
        `redeem:${redemption._id}`
      );
    } catch (e) {
      // rollback redemption if points spend failed
      await RewardRedemption.findByIdAndDelete(redemption._id);
      if (reward.stock !== null && reward.stock !== undefined) {
        await Reward.updateOne({ _id: reward._id }, { $inc: { stock: 1 } });
      }
      if (e.code === 'INSUFFICIENT_POINTS') {
        return res.status(409).json({ message: 'not enough points' });
      }
      throw e;
    }

    // 7. return
    res.status(201).json({
      ok: true,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        expiresAt: redemption.expiresAt,
        status: redemption.status,
      },
      balance: spendResult.balance,
      lifetime: spendResult.lifetime,
    });
  } catch (err) {
    console.error('[redeem]', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// Notification prefs
// ============================================================
router.get('/notification-prefs', auth, requireAuth, async (req, res) => {
  const profile = await EngagementProfile.findOne({ user: req.userId })
    .select('notifPrefs osPushPermission')
    .lean();
  res.json({
    ...(profile?.notifPrefs || {}),
    osPermission: profile?.osPushPermission || 'undetermined',
  });
});

router.put('/notification-prefs', auth, requireAuth, async (req, res) => {
  const allowed = ['streaks', 'dailyDrop', 'deals', 'jobsScholarships', 'social'];
  const set = {};
  for (const k of allowed) {
    if (typeof req.body[k] === 'boolean') set[`notifPrefs.${k}`] = req.body[k];
  }
  await EngagementProfile.updateOne({ user: req.userId }, { $set: set });
  const profile = await EngagementProfile.findOne({ user: req.userId })
    .select('notifPrefs osPushPermission')
    .lean();
  res.json({
    ...(profile?.notifPrefs || {}),
    osPermission: profile?.osPushPermission || 'undetermined',
  });
});

router.post('/push-permission', auth, requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['granted', 'denied', 'undetermined'].includes(status)) {
    return res.status(400).json({ message: 'invalid status' });
  }
  await EngagementProfile.updateOne(
    { user: req.userId },
    { $set: { osPushPermission: status, pushPermissionAskedAt: new Date() } }
  );
  res.status(204).end();
});

// ============================================================
// STREAK — exam mode
// ============================================================
router.get('/streak/status', auth, requireAuth, async (req, res) => {
  try {
    const profile = await EngagementProfile.findOne({ user: req.userId })
      .select('streak')
      .lean();

    const today = dayKey();
    const sk = semesterKey();
    const usesThisSemester = (profile?.streak?.examModeUses || []).filter(
      (u) => u.semesterKey === sk
    ).length;

    res.json({
      count: profile?.streak?.count || 0,
      best: profile?.streak?.best || 0,
      lastActionDay: profile?.streak?.lastActionDay || null,
      freezesLeft: profile?.streak?.freezesLeft ?? 1,
      examModeUntil: profile?.streak?.examModeUntil || null,
      examModeActive: !!(
        profile?.streak?.examModeUntil &&
        profile.streak.examModeUntil >= today
      ),
      examModeUsesThisSemester: usesThisSemester,
      examModeRemaining: Math.max(0, 2 - usesThisSemester),
      health: streakSvc.healthOf(profile?.streak, today),
    });
  } catch (err) {
    console.error('[streak/status]', err);
    res.status(500).json({ message: err.message });
  }
});

router.post('/streak/exam-mode', auth, requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days) || 7, 1), 14);
    const profile = await EngagementProfile.findOne({ user: req.userId });

    if (!profile) {
      return res.status(404).json({ message: 'profile not found' });
    }

    const sk = semesterKey();
    const today = dayKey();
    const usesThisSemester = (profile.streak?.examModeUses || []).filter(
      (u) => u.semesterKey === sk
    ).length;

    const alreadyActive = !!(
      profile.streak?.examModeUntil && profile.streak.examModeUntil >= today
    );

    if (usesThisSemester >= 2 && !alreadyActive) {
      return res.status(409).json({
        message: 'used twice this semester.',
        semesterKey: sk,
        used: usesThisSemester,
      });
    }

    const until = dayKey(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

    const update = { $set: { 'streak.examModeUntil': until } };
    if (!alreadyActive) {
      update.$push = {
        'streak.examModeUses': { semesterKey: sk, startedDay: today },
      };
    }

    await EngagementProfile.updateOne({ user: req.userId }, update);

    const fresh = await EngagementProfile.findOne({ user: req.userId });
    if (fresh.streak?.count > 0 && !fresh.streak.lastActionDay) {
      await EngagementProfile.updateOne(
        { user: req.userId },
        { $set: { 'streak.lastActionDay': dayKey(new Date(Date.now() - 86400000)) } }
      );
    }

    res.json({
      examModeUntil: until,
      days,
      semesterKey: sk,
      usesThisSemester: alreadyActive ? usesThisSemester : usesThisSemester + 1,
      remaining: Math.max(
        0,
        2 - (alreadyActive ? usesThisSemester : usesThisSemester + 1)
      ),
    });
  } catch (err) {
    console.error('[exam-mode POST]', err);
    res.status(500).json({ message: err.message });
  }
});

router.delete('/streak/exam-mode', auth, requireAuth, async (req, res) => {
  try {
    await EngagementProfile.updateOne(
      { user: req.userId },
      { $set: { 'streak.examModeUntil': null } }
    );
    res.json({ examModeUntil: null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// DAILY DROP
// ============================================================
router.get('/drops/today', auth, async (req, res) => {
  if (req.isGuest) return res.json(null);
  const drop = await drops.todayDrop();
  if (!drop) return res.json(null);
  res.json(await drops.dropForUser(drop, req.userId));
});

router.post('/drops/:dayKey/react', auth, requireAuth, async (req, res) => {
  try {
    const { choice } = req.body || {};
    if (!choice) return res.status(400).json({ message: 'choice required' });

    const { myChoice, counts, drop } = await drops.react(
      req.userId,
      req.params.dayKey,
      choice
    );

    // Points / streak tracking must never fail the vote itself
    let engagement = null;
    try {
      engagement = await track(req.userId, 'drop_reacted', {
        meta: { dayKey: req.params.dayKey, choice },
        dedupeKey: `drop_react:${req.userId}:${drop._id}`,
      });
    } catch (e) {
      console.error('[drops/react] track failed:', e.message);
    }

    // ✅ Also return the target so the app knows where to navigate
    const target = await drops.resolveTargetAsync(drop.contentRef, drop.type).catch(() => null);

    res.json({
      myChoice,
      counts,
      target,
      engagement: engagement || undefined,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ============================================================
// SAVED ITEMS
// ============================================================
router.post('/saved/:kind/:id', auth, requireAuth, async (req, res) => {
  const { kind, id } = req.params;
  if (!['scholarship', 'trip'].includes(kind))
    return res.status(400).json({ message: 'invalid kind' });

  try {
    await SavedItem.create({ user: req.userId, kind, refId: id });
  } catch (err) {
    if (err.code !== 11000)
      return res.status(500).json({ message: err.message });
  }

  const eventName =
    kind === 'scholarship' ? 'scholarship_saved' : 'trip_saved';
  const engagement = await track(req.userId, eventName, {
    meta: { refId: id },
    dedupeKey: `saved:${req.userId}:${kind}:${id}`,
  });

  res.json({ saved: true, engagement: engagement || undefined });
});

router.delete('/saved/:kind/:id', auth, requireAuth, async (req, res) => {
  await SavedItem.deleteOne({
    user: req.userId,
    kind: req.params.kind,
    refId: req.params.id,
  });
  res.json({ saved: false });
});
// ═══════════════════════════════════════════════
// POST /admin/engagement/redemptions/lookup
// Staff looks up a code (by code string)
// ═══════════════════════════════════════════════
router.post('/redemptions/lookup', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ message: 'code required' });

    const redemption = await RewardRedemption.findOne({
      code: String(code).trim().toUpperCase(),
    })
      .populate('user', 'name email rollNo')
      .populate('reward', 'title description costPoints kind')
      .lean();

    if (!redemption) {
      return res.status(404).json({ message: 'code not found', valid: false });
    }

    const expired = new Date(redemption.expiresAt) < new Date();
    const usable = redemption.status === 'active' && !expired;

    res.json({
      valid: usable,
      reason: !usable
        ? expired
          ? 'expired'
          : redemption.status
        : null,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        status: redemption.status,
        costPoints: redemption.costPoints,
        createdAt: redemption.createdAt,
        expiresAt: redemption.expiresAt,
        usedAt: redemption.usedAt,
        user: redemption.user
          ? { name: redemption.user.name, email: redemption.user.email }
          : null,
        reward: redemption.reward
          ? {
              title: redemption.reward.title,
              kind: redemption.reward.kind,
            }
          : redemption.snapshot,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// POST /admin/engagement/redemptions/:id/use
// Staff marks a code as used
// ═══════════════════════════════════════════════
router.post('/redemptions/:id/use', async (req, res) => {
  try {
    const redemption = await RewardRedemption.findById(req.params.id);
    if (!redemption) return res.status(404).json({ message: 'not found' });

    if (redemption.status !== 'active') {
      return res.status(400).json({
        message: `cannot use a ${redemption.status} redemption`,
      });
    }

    if (new Date(redemption.expiresAt) < new Date()) {
      redemption.status = 'expired';
      await redemption.save();
      return res.status(400).json({ message: 'code expired' });
    }

    redemption.status = 'used';
    redemption.usedAt = new Date();
    await redemption.save();

    res.json({
      ok: true,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        status: redemption.status,
        usedAt: redemption.usedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════
// POST /admin/engagement/redemptions/auto-expire
// Batch: mark all past-expiry active codes as expired
// (run daily via cron)
// ═══════════════════════════════════════════════
router.post('/redemptions/auto-expire', async (req, res) => {
  try {
    const result = await RewardRedemption.updateMany(
      {
        status: 'active',
        expiresAt: { $lt: new Date() },
      },
      { $set: { status: 'expired' } }
    );
    res.json({ ok: true, expired: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ═══════════════════════════════════════════════
// GET /api/engagement/brands
// Public-ish list of approved brands for reward dropdown
// (used by admin when creating rewards)
// ═══════════════════════════════════════════════
router.get('/brands', auth, async (req, res) => {
  try {
    const brands = await User.find({
      role: 'brand',
      brandApprovalStatus: 'approved',
    })
      .select('_id name brandName logo category address city isOnline isInStore')
      .sort({ brandName: 1, name: 1, createdAt: -1 })
      .lean();

    res.json(
      brands.map((b) => ({
        _id: b._id,
        name: b.brandName || b.name || 'Brand',
        logo: b.logo || null,
        category: b.category || 'General',
        city: b.city || '',
        address: b.address || '',
        isOnline: !!b.isOnline,
        isInStore: !!b.isInStore,
      }))
    );
  } catch (err) {
    console.error('[engagement/brands]', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// REFERRAL SYSTEM
// ============================================================

// ────────────────────────────────────────────────────────────
// GET /api/engagement/referrals/me
// Complete referral state for the current user
// ────────────────────────────────────────────────────────────
// routes/engagement.routes.js — /referrals/me endpoint (COMPLETE FIX)

// routes/engagement.routes.js — replace /referrals/me

router.get('/referrals/me', auth, requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const userIdObj = new mongoose.Types.ObjectId(userId);

    const userDoc = await User.findById(userId)
      .select('name referralCode referralCount canApplyForTdcCard')
      .lean();

    if (!userDoc) return res.status(404).json({ message: 'user not found' });

    const profile = await EngagementProfile.findOne({ user: userId })
      .select('verifiedReferralCount points level')
      .lean();

    // ── Recompute verified count from source of truth (live) ──
    const { computeVerifiedCount } = require('../services/engagement/referral');
    const liveVerifiedCount = await computeVerifiedCount(userId);

    // ── Sync profile if mismatch (self-healing) ──
    if (liveVerifiedCount !== (profile?.verifiedReferralCount || 0)) {
      await EngagementProfile.updateOne(
        { user: userId },
        { $set: { verifiedReferralCount: liveVerifiedCount } }
      );
    }

    // lifetimeReferral from ledger
    let lifetimeReferral = 0;
    try {
      const r = await PointsLedger.aggregate([
        {
          $match: {
            user: userIdObj,
            delta: { $gt: 0 },
            reason: { $regex: '^referral' },
          },
        },
        { $group: { _id: null, total: { $sum: '$delta' } } },
      ]);
      lifetimeReferral = r?.[0]?.total || 0;
    } catch (e) {
      lifetimeReferral = profile?.points?.lifetimeReferral || 0;
    }

    const verifiedCount = liveVerifiedCount;
    const rawCount = userDoc.referralCount || 0;

    // ── Build enriched referees with live verified flags ──
    const referees = await User.find({ referredBy: userId })
      .select('name email profileImage createdAt role')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const refereeIds = referees.map((r) => r._id);
    const refereeProfiles = await EngagementProfile.find({
      user: { $in: refereeIds },
    })
      .select('user sortedCount')
      .lean();

    const sortedByUser = new Map(
      refereeProfiles.map((p) => [String(p.user), p.sortedCount || 0])
    );

    const enrichedReferees = referees.map((r) => {
      const sortedCount = sortedByUser.get(String(r._id)) || 0;
      return {
        _id: r._id,
        name: r.name || 'Anonymous',
        email: r.email,
        profileImage: r.profileImage || null,
        joinedAt: r.createdAt,
        sortedCount,
        verified: sortedCount > 0,
      };
    });

    const pendingCount = enrichedReferees.filter((r) => !r.verified).length;

    return res.json({
      referralCode: userDoc.referralCode || '',
      canApplyForTdcCard: !!userDoc.canApplyForTdcCard,
      rawCount,
      verifiedCount,
      pendingCount,
      lifetimeReferral,
      level: profile?.level?.id || 'member',
      tiersIssued: profile?.level?.tiersIssued || [],
      referees: enrichedReferees,
    });
  } catch (err) {
    console.error('[referrals/me] error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/engagement/referrals/leaderboard
// Top 10 referrers by VERIFIED count
// ────────────────────────────────────────────────────────────
router.get('/referrals/leaderboard', auth, requireAuth, async (req, res) => {
  try {
    const top = await EngagementProfile.find({
      verifiedReferralCount: { $gt: 0 },
    })
      .sort({ verifiedReferralCount: -1 })
      .limit(10)
      .select('user verifiedReferralCount')
      .populate('user', 'name profileImage')
      .lean();

    const leaderboard = top
      .filter((p) => p.user)
      .map((p, i) => ({
        rank: i + 1,
        userId: p.user._id,
        name: p.user.name || 'anonymous',
        profileImage: p.user.profileImage || null,
        verifiedCount: p.verifiedReferralCount || 0,
      }));

    res.json({ leaderboard });
  } catch (err) {
    console.error('[referrals/leaderboard] error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/engagement/referrals/validate/:code
// Check if a referral code is valid (used during signup UX)
// Public-ish — no auth needed but optional
// ────────────────────────────────────────────────────────────
router.get('/referrals/validate/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ valid: false, reason: 'code required' });
    }

    const user = await User.findOne({ referralCode: code })
      .select('name profileImage')
      .lean();

    if (!user) {
      return res.json({ valid: false, reason: 'code not found' });
    }

    res.json({
      valid: true,
      referrer: {
        name: user.name || 'a friend',
        profileImage: user.profileImage || null,
      },
    });
  } catch (err) {
    res.status(500).json({ valid: false, reason: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/engagement/referrals/backfill
// One-time recovery: awards +100 to any referrer/referee pair
// that shows verified but is missing the ledger entry.
// Safe to call multiple times (idempotent).
// ────────────────────────────────────────────────────────────
router.post('/referrals/backfill', auth, requireAuth, async (req, res) => {
  try {
    // Optional admin gate — uncomment if you want to restrict
    // const me = await User.findById(req.userId).select('role').lean();
    // if (me?.role !== 'admin') {
    //   return res.status(403).json({ message: 'admin only' });
    // }

    const User = require('../models/User');
    const PointsLedger = require('../models/PointsLedger');
    const { award } = require('../services/engagement/points');

    // Find every user who was referred
    const referred = await User.find({ referredBy: { $ne: null } })
      .select('_id referredBy name')
      .lean();

    let referrerAwarded = 0;
    let refereeAwarded = 0;
    let referrerSkipped = 0;
    let refereeSkipped = 0;
    let notVerified = 0;

    for (const ref of referred) {
      const referrerId = String(ref.referredBy);
      const refereeIdStr = String(ref._id);

      // Only backfill for referees who have sorted at least one card
      const refProfile = await EngagementProfile.findOne({ user: ref._id })
        .select('sortedCount')
        .lean();

      if (!refProfile || (refProfile.sortedCount || 0) === 0) {
        notVerified++;
        continue;
      }

      // ── Referrer +100 ──
      const referrerIdemKey = `referral:verified:referrer:${referrerId}:${refereeIdStr}`;
      const existingReferrer = await PointsLedger.findOne({
        $or: [{ idemKey: referrerIdemKey }, { dedupeKey: referrerIdemKey }],
      }).lean();

      if (!existingReferrer) {
        try {
          const r = await award(referrerId, 100, 'referral:verified', {
            actorRole: 'referral',
            refType: 'referral',
            refId: refereeIdStr,
            idemKey: referrerIdemKey,
          });
          if (r?.awarded) {
            referrerAwarded++;
            console.log(`[referrals/backfill] +100 → referrer ${referrerId} for referee ${refereeIdStr}`);
          } else {
            referrerSkipped++;
          }
        } catch (e) {
          console.error('[referrals/backfill] referrer award failed:', e.message);
        }
      } else {
        referrerSkipped++;
      }

      // ── Referee +100 (welcome) ──
      const refereeIdemKey = `referral:welcome:${refereeIdStr}`;
      const existingReferee = await PointsLedger.findOne({
        $or: [{ idemKey: refereeIdemKey }, { dedupeKey: refereeIdemKey }],
      }).lean();

      if (!existingReferee) {
        try {
          const r = await award(refereeIdStr, 100, 'referral:welcome', {
            actorRole: 'referral',
            refType: 'referral',
            refId: referrerId,
            idemKey: refereeIdemKey,
          });
          if (r?.awarded) {
            refereeAwarded++;
            console.log(`[referrals/backfill] +100 → referee ${refereeIdStr}`);
          } else {
            refereeSkipped++;
          }
        } catch (e) {
          console.error('[referrals/backfill] referee award failed:', e.message);
        }
      } else {
        refereeSkipped++;
      }
    }

    res.json({
      ok: true,
      scanned: referred.length,
      notVerified,
      referrerAwarded,
      refereeAwarded,
      referrerSkipped,
      refereeSkipped,
    });
  } catch (err) {
    console.error('[referrals/backfill]', err);
    res.status(500).json({ message: err.message });
  }
});
module.exports = router;