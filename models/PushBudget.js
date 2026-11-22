// models/PushBudget.js
// N-2 push budget (flag pushBudgetV1): how many "relevant" and "broadcast" pushes a student got on one Karachi day.
// Personal pushes are never counted. One row per student per day; rows expire after 3 days.
const mongoose = require("mongoose");

const pushBudgetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dayKey: { type: String, required: true }, // Karachi day, YYYY-MM-DD
    relevant: { type: Number, default: 0 },
    broadcast: { type: Number, default: 0 },
  },
  { timestamps: true }
);

pushBudgetSchema.index({ user: 1, dayKey: 1 }, { unique: true });
pushBudgetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model("PushBudget", pushBudgetSchema);
