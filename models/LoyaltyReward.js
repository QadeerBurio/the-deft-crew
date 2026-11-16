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
    savedAmount: { type: Number, default: null }, // what the reward itself took off the bill
    // applied to a bill (feat/loyalty-control): the redemption it was used on and the breakdown on the original bill
    redemptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    offerDiscount: { type: Number, default: null }, // the offer's part of the discount
    totalDiscount: { type: Number, default: null }, // offer + reward, never above the bill
    combine: { type: String, default: null }, // "stack" or "replace", as the program said when used
    // an online promo code that carries this reward (the store coupon includes it); used when that order is confirmed
    promoCodeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reservedOfferPct: { type: Number, default: null }, // the offer's own % when the code was made
    usedNotifiedAt: { type: Date, default: null }, // the student was told "reward used, you saved PKR X" (once)
  },
  { timestamps: true }
);
loyaltyRewardSchema.index({ program: 1, student: 1, cycleKey: 1 }, { unique: true });
loyaltyRewardSchema.index({ brand: 1, student: 1, status: 1 });
loyaltyRewardSchema.index({ useKey: 1 }, { unique: true, partialFilterExpression: { useKey: { $type: "string" } } });

module.exports = mongoose.models.LoyaltyReward || mongoose.model("LoyaltyReward", loyaltyRewardSchema);
