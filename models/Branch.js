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
  },
  { timestamps: true }
);

// Indexes
branchSchema.index({ brand: 1, isActive: 1 });
branchSchema.index({ brand: 1, createdAt: -1 });

module.exports = mongoose.model("Branch", branchSchema);