const express = require("express");
const router = express.Router();
const User = require("../models/User");
const authMiddleware = require("../middleware/auth.middleware");
const { upload } = require("../config/cloudinary");

// @desc    Submit Manual Payment Request (EasyPaisa/JazzCash)
// @route   POST /api/membership/request-upgrade
// POST /api/membership/request-upgrade
router.post("/request-upgrade", authMiddleware, async (req, res) => {
  try {
    const { address, city, phone, zipCode, paymentMethod, receiptUrl } = req.body;

    if (!receiptUrl) {
      return res.status(400).json({ message: "Receipt URL is required." });
    }

    const user = await User.findById(req.user.id);
    if (user.paymentStatus === "Pending Verification") {
      return res.status(400).json({ message: "You already have a pending request." });
    }

    await User.findByIdAndUpdate(req.user.id, {
      paymentReceipt: receiptUrl, // Saving the Cloudinary URL from frontend
      paymentStatus: "Pending Verification",
      paymentMethod: paymentMethod,
      cardStatus: "Ordered",
      shippingDetails: { address, city, phone, zipCode }
    });

    res.status(200).json({ success: true, message: "Verification request submitted." });
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;