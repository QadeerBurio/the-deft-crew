// models/LoyaltyReward.js
// A reward a student earned on a brand's "reward" loyalty program (services/loyalty.js): N verified visits earn
// one reward (% off, a fixed PKR amount off, or a free item). One reward per cycle: the unique cycleKey means a
// retried or simultaneous visit can never earn it twice. Using it is one atomic available -> used change; the
// student's visit count then starts again from that moment. Rewards from an ended program period stay recorded but
// can't be used. Kept as history; never deleted by the loyalty code.
const mongoose = require("mongoose");

const loyaltyRewardSchema = new mongoose.Schema(
  {
    program: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyProgram", required: true },
    programVersion: { type: Number, required: true },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // "<period>:<id of the last used reward | start>": one reward per cycle of N visits
    cycleKey: { type: String, required: true },
    status: { type: String, enum: ["available", "used", "void"], default: "available" },
    // what was earned, as it was when earned
    kind: { type: String, enum: ["percent", "amount", "item"], required: true },
    value: { type: Number, default: null },
    item: { type: String, default: "", maxlength: 80 },
    label: { type: String, default: "", maxlength: 100 },
    visitsNeeded: { type: Number, required: true },
    earnedAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    useKey: { type: String, default: null },
    billAmount: { type: Number, default: null },
    savedAmount: { type: Number, default: null },
  },
  { timestamps: true }
);
loyaltyRewardSchema.index({ program: 1, student: 1, cycleKey: 1 }, { unique: true });
loyaltyRewardSchema.index({ brand: 1, student: 1, status: 1 });
loyaltyRewardSchema.index({ useKey: 1 }, { unique: true, partialFilterExpression: { useKey: { $type: "string" } } });

module.exports = mongoose.models.LoyaltyReward || mongoose.model("LoyaltyReward", loyaltyRewardSchema);
