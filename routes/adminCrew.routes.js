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
    if (require("../services/adminAccess").isAdminAccount(user)) {
      next();
    } else {
      res.status(403).json({ message: 'Access denied. Admins only.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.use(auth, isAdmin);

// ─── P2 helpers ───
const LETTERS = new Set(['letter', 'recommendation']);
const isOid = (v) => /^[0-9a-f]{24}$/i.test(String(v || ''));
const v2For = (userId) => require('../config/featureFlags').isEnabled('ambassadorV2', { id: String(userId), role: 'student' });

// the University id of an application: stored (P2), or found by the name (older applications)
async function universityIdOf(app) {
  if (app.universityId) return app.universityId;
  const name = String(app.university || '').trim();
  if (!name) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const u = await require('../models/University').findOne({ name: { $regex: `^${esc}$`, $options: 'i' } }).select('_id').lean();
  return u ? u._id : null;
}

// P2: tell the student (ambassadorV2 on for them) that their application was reviewed. A personal push.
async function notifyApplicant(app) {
  if (!app?.user || !v2For(app.user)) return;
  const approved = app.status === 'approved';
  const title = approved ? "you're in: tdc ambassador" : 'your ambassador application';
  const body = approved
    ? 'welcome to the crew. open your ambassador hub to get started.'
    : (app.reviewNote ? `not this time: ${app.reviewNote}` : 'not this time. you can apply again in 30 days.');
  try {
    await require('../services/engagement/pushGateway').send(app.user, {
      type: 'crew_application', budgetClass: 'personal', essential: true, title, body,
      data: { route: 'Points', params: {}, crewApplication: app.status },
    });
  } catch (e) {
    console.error('[adminCrew] application push failed:', e.message);
  }
}

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
        summary: p.kind === 'moment' ? 'campus moment' : `${p.platform} post`,
        createdAt: p.createdAt,
        // P2-5 (additive): a campus moment (photo + caption)
        postKind: p.kind || 'link',
        caption: p.caption || '',
        imageUrl: p.imageUrl || '',
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
        // P2-3 (additive): the in-app application's details
        universityId: a.universityId || null,
        whyChips: a.whyChips || [],
        groups: a.groups || [],
        source: a.source || 'form',
        appliedAt: a.appliedAt || a.createdAt,
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
    // P2 (additive): ?university=<University id or name>: by the stored id, older partners by the name
    const filter = { 'partner.type': { $in: ['ambassador', 'influencer'] } };
    const uniQ = String(req.query.university || '').trim();
    if (uniQ) {
      const or = [];
      let name = uniQ;
      if (/^[0-9a-f]{24}$/i.test(uniQ)) {
        or.push({ 'partner.universityId': uniQ });
        const u = await require('../models/University').findById(uniQ).select('name').lean();
        name = u?.name || '';
      }
      if (name) or.push({ 'partner.university': { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
      filter.$or = or.length ? or : [{ _id: null }];
    }
    const monthStart = require('../services/crew/ambassador').karachiMonthStart(new Date());
    const profiles = await EngagementProfile.find(filter)
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
        // P2 (additive): friends who joined with the code and verified their e-mail (all time / this month)
        const [verified, verifiedThisMonth] = await Promise.all([
          User.countDocuments({ referredBy: p.user?._id, emailVerified: true }),
          User.countDocuments({ referredBy: p.user?._id, emailVerified: true, createdAt: { $gte: monthStart } }),
        ]);

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
            verified,
            verifiedThisMonth,
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
    // P2 (additive): an optional note to the student (shown in the app's application status)
    const rawNote = req.body.note ?? req.body.reviewNote;
    const set = { status, reviewedBy: req.userId, reviewedAt: new Date() };
    if (typeof rawNote === 'string') set.reviewNote = rawNote.trim().slice(0, 500);

    const app = await PartnerApplication.findByIdAndUpdate(
      req.params.appId,
      { $set: set },
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
            // P2: the university id (older applications: found by the name)
            'partner.universityId': await universityIdOf(app),
          },
        }
      );
    }
    notifyApplicant(app).catch(() => {});

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

    // P2-5 (ambassadorV2 on for the student): a recommendation letter starts as a draft; an admin writes / edits its
    // text and approves it before it is issued (never generated). Flag off: issued at once, as before.
    if (LETTERS.has(type) && v2For(userId)) {
      const letterText = typeof req.body.letterText === 'string' ? req.body.letterText.trim().slice(0, 6000) : '';
      const d = await Credential.create({ user: userId, type, note: note || '', status: 'draft', letterText, issuedBy: req.userId });
      return res.status(201).json(d);
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
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.userId } }
    );
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// P2-5: edit a draft letter's text (only drafts; an issued letter is never changed)
router.put('/credentials/:id', async (req, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ message: 'credential not found' });
    const c = await Credential.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'credential not found' });
    if (c.status !== 'draft') return res.status(409).json({ message: 'only a draft can be edited' });
    if (typeof req.body.letterText === 'string') c.letterText = req.body.letterText.trim().slice(0, 6000);
    if (typeof req.body.note === 'string') c.note = req.body.note.slice(0, 500);
    await c.save();
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// P2-5: approve a draft letter → issued (needs its text)
router.post('/credentials/:id/approve', async (req, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ message: 'credential not found' });
    const c = await Credential.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'credential not found' });
    if (c.status !== 'draft') return res.status(409).json({ message: 'only a draft can be approved' });
    if (LETTERS.has(c.type) && !String(c.letterText || '').trim()) return res.status(400).json({ message: 'write the letter first' });
    const now = new Date();
    c.status = 'issued'; c.approvedBy = req.userId; c.approvedAt = now; c.issuedAt = now; c.issuedBy = req.userId;
    await c.save();
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// P2-5: revoke (its public verify page then says "revoked"); the same as DELETE, with the reply
router.post('/credentials/:id/revoke', async (req, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ message: 'credential not found' });
    const c = await Credential.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'credential not found' });
    if (c.status !== 'revoked') {
      c.status = 'revoked'; c.revokedAt = new Date(); c.revokedBy = req.userId;
      await c.save();
    }
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// P2-5: preview the PDF (a draft letter too, once it has text)
router.get('/credentials/:id/pdf', async (req, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ message: 'credential not found' });
    const c = await Credential.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ message: 'credential not found' });
    const certificate = require('../services/crew/certificate');
    if (LETTERS.has(c.type) && !String(c.letterText || '').trim()) return res.status(400).json({ message: 'write the letter first' });
    const pdf = await certificate.render(c);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="tdc-${c.type}-${c._id}${c.status === 'draft' ? '-draft' : ''}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(pdf);
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

// Phase A: the permission each admin route needs (middleware/adminAccess.js; shadow mode until adminRbacEnforce)
require("../middleware/adminAccess").applyPermissions(router, {
  "GET /inbox": "crew.view",
  "GET /partners": "crew.view",
  "GET /partners/:userId": "crew.view",
  "GET /campaigns": "crew.view",
  "GET /settings": "crew.view",
  "POST /partners": "crew.manage",
  "DELETE /partners/:userId": "crew.manage",
  "POST /posts/:postId/review": "crew.manage",
  "POST /partners/applications/:appId/review": "crew.manage",
  "POST /campaigns": "crew.manage",
  "PUT /campaigns/:id": "crew.manage",
  "POST /campaigns/:id/end": "crew.manage",
  "DELETE /campaigns/:id": "crew.manage",
  "GET /credentials": "credentials.issue",
  "POST /credentials": "credentials.issue",
  "DELETE /credentials/:id": "credentials.issue",
  "PUT /credentials/:id": "credentials.issue",
  "POST /credentials/:id/approve": "credentials.issue",
  "POST /credentials/:id/revoke": "credentials.issue",
  "GET /credentials/:id/pdf": "credentials.issue",
  "POST /points/award": "points.award",
  "POST /badges/award": "points.award",
}, "adminCrew.routes.js");

module.exports = router;