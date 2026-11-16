// models/EmployerHiringAccess.js
// Posting access of one employer account (services/career/hiringAccessService.js): the free trial and a plan an
// admin granted by hand. Created on first use (no data migration). The trial's state is worked out when it's read:
//   trialStartedAt   when its 60 days started: the first job posted, or the policy's start date for an employer
//                    who had posted before it (existing employers start fresh); null = no job yet (clock not started)
//   extendedUntil    an admin extended the trial to this date (extendedAt: when; a hire before then doesn't end it)
//   endedByAdminAt   an admin ended the trial
//   plan             { jobsGranted (null = no job limit), jobsUsed, validUntil (null = no end date), grantedAt,
//                    grantedBy, reason }: a new grant replaces the plan
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  employerUserId: { type: ObjectId, ref: "User", required: true, unique: true },
  trialStartedAt: { type: Date, default: null },
  extendedUntil: { type: Date, default: null },
  extendedAt: { type: Date, default: null },
  endedByAdminAt: { type: Date, default: null },
  plan: {
    type: new mongoose.Schema({
      jobsGranted: { type: Number, default: null },
      jobsUsed: { type: Number, default: 0 },
      validUntil: { type: Date, default: null },
      grantedAt: { type: Date, required: true },
      grantedBy: { type: ObjectId, ref: "User", default: null },
      reason: { type: String, default: "" },
    }, { _id: false }),
    default: null,
  },
  version: { type: Number, default: 1 },
  history: [{ _id: false, action: String, by: { type: ObjectId, ref: "User", default: null }, byRole: String, reason: String, detail: { type: mongoose.Schema.Types.Mixed, default: null }, at: { type: Date, default: Date.now } }],
}, { timestamps: true });

module.exports = mongoose.models.EmployerHiringAccess || mongoose.model("EmployerHiringAccess", schema);
