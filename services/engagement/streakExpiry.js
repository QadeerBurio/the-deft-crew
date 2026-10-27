// services/engagement/streakExpiry.js
//
// Two evening reminders, sent by the scheduler in Asia/Karachi time:
//
// 1. 20:00 — "your streak expires tonight": every user whose streak will
//    break at midnight unless they do any activity today.
//    A user is "at risk" when ALL of these are true:
//      • streak.count > 0                  (they actually have a streak)
//      • streak.lastActionDay === yesterday (they haven't acted today)
//      • NOT in exam mode (examModeUntil >= today)
//      • their notifPrefs.streaks !== false (checked by the push gateway)
//    Users with freezesLeft > 0 are still warned — they need to know they
//    should either act or consciously burn a freeze.
//
// 2. 10:00 the morning a freeze saved the streak — "we saved your streak":
//    every user whose streak was kept by a freeze at the 00:05 rollover today.
//
// 3. 20:30 the next day — "your streak ended last night": every user whose
//    streak broke at the 00:05 rollover today and who has not started a new
//    one since (acting today clears brokenAt).
//
// All three are "essential" pushes: they skip the daily/weekly marketing caps
// (the 19:00 daily drop would otherwise use the one push a day up) but keep
// the streaks preference and quiet hours. Each job runs once a day (JobLock).

const EngagementProfile = require('../../models/EngagementProfile');
const JobLock = require('../../models/JobLock');
const { dayKey, yesterday } = require('../../utils/karachiTime');
const pushGateway = require('./pushGateway');

/**
 * Query the DB for all at-risk profiles. Uses an index-friendly filter.
 */
async function findAtRiskProfiles(today = dayKey()) {
  const yday = yesterday(today);

  return EngagementProfile.find({
    'streak.count': { $gt: 0 },
    'streak.lastActionDay': yday, // ← the critical filter
  })
    .select('user streak')
    .lean();
}

/**
 * Filter out users who are in exam mode. Done in JS because the
 * exam-mode condition is a comparison against `today`, which can't
 * be expressed cleanly as a Mongo query alongside the lastActionDay
 * filter (Mongo would need $expr and complicates indexes).
 */
function filterInExamMode(profiles, today) {
  return profiles.filter((p) => {
    const until = p.streak?.examModeUntil;
    return !until || until < today; // keep if NOT in exam mode
  });
}

/**
 * Check a single user's streak-at-risk status. Used by GET /streak/at-risk.
 */
async function isAtRisk(userId) {
  const today = dayKey();
  const yday = yesterday(today);

  const profile = await EngagementProfile.findOne({ user: userId })
    .select('streak')
    .lean();

  if (!profile?.streak) return { atRisk: false, reason: 'no_streak' };

  const s = profile.streak;
  if (!s.count || s.count <= 0) return { atRisk: false, reason: 'no_count' };
  if (s.lastActionDay === today)
    return { atRisk: false, reason: 'already_done_today' };
  if (s.lastActionDay !== yday)
    return { atRisk: false, reason: 'already_broken' };

  const inExamMode = s.examModeUntil && s.examModeUntil >= today;
  if (inExamMode)
    return { atRisk: false, reason: 'exam_mode', examModeUntil: s.examModeUntil };

  return {
    atRisk: true,
    count: s.count,
    best: s.best || 0,
    lastActionDay: s.lastActionDay,
    freezesLeft: s.freezesLeft ?? 1,
    expiresAt: `${today}T23:59:59+05:00`,
  };
}

// a 1-day streak gets its own line ("your streak ends at midnight"); 2 and up keep the n-day copy
const oneDayKey = (type, count) => (count === 1 ? `${type}_one` : undefined);

// sends one copy-bank push per profile; counts what the gateway reports
async function sendEach(profiles, type, varsFor, dataFor, tag, copyKeyFor = () => undefined) {
  let sent = 0;
  let skipped = 0;
  const errors = [];
  for (const p of profiles) {
    const uid = String(p.user);
    try {
      const r = await pushGateway.sendFromCopy(uid, type, 'streaks', varsFor(p), dataFor(p), { essential: true, copyKey: copyKeyFor(p) });
      if (r?.sent) sent++;
      else skipped++;
    } catch (err) {
      console.error(`[${tag}] failed for ${uid}:`, err.message);
      errors.push({ userId: uid, error: err.message });
    }
  }
  console.log(`[${tag}] sent=${sent} skipped=${skipped} errors=${errors.length} total=${profiles.length}`);
  return { sent, skipped, errors, total: profiles.length };
}

/**
 * 20:00 PKT — warn everyone whose streak expires at midnight.
 * Returns { sent, skipped, errors, total }. Never throws per user.
 */
async function sendStreakExpiryWarnings(today = dayKey()) {
  const profiles = filterInExamMode(await findAtRiskProfiles(today), today);
  if (!profiles.length) {
    console.log('[streakExpiry] no at-risk users');
    return { sent: 0, skipped: 0, errors: [], total: 0 };
  }
  return sendEach(
    profiles,
    'streak_warning',
    (p) => ({ count: p.streak?.count || 0, freezes: p.streak?.freezesLeft ?? 1 }),
    (p) => ({ route: 'Home', params: { streakAtRisk: p.streak?.count || 0, expiresAt: `${today}T23:59:59+05:00` } }),
    'streakExpiry',
    (p) => oneDayKey('streak_warning', p.streak?.count || 0)
  );
}

/**
 * The 20:00 warning, at most once a day whoever triggers it (the scheduler or
 * POST /streak/expiry-warnings/send). Both take the same JobLock id the
 * scheduler always used, so a second call the same day sends nothing.
 */
async function sendStreakExpiryWarningsOnce(today = dayKey()) {
  try {
    await JobLock.create({ _id: `streak_warning:${today}`, lockedAt: new Date(), owner: process.env.HOSTNAME || 'local' });
  } catch (err) {
    if (err.code === 11000) return { sent: 0, skipped: 0, errors: [], total: 0, alreadySent: true };
    throw err;
  }
  return sendStreakExpiryWarnings(today);
}

/**
 * Profiles whose streak broke at today's rollover and who have not acted
 * since (applyAction clears brokenAt when they start again).
 */
async function findLapsedProfiles(today = dayKey()) {
  const startOfToday = new Date(`${today}T00:00:00+05:00`);
  return EngagementProfile.find({
    'streak.count': 0,
    'streak.brokenAt': { $gte: startOfToday },
  })
    .select('user streak')
    .lean();
}

/**
 * 20:30 PKT, the day after the streak expired — tell the user it ended and
 * invite them to start again today.
 */
async function sendStreakLapsedReminders(today = dayKey()) {
  const profiles = (await findLapsedProfiles(today)).filter((p) => (p.streak?.brokenCount || 0) > 0);
  if (!profiles.length) {
    console.log('[streakLapsed] no lapsed users');
    return { sent: 0, skipped: 0, errors: [], total: 0 };
  }
  return sendEach(
    profiles,
    'streak_broken',
    (p) => ({ count: p.streak?.brokenCount || 0 }),
    (p) => ({ route: 'Home', params: { brokenStreak: p.streak?.brokenCount || 0 } }),
    'streakLapsed',
    (p) => oneDayKey('streak_broken', p.streak?.brokenCount || 0)
  );
}

/**
 * Profiles whose streak a freeze saved at today's rollover.
 */
async function findFrozenProfiles(today = dayKey()) {
  const startOfToday = new Date(`${today}T00:00:00+05:00`);
  return EngagementProfile.find({
    'streak.count': { $gt: 0 },
    'streak.frozenAt': { $gte: startOfToday },
  })
    .select('user streak')
    .lean();
}

/**
 * 10:00 PKT — tell users a freeze saved their streak last night. Moved here from
 * the 00:05 rollover, where quiet hours always dropped it.
 */
async function sendFreezeUsedNotices(today = dayKey()) {
  const profiles = await findFrozenProfiles(today);
  if (!profiles.length) {
    console.log('[freezeUsed] no frozen streaks');
    return { sent: 0, skipped: 0, errors: [], total: 0 };
  }
  return sendEach(
    profiles,
    'freeze_used',
    (p) => ({ count: p.streak?.count || 0, freezes: p.streak?.freezesLeft ?? 0 }),
    () => ({ route: 'Home', params: {} }),
    'freezeUsed'
  );
}

module.exports = {
  findAtRiskProfiles,
  filterInExamMode,
  isAtRisk,
  sendStreakExpiryWarnings,
  sendStreakExpiryWarningsOnce,
  findLapsedProfiles,
  sendStreakLapsedReminders,
  findFrozenProfiles,
  sendFreezeUsedNotices,
};
