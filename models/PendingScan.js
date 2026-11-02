// models/PendingScan.js
// A student's QR scan waiting for the brand to confirm the bill (scan-verify → pending-scans →
// redeem-payment / scan-processed). It used to be an in-memory list: lost on every restart, not shared
// between server instances, and capped at 50 scans across all brands. Each row removes itself 30
// minutes after the scan (TTL index on expiresAt), processed or not.
// One pending scan per student per brand: a partial unique index, so two simultaneous scans make one row.
const mongoose = require("mongoose");

const PENDING_SCAN_MINUTES = 30;

const pendingScanSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  offer: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true },
  status: { type: String, enum: ["pending", "processed"], default: "pending" },
  // what the brand's screen shows, copied from the student's account and the offer at scan time
  name: { type: String, default: "Student" },
  rollNo: { type: String, default: "N/A" },
  universityName: { type: String, default: "University" },
  email: { type: String, default: "" },
  offerTitle: { type: String, default: "Offer" },
  discountPercentage: { type: Number, default: 0 },
  brandName: { type: String, default: "Brand" },
  redemptionsUsed: { type: Number, default: 0 },
  maxRedemptions: { type: Number, default: 2 },
  scannedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: () => new Date(Date.now() + PENDING_SCAN_MINUTES * 60 * 1000) },
});
pendingScanSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
pendingScanSchema.index({ student: 1, brand: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });
pendingScanSchema.index({ brand: 1, status: 1, scannedAt: -1 });

// the shape the brand portal reads (the old in-memory entry)
pendingScanSchema.methods.toScan = function () {
  return {
    studentId: String(this.student),
    name: this.name,
    rollNo: this.rollNo,
    university: this.universityName,
    universityName: this.universityName,
    email: this.email,
    offerId: String(this.offer),
    offerTitle: this.offerTitle,
    discountPercentage: this.discountPercentage,
    brandId: String(this.brand),
    brandName: this.brandName,
    scannedAt: new Date(this.scannedAt).toISOString(),
    status: this.status,
    redemptionsUsed: this.redemptionsUsed || 0,
    maxRedemptions: this.maxRedemptions || 2,
  };
};

const PendingScan = mongoose.models.PendingScan || mongoose.model("PendingScan", pendingScanSchema);
module.exports = PendingScan;
module.exports.PENDING_SCAN_MINUTES = PENDING_SCAN_MINUTES;
