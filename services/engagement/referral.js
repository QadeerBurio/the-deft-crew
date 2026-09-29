// services/engagement/referral.js
const User = require('../../models/User');
const EngagementEvent = require('../../models/EngagementEvent');
const EngagementProfile = require('../../models/EngagementProfile');
const points = require('./points');
const popups = require('./popups');
const { dayKey } = require('../../utils/karachiTime');

// ═══════════════════════════════════════════════════════════════
// STAGE 1 — Instant +50 on signup (referrer only)
// ═══════════════════════════════════════════════════════════════
async function creditReferralOnSignup(refereeUserId) {
  if (!refereeUserId) return { credited: false, reason: 'no_id' };

  const referee = await User.findById(refereeUserId)
    .select('referredBy name')
    .lean();

  if (!referee || !referee.referredBy) {
    return { credited: false, reason: 'no_referrer' };
  }

  const referrerId = String(referee.referredBy);
  const refereeIdStr = String(refereeUserId);
  const dedupeKey = `referral_signup_bonus:${refereeIdStr}`;

  // Best-effort event log
  try {
    await EngagementEvent.create({
      user: referrerId,
      name: 'referral_signup_bonus',
      feature: null,
      dayKey: dayKey(),
      meta: { refereeId: refereeIdStr },
      source: 'system',
      dedupeKey,
    });
  } catch (err) {
    if (err.code !== 11000) {
      console.error('[referral] signup event error:', err.message);
    }
  }

  // ALWAYS attempt award (idempotent)
  let awarded = false;
  try {
    const r = await points.award(referrerId, 50, 'referral:signup_bonus', {
      actorRole: 'referral',
      refType: 'referral',
      refId: refereeIdStr,
      idemKey: dedupeKey,
    });
    awarded = !r?.duplicate;
    console.log('[referral] signup +50 result:', JSON.stringify(r));
  } catch (e) {
    console.error('[referral] signup +50 FAILED:', e.message);
    return { credited: false, reason: 'award_failed' };
  }

  if (awarded) {
    try {
      await popups.enqueue(referrerId, {
        kind: 'referral_signup',
        mood: 'excited',
        line: `${referee.name || 'someone'} just joined with your code! +50 pts.`,
        cta: { label: 'view crew', route: 'RewardsScreen', params: {} },
        payload: { refereeId: refereeIdStr, amount: 50 },
        priority: 25,
      });
    } catch (e) {
      console.error('[referral] signup popup failed:', e.message);
    }
  }

  return { credited: awarded, referrerId, refereeId: refereeIdStr, points: 50 };
}

// ═══════════════════════════════════════════════════════════════
// STAGE 2 — +100 to BOTH on referee's FIRST sort (verified)
// ═══════════════════════════════════════════════════════════════
async function creditReferral(refereeUserId) {
  if (!refereeUserId) return { credited: false, reason: 'no_id' };

  console.log(`[referral] creditReferral called for referee=${refereeUserId}`);

  const referee = await User.findById(refereeUserId)
    .select('referredBy name email')
    .lean();

  if (!referee) {
    console.log('[referral] referee not found:', refereeUserId);
    return { credited: false, reason: 'referee_not_found' };
  }

  if (!referee.referredBy) {
    console.log(
      `[referral] referee has NO referrer: ${referee.name} (${referee.email})`
    );
    return { credited: false, reason: 'no_referrer' };
  }

  const referrerId = String(referee.referredBy);
  const refereeIdStr = String(refereeUserId);

  console.log(
    `[referral] referrer=${referrerId} referee=${refereeIdStr} (${referee.name})`
  );

  const eventKey = `referral_credited:${refereeIdStr}`;
  const referrerIdemKey = `referral:verified:referrer:${referrerId}:${refereeIdStr}`;
  const refereeIdemKey = `referral:welcome:${refereeIdStr}`;

  // Best-effort event log — DON'T bail on duplicate
  try {
    await EngagementEvent.create({
      user: referrerId,
      name: 'referral_credited',
      feature: null,
      dayKey: dayKey(),
      meta: { refereeId: refereeIdStr },
      source: 'system',
      dedupeKey: eventKey,
    });
  } catch (err) {
    if (err.code !== 11000) {
      console.error('[referral] event error:', err.message);
    }
    // Continue to award regardless
  }

  // ── Award REFERRER +100 ──
  let referrerAwarded = false;
  let referrerBalance = 0;
  try {
    const r = await points.award(referrerId, 100, 'referral:verified', {
      actorRole: 'referral',
      refType: 'referral',
      refId: refereeIdStr,
      idemKey: referrerIdemKey,
    });
    referrerAwarded = !r?.duplicate;
    referrerBalance = r?.balance ?? 0;
    console.log(
      `[referral] referrer +100 → awarded=${referrerAwarded} duplicate=${!!r?.duplicate} balance=${referrerBalance}`
    );
  } catch (e) {
    console.error('[referral] ❌ referrer +100 FAILED:', e.message);
    console.error(e.stack);
  }

  // ── Award REFEREE +100 (welcome) ──
  let refereeAwarded = false;
  try {
    const r = await points.award(refereeIdStr, 100, 'referral:welcome', {
      actorRole: 'referral',
      refType: 'referral',
      refId: referrerId,
      idemKey: refereeIdemKey,
    });
    refereeAwarded = !r?.duplicate;
    console.log(
      `[referral] referee +100 → awarded=${refereeAwarded} duplicate=${!!r?.duplicate}`
    );
  } catch (e) {
    console.error('[referral] ❌ referee +100 FAILED:', e.message);
  }

  // ── Recompute verifiedReferralCount ──
  const verifiedCount = await computeVerifiedCount(referrerId);

  await EngagementProfile.findOneAndUpdate(
    { user: referrerId },
    { $set: { verifiedReferralCount: verifiedCount } },
    { upsert: true, new: true }
  );

  // ── Re-evaluate referrer level + badges ──
  try {
    const { evaluateLevelsNow, evaluateBadgesNow } = require('./engine');
    await evaluateLevelsNow(referrerId);
    setImmediate(() => evaluateBadgesNow(referrerId).catch(() => {}));
  } catch (e) {
    console.error('[referral] eval failed:', e.message);
  }

  // ── Popup for referrer (only if newly awarded) ──
  if (referrerAwarded) {
    try {
      await popups.enqueue(referrerId, {
        kind: 'referral_credited',
        mood: 'hype',
        line: `${referee.name || 'someone'} just sorted their first card — +100 crew points.`,
        cta: { label: 'view crew', route: 'Points', params: {} },
        payload: { refereeId: refereeIdStr, amount: 100 },
        priority: 30,
      });
    } catch (e) {
      console.error('[referral] popup failed:', e.message);
    }

    setImmediate(async () => {
      try {
        const pushGateway = require('./pushGateway');
        await pushGateway.sendFromCopy(
          referrerId,
          'referral_joined',
          'social',
          { friend_name: referee?.name || 'a friend' },
          { route: 'Points', params: {} }
        );
      } catch (e) {
        console.error('[referral] push failed:', e.message);
      }
    });
  }

  return {
    credited: referrerAwarded || refereeAwarded,
    referrerId,
    refereeId: refereeIdStr,
    referrerAwarded,
    refereeAwarded,
    verifiedCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPER — count referees who have sorted at least one card
// ═══════════════════════════════════════════════════════════════
async function computeVerifiedCount(referrerId) {
  const referees = await User.find({ referredBy: referrerId })
    .select('_id')
    .lean();

  if (referees.length === 0) return 0;

  const refereeIds = referees.map((r) => r._id);

  const verified = await EngagementProfile.countDocuments({
    user: { $in: refereeIds },
    sortedCount: { $gt: 0 },
  });

  return verified;
}

module.exports = {
  creditReferral,
  creditReferralOnSignup,
  computeVerifiedCount,
};