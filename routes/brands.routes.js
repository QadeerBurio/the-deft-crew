const express = require("express");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware"); // JWT middleware

const router = express.Router();

// In brands.js route file - update the GET / endpoint
router.get("/", auth, async (req, res) => {
  try {
    // Include more fields and handle the response better
    const brands = await User.find({ role: "brand" })
      .select("name email logo category brandName address isOnline isInStore")  // Added more fields
      .lean()
      .exec();
    
    // If no authentication or guest, still return brands with basic info
    // But make sure all brands have a logo field
    const formattedBrands = brands.map(brand => ({
      _id: brand._id,
      name: brand.brandName || brand.name,
      logo: brand.logo || null,
      category: brand.category || "General",
      email: brand.email,
      isOnline: brand.isOnline || false,
      isInStore: brand.isInStore || false,
      address: brand.address || "",
    }));
    
    res.json(formattedBrands);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get all offers by brand
router.get("/:brandId/offers", auth, async (req, res) => {
  try {
    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name")
      .populate("university", "name");
    res.json(offers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
