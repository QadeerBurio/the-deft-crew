// models/PartnerApplication.js
const mongoose = require('mongoose');

const partnerApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    university: { type: String, required: true, trim: true },
    why: { type: String, required: true, maxlength: 2000 },
    handle: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    // P2-3 (additive): the in-app application. universityId: the student's university (the name above stays, for
    // older applications); groups: campus groups / societies; why chips; source: where it came from; appliedAt: the
    // latest (re)application (a rejected student may apply again after 30 days: the same document, back to pending)
    universityId: { type: mongoose.Schema.Types.ObjectId, ref: 'University', default: null, index: true },
    groups: { type: [String], default: undefined },
    whyChips: { type: [String], default: undefined },
    source: { type: String, enum: ['app', 'web', 'form'], default: undefined },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

partnerApplicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PartnerApplication', partnerApplicationSchema);