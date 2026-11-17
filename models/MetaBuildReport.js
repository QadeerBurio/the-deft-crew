// models/MetaBuildReport.js
// Which app builds have the Meta App Events IDs (POST /api/app/meta-build, routes/appFlags.routes.js). One row per
// platform + app version + build number + enabled, counting how many installs reported it. No user, device or
// advertising id: only what the build is. A production build reporting enabled: false means it was built without
// META_APP_ID / META_CLIENT_TOKEN, so Meta sees nothing from it.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  platform: { type: String, enum: ["ios", "android"], required: true },
  appVersion: { type: String, required: true, maxlength: 20 },
  build: { type: String, required: true, maxlength: 12 },
  enabled: { type: Boolean, required: true },
  count: { type: Number, default: 0 },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
});
schema.index({ platform: 1, appVersion: 1, build: 1, enabled: 1 }, { unique: true });

module.exports = mongoose.models.MetaBuildReport || mongoose.model("MetaBuildReport", schema);
