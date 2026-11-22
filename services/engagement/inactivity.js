// services/engagement/inactivity.js
const EngagementProfile = require('../../models/EngagementProfile');
const pushGateway = require('./pushGateway');

async function sendWinBack(userId, daysSince = 3) {
  let copyKey;
  let data = { route: 'Home', params: {} };
  let vars = { n: daysSince };

  if (daysSince >= 30) {
    copyKey = 'win_back_ghost';
  } else if (daysSince >= 14) {
    copyKey = 'exclusive_offer';
    data = { route: 'Brands', params: {} };
    vars = { brand: 'tdc', discount: 20 };
  } else if (daysSince >= 7) {
    copyKey = 'welcome_back';
    data = { route: 'Rewards', params: {} };
    try {
      const profile = await EngagementProfile.findOne({ user: userId })
        .select('points.balance').lean();
      vars = { count: profile?.points?.balance || 0 };
    } catch (e) { vars = { count: 0 }; }
  } else {
    copyKey = 'win_back_soft';
  }

  // Owner (Phase N sign-off): the win-back nudge sends only with pushCopyV2, and only real numbers: days away, new
  // deals and campus confessions since the last visit, the real best live offer, the real points balance. Without
  // the flag (today's copy passes the days off as "deals" / "Rs saved" and offers a made-up "tdc · 20% off"), or
  // with nothing real to say: nothing is sent.
  if (!require('../../config/featureFlags').isEnabled('pushCopyV2', { id: String(userId), role: 'student' })) {
    return { sent: false, reason: 'push_copy_v2_off', copyKey, daysSince, route: data.route };
  }
  try {
    vars = { ...vars, ...(await realFacts(userId, daysSince, copyKey)) };
    if (copyKey === 'exclusive_offer' && !vars.offerId) return { sent: false, reason: 'no_specific_copy', copyKey, daysSince, route: data.route };
    if (vars.offerId) data = { route: 'OfferScreen', params: { offerId: vars.offerId }, offerId: vars.offerId };
  } catch (e) {
    return { sent: false, reason: 'no_specific_copy', copyKey, daysSince, route: data.route };
  }
  const result = await pushGateway.sendFromCopy(userId, copyKey, null, vars, data);
  return { ...result, copyKey, daysSince, route: data.route };
}

/** N-7: the real facts a win-back push may name. exclusive_offer: the best live offer instead of a made-up one. */
async function realFacts(userId, daysSince, copyKey) {
  const profile = await EngagementProfile.findOne({ user: userId }).select('stats.lastActiveAt').lean();
  const since = profile?.stats?.lastActiveAt || new Date(Date.now() - daysSince * 24 * 3600e3);
  const live = { $or: [{ status: { $exists: false } }, { status: null }, { status: 'active' }] };
  const Offer = require('../../models/Offer');
  if (copyKey === 'exclusive_offer') {
    const best = await Offer.find(live).sort({ discountPercentage: -1, createdAt: -1 }).limit(1).populate('brand', 'brandName companyName name').lean();
    const o = best[0];
    const brand = o?.brand?.brandName || o?.brand?.companyName || o?.brand?.name;
    return o && brand && o.discountPercentage > 0 ? { brand, discount: o.discountPercentage, offerId: String(o._id) } : {};
  }
  const user = await require('../../models/User').findById(userId).select('university').lean();
  const deals = await Offer.countDocuments({ createdAt: { $gte: since }, ...live });
  const confessions = user?.university
    ? await require('../../models/Confession').countDocuments({ university: user.university, createdAt: { $gte: since }, $or: [{ status: { $exists: false } }, { status: null }, { status: 'live' }] })
    : 0;
  return { days: daysSince, deals, confessions };
}

module.exports = { sendWinBack, realFacts };