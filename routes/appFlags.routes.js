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
const { clientFlags } = require('../config/featureFlags');

const router = express.Router();

router.get('/flags', (req, res) => {
  // short cache: a switch-off reaches phones within minutes
  res.set('Cache-Control', 'public, max-age=60');
  res.json(clientFlags(null));
});

router.get('/flags/me', auth, (req, res) => {
  // per user: never cached by a shared cache
  res.set('Cache-Control', 'private, no-store');
  const user = req.isGuest ? { role: 'guest' } : { id: String(req.userId), role: req.userRole };
  res.json(clientFlags(user));
});

module.exports = router;
