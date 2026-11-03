// models/SurplusListing.js
// A Surprise Box listing (merchant surplus food, pickup only, pay at pickup): one brand, one branch, a
// quantity, a pickup window and the food disclosures a student must see before confirming.
// quantityAvailable is only ever changed with a conditional $inc (services/surplus/inventory.js), so
// concurrent holds can't sell more than there is. `version` goes up on every merchant edit (409 on a
// stale one). Location is copied from the branch when the listing is created (distance in the app).
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  brand: { type: ObjectId, ref: "User", required: true },
  branch: { type: ObjectId, ref: "Branch", required: true },
  title: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: "", trim: true, maxlength: 600 }, // what's typically inside
  contentsMayVary: { type: Boolean, default: true },
  allergens: { type: [String], default: [] }, // e.g. ["gluten", "dairy", "nuts"]
  allergenNotes: { type: String, default: "", trim: true, maxlength: 400 },
  dietary: { type: [String], default: [] }, // e.g. ["vegetarian", "halal"]
  bestBefore: { type: Date, default: null }, // eat by
  quantityTotal: { type: Number, required: true, min: 1, max: 500 },
  quantityAvailable: { type: Number, required: true, min: 0 },
  listPrice: { type: Number, required: true, min: 0 }, // the usual value
  price: { type: Number, required: true, min: 0 }, // what the student pays at pickup
  currency: { type: String, default: "PKR" },
  pickupStart: { type: Date, required: true },
  pickupEnd: { type: Date, required: true },
  orderCutoff: { type: Date, required: true }, // no new holds after this
  status: { type: String, enum: ["draft", "published", "paused", "sold_out", "closed", "blocked"], default: "draft" },
  location: {
    city: { type: String, default: "" },
    address: { type: String, default: "" },
    branchName: { type: String, default: "" },
    geo: { type: { type: String, enum: ["Point"] }, coordinates: { type: [Number], default: undefined } },
  },
  version: { type: Number, default: 1 },
  publishedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ status: 1, pickupEnd: 1 });
schema.index({ brand: 1, createdAt: -1 });

module.exports = mongoose.models.SurplusListing || mongoose.model("SurplusListing", schema);
