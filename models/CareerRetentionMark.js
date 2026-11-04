// models/CareerRetentionMark.js
// One row per job application whose hiring-timeline data the retention job anonymised (2 years after its
// last event; services/career/retentionService.js), so it is never processed twice. Ids, a time and counts
// only. A new collection: nothing is added to the existing career schemas.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true, unique: true },
  anonymisedAt: { type: Date, default: Date.now },
  counts: { type: mongoose.Schema.Types.Mixed, default: {} }, // { events, interviews, offers, outcomes, outbox }
});

module.exports = mongoose.models.CareerRetentionMark || mongoose.model("CareerRetentionMark", schema);
