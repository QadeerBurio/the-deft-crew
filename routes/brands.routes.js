const express = require("express");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware"); // JWT middleware

const router = express.Router();

// Get all brands
router.get("/", auth, async (req, res) => {
  try {
    const brands = await User.find({ role: "brand" }).select("name email");
    res.json(brands);
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
