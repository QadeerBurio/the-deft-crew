const express = require("express");
const multer = require("multer");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const Notification = require("../models/Notification");
const Slider = require("../models/Slider")
const router = express.Router();
const { storage } = require("../config/cloudinary"); 
const upload = multer({ storage });

// MULTER SETUP: For handling image uploads
// const storage = multer.diskStorage({
//   destination: "uploads/offers",

//   filename: (req, file, cb) => {
//     cb(null, Date.now() + "-" + file.originalname);
//   },
// });

// const upload = multer({ storage });

// 1-Brand Management Routes

// CREATE: Create new offer (and delete old ones for that brand)
router.post("/", auth, upload.single("image"), async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user || user.role !== "brand") {
      return res.status(403).json({
        message: "Only brands allowed",
      });
    }

    // delete old offers
    await Offer.deleteMany({
      brand: user._id,
    });

    // create new offer
    const offer = await Offer.create({
      title: req.body.title,

      description: req.body.description,

      discountPercentage: req.body.discountPercentage,
      category: req.body.category, // <--- New Field
      redeemInstructions: req.body.redeemInstructions,

      location: req.body.location,

      isOnline: req.body.isOnline === "true",

      isInStore: req.body.isInStore === "true",

      image: req.file?.path || null, //

      brand: user._id,
    });

    res.json({
      message: "Offer created successfully. Old offers removed.",
      offer,
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
});

// UPDATE: Modify existing offer
router.put("/:offerId", auth, upload.single("image"), async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);

    if (!offer) return res.status(404).json({ message: "Offer not found" });

    // check ownership
    if (offer.brand.toString() !== req.userId)
      return res.status(403).json({ message: "Unauthorized" });

    // update fields
    offer.title = req.body.title || offer.title;
    offer.description = req.body.description || offer.description;
    offer.discountPercentage =
      req.body.discountPercentage || offer.discountPercentage;
    offer.location = req.body.location || offer.location;
    offer.redeemInstructions =
      req.body.redeemInstructions || offer.redeemInstructions;
    offer.isOnline = req.body.isOnline ?? offer.isOnline;
    offer.isInStore = req.body.isInStore ?? offer.isInStore;

    if (req.file) {
       offer.image = req.file.path;
    }

    await offer.save();

    res.json({
      message: "Offer updated successfully",
      offer,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// READ: Get all offers belonging to the logged-in brand
router.get("/my-offers", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const offers = await Offer.find({ brand: req.userId }).sort({
      createdAt: -1,
    });

    res.json(offers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 2-Student Interaction Routes

// CLAIM: Add offer to "My Discounts"
router.post("/claim/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    // Check if user already has an active claim
    if (offer.claimedBy.includes(req.userId)) {
      return res.status(400).json({ message: "Voucher already in your 'My Discounts'" });
    }

    offer.claimedBy.push(req.userId);
    await offer.save();

    res.json({ message: "Discount added to your profile!", offer });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// UNCLAIM: Remove offer from "My Discounts"
router.post("/unclaim/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);

    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    // Use $pull to remove the userId from the claimedBy array
    await Offer.findByIdAndUpdate(
      req.params.offerId,
      { $pull: { claimedBy: req.userId } },
      { new: true },
    );

    res.json({ message: "Offer unclaimed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// REDEEM: Finalize payment and remove from active claims
router.post("/redeem-payment", auth, async (req, res) => {
  try {
    const { offerId, userId, billAmount, savedAmount } = req.body;

    if (!offerId || !userId || !billAmount)
      return res.status(400).json({ message: "Missing required fields" });

    const offer = await Offer.findById(offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    // 1. Add to Redemptions
    offer.redemptions.push({
      student: userId,
      billAmount: Number(billAmount),
      savedAmount: Number(savedAmount),
      redeemedAt: new Date(),
    });

    // 2. IMPORTANT: Remove student from claimedBy so the voucher "disappears" 
    // from their active "My Discounts" list
    offer.claimedBy = offer.claimedBy.filter(id => id.toString() !== userId.toString());

    await offer.save();

    res.json({
      message: "Redemption successful! Voucher used.",
      offer,
    });
    await Notification.create({
  recipient: userId, // Private to the student
  title: "Payment Successful! 🎉",
  description: `Congratulations! You just saved Rs. ${savedAmount} at ${offer.title}.`,
  type: "System",
  icon: "checkmark-circle",
});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// 3-Discovery & Reporting Routes

// GET: View specific brand's offers
router.get("/brand/:brandId", auth, async (req, res) => {
  const offers = await Offer.find({
    brand: req.params.brandId,
  }).populate("brand");

  res.json(offers);
});

// GET: Student's active (claimed but not redeemed) vouchers
router.get("/claimed", auth, async (req, res) => {
  try {
    // This will only return offers where the user is in the claimedBy array
    // (i.e., they haven't redeemed it yet)
    const claimedOffers = await Offer.find({ claimedBy: req.userId }).populate("brand");
    res.json(claimedOffers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// STATS: Total student savings
router.get("/my-total-savings", auth, async (req, res) => {
  try {
    const offers = await Offer.find({ "redemptions.student": req.userId });
    
    let totalSaved = 0;
    let redemptionCount = 0;

    offers.forEach(offer => {
      offer.redemptions.forEach(r => {
        if (r.student && r.student.toString() === req.userId.toString()) {
          totalSaved += r.savedAmount;
          redemptionCount += 1;
        }
      });
    });

    res.json({ 
      totalSaved, 
      redemptionCount // You can use this for the "Redemptions" stat in ProfileScreen
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// REPORT: Brand's list of students who claimed offers
router.get("/claimed-users", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const offers = await Offer.find({ brand: req.userId }).populate({
      path: "claimedBy",
      select: "name email rollNo university",
      populate: {
        path: "university",
        select: "name",
      },
    });

    const claimedUsers = [];

    offers.forEach((offer) => {
      offer.claimedBy.forEach((student) => {
        claimedUsers.push({
          _id: student._id,
          name: student.name,
          email: student.email,
          rollNo: student.rollNo || "N/A",
          universityName: student.university?.name || "N/A",

          // ✅ VERY IMPORTANT
          offerId: offer._id.toString(),

          offerTitle: offer.title,
          discountPercentage: offer.discountPercentage,
          claimedAt: offer.createdAt,
        });
      });
    });

    res.json(claimedUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// REPORT: Brand's total savings/sales report
router.get("/savings-report", auth, async (req, res) => {
  try {
    const offers = await Offer.find({ brand: req.userId }).populate({
      path: "redemptions.student",
      populate: {
        path: "university",
        select: "name",
      },
    });

    let report = [];

    offers.forEach((offer) => {
      offer.redemptions.forEach((r) => {
        report.push({
          name: r.student?.name || "N/A",

          rollNo: r.student?.rollNo || "N/A",

          university: r.student?.university?.name || "N/A",

          brand: offer.title,

          bill: r.billAmount,

          saved: r.savedAmount,

          paid: r.billAmount - r.savedAmount,

          date: r.redeemedAt,
        });
      });
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
});






module.exports = router;
