// services/engagement/engine.js
// Central event pipeline. Every user action flows through here.
// Steps (in order):
//   1. Write EngagementEvent (idempotent on dedupeKey)
//   2. Ensure profile exists
//   3. Update stats (lastActiveAt, lastFeatureUsed, totalSaved)
//   4. Mission sort — award 50 pts, popup, referral credit on sortedCount 0→1
//   5. Streak — apply action, award milestones, popup
//   6. Badges — evaluate + grant + popup + push
//   7. Levels — evaluate + issue tier + popup + push
//   8. Return pending popups

const EngagementEvent = require('../../models/EngagementEvent');
const EngagementProfile = require('../../models/EngagementProfile');
const UserBadge = require('../../models/UserBadge');
const User = require('../../models/User');
const { dayKey } = require('../../utils/karachiTime');
const cfg = require('../../config/engagement.config');
const points = require('./points');
const missions = require('./missions');
const streakSvc = require('./streak');
const badges = require('./badges');
const popups = require('./popups');
const pushGateway = require('./pushGateway');
const levels = require('./levels');

const STREAK_EVENTS = new Set([
  'deal_redeemed', 'cv_completed', 'resume_created',
  'job_applied', 'job_saved', 'social_posted', 'social_commented',
  'event_rsvp', 'scholarship_saved', 'scholarship_applied',
  'skill_posted', 'skill_swapped', 'trip_saved', 'trip_booked',
  'travel_prompt', 'drop_reacted',
]);

const CARD_FEATURE = {
  deal_redeemed: 'discounts',
  cv_completed: 'resume',
  resume_created: 'resume',
  job_applied: 'jobs',
  social_posted: 'social',
  social_commented: 'social',
  event_rsvp: 'events',
  scholarship_saved: 'scholarship',
  scholarship_applied: 'scholarship',
  skill_posted: 'skillshare',
  skill_swapped: 'skillshare',
  trip_saved: 'traveling',
  trip_booked: 'traveling',
  travel_prompt: 'traveling',
};

// ═══════════════════════════════════════════════════════════
// Profile helpers
// ═══════════════════════════════════════════════════════════
async function ensureProfile(userId) {
  return EngagementProfile.findOneAndUpdate(
    { user: userId },
    {
      $setOnInsert: {
        user: userId,
        'level.id': 'member',
        'level.tiersIssued': [],
        'points.balance': 0,
        'points.lifetime': 0,
        'points.lifetimeReferral': 0,
        verifiedReferralCount: 0,
        sortedCount: 0,
        'streak.count': 0,
        'streak.best': 0,
        'streak.freezesLeft': 1,
        'stats.totalSaved': 0,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════
async function process(userId, name, opts = {}) {
  try {
    if (!userId || userId === 'guest-user') return null;

    const today = dayKey();
    const dedupeKey =
      opts.dedupeKey || `${name}:${userId}:${opts.meta?.refId || today}`;

    // ─── 1. EVENT ────────────────────────────────────────
    try {
      await EngagementEvent.create({
        user: userId,
        name,
        feature: CARD_FEATURE[name] || null,
        dayKey: today,
        meta: opts.meta || {},
        source: opts.source || 'server',
        dedupeKey,
      });
    } catch (err) {
      if (err.code === 11000) return null; // already processed
      throw err;
    }

    // ─── 2. PROFILE ──────────────────────────────────────
    const profile = await ensureProfile(userId);

    // ─── 3. STATS ────────────────────────────────────────
    const statsUpdate = {
      'stats.lastActiveAt': new Date(),
      'stats.lastActiveDay': today,
    };
    if (CARD_FEATURE[name]) {
      statsUpdate['stats.lastFeatureUsed'] = CARD_FEATURE[name];
    }

    const incs = {};
    if (opts.meta?.savedAmount) {
      incs['stats.totalSaved'] = Number(opts.meta.savedAmount) || 0;
    }

    await EngagementProfile.updateOne(
      { user: userId },
      { $set: statsUpdate, ...(Object.keys(incs).length ? { $inc: incs } : {}) }
    );

    let result = {
      cardSorted: null,
      sortedCount: profile.sortedCount || 0,
      streak: null,
      pointsAwarded: 0,
      badgesEarned: [],
      tiersIssued: [],
      popups: [],
    };

    // ─── 4. MISSION SORT ────────────────────────────────
    const feature = CARD_FEATURE[name];
    if (feature && !profile.sorted?.[feature]) {
      const updated = await EngagementProfile.findOneAndUpdate(
        { user: userId, [`sorted.${feature}`]: null },
        {
          $set: {
            [`sorted.${feature}`]: new Date(),
            lastSortedFeature: feature,
          },
          $inc: { sortedCount: 1 },
        },
        { new: true }
      );

      if (updated) {
        // ═══════════════════════════════════════════════════════
        // 🆕 REFERRAL CREDIT — always call, idempotency handles dupes
        // ═══════════════════════════════════════════════════════
        // Points.award uses idemKey so calling this on every sort is safe.
        // This makes the system self-healing: if the first call ever
        // failed (network blip, DB race), the next sort retries.
        if (updated.sortedCount >= 1) {
          try {
            const { creditReferral } = require('./referral');
            const refResult = await creditReferral(userId);
            console.log(
              '[engine] referral credit result:',
              JSON.stringify(refResult)
            );
          } catch (e) {
            console.error('[engine] referral credit FAILED:', e.message);
            console.error(e.stack);
          }
        }

        // 4b. Award mission points
        const award = await points.award(
          userId,
          cfg.points.missionSorted,
          'mission_sorted',
          {
            actorRole: 'feature',
            actor: feature,
            refType: 'feature',
            refId: feature,
            idemKey: `mission:${userId}:${feature}`,
          }
        );
        result.cardSorted = feature;
        result.sortedCount = updated.sortedCount;
        if (award.awarded) result.pointsAwarded += cfg.points.missionSorted;

        // 4c. Queue popup
        await popups.enqueue(userId, {
          kind: 'card_sorted',
          mood: 'sorted',
          line: missions.linesFor(feature, true),
          cta: missions.ROUTES[feature],
          payload: { feature },
          priority: 1,
        });

        // 4d. All 8 sorted → bonus + popup
        if (updated.sortedCount === 8 && !updated.fullySortedAt) {
          await EngagementProfile.updateOne(
            { user: userId },
            { $set: { fullySortedAt: new Date() } }
          );

          const full = await points.award(
            userId,
            cfg.points.fullySorted,
            'fully_sorted',
            {
              actorRole: 'system',
              refType: 'user',
              refId: userId,
              idemKey: `fully:${userId}`,
            }
          );
          if (full.awarded) result.pointsAwarded += cfg.points.fullySorted;

          await popups.enqueue(userId, {
            kind: 'fully_sorted',
            mood: 'excited',
            line: 'all 8. fully sorted.',
            cta: { label: 'see rewards', route: 'Rewards', params: {} },
            priority: 100,
          });
        }
      }
    }

    // ─── 5. STREAK ───────────────────────────────────────
    if (cfg.flags(cfg.STAGE).soloStreak && STREAK_EVENTS.has(name)) {
      const fresh = await EngagementProfile.findOne({ user: userId });

      const { streak, extended, milestone } = streakSvc.applyAction(
        fresh.streak || {},
        today
      );

      if (extended) {
        await EngagementProfile.updateOne(
          { user: userId, 'streak.lastActionDay': { $ne: today } },
          { $set: { streak } }
        );

        if (milestone) {
          const pts = cfg.points.streakMilestone[milestone] || 0;

          if (pts) {
            const award = await points.award(
              userId,
              pts,
              'streak_milestone',
              {
                actorRole: 'system',
                refType: 'streak',
                refId: String(milestone),
                idemKey: `streak:${userId}:${milestone}:${streak.lastActionDay}`,
              }
            );
            if (award.awarded) result.pointsAwarded += pts;
          }

          await popups.enqueue(userId, {
            kind: 'streak_milestone',
            mood: 'excited',
            line: `your ${milestone} day streak. respect.`,
            cta: { label: 'keep going', route: 'Home', params: {} },
            payload: { milestone },
            priority: 50,
          });

          await EngagementProfile.updateOne(
            { user: userId },
            { $addToSet: { 'streak.milestonesHit': milestone } }
          );
        }

        result.streak = {
          count: streak.count,
          extendedToday: true,
          milestone,
        };
      } else {
        result.streak = {
          count: streak.count || 0,
          extendedToday: false,
          milestone: null,
        };
      }
    }

    // ─── 6. BADGES ──────────────────────────────────────
    if (cfg.flags(cfg.STAGE).badges) {
      const fresh = await EngagementProfile.findOne({ user: userId });

      // ✅ Use the SAME counter that badges.config.js rules check
      // badges.config uses `p.verifiedReferralCount` for referral badges
      const verifiedReferralCount = fresh?.verifiedReferralCount || 0;

      // Also fetch raw referralCount for backwards compat with any
      // badges that still use it
      const userDoc = await User.findById(userId).select('referralCount').lean();
      const rawReferralCount = userDoc?.referralCount || 0;

      const candidates = await badges.evaluate(fresh, {
        event: name,
        referralCount: verifiedReferralCount,   // ← badges use verified
        rawReferralCount,                        // ← exposed too
      });
      const granted = await badges.grantMany(userId, candidates);

      if (granted.length) {
        result.badgesEarned = granted;

        for (const id of granted) {
          const def = badges.byIdDef(id);

          if (def.points && def.points > 0) {
            const award = await points.award(
              userId,
              def.points,
              `badge:${id}`,
              {
                actorRole: 'badge',
                refType: 'badge',
                refId: id,
                idemKey: `badge:${userId}:${id}`,
              }
            );
            if (award.awarded) result.pointsAwarded += def.points;
          }

          await popups.enqueue(userId, {
            kind: 'badge',
            mood: def?.mood || 'sorted',
            line: def?.line || 'new badge.',
            cta: { label: 'see badges', route: 'Badges', params: {} },
            payload: { badgeId: id },
            priority: 20,
          });

          setImmediate(async () => {
            try {
              await pushGateway.sendFromCopy(
                userId,
                'badge_earned',
                'deals',
                { badge_name: def?.title || id },
                { route: 'Badges', params: { badgeId: id }, badgeId: id }
              );
            } catch (e) {
              console.error('[engine] badge push failed:', e.message);
            }
          });
        }
      }
    }

    // ─── 7. LEVELS ──────────────────────────────────────
    try {
      const levelResult = await evaluateLevelsNow(userId);
      if (levelResult?.issued?.length) {
        result.tiersIssued = levelResult.issued.map((i) => i.id);
      }
    } catch (e) {
      console.error('[engine] level eval failed:', e.message);
    }

    // ─── 8. POPUPS ──────────────────────────────────────
    const finalProfile = await EngagementProfile.findOne({ user: userId })
      .select('pendingPopups')
      .lean();

    result.popups = (finalProfile?.pendingPopups || [])
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(-5)
      .map((p) => ({
        id: p._id,
        kind: p.kind,
        mood: p.mood,
        line: p.line,
        cta: p.cta,
      }));

    return result;
  } catch (err) {
    console.error('[engine.process] error:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// BADGE EVALUATION (standalone)
// ═══════════════════════════════════════════════════════════
async function evaluateBadgesNow(userId) {
  try {
    const fresh = await EngagementProfile.findOne({ user: userId });
    if (!fresh) return { granted: [] };

    const verifiedReferralCount = fresh.verifiedReferralCount || 0;
    const userDoc = await User.findById(userId).select('referralCount').lean();
    const rawReferralCount = userDoc?.referralCount || 0;

    const candidates = await badges.evaluate(fresh, {
      event: 'manual_evaluate',
      referralCount: verifiedReferralCount,
      rawReferralCount,
    });
    const granted = await badges.grantMany(userId, candidates);

    for (const id of granted) {
      const def = badges.byIdDef(id);

      // Award badge points
      if (def.points && def.points > 0) {
        try {
          await points.award(userId, def.points, `badge:${id}`, {
            actorRole: 'badge',
            refType: 'badge',
            refId: id,
            idemKey: `badge:${userId}:${id}`,
          });
        } catch (e) {
          console.error('[engine.evaluateBadgesNow] award failed:', e.message);
        }
      }

      await popups.enqueue(userId, {
        kind: 'badge',
        mood: def?.mood || 'sorted',
        line: def?.line || 'new badge.',
        cta: { label: 'see badges', route: 'Badges', params: {} },
        payload: { badgeId: id },
        priority: 20,
      });

      setImmediate(async () => {
        try {
          await pushGateway.sendFromCopy(
            userId,
            'badge_earned',
            'deals',
            { badge_name: def?.title || id },
            { route: 'Badges', params: { badgeId: id }, badgeId: id }
          );
        } catch (e) {
          console.error('[engine.evaluateBadgesNow] push failed:', e.message);
        }
      });
    }

    return { granted };
  } catch (e) {
    console.error('[engine.evaluateBadgesNow] error:', e.message);
    return { granted: [] };
  }
}

// ═══════════════════════════════════════════════════════════
// LEVEL EVALUATION (standalone)
// ═══════════════════════════════════════════════════════════
async function evaluateLevelsNow(userId) {
  try {
    const profile = await EngagementProfile.findOne({ user: userId });
    if (!profile) return { issued: [] };

    const newlyCrossed = levels.evaluate(profile);
    if (!newlyCrossed || newlyCrossed.length === 0) return { issued: [] };

    const { LEVELS } = require('../../config/badges');

    const now = new Date();
    const oneYearFromNow = new Date(now);
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

    const issued = [];

    for (const tierId of newlyCrossed) {
      const tier = LEVELS.find((t) => t.id === tierId);
      if (!tier) continue;

      // Guard: don't re-issue already-issued tiers
      if (profile.level?.tiersIssued?.includes(tierId)) continue;

      if (!profile.level) {
        profile.level = { id: 'member', reachedAt: null, tiersIssued: [] };
      }
      if (!profile.level.tiersIssued) profile.level.tiersIssued = [];
      profile.level.tiersIssued.push(tierId);

      profile.level.id = tierId;
      profile.level.reachedAt = now;

      if (tier.discount) {
        profile.tierDiscount = {
          percent: tier.discount.pct,
          capRs: tier.discount.capRs,
          validUntil: oneYearFromNow,
          tierId: tier.id,
        };
      }

      if (!profile.pendingPopups) profile.pendingPopups = [];
      profile.pendingPopups.push({
        kind: 'tier_unlocked',
        mood: 'hype',
        line: `you unlocked ${tier.label || tier.id}!`,
        cta: { label: 'view rewards', route: 'Crew', params: { tierId: tier.id } },
        priority: 100,
        meta: { tierId: tier.id },
        createdAt: now,
      });

      setImmediate(async () => {
        try {
          await pushGateway.sendFromCopy(
            userId,
            'tier_unlocked',
            'deals',
            {
              tier: tier.label || tier.id,
              discount: tier.discount?.pct || 0,
            },
            {
              route: 'Crew',
              params: { tierId: tier.id },
              tierId: tier.id,
            }
          );
        } catch (e) {
          console.error('[engine.evaluateLevelsNow] tier push failed:', e.message);
        }
      });

      issued.push({
        id: tier.id,
        label: tier.label || tier.id,
        reward: tier.reward,
        discount: tier.discount || null,
      });
    }

    if (issued.length > 0) {
      await profile.save();
    }
    return { issued };
  } catch (err) {
    console.error('[engine.evaluateLevelsNow]', err);
    return { issued: [], error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// REFERRAL VERIFIED (standalone — called by referral.js)
// ═══════════════════════════════════════════════════════════
async function onReferralVerified(referrerId, referredUserId, referredSortKey) {
  try {
    const referrerIdStr = String(referrerId);
    const referredUserIdStr = String(referredUserId);

    console.log(
      `[engine.onReferralVerified] referrer=${referrerIdStr} referred=${referredUserIdStr}`
    );

    // ── 1. Award +100 to REFERRER ──
    const referrerAward = await points.award(
      referrerIdStr,
      100,
      'referral:verified',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: referredUserIdStr,
        idemKey: `referral:verified:referrer:${referrerIdStr}:${referredUserIdStr}`,
      }
    );
    console.log('[engine.onReferralVerified] referrerAward:', referrerAward);

    // ── 2. Award +100 to REFERRED USER (welcome) ──
    const referredAward = await points.award(
      referredUserIdStr,
      100,
      'referral:welcome',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: referrerIdStr,
        idemKey: `referral:welcome:${referredUserIdStr}`,
      }
    );
    console.log('[engine.onReferralVerified] referredAward:', referredAward);

    // ── 3. Recompute verifiedReferralCount from source of truth ──
    const { computeVerifiedCount } = require('./referral');
    const verifiedCount = await computeVerifiedCount(referrerIdStr);

    await EngagementProfile.findOneAndUpdate(
      { user: referrerIdStr },
      { $set: { verifiedReferralCount: verifiedCount } },
      { new: true, upsert: true }
    );

    console.log(
      `[engine.onReferralVerified] referrer verifiedReferralCount → ${verifiedCount}`
    );

    // ── 4. Re-evaluate referrer's levels ──
    try {
      await evaluateLevelsNow(referrerIdStr);
    } catch (e) {
      console.error('[engine.onReferralVerified] level eval failed:', e.message);
    }

    // ── 5. Re-evaluate referrer's badges ──
    setImmediate(async () => {
      try {
        await evaluateBadgesNow(referrerIdStr);
      } catch (e) {
        console.error('[engine.onReferralVerified] badge eval failed:', e.message);
      }
    });

    // ── 6. Push notification ──
    setImmediate(async () => {
      try {
        const referredUser = await User.findById(referredUserIdStr)
          .select('name')
          .lean();

        await pushGateway.sendFromCopy(
          referrerIdStr,
          'referral_joined',
          'social',
          { friend_name: referredUser?.name || 'a friend' },
          { route: 'Points', params: {} }
        );
      } catch (e) {
        console.error('[engine.onReferralVerified] push failed:', e.message);
      }
    });

    return {
      ok: true,
      referrerAwarded: !referrerAward?.duplicate,
      referredAwarded: !referredAward?.duplicate,
      verifiedCount,
    };
  } catch (err) {
    console.error('[engine.onReferralVerified] error:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  process,
  ensureProfile,
  evaluateBadgesNow,
  evaluateLevelsNow,
  onReferralVerified,
};