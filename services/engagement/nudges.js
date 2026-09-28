// services/engagement/nudges.js
const EngagementProfile = require('../../models/EngagementProfile');
const pushGateway = require('./pushGateway');

const FEATURE_MAP = {
  discounts:   { copyKey: 'try_discounts',   route: 'Brands' },
  resume:      { copyKey: 'try_resume',      route: 'Resume' },
  jobs:        { copyKey: 'try_jobs',        route: 'Career' },
  social:      { copyKey: 'try_social',      route: 'Social' },
  events:      { copyKey: 'try_events',      route: 'Events' },
  scholarship: { copyKey: 'try_scholarship', route: 'Exchange' },
  skillshare:  { copyKey: 'try_skillshare',  route: 'Dashboard' },
  traveling:   { copyKey: 'try_traveling',   route: 'Travelling' },
};

const CHAIN = {
  discounts: 'scholarship',
  scholarship: 'jobs',
  jobs: 'resume',
  resume: 'events',
  events: 'social',
  social: 'skillshare',
  skillshare: 'traveling',
  traveling: 'discounts',
};

function pickFeature(profile) {
  if (!profile) return null;
  const all = Object.keys(FEATURE_MAP);
  const unused = all.filter((f) => !profile.sorted?.[f]);
  if (unused.length === 0) return null;

  const sortedCount = profile.sortedCount || 0;
  if (sortedCount === 0) return 'discounts';

  const last = profile.lastSortedFeature;
  if (last && CHAIN[last] && unused.includes(CHAIN[last])) return CHAIN[last];
  return unused[0];
}

async function sendFeatureNudge(userId) {
  const profile = await EngagementProfile.findOne({ user: userId });
  if (!profile) return { sent: false, reason: 'no_profile' };
  if (profile.sortedCount === 8) return { sent: false, reason: 'fully_sorted' };

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (profile.stats?.lastActiveAt && new Date(profile.stats.lastActiveAt) < sevenDaysAgo) {
    return { sent: false, reason: 'inactive' };
  }

  const feature = pickFeature(profile);
  if (!feature) return { sent: false, reason: 'no_feature' };

  const mapping = FEATURE_MAP[feature];
  const result = await pushGateway.sendFromCopy(
    userId,
    mapping.copyKey,
    null,
    {},
    { route: mapping.route, params: {} }
  );

  return { ...result, feature, copyKey: mapping.copyKey };
}

module.exports = { sendFeatureNudge, pickFeature, FEATURE_MAP, CHAIN };