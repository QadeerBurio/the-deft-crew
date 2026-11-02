// models/DomainEvent.js
// Something that happened in the business (a redemption, a reward used, an offer archived), recorded
// once. `key` is the event's identity (e.g. "offer.redeemed:<redemptionId>"): the unique index makes a
// retried or duplicated write a no-op, so a side effect keyed on "was I first?" runs once.
// Ids and amounts only, never names, e-mails, phone numbers or tokens. Kept (no TTL): it's history.
const mongoose = require("mongoose");

const domainEventSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  type: { type: String, required: true },             // e.g. "offer.redeemed"
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },  // who did it
  subject: {                                          // what it happened to
    kind: { type: String, default: "" },              // "Offer", "PromoCode", "RewardRedemption", ...
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },  // ids and amounts only
  at: { type: Date, default: Date.now },
});
domainEventSchema.index({ type: 1, at: -1 });
domainEventSchema.index({ "subject.id": 1, at: -1 });

module.exports = mongoose.models.DomainEvent || mongoose.model("DomainEvent", domainEventSchema);
