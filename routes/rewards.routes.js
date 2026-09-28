// backend/routes/rewards.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Reward = require('../models/Reward');
const RewardRedemption = require('../models/RewardRedemption');
const PointsLedger = require('../models/PointsLedger');
const EngagementProfile = require('../models/EngagementProfile');
const { award } = require('../services/engagement/points');
const { generateCode } = require('../services/engagement/rewardCodes');

router.use(auth);

// ─── GET /rewards — active rewards with stock ───
router.get('/', async (req, res) => {
  try {
    const rewards = await Reward.find({ active: true })
      .populate('brand', 'name brandName logo')
      .sort({ costPoints: 1 })
      .lean();

    const withStock = await Promise.all(
      rewards.map(async (r) => {
        let stockLeft = null;
        if (typeof r.stock === 'number') {
          const redeemed = await RewardRedemption.countDocuments({
            reward: r._id,
            status: { $in: ['active', 'used'] },
          });
          stockLeft = Math.max(0, r.stock - redeemed);
        }
        return { ...r, stockLeft };
      })
    );

    res.json(withStock);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /rewards/my-redemptions ───
router.get('/my-redemptions', async (req, res) => {
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

// ─── GET /rewards/ledger?cursor=...&limit=50 ───
router.get('/ledger', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursor = req.query.cursor;

    const query = { user: req.userId };
    if (cursor) {
      const c = new Date(cursor);
      if (!isNaN(c.getTime())) query.createdAt = { $lt: c };
    }

    const items = await PointsLedger.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    let nextCursor = null;
    let result = items;
    if (items.length > limit) {
      result = items.slice(0, limit);
      nextCursor = items[limit].createdAt.toISOString();
    }

    res.json({ items: result, nextCursor });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /rewards/:id/redeem ───
router.post('/:id/redeem', async (req, res) => {
  try {
    const userId = req.userId;
    const rewardId = req.params.id;

    const reward = await Reward.findById(rewardId);
    if (!reward || !reward.active) {
      return res.status(404).json({ message: 'reward not available' });
    }

    // load profile
    let profile = await EngagementProfile.findOne({ user: userId });
    if (!profile) profile = await EngagementProfile.create({ user: userId });

    const balance = profile.points?.balance || 0;
    if (balance < reward.costPoints) {
      return res.status(400).json({ message: 'not enough points' });
    }

    // stock check
    if (typeof reward.stock === 'number') {
      const redeemed = await RewardRedemption.countDocuments({
        reward: reward._id,
        status: { $in: ['active', 'used'] },
      });
      if (redeemed >= reward.stock) {
        return res.status(400).json({ message: 'sold out' });
      }
    }

    // per-user limit
    if (reward.perUserLimit) {
      const mine = await RewardRedemption.countDocuments({
        user: userId,
        reward: reward._id,
        status: { $in: ['active', 'used'] },
      });
      if (mine >= reward.perUserLimit) {
        return res.status(400).json({ message: 'you already redeemed this' });
      }
    }

    // deduct points (idempotent per redemption attempt)
    const idem = `reward_redeem:${userId}:${rewardId}:${Date.now()}`;
    await award(userId, -reward.costPoints, 'reward_redeemed', 'self', userId, idem);

    // create redemption
    const code = generateCode('TDC');
    const expiresAt = new Date(
      Date.now() + (reward.validDays || 30) * 24 * 60 * 60 * 1000
    );

    const redemption = await RewardRedemption.create({
      user: userId,
      reward: reward._id,
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

    const updated = await EngagementProfile.findOne({ user: userId }).lean();

    res.json({
      ok: true,
      redemption: {
        _id: redemption._id,
        code: redemption.code,
        expiresAt: redemption.expiresAt,
        status: redemption.status,
      },
      balance: updated.points.balance,
      lifetime: updated.points.lifetime,
    });
  } catch (err) {
    console.error('[redeem]', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;