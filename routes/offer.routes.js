const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const Notification = require("../models/Notification");
const Slider = require("../models/Slider");
const router = express.Router();
const { uploadOffer } = require("../config/cloudinary");

// Shared cache (same instance as promoCode.routes.js, so clears reach both)
const cache = require("../utils/cache");
const { clearOfferCaches } = require("../utils/cache");
const { getBrandCitiesMap } = require("../utils/brandCities");
const { geocodeInBackground } = require("../services/geo/geocoder");

// Offers/claims change all the time, never let a phone or proxy cache them
router.use((req, res, next) => {
  if (req.method === "GET") res.set("Cache-Control", "no-store");
  next();
});

// ?fresh=1 skips the server cache (pull-to-refresh)
const wantsFresh = (req) => req.query.fresh === "1" || req.query.fresh === "true";

const CACHE_TTL = 120;

// ============================================================
// ✅ PENDING SCANS — declared at TOP so every route can access them
// ============================================================
const pendingScans = [];
const processedScans = new Set();

async function clearBrandCaches(brandId, userId) {
  await clearOfferCaches({ brandId: brandId?.toString(), userId: userId?.toString() });
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
// ✅ Broadcast new offer to students (fire-and-forget)
setImmediate(async () => {
  try {
    const pushGateway = require('../services/engagement/pushGateway');
    const result = await pushGateway.broadcastNewOffer(offer);
    console.log('[offer] broadcast:', result);
  } catch (e) {
    console.error('[offer] broadcast failed:', e.message);
  }
});
    res.json({
      message: "Offer created successfully. Old offers removed.",
      offer,
    });

    // "near me": map point for the offer address, after the response (never blocks the save)
    if (offer.isInStore && offer.location) {
      // the brand's city is added to the address and checked against the match
      geocodeInBackground(Offer, offer._id, [offer.location], { brandId: offer.brand });
    }
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

    const locationBefore = offer.location || "";
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

    // "near me": re-geocode only when the address changed (after the response)
    if ((offer.location || "") !== locationBefore) {
      geocodeInBackground(Offer, offer._id, offer.isInStore ? [offer.location] : [], { brandId: offer.brand, clearOnFail: true });
    }
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

    // Clear this student's claimed list AND the brand/summary lists (claimedBy changed)
    await clearBrandCaches(offer.brand, req.userId);

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
    
    // Try cache first (skipped on ?fresh=1)
    if (!wantsFresh(req)) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    }

    const claimedOffers = await Offer.find({ claimedBy: req.userId })
      .populate("brand", "name brandName logo websiteUrl city address isOnline isInStore")
      .lean()
      .exec();

    // Cities per brand (brand city + branch cities) for the city filter in the app
    const brandDocs = claimedOffers.map((o) => o.brand).filter((b) => b && b._id);
    const citiesMap = await getBrandCitiesMap(brandDocs);
    
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
        brandCities: offer.brand?._id
          ? citiesMap.get(offer.brand._id.toString()) || ["Karachi"]
          : ["Karachi"],
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
// routes/offers.js - UNCLAIM with fixed Mongoose option
router.post("/unclaim/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offer not found" });

    // ✅ FIXED: Use returnDocument: 'after' instead of new: true
    await Offer.findByIdAndUpdate(
      req.params.offerId,
      { $pull: { claimedBy: req.userId } },
      { returnDocument: 'after' } // ✅ Fixed deprecation
    );

    // Clear this student's claimed list AND the brand/summary lists
    await clearBrandCaches(offer.brand, req.userId);

    res.json({ message: "Offer unclaimed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// REDEEM: Finalize payment and remove from active claims
router.post('/redeem-payment', auth, async (req, res) => {
  try {
    // B7: only brand / employee / admin can call this
    const requester = await User.findById(req.userId).select('role').lean();
    if (!requester || !['brand', 'employee', 'admin'].includes(requester.role)) {
      return res.status(403).json({ message: 'Only the scanner side can redeem' });
    }

    const { offerId, userId, billAmount } = req.body;
    if (!offerId || !userId || !billAmount) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) return res.status(404).json({ message: 'Offer not found' });

    // Server computes the saved amount (B7)
    const discount = Number(offer.discountPercentage) || 0;
    const bill = Number(billAmount);
    const computedSaved = Math.round((bill * discount) / 100);

    // Daily cap (Karachi day)
    const { dayKey } = require('../utils/karachiTime');
    const today = dayKey();

    const todayRedemptions = offer.redemptions.filter((r) => {
      const k = dayKey(new Date(r.redeemedAt));
      return r.student.toString() === userId && k === today;
    });

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        message: 'You have already used this discount 2 times today. Please try again tomorrow.',
      });
    }

    offer.redemptions.push({
      student: userId,
      billAmount: bill,
      savedAmount: computedSaved,
      redeemedAt: new Date(),
    });

    const totalRedemptions = offer.redemptions.filter(
      (r) => r.student.toString() === userId
    );
    if (totalRedemptions.length >= 2) {
      offer.claimedBy = offer.claimedBy.filter(
        (id) => id.toString() !== userId.toString()
      );
    }
    await offer.save();

    // Redemption changes claimedBy + redemptions → clear every list that shows them
    await clearBrandCaches(offer.brand, userId);

    // Mark pending scan as processed
    try {
      const idx = pendingScans.findIndex(
        (scan) => scan.studentId === userId && scan.status === 'pending'
      );
      if (idx !== -1) {
        pendingScans[idx].status = 'processed';
        processedScans.add(userId);
      }
    } catch (err) {
      console.error('Error marking scan as processed:', err);
    }

    // 🎯 Engagement hook — fires ONCE per (student, offer) using a stable dedupe key
    try {
      const { track } = require('../services/engagement');
      await track(userId.toString(), 'deal_redeemed', {
        meta: { offerId: offer._id.toString(), savedAmount: computedSaved },
        dedupeKey: `deal:${userId}:${offer._id}`,
      });
    } catch (e) {
      console.error('[engagement] deal_redeemed hook failed:', e.message);
    }

    // Notification (copy follows brand rules — lowercase, full stop, no emoji)
    await Notification.create({
      recipient: userId,
      title: 'payment successful.',
      description: `you saved rs ${computedSaved} at ${offer.title}.`,
      type: 'System',
      icon: 'checkmark-circle',
    }).catch(() => {});

    return res.json({
      message: 'Redemption successful! Voucher used.',
      offer,
      redemptionsUsed: totalRedemptions.length,
      redemptionsRemaining: 2 - totalRedemptions.length,
      savedAmount: computedSaved,
    });
  } catch (err) {
    console.error('Error in redeem-payment:', err);
    return res.status(500).json({ message: err.message });
  }
});

// GET: View specific brand's offers
router.get("/brand/:brandId", auth, async (req, res) => {
  try {
    const cacheKey = `offers:brand:${req.params.brandId}`;
    
    if (!wantsFresh(req)) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    }

    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name logo category websiteUrl")
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
    
    if (!wantsFresh(req)) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
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

// STATS: Total student savings
router.get("/my-total-savings", auth, async (req, res) => {
  try {
    // Aggregations don't cast: req.userId is a string, redemptions.student an ObjectId.
    // Not a valid id (e.g. a guest token) → nothing to count.
    if (!mongoose.Types.ObjectId.isValid(req.userId)) {
      return res.json({ totalSaved: 0, redemptionCount: 0 });
    }
    const uid = new mongoose.Types.ObjectId(req.userId);

    const result = await Offer.aggregate([
      { $unwind: "$redemptions" },
      { $match: { "redemptions.student": uid } },
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

// REPORT: Brand's total savings/sales report - ENHANCED to include promo codes
router.get("/savings-report", auth, async (req, res) => {
  try {
    const PromoCode = require("../models/PromoCode");

    // 1. Get QR / in-store redemptions from offers
    const offers = await Offer.find({ brand: req.userId })
      .populate({
        path: "redemptions.student",
        select: "name rollNo university email",
        populate: {
          path: "university",
          select: "name",
        },
      })
      .lean()
      .exec();

    const qrRedemptions = offers.reduce((acc, offer) => {
      offer.redemptions.forEach(r => {
        acc.push({
          name: r.student?.name || "N/A",
          rollNo: r.student?.rollNo || "N/A",
          email: r.student?.email || "",
          university: r.student?.university?.name || "N/A",
          brand: offer.title || 'Brand',
          bill: r.billAmount || 0,
          saved: r.savedAmount || 0,
          paid: (r.billAmount || 0) - (r.savedAmount || 0),
          date: r.redeemedAt,
          redemptionType: "qr",
          platform: "in-store",
          promoCode: r.promoCode || null,
          offerId: offer._id,
          offerImage: offer.image,
          discountPercentage: offer.discountPercentage
        });
      });
      return acc;
    }, []);

    // 2. Get promo code redemptions (online - Shopify/WooCommerce)
    const usedPromoCodes = await PromoCode.find({
      brand: req.userId,
      status: 'used'
    })
      .populate({
        path: 'student',
        select: 'name rollNo university email',
        populate: {
          path: 'university',
          select: 'name'
        }
      })
      .populate('offer', 'title image discountPercentage')
      .lean();

    // Get the brand to determine platform
    const brandUser = await User.findById(req.userId).lean();
    const brandPlatform = brandUser?.platform || 'woocommerce';

    const promoRedemptions = usedPromoCodes.map(pc => {
      const bill = pc.externalAmount || 0;
      const saved = Math.round((bill * (pc.discountPercentage || 0)) / 100);
      const paid = bill - saved;

      return {
        name: pc.student?.name || "N/A",
        rollNo: pc.student?.rollNo || "N/A",
        email: pc.student?.email || "",
        university: pc.student?.university?.name || "N/A",
        brand: pc.offerTitle || pc.offer?.title || 'Brand',
        bill: bill,
        saved: saved,
        paid: paid,
        date: pc.usedAt || pc.updatedAt,
        redemptionType: "promo",
        platform: brandPlatform,
        promoCode: pc.code,
        offerId: pc.offer?._id,
        offerImage: pc.offer?.image,
        discountPercentage: pc.discountPercentage,
        externalOrderId: pc.externalOrderId || null
      };
    });

    // 3. Merge and sort by date (newest first)
    const combined = [...qrRedemptions, ...promoRedemptions].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    // 4. Remove duplicates
    const seen = new Set();
    const deduped = combined.filter(item => {
      const key = `${item.name}-${item.date}-${item.saved}-${item.promoCode || 'qr'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(deduped);
  } catch (err) {
    console.error("Error in savings-report:", err);
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

// GET: Fetch offer images with filters - SHOW ONLY APPROVED BRANDS' OFFERS
router.get("/images/all", auth, async (req, res) => {
  try {
    const { brandId, category, limit = 100 } = req.query;
    
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

    const offers = await Offer.find(filter)
      .select('_id title image brand discountPercentage category isOnline isInStore')
      .populate({
        path: 'brand',
        select: 'name logo brandApprovalStatus role',
        match: { 
          role: 'brand',
          brandApprovalStatus: 'approved'
        }
      })
      .lean()
      .exec();

    const validOffers = offers.filter(offer => {
      if (!offer.brand || !offer.brand._id) return false;
      if (offer.brand.brandApprovalStatus !== 'approved') return false;
      if (!offer.image || offer.image === null || offer.image === '') return false;
      if (offer.image.includes('via.placeholder.com') || 
          offer.image.includes('placeholder')) return false;
      return true;
    });

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
    
    // 🚫 No engagement hook here — /redeem-payment is the only place that awards points
    
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


// ==================== GENERATE PROMO CODE FROM OFFER ====================
router.post("/generate-promo/:offerId", auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const studentId = req.userId;
    
    const offer = await Offer.findById(offerId)
      .populate('brand', 'name')
      .lean();
    
    if (!offer) {
      return res.status(404).json({ 
        success: false, 
        message: "Offer not found" 
      });
    }
    
    if (!offer.claimedBy.includes(studentId)) {
      return res.status(403).json({ 
        success: false, 
        message: "You must claim this offer first" 
      });
    }
    
    if (!offer.isOnline) {
      return res.status(400).json({ 
        success: false, 
        message: "This offer is not available online" 
      });
    }
    
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
    
    const brandPrefix = offer.brand?.name?.substring(0, 3).toUpperCase() || 'TDC';
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const promoCode = `${brandPrefix}${random}`;
    
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
    
    await Offer.findByIdAndUpdate(offerId, {
      $push: { promoCodesGenerated: newPromoCode._id }
    });
    
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
    
    const hasClaimed = offer.claimedBy.includes(userId);
    
    const activePromo = await PromoCode.findOne({
      offer: offerId,
      student: userId,
      status: 'active'
    }).lean();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === userId && redeemDate.getTime() === today.getTime();
    });
    
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

// GET: Full redemption list for a specific brand (admin view)
router.get("/brand/:brandId/redemptions", auth, async (req, res) => {
  try {
    const PromoCode = require("../models/PromoCode");
    const { brandId } = req.params;

    const requester = await User.findById(req.userId).lean().select('role');
    if (!requester) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    if (requester.role !== 'admin' && requester.role !== 'brand') {
      return res.status(403).json({ message: "Only admins or the brand can view this" });
    }
    if (requester.role === 'brand' && req.userId !== brandId) {
      return res.status(403).json({ message: "You can only view your own redemptions" });
    }

    const offers = await Offer.find({ brand: brandId })
      .populate({
        path: "redemptions.student",
        select: "name rollNo university email phone",
        populate: { path: "university", select: "name" }
      })
      .lean();

    const qrRedemptions = offers.reduce((acc, offer) => {
      (offer.redemptions || []).forEach(r => {
        acc.push({
          studentName: r.student?.name || "N/A",
          rollNo: r.student?.rollNo || "N/A",
          email: r.student?.email || "",
          phone: r.student?.phone || "",
          university: r.student?.university?.name || "N/A",
          offerTitle: offer.title || "Offer",
          offerImage: offer.image,
          discountPercentage: offer.discountPercentage || 0,
          bill: r.billAmount || 0,
          saved: r.savedAmount || 0,
          paid: (r.billAmount || 0) - (r.savedAmount || 0),
          date: r.redeemedAt,
          redemptionType: "qr",
          platform: "in-store",
          promoCode: r.promoCode || null,
          studentId: r.student?._id
        });
      });
      return acc;
    }, []);

    const usedPromoCodes = await PromoCode.find({
      brand: brandId,
      status: 'used'
    })
      .populate({
        path: 'student',
        select: 'name rollNo university email phone',
        populate: { path: 'university', select: 'name' }
      })
      .populate('offer', 'title image discountPercentage')
      .lean();

    const brandUser = await User.findById(brandId).lean();
    const brandPlatform = brandUser?.platform || 'woocommerce';

    const promoRedemptions = usedPromoCodes.map(pc => {
      const bill = pc.externalAmount || 0;
      const saved = Math.round((bill * (pc.discountPercentage || 0)) / 100);

      return {
        studentName: pc.student?.name || "N/A",
        rollNo: pc.student?.rollNo || "N/A",
        email: pc.student?.email || "",
        phone: pc.student?.phone || "",
        university: pc.student?.university?.name || "N/A",
        offerTitle: pc.offerTitle || pc.offer?.title || "Offer",
        offerImage: pc.offer?.image,
        discountPercentage: pc.discountPercentage || 0,
        bill: bill,
        saved: saved,
        paid: bill - saved,
        date: pc.usedAt || pc.updatedAt,
        redemptionType: "promo",
        platform: brandPlatform,
        promoCode: pc.code,
        studentId: pc.student?._id,
        externalOrderId: pc.externalOrderId || null
      };
    });

    const combined = [...qrRedemptions, ...promoRedemptions].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    const seen = new Set();
    const deduped = combined.filter(item => {
      const key = `${item.rollNo}-${item.date}-${item.saved}-${item.promoCode || 'qr'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const totalRevenue = deduped.reduce((sum, r) => sum + (r.paid || 0), 0);
    const totalBill = deduped.reduce((sum, r) => sum + (r.bill || 0), 0);
    const totalSaved = deduped.reduce((sum, r) => sum + (r.saved || 0), 0);
    const uniqueStudents = new Set(deduped.map(r => r.studentId?.toString()).filter(Boolean)).size;

    res.json({
      success: true,
      redemptions: deduped,
      stats: {
        totalRedemptions: deduped.length,
        totalRevenue,
        totalBill,
        totalSaved,
        uniqueStudents,
        onlineCount: promoRedemptions.length,
        inStoreCount: qrRedemptions.length,
        onlineSaved: promoRedemptions.reduce((s, r) => s + r.saved, 0),
        inStoreSaved: qrRedemptions.reduce((s, r) => s + r.saved, 0)
      }
    });
  } catch (err) {
    console.error("Error fetching brand redemptions:", err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET: All Brands Revenue Summary (Admin view)
// ============================================================
router.get("/admin/brands-revenue", auth, async (req, res) => {
  try {
    const PromoCode = require("../models/PromoCode");

    const admin = await User.findById(req.userId).lean().select('role');
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ message: "Only admins allowed" });
    }

    const brands = await User.find({ role: 'brand' })
      .select('name brandName logo category brandApprovalStatus platform address phone email websiteUrl isOnline isInStore createdAt')
      .lean();

    const allOffers = await Offer.find({})
      .populate({
        path: "redemptions.student",
        select: "name rollNo university"
      })
      .lean();

    const allPromoCodes = await PromoCode.find({ status: 'used' })
      .populate('offer', 'title image discountPercentage')
      .lean();

    const offersByBrand = {};
    allOffers.forEach(offer => {
      const brandId = offer.brand?.toString();
      if (!brandId) return;
      if (!offersByBrand[brandId]) offersByBrand[brandId] = [];
      offersByBrand[brandId].push(offer);
    });

    const promosByBrand = {};
    allPromoCodes.forEach(pc => {
      const brandId = pc.brand?.toString();
      if (!brandId) return;
      if (!promosByBrand[brandId]) promosByBrand[brandId] = [];
      promosByBrand[brandId].push(pc);
    });

    const brandsWithRevenue = brands.map(brand => {
      const brandId = brand._id.toString();
      const brandOffers = offersByBrand[brandId] || [];
      const brandPromos = promosByBrand[brandId] || [];

      let qrRevenue = 0;
      let qrBill = 0;
      let qrSaved = 0;
      let qrCount = 0;
      const uniqueQrStudents = new Set();

      brandOffers.forEach(offer => {
        (offer.redemptions || []).forEach(r => {
          const bill = r.billAmount || 0;
          const saved = r.savedAmount || 0;
          qrBill += bill;
          qrSaved += saved;
          qrRevenue += (bill - saved);
          qrCount += 1;
          if (r.student?._id) uniqueQrStudents.add(r.student._id.toString());
        });
      });

      let promoRevenue = 0;
      let promoBill = 0;
      let promoCount = 0;
      const uniquePromoStudents = new Set();

      brandPromos.forEach(pc => {
        const bill = pc.externalAmount || 0;
        const saved = Math.round((bill * (pc.discountPercentage || 0)) / 100);
        promoBill += bill;
        promoRevenue += (bill - saved);
        promoCount += 1;
        if (pc.student) uniquePromoStudents.add(pc.student.toString());
      });

      const promoSaved = Math.round((promoBill * (brandPromos[0]?.discountPercentage || 0)) / 100);

      const totalRevenue = qrRevenue + promoRevenue;
      const totalBill = qrBill + promoBill;
      const totalSaved = qrSaved + promoSaved;
      const totalRedemptions = qrCount + promoCount;
      const uniqueStudents = new Set([
        ...uniqueQrStudents,
        ...uniquePromoStudents
      ]).size;

      let topOffer = "—";
      let topCount = 0;
      brandOffers.forEach(offer => {
        const count = (offer.redemptions || []).length;
        if (count > topCount) {
          topCount = count;
          topOffer = offer.title || "Offer";
        }
      });

      return {
        _id: brand._id,
        name: brand.brandName || brand.name || 'Brand',
        logo: brand.logo || null,
        category: brand.category || 'General',
        approvalStatus: brand.brandApprovalStatus || 'pending',
        platform: brand.platform || 'woocommerce',
        websiteUrl: brand.websiteUrl || '',
        address: brand.address || '',
        phone: brand.phone || '',
        email: brand.email || '',
        createdAt: brand.createdAt,
        isOnline: brand.isOnline || false,
        isInStore: brand.isInStore || false,

        totalRevenue,
        totalBill,
        totalSaved,
        totalRedemptions,
        uniqueStudents,

        qrRevenue,
        qrBill,
        qrSaved,
        qrCount,

        promoRevenue,
        promoBill,
        promoCount,

        topOffer,
        topOfferCount: topCount,
        offersCount: brandOffers.length,
      };
    });

    brandsWithRevenue.sort((a, b) => b.totalRevenue - a.totalRevenue);

    const grandTotalRevenue = brandsWithRevenue.reduce((s, b) => s + b.totalRevenue, 0);
    const grandTotalBill = brandsWithRevenue.reduce((s, b) => s + b.totalBill, 0);
    const grandTotalSaved = brandsWithRevenue.reduce((s, b) => s + b.totalSaved, 0);
    const grandTotalRedemptions = brandsWithRevenue.reduce((s, b) => s + b.totalRedemptions, 0);
    const grandUniqueStudents = brandsWithRevenue.reduce((s, b) => s + b.uniqueStudents, 0);
    const brandsWithRevenueCount = brandsWithRevenue.filter(b => b.totalRevenue > 0).length;

    res.json({
      success: true,
      summary: {
        totalBrands: brands.length,
        brandsWithRevenue: brandsWithRevenueCount,
        totalRevenue: grandTotalRevenue,
        totalBill: grandTotalBill,
        totalSaved: grandTotalSaved,
        totalRedemptions: grandTotalRedemptions,
        uniqueStudents: grandUniqueStudents,
        averageRevenue: brandsWithRevenueCount > 0
          ? Math.round(grandTotalRevenue / brandsWithRevenueCount)
          : 0,
      },
      brands: brandsWithRevenue,
    });
  } catch (err) {
    console.error("Error in brands-revenue:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;