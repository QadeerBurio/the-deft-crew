// models/PromoCode.js
const mongoose = require("mongoose");

const promoSchema = new mongoose.Schema({
  // The actual promo code
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },

  // Reference to the offer this promo code belongs to
  offer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Offer",
    required: true
  },

  // Student who generated/claimed this promo code
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  // Brand that owns this offer
  brand: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  // Discount details (cached for quick access)
  discountPercentage: {
    type: Number,
    required: true
  },
  offerTitle: {
    type: String,
    required: true
  },
  brandName: {
    type: String,
    required: true
  },

  // Status tracking
  status: {
    type: String,
    enum: ['active', 'used', 'expired', 'cancelled'],
    default: 'active'
  },

  // Redemption tracking
  usedAt: {
    type: Date
  },
  usedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  redeemedVia: {
    type: String,
    enum: ['manual', 'webhook'],
    default: 'manual'
  },
  externalOrderId: {
    type: String,
    default: ""
  },
  externalAmount: {
    type: Number,
    default: 0
  },


  // Expiry
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days default
  },

  // Usage limits
  maxUses: {
    type: Number,
    default: 1
  },
  usedCount: {
    type: Number,
    default: 0
  },

  // QR code data (for in-store verification)
  qrData: {
    type: String
  },

  // Metadata
  generatedAt: {
    type: Date,
    default: Date.now
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  }
}, { timestamps: true });

// Indexes for fast lookups
promoSchema.index({ student: 1, status: 1 });
promoSchema.index({ brand: 1, status: 1 });
promoSchema.index({ offer: 1, student: 1 });
promoSchema.index({ expiresAt: 1 });

// Pre-save hook to generate QR data
promoSchema.pre('save', function (next) {
  if (!this.qrData) {
    this.qrData = JSON.stringify({
      code: this.code,
      offerId: this.offer.toString(),
      studentId: this.student.toString(),
      brandId: this.brand.toString(),
      discount: this.discountPercentage,
      generatedAt: this.generatedAt
    });
  }
});

// Static method to generate a unique promo code
promoSchema.statics.generateUniqueCode = async function (prefix = '') {
  let code = '';
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 20;

  while (!isUnique && attempts < maxAttempts) {
    attempts++;
    // Format: PREFIX + 6 random alphanumeric characters
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    code = prefix ? `${prefix}${random}` : random;

    const existing = await this.findOne({ code });
    if (!existing) {
      isUnique = true;
    }
  }

  if (!isUnique) {
    throw new Error('Failed to generate a unique promo code');
  }

  return code;
};

// Static method to generate code with specific format
promoSchema.statics.generateFormattedCode = function (brandName, offerTitle) {
  const prefix = brandName.substring(0, 3).toUpperCase();
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${suffix}`;
};

module.exports = mongoose.model("PromoCode", promoSchema);