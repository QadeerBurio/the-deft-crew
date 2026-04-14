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
      redeemedAt: { type: Date, default: Date.now }
    }
  ]
}, { timestamps: true });

module.exports = mongoose.model("Offer", offerSchema);