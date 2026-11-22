// services/engagement/referralSignup.js
// The referral awards paid when a student signs up with a code (moved unchanged from routes/auth.routes.js,
// signup step 7c, so the e-mail verification step can call the same code; plan P1 follow-up).
const EngagementEvent = require('../../models/EngagementEvent');

  // ═══════════════════════════════════════════════════════════
  // 7c. AWARD +50 (signup bonus) + +100 (immediate verification)
  //     BOTH on signup — total +150 to referrer
  //     AND +100 welcome to referee (new user)
  // ═══════════════════════════════════════════════════════════
// opts.verifiedOnly (referralVerifyGate): verifiedReferralCount counts only referees who confirmed their e-mail.
async function awardSignupReferral(referrer, user, opts = {}) {
  try {
    const points = require("./points");

    // ── +50 to REFERRER (invite bonus) ──
    const signupKey = `referral_signup_bonus:${user._id}`;
    try {
      await EngagementEvent.create({
        user: referrer._id,
        name: 'referral_signup_bonus',
        feature: null,
        dayKey: new Date().toISOString().split('T')[0],
        meta: { refereeId: String(user._id) },
        source: 'server',
        dedupeKey: signupKey,
      });
    } catch (e) {
      // ignore duplicate event
    }

    const signupAward = await points.award(
      String(referrer._id),
      50,
      'referral:signup_bonus',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(user._id),
        idemKey: signupKey,
      }
    );
    console.log('[signup] referrer +50:', signupAward);

    // ── +100 to REFERRER (verified referral, immediate) ──
    const verifiedKey = `referral:verified:referrer:${referrer._id}:${user._id}`;
    const verifiedAward = await points.award(
      String(referrer._id),
      100,
      'referral:verified',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(user._id),
        idemKey: verifiedKey,
      }
    );
    console.log('[signup] referrer +100:', verifiedAward);

    // ── +100 to REFEREE (welcome bonus for new user) ──
    const welcomeKey = `referral:welcome:${user._id}`;
    const welcomeAward = await points.award(
      String(user._id),
      100,
      'referral:welcome',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(referrer._id),
        idemKey: welcomeKey,
      }
    );
    console.log('[signup] referee +100:', welcomeAward);

    // ── Update verifiedReferralCount on referrer's profile ──
    try {
      const EngagementProfile = require("../../models/EngagementProfile");
      const User2 = require("../../models/User");
      const referees = await User2.find(opts.verifiedOnly ? { referredBy: referrer._id, emailVerified: { $ne: false } } : { referredBy: referrer._id })
        .select('_id')
        .lean();
      const refereeIds = referees.map((r) => r._id);

      // For immediate-credit model, all referees count as verified
      const verifiedCount = refereeIds.length;

      await EngagementProfile.findOneAndUpdate(
        { user: referrer._id },
        { $set: { verifiedReferralCount: verifiedCount } },
        { upsert: true }
      );
    } catch (e) {
      console.error('[signup] verifiedReferralCount sync failed:', e.message);
    }

    // ── Popup for referrer ──
    try {
      const popups = require("./popups");
      await popups.enqueue(String(referrer._id), {
        kind: 'referral_credited',
        mood: 'hype',
        line: `${user.name || 'someone'} just joined with your code! +150 pts.`,
        cta: { label: 'view crew', route: 'Points', params: {} },
        payload: { refereeId: String(user._id), amount: 150 },
        priority: 30,
      });
    } catch (e) {
      console.error('[signup] popup enqueue failed:', e.message);
    }

    // ── Re-evaluate referrer level + badges ──
    try {
      const { evaluateLevelsNow, evaluateBadgesNow } = require("./engine");
      await evaluateLevelsNow(String(referrer._id));
      setImmediate(() => evaluateBadgesNow(String(referrer._id)).catch(() => {}));
    } catch (e) {
      console.error('[signup] eval failed:', e.message);
    }
  } catch (e) {
    console.error("[signup] referral awards FAILED:", e.message);
    console.error(e.stack);
  }
}

// referralVerifyGate on for this referrer?
const gateOn = (referrer) => require('../../config/featureFlags').isEnabled('referralVerifyGate', { id: String(referrer._id), role: referrer.role });
const KEYS = (referrerId, userId) => [`referral_signup_bonus:${userId}`, `referral:verified:referrer:${referrerId}:${userId}`, `referral:welcome:${userId}`];

/**
 * Signup (routes/auth.routes.js step 7c). Gate off, or a new account that needs no e-mail code: pays now, as before.
 * Gate on and the student still has to confirm their e-mail: pays nothing now (verify-otp pays).
 */
async function onSignup(referrer, user) {
  if (gateOn(referrer) && user.emailVerified === false) {
    console.log(`[referral] gate: rewards for ${user._id} wait for the e-mail code`);
    return { paid: false, reason: 'waiting_for_email' };
  }
  await awardSignupReferral(referrer, user);
  return { paid: true };
}

/**
 * The e-mail code was confirmed (verify-otp). Gate on: pays the rewards the signup held back, once. Gate off, no
 * referrer, or already paid (all three ledger rows exist): nothing.
 */
async function onEmailVerified(user) {
  try {
    if (!user?.referredBy) return { paid: false, reason: 'no_referrer' };
    const User = require('../../models/User');
    const referrer = await User.findById(user.referredBy).select('_id role name').lean();
    if (!referrer) return { paid: false, reason: 'no_referrer' };
    if (!gateOn(referrer)) return { paid: false, reason: 'gate_off' };
    const keys = KEYS(referrer._id, user._id);
    const PointsLedger = require('../../models/PointsLedger');
    const have = await PointsLedger.countDocuments({ $or: [{ idemKey: { $in: keys } }, { dedupeKey: { $in: keys } }] });
    if (have >= keys.length) return { paid: false, reason: 'already_paid' };
    await awardSignupReferral(referrer, user, { verifiedOnly: true });
    return { paid: true };
  } catch (e) {
    console.error('[referral] gate: paying after verification failed:', e.message);
    return { paid: false, reason: 'error' };
  }
}

module.exports = { awardSignupReferral, onSignup, onEmailVerified };
