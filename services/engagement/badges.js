// services/engagement/badges.js
const UserBadge = require('../../models/UserBadge');
const User = require('../../models/User');
const { byId, badges: ALL } = require('../../config/badges');

async function evaluate(profile, ctx = {}) {
  const earned = new Set(
    (await UserBadge.find({ user: profile.user }).select('badgeId').lean())
      .map((b) => b.badgeId)
  );

  let user = null;
  try {
    user = await User.findById(profile.user)
      .select('createdAt referralCount')
      .lean();
  } catch (e) {
    console.warn('[badges.evaluate] user fetch failed:', e.message);
  }

  // 🆕 Ensure ctx.referralCount is ALWAYS populated
  const safeCtx = {
    ...ctx,
    referralCount:
      typeof ctx.referralCount === 'number'
        ? ctx.referralCount
        : user?.referralCount || 0,
  };

  const out = [];
  for (const def of ALL) {
    if (earned.has(def.id)) continue;
    try {
      if (def.rule && def.rule(profile, user, safeCtx)) out.push(def.id);
    } catch (e) {
      console.warn(`[badges] rule error for ${def.id}:`, e.message);
    }
  }
  return out;
}

async function grant(userId, badgeId, meta = {}) {
  try {
    await UserBadge.create({ user: userId, badgeId, meta });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

async function grantMany(userId, ids, meta = {}) {
  const granted = [];
  for (const id of ids) {
    const ok = await grant(userId, id, meta);
    if (ok) granted.push(id);
  }
  return granted;
}

function all() { return ALL; }
function byIdDef(id) { return byId[id]; }

module.exports = { evaluate, grant, grantMany, all, byIdDef };