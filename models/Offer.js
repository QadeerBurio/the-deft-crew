// models/Offer.js - UPDATED
const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema({
  title: String,
  description: String,
  discountPercentage: Number,
  image: String,
  category: { 
    type: String, 
    required: true,
    enum: [
      "Restaurant",
      "Cafe & Coffee",
      "Food & Drinks",
      "Salon",
      "Spa & Wellness",
      "Health & Beauty",
      "Perfumes & Fragrances",
      "Fashion & Clothing",
      "Shoes & Footwear",
      "Bags & Accessories",
      "Electronics & Gadgets",
      "Mobile & Accessories",
      "Education & Institutes",
      "Travel & Tourism",
      "Hotels & Resorts",
      "Gym & Fitness",
      "Sports",
      "Entertainment",
      "Photography",
      "Services",
      "Others"
    ]
  },
  location: String,
  // "near me": map point for `location` (optional). Filled by services/geo/geocoder.js
  // after save, or set by hand (geoSource "manual").
  geo: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  geoSource: { type: String, enum: ["geocoded", "manual"] },
  // how precise the point is (exact = building/plus code, area = neighbourhood/street)
  geoPrecision: { type: String, enum: ["exact", "area"] },
  geoCity: { type: String }, // city Google matched (geocoded) or the city given by hand
  geoUpdatedAt: { type: Date },
  redeemInstructions: String,
  isOnline: Boolean,
  isInStore: Boolean,
  brand: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  
  university: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "University",
    default: null
  },
  // List of users who clicked "Claim" (Interested)
  claimedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  // List of actual purchases (The "Saving Money" part)
  redemptions: [
    {
      student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      billAmount: Number,
      savedAmount: Number,
      redeemedAt: { type: Date, default: Date.now },
      promoCode: { type: String }, // Track which promo code was used
      promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode' },
      // ✅ ADD THIS — Shopify / Woo order ID, for idempotency
    externalOrderId: { type: String, default: "" },
    }
  ],
  
  // Track promo codes generated for this offer
  promoCodesGenerated: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PromoCode'
  }]
}, { timestamps: true });

// Indexes
offerSchema.index({ brand: 1, isOnline: 1, isInStore: 1 });
offerSchema.index({ category: 1 });
offerSchema.index({ geo: "2dsphere" }, { sparse: true });
offerSchema.index({ 'claimedBy': 1 });
offerSchema.index({ 'redemptions.student': 1 });
offerSchema.index({ "redemptions.promoCodeId": 1 });
offerSchema.index({ "redemptions.externalOrderId": 1 });

// Any change to an offer (claim, redeem, webhook order, edit) clears the
// cached lists, so Brands / OfferScreen / My Discounts never show old data.
function clearOfferListCaches(doc) {
  try {
    const cache = require("../utils/cache");
    const brandId = doc?.brand?._id || doc?.brand;
    Promise.all([
      cache.del("offers:summary"),
      brandId ? cache.del(`offers:brand:${brandId}`) : null,
      cache.delPrefix("offers:claimed:"),
    ]).catch(() => {});
  } catch (e) {}
}

offerSchema.post("save", clearOfferListCaches);
offerSchema.post("findOneAndUpdate", clearOfferListCaches);
offerSchema.post("findOneAndDelete", clearOfferListCaches);
offerSchema.post("deleteOne", { document: true, query: false }, clearOfferListCaches);

module.exports = mongoose.model("Offer", offerSchema);