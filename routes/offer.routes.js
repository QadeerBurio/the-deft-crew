const express = require("express");
const multer = require("multer");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const Notification = require("../models/Notification");
const Slider = require("../models/Slider");
const router = express.Router();
const { uploadOffer } = require("../config/cloudinary");

// Add Redis cache if available, fallback to in-memory cache
let cache;
try {
  const Redis = require('ioredis');
  cache = new Redis(process.env.REDIS_URL);
} catch (e) {
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

const CACHE_TTL = 120;

async function clearBrandCaches(brandId) {
  await cache.del(`offers:brand:${brandId}`);
  await cache.del('offers:summary');
}

// CREATE: Create new offer
router.post("/", auth, uploadOffer.single("image"), async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select('role');
    
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    await Offer.deleteMany({ brand: req.userId });

    const offerData = {
      title: req.body.title,
      description: req.body.description,
      discountPercentage: req.body.discountPercentage,
      category: req.body.category,
      redeemInstructions: req.body.redeemInstructions,
      location: req.body.location,
      isOnline: req.body.isOnline === "true",
      isInStore: req.body.isInStore === "true",
      brand: req.userId,
    };

    if (req.file) {
      offerData.image = req.file.path || req.file.secure_url || req.file.filename;
    }

    const offer = await Offer.create(offerData);

    await clearBrandCaches(req.userId);

    res.json({
      message: "Offer created successfully. Old offers removed.",
      offer,
    });
  } catch (err) {
    console.error("❌ Error creating offer:", err);
    res.status(500).json({ message: err.message });
  }
});

// UPDATE: Modify existing offer
router.put("/:offerId", auth, uploadOffer.single("image"), async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    
    if (!offer) return res.status(404).json({ message: "Offer not found" });
    
    if (offer.brand.toString() !== req.userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const updateData = {
      title: req.body.title || offer.title,
      description: req.body.description || offer.description,
      discountPercentage: req.body.discountPercentage || offer.discountPercentage,
      location: req.body.location || offer.location,
      redeemInstructions: req.body.redeemInstructions || offer.redeemInstructions,
      isOnline: req.body.isOnline !== undefined ? req.body.isOnline === "true" : offer.isOnline,
      isInStore: req.body.isInStore !== undefined ? req.body.isInStore === "true" : offer.isInStore,
    };

    if (req.file) {
      updateData.image = req.file.path || req.file.secure_url || req.file.filename;
    }

    Object.assign(offer, updateData);
    await offer.save();
    await clearBrandCaches(req.userId);

    res.json({ message: "Offer updated successfully", offer });
  } catch (err) {
    console.error("❌ Error updating offer:", err);
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

// routes/offer.routes.js - Add this CLAIM endpoint fix

// CLAIM: Add offer to "My Discounts" - FIXED
router.post("/claim/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    // Check if already claimed
    if (offer.claimedBy.includes(req.userId)) {
      return res.status(400).json({ 
        message: "Voucher already in your 'My Discounts'",
        alreadyClaimed: true 
      });
    }

    offer.claimedBy.push(req.userId);
    await offer.save();

    // Clear cache for this user's claimed offers
    await cache.del(`offers:claimed:${req.userId}`);

    res.json({ 
      message: "Discount added to your profile!", 
      offer,
      claimed: true
    });
  } catch (err) {
    console.error("Error claiming offer:", err);
    res.status(500).json({ message: err.message });
  }
});

// GET: Student's active vouchers with redemption info - FIXED
router.get("/claimed", auth, async (req, res) => {
  try {
    const cacheKey = `offers:claimed:${req.userId}`;
    
    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const claimedOffers = await Offer.find({ claimedBy: req.userId })
      .populate("brand", "name logo")
      .lean()
      .exec();
    
    // Add redemption info to each offer
    const offersWithInfo = claimedOffers.map(offer => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayRedemptions = offer.redemptions?.filter(r => {
        const redeemDate = new Date(r.redeemedAt);
        redeemDate.setHours(0, 0, 0, 0);
        return r.student?.toString() === req.userId && redeemDate.getTime() === today.getTime();
      }) || [];
      
      return {
        ...offer,
        redemptionsToday: todayRedemptions.length,
        maxRedemptionsPerDay: 2,
        canRedeem: todayRedemptions.length < 2,
        isClaimed: true // Explicit flag
      };
    });
    
    // Cache for 30 seconds
    await cache.set(cacheKey, JSON.stringify(offersWithInfo), 30);
    
    res.json(offersWithInfo);
  } catch (err) {
    console.error("Error fetching claimed offers:", err);
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

    // Check if user already redeemed this offer today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === userId && redeemDate.getTime() === today.getTime();
    });

    // Max 2 redemptions per day per user
    if (todayRedemptions.length >= 2) {
      return res.status(400).json({ 
        message: "You have already used this discount 2 times today. Please try again tomorrow." 
      });
    }

    offer.redemptions.push({
      student: userId,
      billAmount: Number(billAmount),
      savedAmount: Number(savedAmount),
      redeemedAt: new Date(),
    });

    // Only remove from claimedBy if this is the second redemption
    const totalRedemptions = offer.redemptions.filter(r => r.student.toString() === userId);
    
    // If user has used 2 redemptions, remove from claimedBy
    if (totalRedemptions.length >= 2) {
      offer.claimedBy = offer.claimedBy.filter(
        id => id.toString() !== userId.toString()
      );
    }
    
    await offer.save();

    // Mark scan as processed
    try {
      const pendingScanIndex = pendingScans.findIndex(
        scan => scan.studentId === userId && scan.status === 'pending'
      );
      if (pendingScanIndex !== -1) {
        pendingScans[pendingScanIndex].status = 'processed';
        processedScans.add(userId);
      }
    } catch (err) {
      console.error("Error marking scan as processed:", err);
    }

    res.json({ 
      message: "Redemption successful! Voucher used.", 
      offer,
      redemptionsUsed: totalRedemptions.length,
      redemptionsRemaining: 2 - totalRedemptions.length
    });

    await Notification.create({
      recipient: userId,
      title: "Payment Successful! 🎉",
      description: `Congratulations! You just saved Rs. ${savedAmount} at ${offer.title}. ${totalRedemptions.length >= 2 ? 'You have used both redemptions for today.' : `You have ${2 - totalRedemptions.length} redemption${2 - totalRedemptions.length > 1 ? 's' : ''} remaining for today.`}`,
      type: "System",
      icon: "checkmark-circle",
    });
  } catch (err) {
    console.error("Error in redeem-payment:", err);
    res.status(500).json({ message: err.message });
  }
});

// GET: View specific brand's offers
router.get("/brand/:brandId", auth, async (req, res) => {
  try {
    const cacheKey = `offers:brand:${req.params.brandId}`;
    
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name logo category")
      .lean()
      .exec();

    await cache.set(cacheKey, JSON.stringify(offers || []), CACHE_TTL);

    res.json(offers || []);
  } catch (err) {
    res.json([]);
  }
});

// GET: Offers summary
router.get("/summary", auth, async (req, res) => {
  try {
    const cacheKey = 'offers:summary';
    
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

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

// // GET: Student's active vouchers with redemption info
// router.get("/claimed", auth, async (req, res) => {
//   try {
//     const claimedOffers = await Offer.find({ claimedBy: req.userId })
//       .populate("brand", "name logo")
//       .lean()
//       .exec();
    
//     // Add redemption info to each offer
//     const offersWithInfo = claimedOffers.map(offer => {
//       const today = new Date();
//       today.setHours(0, 0, 0, 0);
      
//       const todayRedemptions = offer.redemptions.filter(r => {
//         const redeemDate = new Date(r.redeemedAt);
//         redeemDate.setHours(0, 0, 0, 0);
//         return r.student.toString() === req.userId && redeemDate.getTime() === today.getTime();
//       });
      
//       return {
//         ...offer,
//         redemptionsToday: todayRedemptions.length,
//         maxRedemptionsPerDay: 2,
//         canRedeem: todayRedemptions.length < 2
//       };
//     });
    
//     res.json(offersWithInfo);
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// });

// STATS: Total student savings
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

// REPORT: Brand's list of students who claimed offers
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
        const studentRedemptions = offer.redemptions.filter(
          r => r.student.toString() === student._id.toString()
        );
        
        acc.push({
          _id: student._id,
          name: student.name || 'Student',
          email: student.email || '',
          rollNo: student.rollNo || "N/A",
          universityName: student.university?.name || "N/A",
          offerId: offer._id.toString(),
          offerTitle: offer.title || 'Offer',
          discountPercentage: offer.discountPercentage || 0,
          claimedAt: offer.createdAt,
          redemptionsCount: studentRedemptions.length,
          totalSaved: studentRedemptions.reduce((sum, r) => sum + r.savedAmount, 0)
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

// REPORT: Brand's total savings/sales report
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
          brand: offer.title || 'Brand',
          bill: r.billAmount || 0,
          saved: r.savedAmount || 0,
          paid: (r.billAmount || 0) - (r.savedAmount || 0),
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

// GET: Fetch offer image
router.get("/:offerId/image", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId)
      .select('image title brand')
      .lean()
      .exec();

    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }
    
    res.json({
      offerId: offer._id,
      title: offer.title,
      image: offer.image,
      brand: offer.brand
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: Fetch offer images with filters - FIXED VERSION
// GET: Fetch offer images with filters - SHOW ONLY APPROVED BRANDS' OFFERS
router.get("/images/all", auth, async (req, res) => {
  try {
    const { brandId, category, limit = 100 } = req.query;
    
    // Build filter - only get offers with images
    const filter = { 
      image: { $ne: null, $ne: '' }
    };
    
    if (brandId) filter.brand = brandId;
    if (category) filter.category = category;

    const cacheKey = `offers:images:approved:${JSON.stringify(filter)}`;
    
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Get all offers with images
    const offers = await Offer.find(filter)
      .select('_id title image brand discountPercentage category isOnline isInStore')
      .populate({
        path: 'brand',
        select: 'name logo brandApprovalStatus role',
        match: { 
          role: 'brand',
          brandApprovalStatus: 'approved' // ONLY approved brands
        }
      })
      .lean()
      .exec();

    // Filter out offers where brand doesn't exist or is not approved
    const validOffers = offers.filter(offer => {
      // Check if brand exists and has an _id
      if (!offer.brand || !offer.brand._id) {
        console.log(`Offer ${offer._id} filtered: No brand found`);
        return false;
      }
      
      // Check if brand is approved
      if (offer.brand.brandApprovalStatus !== 'approved') {
        console.log(`Offer ${offer._id} filtered: Brand ${offer.brand.name} status: ${offer.brand.brandApprovalStatus}`);
        return false;
      }
      
      // Check if image exists and is valid
      if (!offer.image || offer.image === null || offer.image === '') {
        console.log(`Offer ${offer._id} filtered: No image`);
        return false;
      }
      
      // Check if image is not a placeholder
      if (offer.image.includes('via.placeholder.com') || 
          offer.image.includes('placeholder')) {
        console.log(`Offer ${offer._id} filtered: Placeholder image`);
        return false;
      }
      
      return true;
    });

    console.log(`Total offers found: ${offers.length}`);
    console.log(`Valid offers from approved brands: ${validOffers.length}`);

    const response = {
      count: validOffers.length,
      totalOffers: offers.length,
      approvedBrandOffers: validOffers.length,
      offers: validOffers.map(offer => ({
        offerId: offer._id,
        title: offer.title || 'Offer',
        image: offer.image,
        brand: {
          id: offer.brand._id,
          name: offer.brand.name || 'Brand',
          logo: offer.brand.logo || null,
          approved: offer.brand.brandApprovalStatus === 'approved'
        },
        discountPercentage: offer.discountPercentage || 0,
        category: offer.category || 'General',
        isOnline: offer.isOnline || false,
        isInStore: offer.isInStore || false
      }))
    };

    await cache.set(cacheKey, JSON.stringify(response), 300);

    res.json(response);
  } catch (err) {
    console.error('Error fetching offer images:', err);
    res.status(500).json({ 
      message: err.message,
      offers: [],
      count: 0,
      totalOffers: 0,
      approvedBrandOffers: 0
    });
  }
});


// ============= QR SCAN ROUTES =============

// Track pending student scans
const pendingScans = [];
const processedScans = new Set();

// POST - Student scans QR and sends data
router.post("/scan-verify", auth, async (req, res) => {
  try {
    const { studentId, name, rollNo, university, email, offerId, offerTitle, discountPercentage, brandId, brandName } = req.body;
    
    if (!studentId || !name || !offerId) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required student information" 
      });
    }
    
    // Check if student has already used 2 redemptions today
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ 
        success: false, 
        message: "Offer not found" 
      });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === studentId && redeemDate.getTime() === today.getTime();
    });
    
    if (todayRedemptions.length >= 2) {
      return res.status(400).json({ 
        success: false, 
        message: "You have already used this discount 2 times today. Please try again tomorrow.",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2
      });
    }
    
    // Check for existing pending scan
    const existingScan = pendingScans.find(
      scan => scan.studentId === studentId.toString() && 
              scan.brandId === (brandId ? brandId.toString() : '') && 
              scan.status === 'pending'
    );
    
    if (existingScan) {
      return res.json({ 
        success: true, 
        message: 'Student already scanned',
        scanId: pendingScans.indexOf(existingScan),
        student: existingScan,
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2
      });
    }
    
    let universityName = '';
    if (typeof university === 'string') {
      universityName = university;
    } else if (university && typeof university === 'object') {
      universityName = university.name || university._id || 'University';
    } else {
      universityName = 'University';
    }
    
    pendingScans.push({
      studentId: studentId.toString(),
      name: name || 'Student',
      rollNo: rollNo || 'N/A',
      university: universityName,
      universityName: universityName,
      email: email || '',
      offerId: offerId.toString(),
      offerTitle: offerTitle || 'Offer',
      discountPercentage: discountPercentage || 0,
      brandId: brandId ? brandId.toString() : '',
      brandName: brandName || 'Brand',
      scannedAt: new Date().toISOString(),
      status: 'pending',
      redemptionsUsed: todayRedemptions.length,
      maxRedemptions: 2
    });
    
    while (pendingScans.length > 50) {
      pendingScans.shift();
    }
    
    res.json({ 
      success: true, 
      message: 'Student data received successfully',
      scanId: pendingScans.length - 1,
      student: pendingScans[pendingScans.length - 1],
      redemptionsUsed: todayRedemptions.length,
      maxRedemptions: 2
    });
  } catch (err) {
    console.error("Error in scan-verify:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET - Brand checks for pending student scans
router.get("/pending-scans", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select('role');
    
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }
    
    const brandScans = pendingScans.filter(
      scan => scan.brandId === req.userId && scan.status === 'pending'
    );
    
    const formattedScans = brandScans.map(scan => ({
      studentId: scan.studentId,
      name: scan.name,
      rollNo: scan.rollNo,
      university: scan.university,
      universityName: scan.universityName || scan.university || 'University',
      email: scan.email,
      offerId: scan.offerId,
      offerTitle: scan.offerTitle,
      discountPercentage: scan.discountPercentage,
      scannedAt: scan.scannedAt,
      status: scan.status,
      redemptionsUsed: scan.redemptionsUsed || 0,
      maxRedemptions: scan.maxRedemptions || 2
    }));
    
    res.json(formattedScans);
  } catch (err) {
    console.error("Error fetching pending scans:", err);
    res.status(500).json({ message: err.message });
  }
});

// POST - Mark scan as processed
router.post("/scan-processed", auth, async (req, res) => {
  try {
    const { studentId } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: "Student ID required" });
    }
    
    let found = false;
    for (let i = 0; i < pendingScans.length; i++) {
      if (pendingScans[i].studentId === studentId && pendingScans[i].status === 'pending') {
        pendingScans[i].status = 'processed';
        processedScans.add(studentId);
        found = true;
      }
    }
    
    if (found) {
      res.json({ success: true, message: "Scan marked as processed" });
    } else {
      res.status(404).json({ success: false, message: "Scan not found" });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Check if student can scan
router.get("/can-scan/:offerId", auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const userId = req.userId;
    
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ 
        canScan: false, 
        message: "Offer not found" 
      });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === userId && redeemDate.getTime() === today.getTime();
    });
    
    const canScan = todayRedemptions.length < 2;
    
    res.json({
      canScan,
      redemptionsUsed: todayRedemptions.length,
      maxRedemptions: 2,
      remainingRedemptions: 2 - todayRedemptions.length,
      message: canScan ? "You can scan and redeem" : "You have already used this discount 2 times today"
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Get a specific student by ID
router.get("/student/:studentId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.studentId)
      .select('name email rollNo university')
      .populate('university', 'name')
      .lean();
    
    if (!user) {
      return res.status(404).json({ message: "Student not found" });
    }
    
    const universityName = user.university?.name || 'N/A';
    
    res.json({
      _id: user._id,
      name: user.name || 'Student',
      email: user.email || '',
      rollNo: user.rollNo || 'N/A',
      universityName: universityName
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/brandss", async (req, res) => {
  try {
    const brands = await User.find({ role: "brand" })
      .select("name logo category description location")
      .lean()
      .exec();

    // Get offers for each brand
    const brandsWithOffers = await Promise.all(
      brands.map(async (brand) => {
        const offers = await Offer.find({ brand: brand._id })
          .select("title description discountPercentage category image isOnline isInStore location createdAt")
          .lean()
          .exec();
        
        return {
          ...brand,
          offersCount: offers.length,
          offers: offers
        };
      })
    );

    res.json({
      success: true,
      count: brandsWithOffers.length,
      brands: brandsWithOffers
    });
  } catch (err) {
    console.error("Error fetching brands:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});




// routes/offer.routes.js - Add these new routes to existing file

// ==================== GENERATE PROMO CODE FROM OFFER ====================
// POST /api/offers/generate-promo/:offerId
// This is a convenience route that calls the promo code generation
router.post("/generate-promo/:offerId", auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const studentId = req.userId;
    
    // Forward to promo code generation
    const promoCodeGen = require('./promoCode.routes');
    
    // Find offer first
    const offer = await Offer.findById(offerId)
      .populate('brand', 'name')
      .lean();
    
    if (!offer) {
      return res.status(404).json({ 
        success: false, 
        message: "Offer not found" 
      });
    }
    
    // Check if student has claimed this offer
    if (!offer.claimedBy.includes(studentId)) {
      return res.status(403).json({ 
        success: false, 
        message: "You must claim this offer first" 
      });
    }
    
    // Check if offer is online
    if (!offer.isOnline) {
      return res.status(400).json({ 
        success: false, 
        message: "This offer is not available online" 
      });
    }
    
    // Check if student already has an active promo code
    const PromoCode = require("../models/PromoCode");
    const existingActive = await PromoCode.findOne({
      offer: offerId,
      student: studentId,
      status: 'active'
    });
    
    if (existingActive) {
      return res.status(400).json({
        success: false,
        message: "You already have an active promo code for this offer",
        promoCode: existingActive.code
      });
    }
    
    // Check daily limit
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === studentId && redeemDate.getTime() === today.getTime();
    });
    
    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        success: false,
        message: "You have already used this discount 2 times today",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2
      });
    }
    
    // Generate promo code
    const brandPrefix = offer.brand?.name?.substring(0, 3).toUpperCase() || 'TDC';
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const promoCode = `${brandPrefix}${random}`;
    
    // Create promo code
    const newPromoCode = await PromoCode.create({
      code: promoCode,
      offer: offerId,
      student: studentId,
      brand: offer.brand._id,
      discountPercentage: offer.discountPercentage,
      offerTitle: offer.title,
      brandName: offer.brand?.name || 'Brand',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      maxUses: 1
    });
    
    // Add to offer's promo codes
    await Offer.findByIdAndUpdate(offerId, {
      $push: { promoCodesGenerated: newPromoCode._id }
    });
    
    // Create notification
    await Notification.create({
      recipient: studentId,
      title: "🎉 Promo Code Generated!",
      description: `Your promo code ${promoCode} for ${offer.title} is ready. Use it at checkout to get ${offer.discountPercentage}% OFF!`,
      type: "System",
      icon: "ticket-outline"
    });
    
    res.json({
      success: true,
      message: "Promo code generated successfully",
      promoCode: {
        code: newPromoCode.code,
        offerTitle: newPromoCode.offerTitle,
        brandName: newPromoCode.brandName,
        discountPercentage: newPromoCode.discountPercentage,
        expiresAt: newPromoCode.expiresAt,
        qrData: newPromoCode.qrData
      }
    });
    
  } catch (err) {
    console.error("Error generating promo from offer:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// ==================== GET OFFER WITH PROMO CODE INFO ====================
// GET /api/offers/:offerId/promo-info
router.get("/:offerId/promo-info", auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const userId = req.userId;
    
    const PromoCode = require("../models/PromoCode");
    
    const offer = await Offer.findById(offerId)
      .populate('brand', 'name logo')
      .lean();
    
    if (!offer) {
      return res.status(404).json({ 
        success: false, 
        message: "Offer not found" 
      });
    }
    
    // Check if user has claimed this offer
    const hasClaimed = offer.claimedBy.includes(userId);
    
    // Check if user has an active promo code
    const activePromo = await PromoCode.findOne({
      offer: offerId,
      student: userId,
      status: 'active'
    }).lean();
    
    // Get today's redemptions for this user
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === userId && redeemDate.getTime() === today.getTime();
    });
    
    // Get total redemptions for this user
    const totalRedemptions = offer.redemptions.filter(r => 
      r.student.toString() === userId
    );
    
    res.json({
      success: true,
      offer: {
        id: offer._id,
        title: offer.title,
        discountPercentage: offer.discountPercentage,
        isOnline: offer.isOnline,
        isInStore: offer.isInStore
      },
      userStatus: {
        hasClaimed,
        hasActivePromo: !!activePromo,
        activePromo: activePromo ? {
          code: activePromo.code,
          expiresAt: activePromo.expiresAt,
          qrData: activePromo.qrData
        } : null,
        redemptionsToday: todayRedemptions.length,
        maxRedemptionsPerDay: 2,
        totalRedemptions: totalRedemptions.length,
        maxTotalRedemptions: 2,
        canGeneratePromo: hasClaimed && 
                          offer.isOnline && 
                          !activePromo && 
                          todayRedemptions.length < 2 &&
                          totalRedemptions.length < 2
      }
    });
    
  } catch (err) {
    console.error("Error getting promo info:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});
module.exports = router;