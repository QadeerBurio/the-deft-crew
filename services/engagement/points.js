// services/engagement/points.js
const PointsLedger = require('../../models/PointsLedger');
const EngagementProfile = require('../../models/EngagementProfile');

const LEVELS = [
  { id: 'member',              label: 'member',              min: 0 },
  { id: 'deft rookie',         label: 'deft rookie',         min: 300 },
  { id: 'deft main character', label: 'deft main character', min: 1000 },
  { id: 'deft pro',            label: 'deft pro',            min: 3000 },
  { id: 'deft goat',           label: 'deft goat',           min: 6000 },
  { id: 'founder circle',      label: 'founder circle',      min: 10000 },
];

const VALID_ROLES = new Set([
  'self', 'system', 'admin', 'feature', 'reward', 'mission', 'referral', 'badge',
]);

const resolveLevel = (lifetime) => {
  let current = LEVELS[0];
  for (const l of LEVELS) if (lifetime >= l.min) current = l;
  return current;
};

const isObjectIdLike = (v) =>
  typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

function isReferralReason(reason) {
  if (!reason || typeof reason !== 'string') return false;
  return reason.startsWith('referral');
}

/**
 * Award or deduct points.
 * Supports BOTH call styles:
 *   award(userId, delta, reason, { actorRole, actor, refType, refId, idemKey, metadata })
 *   award(userId, delta, reason, actorRole, actorId, idemKey)
 */
async function award(userId, delta, reason, arg4 = 'system', arg5 = null, arg6 = null) {
  if (!userId) throw new Error('userId required');
  if (!Number.isFinite(delta) || delta === 0) throw new Error('delta must be non-zero');

  let actorRole = 'system';
  let actor = null;
  let refType = null;
  let refId = null;
  let idemKey = null;
  let metadata = {};

  if (arg4 && typeof arg4 === 'object' && !Array.isArray(arg4)) {
    // Object form
    actorRole = arg4.actorRole || arg4.role || 'system';
    actor     = arg4.actor ?? arg4.actorId ?? null;
    refType   = arg4.refType || null;
    refId     = arg4.refId || null;
    idemKey   = arg4.idemKey || arg4.dedupeKey || null;
    metadata  = arg4.metadata || {};
    if (!idemKey && typeof arg5 === 'string') idemKey = arg5;
  } else {
    // Positional form
    actorRole = arg4 || 'system';
    actor     = arg5;
    idemKey   = arg6;
  }

  if (!VALID_ROLES.has(actorRole)) {
    if (!refType && typeof actorRole === 'string') refType = actorRole;
    actorRole = 'system';
  }

  if (actor && typeof actor === 'string' && !isObjectIdLike(actor)) {
    if (!refType) refType = actor;
    actor = null;
  }

  // ── Idempotency check ────────────────────────────────────
  if (idemKey) {
    const existing = await PointsLedger.findOne({
      $or: [{ idemKey }, { dedupeKey: idemKey }],
    }).lean();
    if (existing) {
      const profile = await EngagementProfile.findOne({ user: userId }).lean();
      return {
        ok: true,
        duplicate: true,
        awarded: false,
        balance: profile?.points?.balance || 0,
        lifetime: profile?.points?.lifetime || 0,
        lifetimeReferral: profile?.points?.lifetimeReferral || 0,
        level: profile?.level || resolveLevel(profile?.points?.lifetime || 0),
      };
    }
  }

  // ── Load or create profile ────────────────────────────────
  let profile = await EngagementProfile.findOne({ user: userId });
  if (!profile) profile = await EngagementProfile.create({ user: userId });

  const before = profile.points?.balance || 0;
  const lifetimeBefore = profile.points?.lifetime || 0;
  const lifetimeReferralBefore = profile.points?.lifetimeReferral || 0;

  const balanceAfter = Math.max(0, before + delta);
  const lifetime = delta > 0 ? lifetimeBefore + delta : lifetimeBefore;

  const deltaReferral = (delta > 0 && isReferralReason(reason)) ? delta : 0;
  const lifetimeReferral = lifetimeReferralBefore + deltaReferral;

  profile.points = {
    ...(profile.points || {}),
    balance: balanceAfter,
    lifetime,
    lifetimeReferral,
    level: resolveLevel(lifetime).id,
  };

  const resolvedLevel = resolveLevel(lifetime);
  profile.level = {
    ...(profile.level || {}),
    id: resolvedLevel.id,
  };

  profile.stats = profile.stats || {};
  profile.stats.lastActiveAt = new Date();

  await profile.save();

  // ── Write ledger ──────────────────────────────────────────
  const ledgerDoc = {
    user: userId,
    delta,
    balanceAfter,
    reason,
    actorRole,
    actor,
    refType,
    refId,
    metadata,
  };

  if (idemKey && typeof idemKey === 'string') {
    ledgerDoc.idemKey = idemKey;
    ledgerDoc.dedupeKey = idemKey;
  }

  try {
    await PointsLedger.create(ledgerDoc);
  } catch (err) {
    if (err?.code === 11000) {
      // Duplicate — rollback profile? No, another call already updated it. Just re-read.
      const p = await EngagementProfile.findOne({ user: userId }).lean();
      return {
        ok: true,
        duplicate: true,
        awarded: false,
        balance: p?.points?.balance || balanceAfter,
        lifetime: p?.points?.lifetime || lifetime,
        lifetimeReferral: p?.points?.lifetimeReferral || lifetimeReferral,
        level: p?.level || resolveLevel(lifetime),
      };
    }
    throw err;
  }

  return {
    ok: true,
    awarded: true,
    duplicate: false,
    balance: balanceAfter,
    lifetime,
    lifetimeReferral,
    level: profile.level,
  };
}

/**
 * Spend points — safe, idempotent, refuses on insufficient balance.
 */
async function spend(userId, amount, reason = 'spend', refType = null, refId = null, idemKey = null) {
  const delta = -Math.abs(Number(amount) || 0);
  if (delta === 0) throw new Error('amount must be > 0');

  const profile = await EngagementProfile.findOne({ user: userId }).lean();
  const balance = profile?.points?.balance || 0;
  if (balance < Math.abs(delta)) {
    const err = new Error('not enough points');
    err.code = 'INSUFFICIENT_POINTS';
    err.balance = balance;
    err.required = Math.abs(delta);
    throw err;
  }

  return award(userId, delta, reason, {
    actorRole: 'self',
    actor: userId,
    refType,
    refId,
    idemKey,
  });
}

module.exports = { award, spend, resolveLevel, LEVELS };