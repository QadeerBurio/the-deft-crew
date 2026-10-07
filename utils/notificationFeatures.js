// utils/notificationFeatures.js
// ONE table for how every notification looks and sounds, per feature.
//   mood  → emoji in the title + dot image + in-app banner
//   sound → file played in the app AND by the phone when the app is closed
//
// Exact copies of this table live in:
//   app:   app/src/utils/notificationFeatures.js
//   admin: src/screens/TestPush.js (FEATURES)
// Change all three together.
//
// mood emojis: sorted 😊 excited 🤩 hype 😆 money 🤑 cheeky 😜 smug 😏
//              shook 😮 shock 😳 sus 😒 panic 😰 urgent 😨 sleepy 😴
//              broke 😢 ghost 😑

const FEATURES = {
  // ── Deals / offers / payments ──
  new_offer:        { mood: 'excited', sound: 'tdc_push_deal' },
  exclusive_offer:  { mood: 'excited', sound: 'tdc_push_deal' },
  nearby_deal:      { mood: 'money',   sound: 'tdc_push_deal' },
  try_discounts:    { mood: 'money',   sound: 'tdc_push_deal' },
  offer_claimed:    { mood: 'excited', sound: 'tdc_push_deal' },
  payment:          { mood: 'money',   sound: 'tdc_mood_rs' },
  redemption:       { mood: 'money',   sound: 'tdc_mood_rs' },

  // ── SkillShare ──
  offer_accepted:   { mood: 'hype',    sound: 'tdc_push_deal' },
  offer_rejected:   { mood: 'broke',   sound: 'tdc_nope' },
  match_created:    { mood: 'hype',    sound: 'tdc_push_deal' },
  listing_created:  { mood: 'excited', sound: 'tdc_push_deal' },
  listing_updated:  { mood: 'sorted',  sound: 'tdc_push_default' },
  listing_deleted:  { mood: 'sleepy',  sound: 'tdc_push_default' },
  try_skillshare:   { mood: 'cheeky',  sound: 'tdc_push_deal' },

  // ── Social ──
  like:                { mood: 'excited', sound: 'tdc_like' },
  comment:             { mood: 'cheeky',  sound: 'tdc_like' },
  reply:               { mood: 'cheeky',  sound: 'tdc_like' },
  mention:             { mood: 'shook',   sound: 'tdc_like' },
  follow:              { mood: 'smug',    sound: 'tdc_push_message' },
  request:             { mood: 'sus',     sound: 'tdc_push_message' },
  connection_accepted: { mood: 'hype',    sound: 'tdc_push_message' },
  request_declined:    { mood: 'broke',   sound: 'tdc_nope' },
  message:             { mood: 'cheeky',  sound: 'tdc_push_message' },
  Message:             { mood: 'cheeky',  sound: 'tdc_push_message' },
  try_social:          { mood: 'sus',     sound: 'tdc_push_message' },
  confession:          { mood: 'shock',   sound: 'tdc_push_confession' },
  confession_tease:    { mood: 'shock',   sound: 'tdc_push_confession' },

  // ── Careers / scholarships / events ──
  new_job:          { mood: 'hype',    sound: 'tdc_push_internship' },
  internship:       { mood: 'hype',    sound: 'tdc_push_internship' },
  job_application:  { mood: 'sorted',  sound: 'tdc_push_internship' },
  interview:        { mood: 'panic',   sound: 'tdc_push_internship' },
  try_jobs:         { mood: 'hype',    sound: 'tdc_push_internship' },
  try_resume:       { mood: 'sorted',  sound: 'tdc_push_internship' },
  scholarship:      { mood: 'shook',   sound: 'tdc_mood_shook' },
  try_scholarship:  { mood: 'shook',   sound: 'tdc_mood_shook' },
  event:            { mood: 'excited', sound: 'tdc_push_event' },
  try_events:       { mood: 'excited', sound: 'tdc_push_event' },
  try_traveling:    { mood: 'excited', sound: 'tdc_mood_excited' },

  // ── Streaks / points / levels ──
  daily_drop:       { mood: 'cheeky',  sound: 'tdc_mood_cheeky' },
  streak:           { mood: 'hype',    sound: 'tdc_push_streak' },
  streak_milestone: { mood: 'hype',    sound: 'tdc_push_streak' },
  streak_warning:   { mood: 'panic',   sound: 'tdc_push_streak' },
  streak_broken:    { mood: 'broke',   sound: 'tdc_mood_broke' },
  freeze_used:      { mood: 'sleepy',  sound: 'tdc_push_streak' },
  freeze_reset:     { mood: 'sorted',  sound: 'tdc_push_streak' },
  points:           { mood: 'money',   sound: 'tdc_push_points' },
  rs:               { mood: 'money',   sound: 'tdc_mood_rs' },
  referral_joined:  { mood: 'smug',    sound: 'tdc_push_points' },
  level_up:         { mood: 'hype',    sound: 'tdc_push_level_up' },
  badge:            { mood: 'excited', sound: 'tdc_push_level_up' },
  badge_earned:     { mood: 'excited', sound: 'tdc_push_level_up' },
  tier_unlocked:    { mood: 'hype',    sound: 'tdc_push_level_up' },
  card_sorted:      { mood: 'sorted',  sound: 'tdc_mood_sorted' },
  fully_sorted:     { mood: 'excited', sound: 'tdc_push_level_up' },

  // ── Re-engagement ──
  reminder:         { mood: 'panic',   sound: 'tdc_push_reminder' },
  win_back_soft:    { mood: 'sleepy',  sound: 'tdc_push_reminder' },
  win_back_ghost:   { mood: 'ghost',   sound: 'tdc_push_reminder' },
  welcome_back:     { mood: 'excited', sound: 'tdc_mood_excited' },
  new_for_you:      { mood: 'excited', sound: 'tdc_mood_excited' },
  app_update:       { mood: 'sorted',  sound: 'tdc_push_default' },
  alert:            { mood: 'urgent',  sound: 'tdc_push_reminder' },
  Security:         { mood: 'urgent',  sound: 'tdc_push_reminder' },

  // ── Generic (caller's mood is kept if it set one) ──
  transactional:    { mood: 'sorted',  sound: 'tdc_push_default', generic: true },
  System:           { mood: 'sorted',  sound: 'tdc_push_default', generic: true },
  system:           { mood: 'sorted',  sound: 'tdc_push_default', generic: true },
  transaction:      { mood: 'sorted',  sound: 'tdc_push_default', generic: true },
};

// Fallback sound by mood (only when the feature is unknown or generic)
const MOOD_SOUND = {
  sorted: 'tdc_mood_sorted', excited: 'tdc_mood_excited', panic: 'tdc_mood_panic',
  broke: 'tdc_mood_broke', sleepy: 'tdc_mood_sleepy', shook: 'tdc_mood_shook',
  sus: 'tdc_mood_sus', cheeky: 'tdc_mood_cheeky', rs: 'tdc_mood_rs',
  hype: 'tdc_mood_excited', money: 'tdc_mood_rs', smug: 'tdc_mood_cheeky',
  shock: 'tdc_mood_shook', urgent: 'tdc_mood_panic', ghost: 'tdc_mood_sleepy',
};

const MOOD_EMOJI = {
  sorted: '😊', excited: '🤩', hype: '😆', money: '🤑', cheeky: '😜', smug: '😏',
  shook: '😮', shock: '😳', sus: '😒', panic: '😰', urgent: '😨', sleepy: '😴',
  broke: '😢', ghost: '😑', rs: '🤑',
};

// Feature mood wins. For generic types (System/transactional) the caller's mood is kept.
function featureMood(type, mood) {
  const f = FEATURES[type];
  if (f && !f.generic) return f.mood;
  if (mood && MOOD_EMOJI[mood]) return mood;
  return f?.mood || 'sorted';
}

// Feature sound wins, then mood sound, then default.
function featureSound(type, mood) {
  const f = FEATURES[type];
  if (f && !f.generic) return f.sound;
  return MOOD_SOUND[mood] || f?.sound || 'tdc_push_default';
}

module.exports = { FEATURES, MOOD_SOUND, MOOD_EMOJI, featureMood, featureSound };
