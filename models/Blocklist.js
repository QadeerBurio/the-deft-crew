// models/Blocklist.js
// E-mails and phone numbers that can't sign up again (plan P4-1b "blacklist"). Only hashes are stored (sha256 of the
// normalised value), never the e-mail or number itself. Written only by the safety e-mail's blacklist action or an
// admin; read by POST /api/auth/signup.
const mongoose = require("mongoose");

const blocklistSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["email", "phone"], required: true },
    hash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // the account that was blacklisted
    reason: { type: String, maxlength: 200 },
  },
  { timestamps: true }
);
blocklistSchema.index({ kind: 1, hash: 1 }, { unique: true });

module.exports = mongoose.model("Blocklist", blocklistSchema);
