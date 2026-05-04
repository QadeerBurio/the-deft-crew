const express = require("express");
const multer = require("multer");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const Notification = require("../models/Notification");
const Slider = require("../models/Slider");
const router = express.Router();
const { storage } = require("../config/cloudinary");
const upload = multer({ storage });

// Add Redis cache if available, fallback to in-memory cache
let cache;
try {
  const Redis = require('ioredis');
  cache = new Redis(process.env.REDIS_URL);
} catch (e) {
  // Simple in-memory cache fallback
  cache = {
    store: new Map(),
    async get(key) { 
      const item = this.store.get(key);
      if (!item) return null;
      if (Date.now() > item.expiry) {
        this.store.delete(key);
        return null;
      }
      return item.data;
    },
    async set(key, data, ttl = 300) {
      this.store.set(key, { data, expiry: Date.now() + ttl * 1000 });
    },
    async del(pattern) {
      for (const key of this.store.keys()) {
        if (key.includes(pattern)) this.store.delete(key);
      }
    }
  };
}

const CACHE_TTL = 120; // 2 minutes

// Helper: Clear brand-related caches
async function clearBrandCaches(brandId) {
  await cache.del(`offers:brand:${brandId}`);
  await cache.del('offers:summary');
}

// CREATE: Create new offer (and delete old ones for that brand)
router.post("/", auth, upload.single("image"), async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select('role');
    
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    // Delete old offers
    await Offer.deleteMany({ brand: req.userId });

    // Create new offer
    const offer = await Offer.create({
      title: req.body.title,
      description: req.body.description,
      discountPercentage: req.body.discountPercentage,
      category: req.body.category,
      redeemInstructions: req.body.redeemInstructions,
      location: req.body.location,
      isOnline: req.body.isOnline === "true",
      isInStore: req.body.isInStore === "true",
      image: req.file?.path || null,
      brand: req.userId,
    });

    // Clear caches
    await clearBrandCaches(req.userId);

    res.json({
      message: "Offer created successfully. Old offers removed.",
      offer,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// UPDATE: Modify existing offer
router.put("/:offerId", auth, upload.single("image"), async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    
    if (!offer) return res.status(404).json({ message: "Offer not found" });
    
    if (offer.brand.toString() !== req.userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Update fields
    Object.assign(offer, {
      title: req.body.title || offer.title,
      description: req.body.description || offer.description,
      discountPercentage: req.body.discountPercentage || offer.discountPercentage,
      location: req.body.location || offer.location,
      redeemInstructions: req.body.redeemInstructions || offer.redeemInstructions,
      isOnline: req.body.isOnline ?? offer.isOnline,
      isInStore: req.body.isInStore ?? offer.isInStore,
      image: req.file ? req.file.path : offer.image,
    });

    await offer.save();
    await clearBrandCaches(req.userId);

    res.json({ message: "Offer updated successfully", offer });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// READ: Get all offers belonging to the logged-in brand
router.get("/my-offers", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select('role');
    
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const offers = await Offer.find({ brand: req.userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    res.json(offers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// CLAIM: Add offer to "My Discounts"
router.post("/claim/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

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
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    await Offer.findByIdAndUpdate(
      req.params.offerId,
      { $pull: { claimedBy: req.userId } },
      { new: true }
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
    
    if (!offerId || !userId || !billAmount) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    offer.redemptions.push({
      student: userId,
      billAmount: Number(billAmount),
      savedAmount: Number(savedAmount),
      redeemedAt: new Date(),
    });

    offer.claimedBy = offer.claimedBy.filter(
      id => id.toString() !== userId.toString()
    );
    
    await offer.save();

    res.json({ message: "Redemption successful! Voucher used.", offer });

    await Notification.create({
      recipient: userId,
      title: "Payment Successful! 🎉",
      description: `Congratulations! You just saved Rs. ${savedAmount} at ${offer.title}.`,
      type: "System",
      icon: "checkmark-circle",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: View specific brand's offers (with caching)
router.get("/brand/:brandId", auth, async (req, res) => {
  try {
    const cacheKey = `offers:brand:${req.params.brandId}`;
    
    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name logo category")
      .lean()
      .exec();

    // Cache the results
    await cache.set(cacheKey, JSON.stringify(offers), CACHE_TTL);

    res.json(offers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// NEW: Offers summary endpoint for fast loading
router.get("/summary", auth, async (req, res) => {
  try {
    const cacheKey = 'offers:summary';
    
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Aggregate offers by brand with minimal data
    const offers = await Offer.aggregate([
      {
        $group: {
          _id: "$brand",
          offers: {
            $push: {
              _id: "$_id",
              title: "$title",
              discountPercentage: "$discountPercentage",
              category: "$category",
              image: "$image",
              isOnline: "$isOnline",
              isInStore: "$isInStore",
              claimedBy: "$claimedBy"
            }
          }
        }
      }
    ]);

    // Transform to brandId -> offers map
    const summaryMap = {};
    offers.forEach(item => {
      summaryMap[item._id] = item.offers;
    });

    await cache.set(cacheKey, JSON.stringify(summaryMap), CACHE_TTL);

    res.json(summaryMap);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: Student's active vouchers
router.get("/claimed", auth, async (req, res) => {
  try {
    const claimedOffers = await Offer.find({ claimedBy: req.userId })
      .populate("brand", "name logo")
      .lean()
      .exec();
    
    res.json(claimedOffers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// STATS: Total student savings (optimized with aggregation)
router.get("/my-total-savings", auth, async (req, res) => {
  try {
    const result = await Offer.aggregate([
      { $unwind: "$redemptions" },
      { $match: { "redemptions.student": req.userId } },
      {
        $group: {
          _id: null,
          totalSaved: { $sum: "$redemptions.savedAmount" },
          redemptionCount: { $sum: 1 }
        }
      }
    ]);

    const stats = result[0] || { totalSaved: 0, redemptionCount: 0 };

    res.json({
      totalSaved: stats.totalSaved,
      redemptionCount: stats.redemptionCount
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// REPORT: Brand's list of students who claimed offers (optimized)
router.get("/claimed-users", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select('role');
    
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const offers = await Offer.find({ brand: req.userId })
      .populate({
        path: "claimedBy",
        select: "name email rollNo university",
        populate: {
          path: "university",
          select: "name",
        },
      })
      .lean()
      .exec();

    const claimedUsers = offers.reduce((acc, offer) => {
      offer.claimedBy.forEach(student => {
        acc.push({
          _id: student._id,
          name: student.name,
          email: student.email,
          rollNo: student.rollNo || "N/A",
          universityName: student.university?.name || "N/A",
          offerId: offer._id.toString(),
          offerTitle: offer.title,
          discountPercentage: offer.discountPercentage,
          claimedAt: offer.createdAt,
        });
      });
      return acc;
    }, []);

    res.json(claimedUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// REPORT: Brand's total savings/sales report (optimized)
router.get("/savings-report", auth, async (req, res) => {
  try {
    const offers = await Offer.find({ brand: req.userId })
      .populate({
        path: "redemptions.student",
        select: "name rollNo university",
        populate: {
          path: "university",
          select: "name",
        },
      })
      .lean()
      .exec();

    const report = offers.reduce((acc, offer) => {
      offer.redemptions.forEach(r => {
        acc.push({
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
      return acc;
    }, []);

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;