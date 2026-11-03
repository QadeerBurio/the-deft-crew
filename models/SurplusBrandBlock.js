// models/SurplusBrandBlock.js
// An admin's decision to stop a brand's Surprise Box listings (e.g. after repeated upheld disputes).
// One row per brand; `active` false lifts it. Never set automatically.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  brand: { type: ObjectId, ref: "User", required: true, unique: true },
  active: { type: Boolean, default: true },
  reason: { type: String, default: "", maxlength: 500 },
  by: { type: ObjectId, ref: "User", default: null },
  history: [{ _id: false, active: Boolean, reason: String, by: { type: ObjectId, ref: "User" }, at: { type: Date, default: Date.now } }],
}, { timestamps: true });

module.exports = mongoose.models.SurplusBrandBlock || mongoose.model("SurplusBrandBlock", schema);
