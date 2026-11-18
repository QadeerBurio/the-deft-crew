// models/University.js — the one list of universities for signup, student verification, profiles, admin lists,
// filters and metrics (feat/universities). Additive: entries made before this have only `name` (made by signup
// from whatever was typed) and no `status`; they are "unmatched" until an admin matches, merges or approves them.
//   status   approved (searchable) | pending (a student's request) | hidden (not offered: merged, rejected, closed)
//            missing = an old signup entry, unmatched
//   key      the name normalised for matching (lower case, "&" = "and", no punctuation / "the" / campus words)
//   source   seed (HEC list, scripts/seed-universities.js) | admin | student (a request) | signup (old entries)
// Students point at it with User.university (+ User.universityName, the name shown). Matching never reads it.
const mongoose = require("mongoose");

const universitySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  shortName: { type: String, default: "", trim: true },
  city: { type: String, default: "", trim: true },
  province: { type: String, default: "", trim: true },
  sector: { type: String, default: "", trim: true },
  aliases: { type: [String], default: [] },
  key: { type: String, default: "", index: true },
  status: { type: String, enum: ["approved", "pending", "hidden"] },
  source: { type: String, enum: ["seed", "admin", "student", "signup"] },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  rejectReason: { type: String, default: "", trim: true },
  mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: "University", default: null },
  studentCount: { type: Number, default: 0 },
  hec: {
    page: { type: String, default: "" },
    discipline: { type: String, default: "" },
    charteredBy: { type: String, default: "" },
  },
}, { timestamps: true });

universitySchema.index({ status: 1, name: 1 });

module.exports = mongoose.models.University || mongoose.model("University", universitySchema);
