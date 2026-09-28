// models/EngagementProfile.js
const mongoose = require('mongoose');

const profileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, index: true },

    // 8 "sorted cards"
    sorted: {
      discounts:   { type: Date, default: null },
      resume:      { type: Date, default: null },
      jobs:        { type: Date, default: null },
      social:      { type: Date, default: null },
      events:      { type: Date, default: null },
      scholarship: { type: Date, default: null },
      skillshare:  { type: Date, default: null },
      traveling:   { type: Date, default: null },
    },
    sortedCount: { type: Number, default: 0 },
    fullySortedAt: { type: Date, default: null },
    snoozes: [
      {
        feature: String,
        until: Date,
        count: { type: Number, default: 1 },
      },
    ],
    lastSortedFeature: { type: String, default: null },

    // Tour
    tourCompletedAt: { type: Date, default: null },
    tooltipsSeen: { type: [String], default: [] },

    // Solo streak
    streak: {
      count: { type: Number, default: 0 },
      best: { type: Number, default: 0 },
      lastActionDay: { type: String, default: null },
      freezesLeft: { type: Number, default: 1 },
      freezeWeekKey: { type: String, default: null },
      examModeUntil: { type: String, default: null },
      examModeUses: [{ semesterKey: String, startedDay: String }],
      brokenAt: { type: Date, default: null },
      restorableUntil: { type: Date, default: null },
      milestonesHit: { type: [Number], default: [] },
    },

    // Stats
    stats: {
      totalSaved: { type: Number, default: 0 },
      lastActiveAt: { type: Date, default: null },
      lastActiveDay: { type: String, default: null },
      lastFeatureUsed: { type: String, default: null },
    },

    // ✅ Points — two-track ledger cache (ledger is source of truth)
    points: {
      balance:          { type: Number, default: 0 },
      lifetime:         { type: Number, default: 0 },   // total (activity + referral)
      lifetimeReferral: { type: Number, default: 0 },   // referral-sourced only
    },

    // ✅ Level — extended with tiersIssued array + reachedAt
    level: {
      id:          { type: String, default: 'member' },
      reachedAt:   { type: Date,   default: null },
      tiersIssued: { type: [String], default: [] },     // ['rookie','starter',...]
    },

    // ✅ Active tier discount (only highest tier's discount is live)
    tierDiscount: {
      percent:    { type: Number, default: 0 },
      capRs:      { type: Number, default: 0 },
      validUntil: { type: Date,   default: null },
      tierId:     { type: String, default: null },
    },

    // ✅ Verified referral headcount (only counted after referee sorts first card)
    verifiedReferralCount: { type: Number, default: 0 },

    // Founder application
    founderApplication: {
      appliedAt:  { type: Date,   default: null },
      motivation: { type: String, default: '' },
      status:     { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
      reviewedAt: { type: Date,   default: null },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      note:       { type: String, default: '' },
    },

    // Notifications
    notifPrefs: {
      streaks:          { type: Boolean, default: true },
      dailyDrop:        { type: Boolean, default: true },
      deals:            { type: Boolean, default: true },
      jobsScholarships: { type: Boolean, default: true },
      social:           { type: Boolean, default: true },
    },
    osPushPermission: {
      type: String,
      enum: ['granted', 'denied', 'undetermined'],
      default: 'undetermined',
    },
    pushPermissionAskedAt: { type: Date, default: null },
    push: {
      weekKey:       { type: String, default: null },
      sentThisWeek:  { type: Number, default: 0 },
      lastPushDay:   { type: String, default: null },
      lastPushAt:    { type: Date, default: null },
    },

    // In-app popup queue
    pendingPopups: [
      {
        kind: String,
        mood: String,
        line: String,
        cta: {
          label: String,
          route: String,
          params: mongoose.Schema.Types.Mixed,
        },
        payload: mongoose.Schema.Types.Mixed,
        priority: { type: Number, default: 0 },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Partner / crew
    partner: {
      type: {
        type: String,
        enum: ['none', 'ambassador', 'influencer'],
        default: 'none',
      },
      since: Date,
      university: String,
      handle: String,
      addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },

    backfilledAt: { type: Date, default: null },

    // Welcome perk (from referral / campaign)
    welcomePerk: {
      campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
      brand:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      percent:  { type: Number, default: 0 },
      usedAt:   { type: Date, default: null },
    },
  },
  { timestamps: true }
);

profileSchema.index({ 'streak.lastActionDay': 1, 'streak.count': 1 });
profileSchema.index({ 'stats.lastActiveAt': 1 });
profileSchema.index({ verifiedReferralCount: -1 });

module.exports = mongoose.model('EngagementProfile', profileSchema);