// services/engagement/missions.js
const FEATURES = [
  'discounts', 'resume', 'jobs', 'social',
  'events', 'scholarship', 'skillshare', 'traveling',
];

// After X, prefer Y (the "next-card" rule)
const PREFERENCE = {
  jobs: 'resume',
  scholarship: 'resume',
  discounts: 'events',
  events: 'social',
};

// Mission copy (server-owned, so social can change without an app release)
const LINES = {
  discounts:   { before: 'paying full price? never again.',           after: 'rs saved. sorted.' },
  resume:      { before: 'cv from matric? lets fix that.',            after: 'your cv is sorted.' },
  jobs:        { before: 'your first internship wont apply itself.',  after: 'you applied. thats the hard part.' },
  social:      { before: 'say it. anonymously or not.',               after: 'you said it.' },
  events:      { before: 'something happening on campus.',            after: 'you rsvped. see you there.' },
  scholarship: { before: 'big dreams. bigger applications.',          after: 'you went for it.' },
  skillshare:  { before: 'teach something. learn something.',         after: 'skill swapped.' },
  traveling:   { before: 'somewhere new is waiting.',                 after: 'trip booked.' },
};

// Route hints for the mobile CTA button
const ROUTES = {
  discounts:   { route: 'Brands', params: {} },
  resume:      { route: 'Resume', params: {} },
  jobs:        { route: 'Career', params: {} },
  social:      { route: 'Social', params: { initialTab: 'Confession' } },
  events:      { route: 'Events', params: {} },
  scholarship: { route: 'Exchange', params: {} },
  skillshare:  { route: 'Dashboard', params: {} },
  traveling:   { route: 'Travelling', params: {} },
};

/**
 * Choose the next unsorted feature for a profile, honoring the preference map
 * and snoozes. Returns feature id or null.
 */
function nextCard(profile) {
  if (!profile) return FEATURES[0];
  const now = Date.now();

  const snoozed = new Set(
    (profile.snoozes || [])
      .filter(s => s.until && new Date(s.until).getTime() > now)
      .map(s => s.feature)
  );

  const unsorted = FEATURES.filter(f => !profile.sorted?.[f] && !snoozed.has(f));
  if (unsorted.length === 0) return null;

  // If the last sorted feature suggests a follow-up, prefer it
  const last = profile.lastSortedFeature;
  if (last && PREFERENCE[last] && unsorted.includes(PREFERENCE[last])) {
    return PREFERENCE[last];
  }

  // Otherwise first unsorted in plan order
  return unsorted[0];
}

function linesFor(feature, sorted) {
  const l = LINES[feature] || { before: '', after: '' };
  return sorted ? l.after : l.before;
}

module.exports = { FEATURES, LINES, ROUTES, PREFERENCE, nextCard, linesFor };