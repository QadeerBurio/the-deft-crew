// services/engagement/copy.js
// Two tones, one app:
//   • Screens/buttons: lowercase + no emoji
//   • Push/toast: louder GenZ/Roman-Urdu mixed (this file)
// Each type is an ARRAY — one variant picked per firing.
// Tracks last-used index per (user, type) so no immediate repeats.

const BANK = {
  // ══════════════════════════════════════════════
  // IN-APP POPUPS
  // ══════════════════════════════════════════════
  card_sorted: {
    mood: 'sorted',
    variants: ['sorted.'],
  },
  fully_sorted: {
    mood: 'excited',
    variants: ['all 8. fully sorted.'],
  },
  freeze_used: {
    mood: 'sleepy',
    variants: ['we saved your {count} day streak. one freeze used.'],
  },
  streak_milestone: {
    mood: 'excited',
    variants: ['your {count} day streak. respect.'],
  },

  // ══════════════════════════════════════════════
  // STREAK AT RISK — icon: urgent · no emoji · deadpan
  // ══════════════════════════════════════════════
  streak_warning: {
    mood: 'panic',
    variants: [
      'you do this every night. 15 mins left.',
      "12 days. don't be the guy who breaks it on a tuesday.",
      "your streak is flatlining. cpr's free, just open the app.",
      'bhai your streak is literally about to die. 15 mins left.',
      "streak on the edge rn. don't be that guy.",
      "your {count}-day streak said 'don't leave me hanging' — 20 mins left",
      'last call. streak dies at midnight. you know what to do.',
      '{count} days of pure grind about to flatline. 15 min countdown.',
      "we've seen this movie before. you always open at 11:58. cutting it close again?",
    ],
  },

  streak_broken: {
    mood: 'sleepy',
    variants: [
      'your {count} day streak broke. come back stronger.',
      '{count} days gone. new start tomorrow.',
      'streak reset. no drama, just reload.',
      'you missed a day. the grind continues.',
    ],
  },

  // ══════════════════════════════════════════════
  // DAILY DROP — icon: sus
  // ══════════════════════════════════════════════
  daily_drop: {
    mood: 'sus',
    variants: [
      "tonight's confession is going to end a friendship.",
      'someone in your uni said something wild. 7pm.',
      "this drop's not for the weak.",
      'read this before your group chat does.',
      "someone's confession tonight is wild. go see who got picked",
      "new drop just landed. this one's screenshot material fr.",
      'deals + confessions + chaos, served fresh. 7pm drop is live.',
      "your uni's version of prime time. tonight's drop is up.",
      "7pm. tonight's confession has main character energy and you're not in it yet.",
    ],
  },

  // ══════════════════════════════════════════════
  // BADGE EARNED — icon: excited · emoji allowed
  // ══════════════════════════════════════════════
  badge_earned: {
    mood: 'excited',
    variants: [
      '{badge_name}. took you long enough.',
      'unlocked. most people quit before this one.',
      "{badge_name} — proof you're not just lurking.",
      'BOOM. {badge_name} unlocked. flex it.',
      'certified {badge_name} holder now. screenshot this, you earned it.',
      "you're one of the few. {badge_name} says so now, permanently.",
      '{badge_name}. rare. like Wi-Fi that actually works on campus.',
    ],
  },

  // ══════════════════════════════════════════════
  // LEVEL UP — icon: hype · emoji allowed
  // ══════════════════════════════════════════════
  tier_unlocked: {
    mood: 'hype',
    variants: [
      "LEVEL UP. you're {tier} now. card's ready, discount's live.",
      'welcome to {tier}. this is not a drill, your perks just got real.',
      'you clawed your way to {tier}. respect. go claim your card.',
      '{tier} unlocked. {discount}% off just kicked in — go use it before you forget.',
      "the crew has a new {tier} member. that's you. that's actually you.",
      "you're {tier} now. this is the part where you tell everyone, subtly.",
      "level: {tier}. we'd throw confetti but this is a phone.",
    ],
  },

  // ══════════════════════════════════════════════
  // REFERRAL — icon: smug · emoji allowed
  // ══════════════════════════════════════════════
  referral_joined: {
    mood: 'smug',
    variants: [
      "{friend_name} just joined with YOUR code. that's 100 points, straight up.",
      'you put someone on. {friend_name} joined tdc because of you. +100 pts',
      "recruiter era activated. {friend_name} is in, you're up 100 points.",
      "{friend_name} joined on your code. you're basically a talent scout now. +100 pts.",
      'you turned a friend into a user. dark, but effective.',
      'referral logged. {friend_name} owes you one. we already paid you.',
    ],
  },

  // ══════════════════════════════════════════════
  // WIN-BACK
  // ══════════════════════════════════════════════
  win_back_soft: {
    mood: 'sleepy',
    variants: [
      'we kept your seat warm. {n} deals dropped since you left.',
      'your account said "it\'s been a minute." prove it wrong.',
      'campus moved on without you a little. come see what you missed.',
      'not to guilt trip but... {n} confessions happened without you reading them',
    ],
  },
  win_back_ghost: {
    mood: 'ghost',
    variants: [
      "it's been {n} days. your app icon has started to wonder about you.",
      "you left. the deals didn't. neither did we, technically. we're a notification.",
      'your streak died alone. no one came.',
      "fun fact: you've saved Rs {n} on this app. also fact: you ghosted us.",
      "{n} days of silence. we're not mad. we're just going to remind you forever.",
      "everything's still here. you're the only thing that left.",
    ],
  },

  // ══════════════════════════════════════════════
  // NEARBY DEAL — icon: money
  // ══════════════════════════════════════════════
  nearby_deal: {
    mood: 'money',
    variants: [
      "you're literally standing next to a deal rn. {brand} — {discount}% off, go in.",
      "{brand} is 200m away. so is a discount you're about to walk past.",
      '{brand} nearby, {discount}% off with your tdc code. this is not a coincidence.',
      "{brand} noticed you're nearby. we told them. don't make it weird.",
      "you're closer to saving money right now than you've been all week.",
    ],
  },

  confession_tease: {
    mood: 'shock',
    variants: [
      'the confession tonight is causing problems. go see who it is.',
      "someone's confession is about to become campus folklore.",
      "tonight's confession has main character syndrome.",
    ],
  },

  // ══════════════════════════════════════════════
  // FEATURE NUDGES (try_*)
  // ══════════════════════════════════════════════
  try_discounts: {
    mood: 'broke',
    variants: [
      'deals you walked past this week. still there.',
      '{count} offers live near you. take a look.',
    ],
  },
  try_scholarship: {
    mood: 'shook',
    variants: [
      'you sorted deals. now sort scholarships. rs 500k+ waiting.',
      'rs 500k+ in scholarships. 3 minutes to apply.',
    ],
  },
  try_jobs: {
    mood: 'excited',
    variants: [
      'new internships match your cv. 3 minutes to apply.',
      'job board refreshed. something might click today.',
    ],
  },
  try_resume: {
    mood: 'sorted',
    variants: [
      "your cv isn't sorted yet. fix it in 5 minutes.",
      'cv not uploaded. employers scroll past. fix that.',
    ],
  },
  try_events: {
    mood: 'excited',
    variants: [
      'something happening on campus this week.',
      'events near you just went live. rsvp?',
    ],
  },
  try_social: {
    mood: 'sus',
    variants: [
      'say it. anonymously or not. the feed is waiting.',
      'confessions section is fresh today. drop something.',
    ],
  },
  try_skillshare: {
    mood: 'cheeky',
    variants: [
      'teach something. learn something. skill swap is live.',
      "someone's offering exactly what you need. check it.",
    ],
  },
  try_traveling: {
    mood: 'sleepy',
    variants: [
      'somewhere new is waiting. trips from rs 15k.',
      'weekend plans? look at trips near you.',
    ],
  },

  // ══════════════════════════════════════════════
  // OFFERS
  // ══════════════════════════════════════════════
  new_offer: {
    mood: 'excited',
    variants: [
      'new offer from {brand}: {discount}% off. claim in 1 tap.',
      "{brand} just dropped {discount}% off. grab it before it's gone.",
      'deal alert: {brand} — {discount}% off for you.',
    ],
  },
  exclusive_offer: {
    mood: 'excited',
    variants: [
      'exclusive for you: {brand} · {discount}% off. expires soon.',
      'just for you: {brand}, {discount}% off. one-tap claim.',
    ],
  },

  // ══════════════════════════════════════════════
  // SYSTEM
  // ══════════════════════════════════════════════
  app_update: {
    mood: 'sorted',
    variants: [
      'tdc just got better. new features live. update now.',
      'fresh version is out. tap to update.',
    ],
  },
  freeze_reset: {
    mood: 'sorted',
    variants: [
      'weekly freeze reset. your streak is protected.',
      'freeze is back. keep the streak alive.',
    ],
  },
  welcome_back: {
    mood: 'excited',
    variants: ['welcome back. your {count} points are waiting.'],
  },
  new_for_you: {
    mood: 'excited',
    variants: ['something new for you on tdc.'],
  },
  transactional: {
    mood: 'sorted',
    variants: ['{message}'],
  },
};

// ─────────────────────────────────────────────────
// Variant picker — avoids repeating last-used per (user, type)
// ─────────────────────────────────────────────────
const lastUsedIndex = new Map();

function pickVariant(type, variants, userId) {
  if (!variants || variants.length === 0) return '';
  if (variants.length === 1) return variants[0];

  const key = userId ? `${userId}:${type}` : `_global:${type}`;
  const prev = lastUsedIndex.get(key);

  let idx;
  if (variants.length > 1) {
    do {
      idx = Math.floor(Math.random() * variants.length);
    } while (idx === prev);
  } else {
    idx = 0;
  }
  lastUsedIndex.set(key, idx);

  return variants[idx];
}

function fill(key, vars = {}, userId = null) {
  const entry = BANK[key];
  if (!entry) return { title: '', body: '', mood: 'sorted' };

  const chosen = pickVariant(key, entry.variants, userId);
  let body = chosen;

  for (const [k, v] of Object.entries(vars || {})) {
    body = body.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }

  const { featureMood } = require('../../utils/notificationFeatures');
  return { title: '', body, mood: featureMood(key, entry.mood || 'sorted') };
}

module.exports = { BANK, fill, pickVariant };