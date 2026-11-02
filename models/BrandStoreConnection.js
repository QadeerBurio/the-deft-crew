// models/BrandStoreConnection.js
// A brand's online store connection (WooCommerce for now): one per brand. Credentials are sealed with
// utils/secretBox (AES-256-GCM) and never selected unless a query asks for them by name; toJSON drops them
// anyway, so no route can send them to a client by accident.
const mongoose = require("mongoose");

const SECRET_FIELDS = ["keyEnc", "secretEnc", "webhookSecretEnc", "stateHash"];

const brandStoreConnectionSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    platform: { type: String, enum: ["woocommerce"], default: "woocommerce" },
    // https origin + path of the store, no trailing slash
    storeUrl: { type: String, default: "" },
    // pending: waiting for WooCommerce to send keys; connected: keys work; error: keys or store failing
    status: { type: String, enum: ["pending", "connected", "error", "disconnected"], default: "pending", index: true },
    connectMethod: { type: String, enum: ["wc-auth", "manual", "migrated"], default: "wc-auth" },

    keyEnc: { type: String, default: "", select: false },
    secretEnc: { type: String, default: "", select: false },
    wcKeyId: { type: Number, default: null }, // WooCommerce's id for the key (to revoke it there)
    keyPermissions: { type: String, default: "" },

    webhookId: { type: Number, default: null },
    webhookSecretEnc: { type: String, default: "", select: false },
    webhookStatus: { type: String, enum: ["none", "active", "error"], default: "none" },

    // one-time state for the wc-auth callback (sha256 of the random value), and when it stops working
    stateHash: { type: String, default: "", select: false },
    stateExpiresAt: { type: Date, default: null },

    lastCheckAt: { type: Date, default: null },
    lastError: { type: String, default: "" }, // short, never a key or secret
    connectedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        for (const f of SECRET_FIELDS) delete ret[f];
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.BrandStoreConnection || mongoose.model("BrandStoreConnection", brandStoreConnectionSchema);
module.exports.SECRET_FIELDS = SECRET_FIELDS;
