// models/EmployerCompanyVerification.js
// An employer's company details for First Hire Free (FLAG_EMPLOYER_FIRST_HIRE_FREE), checked by an admin:
// company name, NTN or SECP registration number, business e-mail domain and website. One per employer
// account (unique employerUserId). companyGroupKey groups accounts of the same company: same registration
// number, same e-mail domain or same website = the same company group, and a group gets one trial.
// A submission matching another account goes to duplicate_review. The User schema is unchanged.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  employerUserId: { type: ObjectId, ref: "User", required: true, unique: true },
  companyGroupKey: { type: String, required: true },
  companyName: { type: String, required: true, trim: true, maxlength: 120 },
  registrationType: { type: String, enum: ["ntn", "secp"], required: true },
  ntnOrSecp: { type: String, required: true }, // normalized: upper case, letters and digits only
  businessEmailDomain: { type: String, required: true }, // e.g. "brightlabs.pk"
  website: { type: String, required: true }, // host only, e.g. "brightlabs.pk"
  signInEmailMatchesDomain: { type: Boolean, default: false }, // a hint for the admin
  websiteMatchesDomain: { type: Boolean, default: false },
  status: { type: String, enum: ["pending", "approved", "rejected", "duplicate_review"], default: "pending" },
  duplicateOf: [{ _id: false, verificationId: { type: ObjectId, ref: "EmployerCompanyVerification" }, employerUserId: { type: ObjectId, ref: "User" }, matchedOn: [String] }],
  reviewedBy: { type: ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reason: { type: String, default: "", maxlength: 500 }, // the admin's reason (shown to the employer)
  history: [{ _id: false, action: String, status: String, by: { type: ObjectId, ref: "User", default: null }, byRole: String, reason: String, at: { type: Date, default: Date.now } }],
}, { timestamps: true });
schema.index({ status: 1, createdAt: -1 });
schema.index({ ntnOrSecp: 1 });
schema.index({ businessEmailDomain: 1 });
schema.index({ website: 1 });
schema.index({ companyGroupKey: 1 });

module.exports = mongoose.models.EmployerCompanyVerification || mongoose.model("EmployerCompanyVerification", schema);
