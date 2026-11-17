// models/EmployerVerificationDocument.js
// Proof an employer uploads for company verification when they have no own e-mail domain or website: an NTN
// certificate, an SECP certificate, a business registration or a letterhead. PDF, JPEG, PNG or WebP, at most 5 MB.
// Private: the bytes are stored here (not on a public file host) and only an admin can open them
// (GET /api/career/admin/company-verifications/:id/documents/:documentId, logged). Never sent in lists.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const KINDS = ["ntn_certificate", "secp_certificate", "business_registration", "letterhead"];
const schema = new mongoose.Schema({
  employerUserId: { type: ObjectId, ref: "User", required: true, index: true },
  kind: { type: String, enum: KINDS, required: true },
  fileName: { type: String, default: "", maxlength: 200 },
  mimeType: { type: String, enum: ["application/pdf", "image/jpeg", "image/png", "image/webp"], required: true },
  size: { type: Number, required: true, max: 5 * 1024 * 1024 },
  sha256: { type: String, default: "" },
  data: { type: Buffer, required: true, select: false },
}, { timestamps: true });

schema.statics.KINDS = KINDS;
module.exports = mongoose.models.EmployerVerificationDocument || mongoose.model("EmployerVerificationDocument", schema);
