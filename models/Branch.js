// models/Branch.js
const mongoose = require("mongoose");

const branchSchema = new mongoose.Schema(
  {
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Branch name is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    // Discount percentage for this branch
    discountPercentage: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    // Availability type
    isOnline: {
      type: Boolean,
      default: false,
    },
    isInStore: {
      type: Boolean,
      default: false,
    },
    // Location (only for in-store)
    location: {
      type: String,
      default: "",
      trim: true,
    },
    // Optional
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    city: {
      type: String,
      default: "",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // "near me": map point for this branch's address (optional).
    // Filled by services/geo/geocoder.js after save, or set by hand (geoSource "manual").
    geo: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
    geoSource: { type: String, enum: ["geocoded", "manual"] },
    // how precise the point is (exact = building/plus code, area = neighbourhood/street)
    geoPrecision: { type: String, enum: ["exact", "area"] },
    geoCity: { type: String }, // city Google matched (geocoded) or the city given by hand
    geoUpdatedAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes
branchSchema.index({ brand: 1, isActive: 1 });
branchSchema.index({ brand: 1, createdAt: -1 });
branchSchema.index({ geo: "2dsphere" }, { sparse: true });

module.exports = mongoose.model("Branch", branchSchema);