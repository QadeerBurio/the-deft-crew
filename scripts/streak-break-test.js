// scripts/test-streak-break.js
// Force a streak break and send the push — for testing.
// Usage: node scripts/test-streak-break.js user@email.com

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const EngagementProfile = require('../models/EngagementProfile');
const User = require('../models/User');
const streakSvc = require('../services/engagement/streak');
const pushGateway = require('../services/engagement/pushGateway');
const popups = require('../services/engagement/popups');
const { dayKey, addDays } = require('../utils/karachiTime');

async function main() {
  await connectDB();

  const email = process.argv[2];
  if (!email) {
    console.log('usage: node scripts/test-streak-break.js user@email.com');
    process.exit(1);
  }

  const user = await User.findOne({ email }).select('_id name').lean();
  if (!user) {
    console.log('❌ user not found');
    process.exit(1);
  }

  const profile = await EngagementProfile.findOne({ user: user._id });
  if (!profile) {
    console.log('❌ no engagement profile — user has never triggered engagement');
    process.exit(1);
  }

  // Force a breakable state: 5-day streak, last action 3 days ago, NO freeze
  const oldDay = addDays(dayKey(), -3);
  const prevCount = 5;

  profile.streak = {
    ...(profile.streak || {}),
    count: prevCount,
    best: Math.max(profile.streak?.best || 0, prevCount),
    lastActionDay: oldDay,
    freezesLeft: 0,
    examModeUntil: null,
    brokenAt: null,
    restorableUntil: null,
  };
  await profile.save();

  console.log(`[setup] user=${email} streak=${prevCount} lastAction=${oldDay}`);

  // Run rollover
  const today = dayKey();
  const result = streakSvc.rollover(profile, today);
  console.log(`[rollover] action: ${result.action}`);

  if (result.action === 'kept') {
    console.log('nothing to do — streak still safe');
    await mongoose.disconnect();
    process.exit(0);
  }

  await profile.save();
  console.log(`[rollover] saved. new count: ${profile.streak.count}`);

  // ── Push ──
  if (result.action === 'broke') {
    console.log('[push] sending streak_broken...');
    const r = await pushGateway.sendFromCopy(
      user._id,
      'streak_broken',
      'streaks',
      { count: prevCount },
      {
        route: 'Home',
        params: { brokenStreak: prevCount, restorable: true },
      }
    );
    console.log('[push] result:', r);

    // ── Popup ──
    console.log('[popup] enqueueing...');
    await popups.enqueue(user._id, {
      kind: 'streak_broken',
      mood: 'sleepy',
      line: `your ${prevCount} day streak broke. come back stronger.`,
      cta: { label: 'start again', route: 'Home', params: {} },
      payload: { prevCount },
      priority: 60,
    });
    console.log('[popup] enqueued');
  } else if (result.action === 'froze') {
    console.log('[push] sending freeze_used...');
    const r = await pushGateway.sendFromCopy(
      user._id,
      'freeze_used',
      'streaks',
      { count: prevCount },
      { route: 'Home', params: {} }
    );
    console.log('[push] result:', r);
  }

  console.log('✅ done');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});