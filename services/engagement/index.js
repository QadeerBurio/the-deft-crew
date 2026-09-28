// services/engagement/index.js
const { process, ensureProfile } = require('./engine');
const EngagementProfile = require('../../models/EngagementProfile');

async function track(userId, name, opts = {}) {
  return process(userId, name, opts);
}

async function getProfile(userId) {
  return EngagementProfile.findOne({ user: userId }).lean();
}

module.exports = { track, getProfile, ensureProfile };