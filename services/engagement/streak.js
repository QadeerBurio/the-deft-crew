// services/engagement/streak.js
// Pure functions for the streak engine.
// Spec §4.2–4.7.
//
// Returns from rollover():
//   { action: 'kept',  previousCount }
//   { action: 'froze', previousCount }
//   { action: 'broke', previousCount }
//   { action: 'noop',  previousCount }   (nothing to do — safe)

const { dayKey, yesterday } = require('../../utils/karachiTime');

const MILESTONES = [7, 30, 100];

// ─────────────────────────────────────────────────────────────
// HEALTH STATE — for UI (§4.7)
// ─────────────────────────────────────────────────────────────
function healthOf(streak, today = dayKey()) {
  if (!streak) return 'none';
  const count = streak.count || 0;
  const last = streak.lastActionDay || null;

  if (!last && count === 0 && !streak.brokenAt) return 'none';
  if (count === 0 && streak.brokenAt) return 'broken';
  if (last === today) return 'safe';

  // Before 20:00 PKT → still safe (still time to act)
  const nowPktHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
  );
  if (nowPktHour < 20) return 'safe';
  return 'at_risk';
}

// ─────────────────────────────────────────────────────────────
// APPLY ACTION — called inside engine.process()
// Returns { streak, extended, milestone }
// ─────────────────────────────────────────────────────────────
function applyAction(streak = {}, today = dayKey()) {
  const next = { ...streak };

  // Already acted today → no-op
  if (next.lastActionDay === today) {
    return { streak: next, extended: false, milestone: null };
  }

  const yesterdayKey = yesterday(today);

  let newCount;
  if (next.lastActionDay === yesterdayKey) {
    newCount = (next.count || 0) + 1;
  } else {
    newCount = 1;
  }

  next.count = newCount;
  next.best = Math.max(next.best || 0, newCount);
  next.lastActionDay = today;

  // Clear broken markers — streak is revived
  next.brokenAt = null;
  next.restorableUntil = null;

  // Milestone detection (only if never hit before)
  let milestone = null;
  if (MILESTONES.includes(newCount)) {
    const hit = Array.isArray(next.milestonesHit) ? next.milestonesHit : [];
    if (!hit.includes(newCount)) milestone = newCount;
  }

  return { streak: next, extended: true, milestone };
}

// ─────────────────────────────────────────────────────────────
// ROLLOVER — nightly check for ONE profile
// Mutates profile.streak in place. Returns action object.
//
//   'kept'   → streak is safe, nothing changed
//   'froze'  → missed a day, a freeze was used
//   'broke'  → missed a day, no freeze → streak reset to 0
//   'noop'   → nothing to do (no active streak)
// ─────────────────────────────────────────────────────────────
function rollover(profile, today = dayKey()) {
  const s = profile.streak || {};
  const count = s.count || 0;
  const last = s.lastActionDay || null;

  // No active streak → nothing to do
  if (count === 0 || !last) {
    return { action: 'noop', previousCount: count };
  }

  const yesterdayKey = yesterday(today);

  // Already acted yesterday or today → streak intact
  if (last >= yesterdayKey) {
    return { action: 'kept', previousCount: count };
  }

  // ── Exam mode absorbs the missed day ──
  if (s.examModeUntil && today <= s.examModeUntil) {
    profile.streak = { ...s, lastActionDay: yesterdayKey };
    return { action: 'kept', previousCount: count };
  }

  // ── Freeze available ──
  if ((s.freezesLeft || 0) > 0) {
    profile.streak = {
      ...s,
      freezesLeft: s.freezesLeft - 1,
      lastActionDay: yesterdayKey,
    };
    return { action: 'froze', previousCount: count };
  }

  // ── Break ──
  const now = new Date();
  const restorableUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  profile.streak = {
    ...s,
    count: 0,
    lastActionDay: null,
    brokenAt: now,
    restorableUntil,
  };

  return { action: 'broke', previousCount: count };
}

module.exports = {
  applyAction,
  healthOf,
  rollover,
  MILESTONES,
};