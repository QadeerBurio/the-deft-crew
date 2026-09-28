// services/engagement/dailyPoints.js
// Daily-capped engagement points: like · comment · post · confession
// All four use the same underlying award() with a per-user-per-day idemKey,
// so the DB enforces the daily cap automatically.

const { award } = require('./points');
const { dayKey } = require('../../utils/karachiTime');

// ── Daily point rules ─────────────────────────────────────
// `reason` is the ledger label. `idemPrefix` scopes the daily dedupe key.
const DAILY_RULES = {
  daily_like:       { points: 1,  reason: 'daily_like' },
  daily_comment:    { points: 5,  reason: 'daily_comment' },
  daily_post:       { points: 10, reason: 'daily_post' },
  daily_confession: { points: 10, reason: 'daily_confession' },
};

/**
 * Award a daily-capped engagement point.
 *
 * @param {string} userId        — the user who performed the action
 * @param {keyof typeof DAILY_RULES} action
 * @returns {Promise<{ awarded: boolean, points: number, alreadyToday: boolean, balance?: number, lifetime?: number, level?: any }>}
 */
async function awardDaily(userId, action) {
  const rule = DAILY_RULES[action];
  if (!rule) {
    throw new Error(`unknown daily action: ${action}`);
  }
  if (!userId) {
    throw new Error('userId required');
  }

  const today = dayKey();                      // '2026-09-27' in Karachi time
  const idemKey = `${action}:${userId}:${today}`;

  // award() is idempotent on idemKey — a second call today returns
  // { duplicate: true } without writing a new ledger row or changing balance.
  const result = await award(
    userId,
    rule.points,
    rule.reason,
    { actorRole: 'self', actor: userId, refType: action, refId: today, idemKey }
  );

  if (result?.duplicate) {
    return {
      awarded: false,
      alreadyToday: true,
      points: 0,
    };
  }

  return {
    awarded: true,
    alreadyToday: false,
    points: rule.points,
    balance: result?.balance,
    lifetime: result?.lifetime,
    level: result?.level,
  };
}

module.exports = { awardDaily, DAILY_RULES };