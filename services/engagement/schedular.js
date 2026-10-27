// services/engagement/scheduler.js
// All cron jobs for the engagement system.
// Runs in Asia/Karachi timezone. Uses JobLock to prevent double-run on scaled servers.

const cron = require('node-cron');
const cfg = require('../../config/engagement.config');
const { dayKey, weekKey } = require('../../utils/karachiTime');
const JobLock = require('../../models/JobLock');
const EngagementProfile = require('../../models/EngagementProfile');
const DailyDrop = require('../../models/DailyDrop');
const streakSvc = require('./streak');
const pushGateway = require('./pushGateway');
const popups = require('./popups');
const streakExpiry = require('./streakExpiry');

// ─────────────────────────────────────────────────────────────
// JobLock helper — prevents concurrent runs across scaled instances
// ─────────────────────────────────────────────────────────────
async function lock(name, key) {
  const _id = `${name}:${key}`;
  try {
    await JobLock.create({
      _id,
      lockedAt: new Date(),
      owner: process.env.HOSTNAME || 'local',
    });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already ran today
    throw err;
  }
}

function start() {
  // ═════════════════════════════════════════════════════════════
  // 19:00 PKT — DAILY DROP
  // Publish today's drop + push to active users
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '0 19 * * *',
    async () => {
      if (!(await lock('drop_publish', dayKey()))) return;
      try {
        const today = dayKey();
        const drop = await DailyDrop.findOne({ dayKey: today });
        if (!drop || drop.status === 'archived') {
          console.log('[scheduler] drop_publish: no drop scheduled for', today);
          return;
        }

        drop.status = 'live';
        drop.pushedAt = new Date();
        await drop.save();

        // Send to users who haven't acted today
        const candidates = await EngagementProfile.find({
          'notifPrefs.dailyDrop': { $ne: false },
          $or: [
            { 'streak.count': { $lt: 2 } },
            { 'streak.lastActionDay': today },
            { 'streak.count': { $exists: false } },
          ],
        })
          .select('user')
          .limit(10000)
          .lean();

        // Tap opens the drop's content (job, offer, event...) or Home for polls
        const { resolveTargetAsync } = require('./drops');
        const target = await resolveTargetAsync(drop.contentRef, drop.type).catch(() => null);

        let sent = 0;
        for (const c of candidates) {
          const r = await pushGateway
            .sendFromCopy(c.user, 'daily_drop', 'dailyDrop', {}, {
              route: target?.route || 'Home',
              params: { ...(target?.params || {}), dayKey: today },
            })
            .catch(() => ({ sent: false }));
          if (r?.sent) sent++;
        }

        console.log(
          `[scheduler] drop_publish done: drop=${today} sent=${sent}/${candidates.length}`
        );
      } catch (err) {
        console.error('[scheduler] drop_publish failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  // ═════════════════════════════════════════════════════════════
  // 10:00 PKT — A FREEZE SAVED YOUR STREAK LAST NIGHT
  // Users whose streak a freeze kept at today's 00:05 rollover
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '0 10 * * *',
    async () => {
      if (!(await lock('freeze_used', dayKey()))) return;
      try {
        const r = await streakExpiry.sendFreezeUsedNotices(dayKey());
        console.log(`[scheduler] freeze_used done: sent=${r.sent}/${r.total}`);
      } catch (err) {
        console.error('[scheduler] freeze_used failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  // ═════════════════════════════════════════════════════════════
  // 20:00 PKT — STREAK EXPIRES TONIGHT
  // Warn users whose streak breaks at midnight unless they act today
  // (services/engagement/streakExpiry.js: exam mode excluded, essential push)
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '0 20 * * *',
    async () => {
      try {
        // takes the streak_warning lock itself, shared with the admin/cron route
        const r = await streakExpiry.sendStreakExpiryWarningsOnce(dayKey());
        if (r.alreadySent) return;
        console.log(`[scheduler] streak_warning done: sent=${r.sent}/${r.total}`);
      } catch (err) {
        console.error('[scheduler] streak_warning failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  // ═════════════════════════════════════════════════════════════
  // 20:30 PKT — STREAK ENDED LAST NIGHT (the day after it expired)
  // Users whose streak broke at today's 00:05 rollover and who have not
  // started again today
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '30 20 * * *',
    async () => {
      if (!(await lock('streak_lapsed', dayKey()))) return;
      try {
        const r = await streakExpiry.sendStreakLapsedReminders(dayKey());
        console.log(`[scheduler] streak_lapsed done: sent=${r.sent}/${r.total}`);
      } catch (err) {
        console.error('[scheduler] streak_lapsed failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  // ═════════════════════════════════════════════════════════════
  // 00:05 PKT — STREAK ROLLOVER
  // Detects freeze-used, streak-broken, exam-mode-kept
  // 🎯 THIS IS THE JOB THAT HANDLES "STREAK BROKEN" AUTO-NOTIFICATION
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '5 0 * * *',
    async () => {
      if (!(await lock('streak_rollover', dayKey()))) return;
      try {
        const today = dayKey();
        const cursor = EngagementProfile.find({ 'streak.count': { $gt: 0 } })
          .select('user streak notifPrefs pendingPopups')
          .cursor();

        let kept = 0;
        let froze = 0;
        let broke = 0;
        let examKept = 0;

        for await (const profile of cursor) {
          // 🔑 Capture BEFORE rollover — rollover resets count to 0 on break
          const prevCount = profile.streak?.count || 0;
          const prevBest = profile.streak?.best || 0;

          const result = streakSvc.rollover(profile, today);

          if (result.action === 'kept') {
            kept++;
            continue;
          }

          await profile.save();

          // ─────────────────────────────────────────────
          // CASE 1: FREEZE USED
          // ─────────────────────────────────────────────
          if (result.action === 'froze') {
            froze++;
            // The "we saved your streak" push goes out at 10:00 (freeze_used
            // below): 00:05 is inside quiet hours, so a push here was always dropped.
          }

          // ─────────────────────────────────────────────
          // CASE 2: STREAK BROKEN
          // ─────────────────────────────────────────────
          else if (result.action === 'broke') {
            broke++;
            // The push for a broken streak goes out at 20:30 the same day
            // (streak_lapsed above): 00:05 is inside quiet hours, so a push
            // here was always dropped. The in-app popup stays.

            // ✅ Also enqueue an in-app popup (celebration queue)
            try {
              await popups.enqueue(profile.user, {
                kind: 'streak_broken',
                mood: 'sleepy',
                line: `your ${prevCount} day streak broke. come back stronger.`,
                cta: {
                  label: 'start again',
                  route: 'Home',
                  params: {},
                },
                payload: { prevCount, prevBest },
                priority: 60,
              });
            } catch (e) {
              console.error(
                '[scheduler] streak_broken popup failed:',
                e.message
              );
            }
          }

          // ─────────────────────────────────────────────
          // CASE 3: EXAM MODE KEPT THE STREAK
          // ─────────────────────────────────────────────
          else if (result.action === 'exam_kept') {
            examKept++;
            console.log(
              `[scheduler] exam_mode preserved streak → user=${profile.user} count=${prevCount}`
            );
          }
        }

        console.log(
          `[scheduler] streak_rollover done: kept=${kept} froze=${froze} broke=${broke} exam=${examKept}`
        );
      } catch (err) {
        console.error('[scheduler] streak_rollover failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  // ═════════════════════════════════════════════════════════════
  // MON 00:00 PKT — WEEKLY FREEZE RESET
  // Every user gets 1 freeze back
  // ═════════════════════════════════════════════════════════════
  cron.schedule(
    '0 0 * * 1',
    async () => {
      if (!(await lock('freeze_reset', weekKey()))) return;
      try {
        const result = await EngagementProfile.updateMany(
          {},
          {
            $set: {
              'streak.freezesLeft': 1,
              'streak.freezeWeekKey': weekKey(),
            },
          }
        );

        console.log(
          `[scheduler] freeze_reset done: week=${weekKey()} modified=${result.modifiedCount}`
        );
      } catch (err) {
        console.error('[scheduler] freeze_reset failed:', err.message);
      }
    },
    { timezone: cfg.TZ }
  );

  console.log('⏰ [engagement] scheduler started — 6 jobs registered');
}

module.exports = { start };