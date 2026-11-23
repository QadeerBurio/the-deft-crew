// models/Credential.js
const mongoose = require('mongoose');

const credentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['certificate', 'letter', 'recommendation', 'founder_card', 'badge'],
      required: true,
    },
    note: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'issued', 'revoked'], default: 'issued', index: true },
    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fileUrl: { type: String, default: '' },
    // P2-5 (additive): a recommendation letter's text, written / edited by an admin and approved before it is issued
    // (never generated); revokedAt / revokedBy: a revoked credential shows "revoked" on its public verify page
    letterText: { type: String, default: undefined, maxlength: 6000 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    approvedAt: { type: Date, default: undefined },
    revokedAt: { type: Date, default: undefined },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Credential', credentialSchema);