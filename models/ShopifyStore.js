// models/ShopifyStore.js
const mongoose = require("mongoose");

const shopifyStoreSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  shopifyShopId: String,
  accessToken: { type: String, required: true },
  refreshToken: String,
  tokenExpiresAt: Date,
  scopes: [String],
  status: {
    type: String,
    enum: ["active", "uninstalled", "suspended"],
    default: "active",
  },
  installedAt: { type: Date, default: Date.now },
  uninstalledAt: Date,
}, { timestamps: true });

shopifyStoreSchema.index({ brandId: 1, status: 1 });

module.exports = mongoose.model("ShopifyStore", shopifyStoreSchema);