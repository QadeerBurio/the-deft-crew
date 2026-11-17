// models/EmployerPlanRequest.js
// An employer's "request a plan" (services/career/hiringAccessService.js): how many jobs and a short note. One open
// request per employer (sending again updates it). An admin grants a plan (status granted) or declines it, with a
// reason; both are in AdminActionLog. No payment of any kind.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  employerUserId: { type: ObjectId, ref: "User", required: true, index: true },
  jobs: { type: Number, required: true, min: 1, max: 100 },
  note: { type: String, default: "", maxlength: 500 },
  status: { type: String, enum: ["open", "granted", "declined"], default: "open", index: true },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: ObjectId, ref: "User", default: null },
  resolution: { type: String, default: "" },
}, { timestamps: true });

module.exports = mongoose.models.EmployerPlanRequest || mongoose.model("EmployerPlanRequest", schema);
