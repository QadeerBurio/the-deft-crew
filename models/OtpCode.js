// models/OtpCode.js
// OTPs live in MongoDB (not server memory), so they survive Railway restarts,
// redeploys and multiple instances. Mongo deletes them automatically on expiry.
const mongoose = require('mongoose');

const otpCodeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, default: 'password-reset', index: true },
    codeHash: { type: String, required: true }, // sha256, never the raw code
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: Mongo removes the doc once expiresAt passes
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpCode', otpCodeSchema);
