// models/EmployerCompanyVerification.js
// An employer's company details for First Hire Free (FLAG_EMPLOYER_FIRST_HIRE_FREE), checked by an admin:
// company name, NTN or SECP registration number, business e-mail domain and website. One per employer
// account (unique employerUserId). companyGroupKey groups accounts of the same company: same registration
// number, same e-mail domain or same website = the same company group, and a group gets one trial.
// A submission matching another account goes to duplicate_review. The User schema is unchanged.
// Proof: at least one of the company's own e-mail domain, its website, or an uploaded document (NTN certificate,
// SECP certificate, business registration or letterhead: models/EmployerVerificationDocument.js, admins only).
// status needs_info: an admin asked for more (the reason says what); the employer sends again.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  employerUserId: { type: ObjectId, ref: "User", required: true, unique: true },
  companyGroupKey: { type: String, required: true },
  companyName: { type: String, required: true, trim: true, maxlength: 120 },
  registrationType: { type: String, enum: ["ntn", "secp"], required: true },
  ntnOrSecp: { type: String, required: true }, // normalized: upper case, letters and digits only
  businessEmailDomain: { type: String, default: "" }, // e.g. "brightlabs.pk"; optional when a document is uploaded
  website: { type: String, default: "" }, // host only, e.g. "brightlabs.pk"; optional when a document is uploaded
  // uploaded proof (the files themselves are in EmployerVerificationDocument; only admins can open them)
  documents: [{ _id: false, documentId: { type: ObjectId, ref: "EmployerVerificationDocument" }, kind: String, fileName: String, mimeType: String, size: Number, uploadedAt: Date }],
  signInEmailMatchesDomain: { type: Boolean, default: false }, // a hint for the admin
  websiteMatchesDomain: { type: Boolean, default: false },
  status: { type: String, enum: ["pending", "approved", "rejected", "duplicate_review", "needs_info"], default: "pending" },
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
