// models/LoyaltyProgram.js
// A brand's loyalty program (one per brand). Only brands that opt in have one; status "active" is the opt-in.
// Tiers are by qualifying visit number: { minVisit, maxVisit (null = and up), discountPct }. The discount
// applied is capped by maxDiscountPct (set by the brand) and adminMaxDiscountPct (admin override, if set).
// Every rule change bumps `version` and keeps the previous rules in `history`; ledger rows store the
// version they were credited under. Visits: services/loyalty.js, from LoyaltyLedger.
// mode: "tiers" (the discount grows with visits; the default, and what a program without a mode is) or "reward"
// (every reward.visitsNeeded verified visits earn one reward: % off, PKR off or a free item; models/LoyaltyReward.js).
const mongoose = require("mongoose");

const tierSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true, maxlength: 40 },
    minVisit: { type: Number, required: true, min: 1 },
    maxVisit: { type: Number, default: null }, // null: this visit and every later one
    discountPct: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

const loyaltyProgramSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    status: { type: String, enum: ["draft", "active", "paused", "ended"], default: "draft", index: true },
    mode: { type: String, enum: ["tiers", "reward"], default: "tiers" },
    // reward mode only ("kind", not "type": Mongoose reads "type" as a type declaration)
    reward: {
      visitsNeeded: { type: Number, default: null, min: 2, max: 20 },
      kind: { type: String, enum: ["percent", "amount", "item", null], default: null },
      value: { type: Number, default: null, min: 0 }, // percent 1-100, or PKR
      item: { type: String, default: "", trim: true, maxlength: 80 }, // the free item
      maxPerStudent: { type: Number, default: null, min: 1, max: 100 }, // rewards per student in this program period
      maxPerMonth: { type: Number, default: null, min: 1, max: 31 }, // rewards per student per Karachi month
    },
    tiers: { type: [tierSchema], default: [] },
    // empty = every offer / branch of the brand
    eligibleOfferIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Offer" }],
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Branch" }],
    maxDiscountPct: { type: Number, required: true, min: 0, max: 100 },
    adminMaxDiscountPct: { type: Number, default: null, min: 0, max: 100 },
    // at most this many qualifying visits per student per Karachi day (0 = no limit)
    maxVisitsPerDay: { type: Number, default: 1, min: 0, max: 10 },
    // visits older than this many months stop counting (0 = never)
    resetMonths: { type: Number, default: 12, min: 0, max: 60 },
    terms: { type: String, default: "", trim: true, maxlength: 1000 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] }, // previous versions' rules (last 20)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LoyaltyProgram || mongoose.model("LoyaltyProgram", loyaltyProgramSchema);
