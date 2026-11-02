// models/RedemptionGuard.js
// A counter per cap (e.g. one student, one offer, one Karachi day). A request takes a slot with one
// conditional update ({ count < limit } → $inc), so two simultaneous requests can't both get past a
// cap. Rows remove themselves after expiresAt (TTL index).
const mongoose = require("mongoose");

const redemptionGuardSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
});
redemptionGuardSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RedemptionGuard = mongoose.models.RedemptionGuard || mongoose.model("RedemptionGuard", redemptionGuardSchema);

// Take one slot under `limit`. `already` is how many were used before this guard existed for the key
// (counted from the records), so a cap that was already reached stays reached. true = slot taken.
async function takeSlot(key, limit, already, expiresAt) {
  try {
    await RedemptionGuard.updateOne({ key }, { $setOnInsert: { count: already, expiresAt } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err; // another request created it at the same moment: fine
  }
  const won = await RedemptionGuard.findOneAndUpdate({ key, count: { $lt: limit } }, { $inc: { count: 1 } }, { new: true });
  return !!won;
}

// give a slot back (the write it guarded failed)
async function releaseSlot(key) {
  await RedemptionGuard.updateOne({ key, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

module.exports = RedemptionGuard;
module.exports.takeSlot = takeSlot;
module.exports.releaseSlot = releaseSlot;
