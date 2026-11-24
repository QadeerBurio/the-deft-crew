// models/ConfessionFollow.js
// P4b (flag confessionFollow): a student follows a confession (the bell) and gets a push on new replies. The author
// follows their own confession automatically and can mute it (on: false). Never shown to anyone: nobody can see who
// follows what. lastPushAt: at most one reply push per confession per 30 minutes for each follower.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  user: { type: ObjectId, ref: "User", required: true },
  confession: { type: ObjectId, ref: "Confession", required: true },
  on: { type: Boolean, default: true },
  author: { type: Boolean, default: false }, // the confession's own author (followed automatically)
  lastPushAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ user: 1, confession: 1 }, { unique: true });
schema.index({ confession: 1, on: 1 });

module.exports = mongoose.models.ConfessionFollow || mongoose.model("ConfessionFollow", schema);
