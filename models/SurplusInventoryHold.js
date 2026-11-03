// models/SurplusInventoryHold.js
// Stock held for one student while they confirm (10 minutes). The stock was already taken from the
// listing when the hold was made; the hold ends as "consumed" (an order was placed), "released" (the
// student backed out) or "expired" (time ran out: the sweep puts the stock back). Each end is a
// conditional update from "active", so stock goes back exactly once.
// One active hold per student per listing (partial unique index). (student, idempotencyKey) is unique:
// a repeated tap returns the same hold. purgeAt (TTL) removes finished holds after 7 days; an active
// hold is never removed by TTL, because its stock must be returned first.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  listing: { type: ObjectId, ref: "SurplusListing", required: true },
  brand: { type: ObjectId, ref: "User", required: true },
  student: { type: ObjectId, ref: "User", required: true },
  qty: { type: Number, required: true, min: 1, max: 2 },
  expiresAt: { type: Date, required: true },
  state: { type: String, enum: ["active", "consumed", "released", "expired"], default: "active" },
  idempotencyKey: { type: String, required: true },
  order: { type: ObjectId, ref: "SurplusOrder", default: null },
  endedAt: { type: Date, default: null },
  purgeAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ student: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ listing: 1, student: 1 }, { unique: true, partialFilterExpression: { state: "active" } });
schema.index({ state: 1, expiresAt: 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.SurplusInventoryHold || mongoose.model("SurplusInventoryHold", schema);
