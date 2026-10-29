// models/RedemptionArchive.js
// What is kept of a deleted brand's redemptions (services/accountDeletion.js), so revenue and savings
// figures don't change when a brand account is deleted. Never holds the brand's id, name or offer titles.
//   kind "redemption":   one per redemption of the deleted brand's offers. Keeps the student who made it
//                        (that student's account still exists), so their savings and history stay right.
//   kind "brand-totals": one per deleted brand: the figures /api/offers/admin/brands-revenue showed for
//                        it, added to the grand totals there.
const mongoose = require("mongoose");

const totalsSchema = new mongoose.Schema(
  {
    totalRevenue: { type: Number, default: 0 },
    totalBill: { type: Number, default: 0 },
    totalSaved: { type: Number, default: 0 },
    totalRedemptions: { type: Number, default: 0 },
    uniqueStudents: { type: Number, default: 0 },
    qrRevenue: { type: Number, default: 0 },
    qrBill: { type: Number, default: 0 },
    qrSaved: { type: Number, default: 0 },
    qrCount: { type: Number, default: 0 },
    promoRevenue: { type: Number, default: 0 },
    promoBill: { type: Number, default: 0 },
    promoCount: { type: Number, default: 0 },
    offersCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const redemptionArchiveSchema = new mongoose.Schema({
  kind: { type: String, enum: ["redemption", "brand-totals"], required: true },
  // random per deletion; only the admin audit log connects it to the deleted account
  deletionId: { type: String, required: true, index: true },

  // kind "redemption": the original redemption and offer ids (the app reports redemptions to Meta by id)
  redemptionId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  offerId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined, index: true },
  billAmount: { type: Number, default: 0 },
  savedAmount: { type: Number, default: 0 },
  redeemedAt: { type: Date },

  // kind "brand-totals"
  totals: { type: totalsSchema, default: undefined },

  createdAt: { type: Date, default: Date.now },
});

// archiving twice (a re-run after a failure) never counts anything twice
redemptionArchiveSchema.index({ redemptionId: 1 }, { unique: true, partialFilterExpression: { kind: "redemption" } });
redemptionArchiveSchema.index({ deletionId: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: "brand-totals" } });

module.exports = mongoose.models.RedemptionArchive || mongoose.model("RedemptionArchive", redemptionArchiveSchema);
