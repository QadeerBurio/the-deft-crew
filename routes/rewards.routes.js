// backend/routes/rewards.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Reward = require('../models/Reward');
const RewardRedemption = require('../models/RewardRedemption');
const PointsLedger = require('../models/PointsLedger');
const EngagementProfile = require('../models/EngagementProfile');
const { spend, refund } = require('../services/engagement/points');
const { takeSlot, releaseSlot } = require('../models/RedemptionGuard');
const { generateCode } = require('../services/engagement/rewardCodes');
const { recordSafe } = require('../services/domainEvents');

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

    let profile = await EngagementProfile.findOne({ user: userId }).lean();
    if (!profile) profile = (await EngagementProfile.create({ user: userId })).toObject();
    if ((profile.points?.balance || 0) < reward.costPoints) {
      return res.status(400).json({ message: 'not enough points' });
    }

    // Limits, each taken atomically (two simultaneous redeems can't both pass): the student's own limit
    // and the reward's total stock (stock here = how many codes can exist, active or used)
    // STOCK = TOTAL: reward.stock is never changed here; /api/engagement/rewards/:id/redeem decrements it instead. Intentional, don't make them match.
    const taken = [];
    const release = async () => { for (const k of taken) await releaseSlot(k); };
    if (reward.perUserLimit) {
      const mine = await RewardRedemption.countDocuments({ user: userId, reward: reward._id, status: { $in: ['active', 'used'] } });
      const key = `reward-user:${userId}:${reward._id}`;
      if (!(await takeSlot(key, reward.perUserLimit, mine, null))) {
        return res.status(400).json({ message: 'you already redeemed this' });
      }
      taken.push(key);
    }
    if (typeof reward.stock === 'number') {
      const redeemed = await RewardRedemption.countDocuments({ reward: reward._id, status: { $in: ['active', 'used'] } });
      const key = `reward-stock:${reward._id}`;
      if (!(await takeSlot(key, reward.stock, redeemed, null))) {
        await release();
        return res.status(400).json({ message: 'sold out' });
      }
      taken.push(key);
    }

    // deduct points atomically (only if the balance still covers it)
    const idem = `reward_redeem:${userId}:${rewardId}:${Date.now()}`;
    try {
      await spend(userId, reward.costPoints, 'reward_redeemed', 'reward', String(reward._id), idem);
    } catch (e) {
      await release();
      if (e.code === 'INSUFFICIENT_POINTS') return res.status(400).json({ message: 'not enough points' });
      throw e;
    }

    // create redemption
    const code = generateCode('TDC');
    const expiresAt = new Date(
      Date.now() + (reward.validDays || 30) * 24 * 60 * 60 * 1000
    );

    let redemption;
    try {
      redemption = await RewardRedemption.create({
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
    } catch (e) {
      await refund(userId, reward.costPoints, 'reward_redeem_failed', 'reward', String(reward._id));
      await release();
      throw e;
    }

    await recordSafe('reward.redeemed', String(redemption._id), {
      actor: userId, subject: { kind: 'RewardRedemption', id: redemption._id },
      data: { reward: String(reward._id), costPoints: reward.costPoints },
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