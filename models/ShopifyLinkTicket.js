const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: String,
  shop: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  brandId: mongoose.Schema.Types.ObjectId,
  browserDigest: String,
  redeemedAt: Date,
});

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("ShopifyLinkTicket", schema);
