// models/LoyaltyProgramRestart.js
// One row per restart of an ended loyalty program (services/loyalty.js restartProgram). Ending is final for the
// version that ended: a restart turns the same program back into a draft at a new version, and this row marks
// where the old period stops. Visits credited under any version up to `endedVersion` never count again (the
// ledger keeps them; tallies skip them), so a restart never reopens old redemptions. Kept for good: unlike the
// program's own `history` (last 20 versions), every ended period's rules stay here. Append-only.
const mongoose = require("mongoose");

const loyaltyProgramRestartSchema = new mongoose.Schema(
  {
    program: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyProgram", required: true },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    endedVersion: { type: Number, required: true }, // credits with programVersion <= this belong to the ended period
    newVersion: { type: Number, required: true }, // the draft version the restart created
    endedAt: { type: Date, default: null }, // when it was ended (from the program's last update), if known
    endedRules: { type: mongoose.Schema.Types.Mixed, default: {} }, // the ended version's rules, as they were
    restartedAt: { type: Date, required: true },
    restartedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byAdmin: { type: Boolean, default: false },
  },
  { timestamps: false }
);
// one restart per ended version: a double click or a retry can't restart the same ended version twice
loyaltyProgramRestartSchema.index({ program: 1, endedVersion: 1 }, { unique: true });

module.exports = mongoose.models.LoyaltyProgramRestart || mongoose.model("LoyaltyProgramRestart", loyaltyProgramRestartSchema);
