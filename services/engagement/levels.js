// services/engagement/levels.js
// Evaluates which tiers a profile has newly qualified for.
// Returns an ORDERED array of tier ids (low → high).
// Does NOT persist — the caller (engine.js) applies rewards.

const { LEVELS } = require('../../config/badges');

function evaluate(profile) {
  if (!profile) return [];

  const lifetime         = profile.points?.lifetime         || 0;
  const lifetimeReferral = profile.points?.lifetimeReferral || 0;
  const activityPoints   = lifetime - lifetimeReferral;
  const verifiedRefs     = profile.verifiedReferralCount    || 0;
  const issued           = new Set(profile.level?.tiersIssued || []);

  const newlyCrossed = [];

  for (const tier of LEVELS) {
    if (issued.has(tier.id)) continue;
    if (tier.requiresApply) continue;

    const passesTotal = lifetime       >= tier.points;
    const passesFloor = activityPoints >= tier.activityFloor;
    const passesRefs  = verifiedRefs   >= tier.referrals;

    if (passesTotal && passesFloor && passesRefs) {
      newlyCrossed.push(tier.id);
    }
  }

  return newlyCrossed;
}

function nextTierStatus(profile) {
  if (!profile) return null;

  const lifetime         = profile.points?.lifetime         || 0;
  const lifetimeReferral = profile.points?.lifetimeReferral || 0;
  const activityPoints   = lifetime - lifetimeReferral;
  const verifiedRefs     = profile.verifiedReferralCount    || 0;
  const issued           = new Set(profile.level?.tiersIssued || []);

  for (const tier of LEVELS) {
    if (issued.has(tier.id)) continue;

    const missing = {
      points:    Math.max(0, tier.points        - lifetime),
      activity:  Math.max(0, tier.activityFloor - activityPoints),
      referrals: Math.max(0, tier.referrals     - verifiedRefs),
    };

    return {
      tier: {
        id:            tier.id,
        label:         tier.label || tier.id,
        points:        tier.points,
        activityFloor: tier.activityFloor,
        referrals:     tier.referrals,
        reward:        tier.reward,
        discount:      tier.discount || null,
        requiresApply: !!tier.requiresApply,
      },
      missing,
      applyAvailable:
        !!tier.requiresApply &&
        missing.points === 0 &&
        missing.activity === 0 &&
        missing.referrals === 0,
      progress: {
        points:    tier.points        > 0 ? Math.min(1, lifetime / tier.points)                : 1,
        activity:  tier.activityFloor > 0 ? Math.min(1, activityPoints / tier.activityFloor)   : 1,
        referrals: tier.referrals     > 0 ? Math.min(1, verifiedRefs / tier.referrals)         : 1,
      },
    };
  }

  return null;
}

function diagnostic(profile) {
  if (!profile) return null;
  const lifetime         = profile.points?.lifetime         || 0;
  const lifetimeReferral = profile.points?.lifetimeReferral || 0;
  const activityPoints   = lifetime - lifetimeReferral;
  const verifiedRefs     = profile.verifiedReferralCount    || 0;
  const issued           = new Set(profile.level?.tiersIssued || []);

  return {
    lifetime, lifetimeReferral, activityPoints, verifiedRefs,
    currentLevel: profile.level?.id || 'member',
    tiersIssued: Array.from(issued),
    tiers: LEVELS.map((tier) => ({
      id: tier.id,
      issued: issued.has(tier.id),
      need: {
        points:    Math.max(0, tier.points        - lifetime),
        activity:  Math.max(0, tier.activityFloor - activityPoints),
        referrals: Math.max(0, tier.referrals     - verifiedRefs),
      },
    })),
  };
}

module.exports = { evaluate, nextTierStatus, diagnostic };