// models/SkillGapCache.js
// ============================================================
// Caches skill gap analysis results for (resumeId × jobId) pairs.
// GPT-4o-mini calls cost money — this prevents re-running the same
// analysis on every page view. Cache expires after 24 hours.
// On resume update, cache entries for that resumeId are invalidated
// automatically via the TTL index.
// ============================================================

const mongoose = require('mongoose');

const SkillGapCacheSchema = new mongoose.Schema({

  // Composite key: one cache entry per (resume, job) pair
  resumeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Resume',
    required: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },

  // ── Core analysis results ──────────────────────────────────
  overallMatchScore: { type: Number, default: 0 },   // 0–100
  atsCompatibilityScore: { type: Number, default: 0 }, // 0–100
  shouldApply: { type: Boolean, default: false },
  confidence: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },

  // Skill breakdown
  matchedSkills: [{
    skill:         { type: String },
    candidateLevel: { type: String },   // Beginner / Intermediate / Advanced / Expert
    required:      { type: Boolean }
  }],
  missingSkills: [{
    skill:          { type: String },
    importance:     { type: String, enum: ['critical', 'important', 'nice-to-have'], default: 'important' },
    learnTimeWeeks: { type: Number, default: 2 },
    resources:      [{ type: String }]  // e.g. ["Coursera", "Udemy", "Official Docs"]
  }],
  partialSkills: [{
    skill:          { type: String },
    candidateLevel: { type: String },
    requiredLevel:  { type: String },
    gapDescription: { type: String }
  }],

  // AI narrative output
  strengths:       [{ type: String }],   // 3-5 bullet strengths
  weaknesses:      [{ type: String }],   // 2-3 bullet gaps
  recommendation:  { type: String },     // 1-3 sentence overall recommendation
  coverLetterHints: [{ type: String }],  // 2-3 things to emphasise in cover letter

  // Meta
  analysisVersion: { type: String, default: '1.0.0' },
  generatedAt:     { type: Date, default: Date.now },

  // TTL index: auto-delete after 24 hours (86400 seconds)
  // MongoDB will clean these up automatically
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  }

});

// ── Indexes ────────────────────────────────────────────────
// Fast lookup by (resumeId, jobId) pair — this is the primary query
SkillGapCacheSchema.index({ resumeId: 1, jobId: 1 }, { unique: true });

// TTL index — MongoDB auto-deletes expired documents
SkillGapCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Allow fast invalidation of all cache for a given resume (e.g. on resume update)
SkillGapCacheSchema.index({ resumeId: 1 });

module.exports = mongoose.model('SkillGapCache', SkillGapCacheSchema);
