// routes/appFlags.routes.js
// Public switches the app reads at launch (no sign-in, no personal data).
//
//   GET /api/app/flags → { metaEvents: boolean }
//
// metaEvents: Meta App Events in the app (still only after the student allows it in the
// app). Off unless the Railway variable META_EVENTS_ENABLED is exactly "true", so a missing
// or mistyped variable keeps Meta off. Changing it needs no app update.

const express = require('express');

const router = express.Router();

const isOn = (v) => String(v || '').trim().toLowerCase() === 'true';

router.get('/flags', (req, res) => {
  // short cache: a switch-off reaches phones within minutes
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ metaEvents: isOn(process.env.META_EVENTS_ENABLED) });
});

module.exports = router;
