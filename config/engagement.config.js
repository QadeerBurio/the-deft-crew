// config/engagement.config.js
module.exports = {
  TZ: 'Asia/Karachi',

  STAGE: Number(process.env.ENGAGEMENT_STAGE || 1),

  flags: (stage) => ({
    tour: true,
    missions: true,
    dailyDrop: true,
    popups: true,
    soloStreak: stage >= 2 || process.env.FORCE_STREAKS === '1',
    badges: stage >= 2 || process.env.FORCE_BADGES === '1',
    savingsCounter: true,
    duoStreak: stage >= 3,
    leaderboard: stage >= 3,
    winBack: stage >= 3,
  }),

  push: {
    weeklyCap: (stage) => (stage >= 3 ? 4 : 2),
    dailyCap: 1,
    quietStartHour: 23, // 23:00 PKT
    quietEndHour: 9,    // 09:00 PKT
  },

  points: {
    missionSorted: 50,
    fullySorted: 200,
    streakMilestone: {
      3: 20,
      7: 50,
      14: 100,
      30: 250,
      50: 400,
      100: 1000,
    },
    referral: 100,
     referralCredited: 100,   // 🆕 add this
  },

  og: { cutoff: '2026-12-31T23:59:59+05:00' },

  referral: {
    // Credit is only awarded when the referee sorts their FIRST card.
    firstSortOnly: true,
  },
};