// models/SocialPushGroup.js
// Items waiting for (or sent in) one social push: one open group per kind ("post",
// "confession", "listing") and scope ("all", or the university id for confessions).
// Kept in MongoDB so items created at night (sent at 09:00) survive a restart.
// Stores only what the push text needs: a post's author first name and a 60-character snippet,
// a listing's title; for a confession nothing but its id. Removed after 14 days.
const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    firstName: { type: String, default: "" },
    text: { type: String, default: "" },
    hasImage: { type: Boolean, default: false },
    title: { type: String, default: "" },
  },
  { _id: false }
);

const socialPushGroupSchema = new mongoose.Schema({
  kind: { type: String, enum: ["post", "confession", "listing"], required: true },
  scope: { type: String, required: true },
  status: { type: String, enum: ["open", "sending", "sent", "dropped"], default: "open" },
  items: { type: [itemSchema], default: [] },
  sendAfter: { type: Date, required: true },
  sentAt: { type: Date, default: null },
  result: {
    students: Number,
    devices: Number,
    delivered: Number,
    failed: Number,
    capped: Number,
  },
  reason: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

socialPushGroupSchema.index({ kind: 1, scope: 1, status: 1 });
socialPushGroupSchema.index({ status: 1, sendAfter: 1 });
socialPushGroupSchema.index({ kind: 1, scope: 1, sentAt: -1 });
socialPushGroupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

module.exports = mongoose.models.SocialPushGroup || mongoose.model("SocialPushGroup", socialPushGroupSchema);
