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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Credential', credentialSchema);