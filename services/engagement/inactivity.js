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

  const result = await pushGateway.sendFromCopy(userId, copyKey, null, vars, data);
  return { ...result, copyKey, daysSince, route: data.route };
}

module.exports = { sendWinBack };