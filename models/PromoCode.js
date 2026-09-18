// models/PromoCode.js
const mongoose = require("mongoose");

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  offer: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  discountPercentage: { type: Number, required: true },
  offerTitle: { type: String, required: true },
  brandName: { type: String, required: true },

  status: { type: String, enum: ['active', 'used', 'expired', 'cancelled'], default: 'active' },
  usedAt: Date,
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  redeemedVia: { type: String, enum: ['manual', 'webhook'], default: 'manual' },
  externalOrderId: { type: String, default: "" },
  externalAmount: { type: Number, default: 0 },

 externalProvider: {
  type: String,
  enum: ['none', 'shopify', 'woocommerce'],
  default: 'none',
},
externalDiscountId: { type: String, default: "" },

  expiresAt: { type: Date, required: true, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  maxUses: { type: Number, default: 1 },
  usedCount: { type: Number, default: 0 },

  qrData: String,
  generatedAt: { type: Date, default: Date.now },
  ipAddress: String,
  userAgent: String,
}, { timestamps: true });

promoSchema.index({ student: 1, status: 1 });
promoSchema.index({ brand: 1, status: 1 });
promoSchema.index({ offer: 1, student: 1 });
promoSchema.index({ expiresAt: 1 });

// ✅ FIX: call next() — this was the hanging bug
promoSchema.pre('save', function (next) {
  if (!this.qrData) {
    this.qrData = JSON.stringify({
      code: this.code,
      offerId: this.offer?.toString(),
      studentId: this.student?.toString(),
      brandId: this.brand?.toString(),
      discount: this.discountPercentage,
      generatedAt: this.generatedAt,
    });
  }
  next();
});

promoSchema.statics.generateUniqueCode = async function (prefix = '') {
  let attempts = 0;
  while (attempts < 20) {
    attempts++;
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const code = prefix ? `${prefix}${random}` : random;
    const existing = await this.findOne({ code }).lean();
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique promo code');
};

promoSchema.statics.generateFormattedCode = function (brandName) {
  const prefix = brandName.substring(0, 3).toUpperCase();
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${suffix}`;
};

module.exports = mongoose.model("PromoCode", promoSchema);