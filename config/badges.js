// config/badges.config.js
// ═══════════════════════════════════════════════════════════
// TDC engagement config — single source of truth
//   • badges  (26 → will become 25 after removing referral_10000)
//   • levels  (6 tiers: rookie → founder)
//   • helpers
// ═══════════════════════════════════════════════════════════

const OG_CUTOFF = new Date(process.env.OG_CUTOFF || '2026-12-31T23:59:59+05:00');

// ═══════════════════════════════════════════════════════════
// BADGES
// ═══════════════════════════════════════════════════════════
const badges = [
  // ─── FEATURE BADGES (8) ─────────────────────────────────
  { id: 'feature_discounts',   group: 'features', mood: 'broke',   title: 'deal hunter',       line: 'you never pay full price.',           points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.discounts != null },
  { id: 'feature_resume',      group: 'features', mood: 'sorted',  title: 'cv ready',          line: 'your cv is sorted.',                  points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.resume != null },
  { id: 'feature_jobs',        group: 'features', mood: 'excited', title: 'first application', line: 'you applied. thats the hard part.',   points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.jobs != null },
  { id: 'feature_social',      group: 'features', mood: 'sus',     title: 'said it first',     line: 'you posted. anonymously or not.',     points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.social != null },
  { id: 'feature_events',      group: 'features', mood: 'excited', title: 'showed up',         line: 'you rsvped. see you there.',          points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.events != null },
  { id: 'feature_scholarship', group: 'features', mood: 'shook',   title: 'big dreams',        line: 'you went for it.',                    points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.scholarship != null },
  { id: 'feature_skillshare',  group: 'features', mood: 'cheeky',  title: 'skill swap',        line: 'you taught. you learned.',            points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.skillshare != null },
  { id: 'feature_traveling',   group: 'features', mood: 'sleepy',  title: 'somewhere new',     line: 'you booked the trip.',                points: 0, perkRewardId: null,
    rule: (p) => p?.sorted?.traveling != null },

  // Fully sorted
  { id: 'fully_sorted', group: 'features', mood: 'sorted', title: 'fully sorted', line: 'all 8 cards. no notes.', points: 200, perkRewardId: 'AUTO_CHEAPEST',
    rule: (p) => p?.sortedCount === 8 },

  // ─── REFERRAL MILESTONE BADGES (8) — stops at 5k ────────
  // ─── REFERRAL MILESTONE BADGES (8) — verified counts ────
{ id: 'referral_10',    group: 'referrals', mood: 'excited', title: '10 verified',    line: '10 friends joined and sorted.', points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 10 },
{ id: 'referral_50',    group: 'referrals', mood: 'cheeky',  title: '50 verified',    line: 'half a hundred. respect.',      points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 50 },
{ id: 'referral_100',   group: 'referrals', mood: 'sorted',  title: '100 verified',   line: 'a movement, not a moment.',     points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 100 },
{ id: 'referral_500',   group: 'referrals', mood: 'shook',   title: '500 verified',   line: 'you built a crowd.',            points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 500 },
{ id: 'referral_1000',  group: 'referrals', mood: 'panic',   title: '1,000 verified', line: 'four digits deep.',             points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 1000 },
{ id: 'referral_2000',  group: 'referrals', mood: 'excited', title: '2,000 verified', line: 'unstoppable. unreal.',          points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 2000 },
{ id: 'referral_3000',  group: 'referrals', mood: 'cheeky',  title: '3,000 verified', line: 'legendary status.',             points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 3000 },
{ id: 'referral_5000',  group: 'referrals', mood: 'shook',   title: '5,000 verified', line: 'top of the mountain.',          points: 0, perkRewardId: null,
  rule: (p) => (p?.verifiedReferralCount || 0) >= 5000 },

  // ─── SAVINGS (3) ────────────────────────────────────────
  { id: 'saved_1k',  group: 'savings', mood: 'broke',   title: 'Rs 1k saved',  line: 'thats a free lunch. twice.', points: 0, perkRewardId: null,
    rule: (p) => (p?.stats?.totalSaved || 0) >= 1000 },
  { id: 'saved_5k',  group: 'savings', mood: 'cheeky',  title: 'Rs 5k saved',  line: 'youre winning.',             points: 50, perkRewardId: null,
    rule: (p) => (p?.stats?.totalSaved || 0) >= 5000 },
  { id: 'saved_10k', group: 'savings', mood: 'excited', title: 'Rs 10k saved', line: 'thats a whole trip.',        points: 100, perkRewardId: null,
    rule: (p) => (p?.stats?.totalSaved || 0) >= 10000 },

  // ─── STREAKS (3) ────────────────────────────────────────
  { id: 'streak_7',   group: 'streaks', mood: 'sorted',  title: '7 day streak',   line: 'one week. consistent.', points: 50,   perkRewardId: null,
    rule: (p) => (p?.streak?.best || 0) >= 7 },
  { id: 'streak_30',  group: 'streaks', mood: 'excited', title: '30 day streak',  line: 'a month. respect.',     points: 250,  perkRewardId: null,
    rule: (p) => (p?.streak?.best || 0) >= 30 },
  { id: 'streak_100', group: 'streaks', mood: 'panic',   title: '100 day streak', line: 'unreal. dont stop.',    points: 1000, perkRewardId: null,
    rule: (p) => (p?.streak?.best || 0) >= 100 },

  // ─── STATUS (2) ─────────────────────────────────────────
  { id: 'og', group: 'status', mood: 'sorted', title: 'og', line: 'you were here first.', points: 0, perkRewardId: null,
    rule: (p, user) => user?.createdAt && new Date(user.createdAt) <= OG_CUTOFF },
  { id: 'confession_of_the_day', group: 'status', mood: 'sus', title: 'confession of the day', line: 'you said it best.', points: 0, perkRewardId: null,
    rule: (p, user, ctx) => ctx?.confessionPicked === true },
];

// ═══════════════════════════════════════════════════════════
// LEVELS
// 3 conditions must ALL pass for a tier to unlock:
//   1. total points (activity + referral) >= tier.points
//   2. activity points alone               >= tier.activityFloor  (30% floor)
//   3. verified referral count             >= tier.referrals
// Founder circle is gated behind MSB approval (requiresApply).
// ═══════════════════════════════════════════════════════════
const LEVELS = [
  {
    id: 'rookie',
    label: 'deft rookie',
    points: 300,
    activityFloor: 300,
    referrals: 0,
    reward: 'badge',
  },
  {
    id: 'starter',
    label: 'deft starter',
    points: 1000,
    activityFloor: 300,
    referrals: 10,
    reward: 'badge_upgraded',
  },
  {
    id: 'silver',
    label: 'silver',
    points: 2000,
    activityFloor: 600,
    referrals: 20,
    reward: 'silver_card',
    discount: { pct: 10, capRs: 350 },
  },
  {
    id: 'gold',
    label: 'gold',
    points: 3000,
    activityFloor: 900,
    referrals: 30,
    reward: 'gold_card',
    discount: { pct: 15, capRs: 500 },
  },
  {
    id: 'platinum',
    label: 'platinum',
    points: 6000,
    activityFloor: 1800,
    referrals: 40,
    reward: 'platinum_card',
    discount: { pct: 20, capRs: 750 },
  },
  {
    id: 'founder',
    label: 'founder circle',
    points: 8000,
    activityFloor: 2400,
    referrals: 50,
    reward: 'founder_card',
    discount: { pct: 25, capRs: 1000 },
    requiresApply: true,
    maxSeats: 50,
  },
];

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const byId = Object.fromEntries(badges.map((b) => [b.id, b]));
const total = badges.length;

// Highest tier whose `points` threshold is met (display only —
// not for issuing tiers, see services/engagement/levels.js).
function currentLevelFor(lifetime) {
  let current = LEVELS[0];
  for (const l of LEVELS) {
    if (lifetime >= l.points) current = l;
  }
  return current;
}

// Founder circle needs 3000 REAL activity points (not the 2400 floor),
// because 50 referrals only supply 5,000 of the 8,000 total.
const FOUNDER_REAL_ACTIVITY = 3000;

module.exports = {
  // badges
  badges,
  byId,
  total,
  OG_CUTOFF,

  // levels
  LEVELS,
  currentLevelFor,
  FOUNDER_REAL_ACTIVITY,
};