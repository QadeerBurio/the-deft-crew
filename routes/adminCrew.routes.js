// routes/adminCrew.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');

// ─── Models ───
const User = require('../models/User');
const EngagementProfile = require('../models/EngagementProfile');
const PartnerPost = require('../models/PartnerPost');
const PartnerApplication = require('../models/PartnerApplication');
const Campaign = require('../models/Campaign');
const Credential = require('../models/Credential');
const UserBadge = require('../models/UserBadge');
const PointsLedger = require('../models/PointsLedger');

// ─── Services ───
const pointsService = require('../services/engagement/points');
const badgesService = require('../services/engagement/badges');

// ─── Admin guard (matches admin.routes.js pattern) ───
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (user && user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ message: 'Access denied. Admins only.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.use(auth, isAdmin);

// ═══════════════════════════════════════════════════════════
// INBOX — combined feed of pending posts + applications
// ═══════════════════════════════════════════════════════════
router.get('/inbox', async (req, res) => {
  try {
    const [posts, apps] = await Promise.all([
      PartnerPost.find({ status: 'pending' })
        .populate('user', 'name email profileImage')
        .sort({ createdAt: 1 })
        .lean(),
      PartnerApplication.find({ status: 'pending' })
        .populate('user', 'name email profileImage')
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const items = [
      ...posts.map((p) => ({
        _id: p._id,
        kind: 'post',
        user: p.user,
        platform: p.platform,
        url: p.url,
        screenshotUrl: p.screenshotUrl,
        summary: `${p.platform} post`,
        createdAt: p.createdAt,
      })),
      ...apps.map((a) => ({
        _id: a._id,
        kind: 'application',
        user: a.user,
        university: a.university,
        handle: a.handle,
        why: a.why,
        summary: 'partner application',
        createdAt: a.createdAt,
      })),
    ];

    // Overdue first, then oldest first
    items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    res.json(items);
  } catch (err) {
    console.error('[adminCrew/inbox]', err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PARTNERS
// ═══════════════════════════════════════════════════════════
router.get('/partners', async (req, res) => {
  try {
    const profiles = await EngagementProfile.find({
      'partner.type': { $in: ['ambassador', 'influencer'] },
    })
      .populate('user', 'name email profileImage university')
      .lean();

    const results = await Promise.all(
      profiles.map(async (p) => {
        const userIds = await User.find({ referredBy: p.user?._id }).distinct('_id');
        const totalReferred = userIds.length;
        const firstSorts = await EngagementProfile.countDocuments({
          user: { $in: userIds },
          sortedCount: { $gte: 1 },
        });
        const sortedPercent =
          totalReferred > 0 ? Math.round((firstSorts / totalReferred) * 100) : 0;
        const approvedPosts = await PartnerPost.countDocuments({
          user: p.user?._id,
          status: 'approved',
        });

        return {
          _id: p._id,
          user: p.user,
          partner: p.partner,
          points: p.points,
          level: p.level,
          stats: {
            referralsCredited: totalReferred,
            firstSorts,
            sortedPercent,
            approvedPosts,
          },
        };
      })
    );

    res.json(results);
  } catch (err) {
    console.error('[adminCrew/partners]', err);
    res.status(500).json({ message: err.message });
  }
});

// ADD partner
router.post('/partners', async (req, res) => {
  try {
    const { email, type, university, handle } = req.body;
    if (!email || !type) {
      return res.status(400).json({ message: 'email and type required' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'user not found' });

    await EngagementProfile.findOneAndUpdate(
      { user: user._id },
      {
        $setOnInsert: { user: user._id },
        $set: {
          'partner.type': type,
          'partner.since': new Date(),
          'partner.university': university || '',
          'partner.handle': handle || '',
          'partner.addedBy': req.userId,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ ok: true, user: { _id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// REMOVE partner
router.delete('/partners/:userId', async (req, res) => {
  try {
    await EngagementProfile.updateOne(
      { user: req.params.userId },
      { $set: { 'partner.type': 'none' } }
    );
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET single partner detail
router.get('/partners/:userId', async (req, res) => {
  try {
    const profile = await EngagementProfile.findOne({ user: req.params.userId })
      .populate('user', 'name email profileImage phone university')
      .lean();

    if (!profile) return res.status(404).json({ message: 'partner not found' });

    const userIds = await User.find({ referredBy: req.params.userId }).distinct('_id');
    const totalReferred = userIds.length;
    const firstSorts = await EngagementProfile.countDocuments({
      user: { $in: userIds },
      sortedCount: { $gte: 1 },
    });
    const approvedPosts = await PartnerPost.countDocuments({
      user: req.params.userId,
      status: 'approved',
    });

    res.json({
      ...profile,
      stats: {
        referralsCredited: totalReferred,
        firstSorts,
        sortedPercent:
          totalReferred > 0 ? Math.round((firstSorts / totalReferred) * 100) : 0,
        approvedPosts,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PARTNER POSTS — review
// ═══════════════════════════════════════════════════════════
router.post('/posts/:postId/review', async (req, res) => {
  try {
    const { status, reach } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved or rejected' });
    }

    const pointsMap = { posted: 50, '1k': 150, '5k': 300 };
    const points = status === 'approved' ? pointsMap[reach] || 50 : 0;

    const post = await PartnerPost.findByIdAndUpdate(
      req.params.postId,
      {
        $set: {
          status,
          reach: reach || 'posted',
          points,
          reviewedBy: req.userId,
          reviewedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!post) return res.status(404).json({ message: 'post not found' });

    if (status === 'approved' && points > 0) {
      try {
        await pointsService.award(
          post.user,
          points,
          'badge',
          'post',
          String(post._id),
          `post:${post._id}`
        );
      } catch (e) {
        console.warn('[adminCrew/review] points award failed:', e.message);
      }
    }

    res.json(post);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PARTNER APPLICATIONS — review
// ═══════════════════════════════════════════════════════════
router.post('/partners/applications/:appId/review', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved or rejected' });
    }

    const app = await PartnerApplication.findByIdAndUpdate(
      req.params.appId,
      { $set: { status, reviewedBy: req.userId, reviewedAt: new Date() } },
      { new: true }
    );

    if (!app) return res.status(404).json({ message: 'application not found' });

    if (status === 'approved') {
      await EngagementProfile.updateOne(
        { user: app.user },
        {
          $set: {
            'partner.type': 'ambassador',
            'partner.since': new Date(),
            'partner.university': app.university,
            'partner.handle': app.handle,
            'partner.addedBy': req.userId,
          },
        }
      );
    }

    res.json(app);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await Campaign.find({})
      .populate('brand', 'name brandName logo')
      .populate('partner', 'name profileImage')
      .sort({ createdAt: -1 })
      .lean();

    const enriched = await Promise.all(
      campaigns.map(async (c) => {
        const followersJoined = await EngagementProfile.countDocuments({
          'welcomePerk.campaign': c._id,
        });
        return {
          ...c,
          stats: {
            followersJoined,
            firstVisitsRedeemed: 0,
            billTotal: 0,
            savingsGiven: 0,
          },
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('[adminCrew/campaigns GET]', err);
    res.status(500).json({ message: err.message });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { name, brandId, partnerId, followerPercent, startsAt, endsAt, cap } =
      req.body;

    if (!name || !brandId || !partnerId || !followerPercent) {
      return res
        .status(400)
        .json({ message: 'name, brandId, partnerId, followerPercent required' });
    }

    const c = await Campaign.create({
      name,
      brand: brandId,
      partner: partnerId,
      followerPercent: Number(followerPercent),
      startsAt: startsAt ? new Date(startsAt) : new Date(),
      endsAt: endsAt ? new Date(endsAt) : new Date(Date.now() + 30 * 86400000),
      cap: cap ? Number(cap) : null,
      status: 'live',
      createdBy: req.userId,
    });

    res.status(201).json(c);
  } catch (err) {
    console.error('[adminCrew/campaigns POST]', err);
    res.status(500).json({ message: err.message });
  }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const c = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    if (!c) return res.status(404).json({ message: 'campaign not found' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/campaigns/:id/end', async (req, res) => {
  try {
    const c = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'ended', endedAt: new Date() } },
      { new: true }
    );
    if (!c) return res.status(404).json({ message: 'campaign not found' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    await Campaign.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CREDENTIALS
// ═══════════════════════════════════════════════════════════
router.get('/credentials', async (req, res) => {
  try {
    const items = await Credential.find({})
      .populate('user', 'name email profileImage')
      .populate('issuedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    console.error('[adminCrew/credentials GET]', err);
    res.status(500).json({ message: err.message });
  }
});

router.post('/credentials', async (req, res) => {
  try {
    const { userId, type, note } = req.body;
    if (!userId || !type) {
      return res.status(400).json({ message: 'userId and type required' });
    }

    const c = await Credential.create({
      user: userId,
      type,
      note: note || '',
      status: 'issued',
      issuedAt: new Date(),
      issuedBy: req.userId,
    });

    res.status(201).json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/credentials/:id', async (req, res) => {
  try {
    await Credential.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POINTS / BADGES (also available in adminEngagement)
// ═══════════════════════════════════════════════════════════
router.post('/points/award', async (req, res) => {
  try {
    const { userId, delta, note } = req.body;
    if (!userId || delta === undefined) {
      return res.status(400).json({ message: 'userId and delta required' });
    }

    const result = await pointsService.award(
      userId,
      Number(delta),
      'admin_adjust',
      'admin',
      req.userId,
      `admin_adjust:${userId}:${Date.now()}`
    );

    res.json({ ...result, note: note || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/badges/award', async (req, res) => {
  try {
    const { userId, badgeId } = req.body;
    if (!userId || !badgeId) {
      return res.status(400).json({ message: 'userId and badgeId required' });
    }
    const ok = await badgesService.grant(userId, badgeId);
    res.json({ awarded: ok });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  try {
    // Summon current config (could be extended later)
    const cfg = require('../config/engagement.config');
    res.json({
      stage: cfg.STAGE,
      flags: cfg.flags(cfg.STAGE),
      push: cfg.push,
      points: cfg.points,
      og: cfg.og,
      referral: cfg.referral,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;