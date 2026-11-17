// routes/appFlags.routes.js
// Switches the app reads (config/featureFlags.js; Railway variables, no app update to change one).
//
//   GET /api/app/flags    → { metaEvents: boolean }   public, no sign-in: the flags as for nobody in
//                           particular (a percentage or role rule counts as off)
//   GET /api/app/flags/me → { metaEvents: boolean }   the same flags for whoever is signed in (a guest
//                           has role "guest" and no id), so a flag can reach some users first
//
// metaEvents: Meta App Events in the app (still only after the student allows it in the app). Off
// unless FLAG_META_EVENTS (or the older META_EVENTS_ENABLED) switches it on, so a missing or
// mistyped variable keeps Meta off.

const express = require('express');
const auth = require('../middleware/auth.middleware');
const { clientFlags, publicFlags } = require('../config/featureFlags');

const router = express.Router();

router.get('/flags', (req, res) => {
  // short cache: a switch-off reaches phones within minutes
  res.set('Cache-Control', 'public, max-age=60');
  res.json(publicFlags());
});

router.get('/flags/me', auth, (req, res) => {
  // per user: never cached by a shared cache
  res.set('Cache-Control', 'private, no-store');
  const user = req.isGuest ? { role: 'guest' } : { id: String(req.userId), role: req.userRole };
  res.json(clientFlags(user));
});

// ---------- which builds carry the Meta IDs (chore/meta-build-guard) ----------
//   POST /api/app/meta-build  { platform: ios|android, appVersion: "1.2.1", build: "89", enabled: boolean }
//        public (the app reports at first launch, before anyone signs in), once per build per install; nothing
//        about the user or the device. 204. At most 20 reports per address per hour.
//   GET  /api/app/meta-builds  admin: the builds seen, newest first, and the ones reporting Meta off
const { rateLimit } = require('express-rate-limit');
const MetaBuildReport = require('../models/MetaBuildReport');
const User = require('../models/User');
const { clientIp } = require('../services/loginGuard');

const reportLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `meta-build:${clientIp(req)}`,
  validate: false, // the key is our own (last X-Forwarded-For entry), not req.ip
  handler: (req, res) => res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many reports' }),
});

router.post('/meta-build', reportLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const platform = String(b.platform || '');
    const appVersion = String(b.appVersion || '');
    const build = String(b.build ?? '');
    if (!['ios', 'android'].includes(platform) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(appVersion) || !/^\d{1,9}$/.test(build) || typeof b.enabled !== 'boolean') {
      return res.status(400).json({ code: 'INVALID_REPORT', message: 'platform, appVersion (x.y.z), build (digits) and enabled (true/false)' });
    }
    const now = new Date();
    await MetaBuildReport.updateOne(
      { platform, appVersion, build, enabled: b.enabled },
      { $inc: { count: 1 }, $set: { lastAt: now }, $setOnInsert: { firstAt: now } },
      { upsert: true }
    );
    res.status(204).end();
  } catch (err) {
    if (err?.code === 11000) return res.status(204).end(); // two first reports at once: the other one counted
    console.error('[meta-build] report failed:', err.message);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Something went wrong' });
  }
});

router.get('/meta-builds', auth, async (req, res) => {
  try {
    if (req.isGuest) return res.status(401).json({ message: 'Sign in first' });
    const me = await User.findById(req.userId).select('role').lean();
    if (me?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
    const rows = await MetaBuildReport.find({}).sort({ lastAt: -1 }).limit(200).lean();
    const builds = rows.map((r) => ({ platform: r.platform, appVersion: r.appVersion, build: r.build, enabled: r.enabled, installs: r.count, firstAt: r.firstAt, lastAt: r.lastAt }));
    res.set('Cache-Control', 'private, no-store');
    res.json({ builds, metaOff: builds.filter((b) => !b.enabled) });
  } catch (err) {
    console.error('[meta-build] list failed:', err.message);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

module.exports = router;
