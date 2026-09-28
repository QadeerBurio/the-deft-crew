// services/engagement/popups.js
const EngagementProfile = require('../../models/EngagementProfile');

async function enqueue(userId, popup) {
  if (!popup || !popup.kind) return;
  const full = {
    ...popup,
    createdAt: new Date(),
    priority: popup.priority ?? 0,
  };
  await EngagementProfile.updateOne(
    { user: userId },
    { $push: { pendingPopups: full } }
  );
}

module.exports = { enqueue };