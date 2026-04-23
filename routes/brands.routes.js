// routes/brands.js
const express = require("express");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const router = express.Router();

// ==========================================
// 🚀 NEW: ULTRA-FAST BRANDS ENDPOINT
// Returns all brands with their first offer in ONE API call
// ==========================================
router.get("/fast", auth, async (req, res) => {
  try {
    const userId = req.userId;
    const { 
      search, 
      category, 
      minDiscount = 0,
      onlineOnly = false,
      page = 1,
      limit = 50 
    } = req.query;

    // Get all brands with role "brand"
    const brandsQuery = { role: "brand" };
    
    // Add search filter if provided
    if (search) {
      brandsQuery.name = { $regex: search, $options: 'i' };
    }

    // Get all brands first (limited)
    const brands = await User.find(brandsQuery)
      .select("name email logo category")
      .lean()
      .limit(100); // Max 100 brands for speed

    if (!brands.length) {
      return res.json({ brands: [], total: 0, hasMore: false });
    }

    // Get all brand IDs
    const brandIds = brands.map(b => b._id);

    // 🔥 MAGIC: Get all offers for all brands in ONE query using aggregation
    const offersAggregation = await Offer.aggregate([
      // Match offers that belong to our brands
      { $match: { brand: { $in: brandIds } } },
      
      // Apply category filter
      ...(category && category !== "All" ? [
        { $match: { category: category } }
      ] : []),
      
      // Apply minimum discount filter
      ...(minDiscount > 0 ? [
        { $match: { discountPercentage: { $gte: parseInt(minDiscount) } } }
      ] : []),
      
      // Apply online only filter
      ...(onlineOnly === 'true' ? [
        { $match: { isOnline: true } }
      ] : []),
      
      // Sort by discount (highest first) and then by newest
      { $sort: { discountPercentage: -1, createdAt: -1 } },
      
      // Group by brand and get the first offer for each
      {
        $group: {
          _id: "$brand",
          firstOffer: { $first: "$$ROOT" },
          totalOffers: { $sum: 1 },
          // Check if user has claimed the first offer
          isClaimed: { 
            $in: [new mongoose.Types.ObjectId(userId), "$claimedBy"]
          }
        }
      }
    ]);

    // Convert to map for fast lookup
    const offersMap = {};
    offersAggregation.forEach(item => {
      offersMap[item._id.toString()] = {
        offer: item.firstOffer,
        offerCount: item.totalOffers,
        isClaimed: item.isClaimed
      };
    });

    // 🔥 Merge brands with their offers
    const brandsWithOffers = brands
      .map(brand => {
        const brandId = brand._id.toString();
        const offerData = offersMap[brandId];
        const firstOffer = offerData?.offer;
        
        // Skip brands that don't match filters (if category/discount applied)
        if ((category && category !== "All" || minDiscount > 0 || onlineOnly === 'true') && !firstOffer) {
          return null;
        }

        return {
          _id: brand._id,
          name: brand.name,
          email: brand.email,
          logo: brand.logo,
          displayImage: firstOffer?.image || brand.logo,
          hasOffer: !!firstOffer,
          discount: firstOffer?.discountPercentage || 0,
          category: firstOffer?.category || brand.category || "General",
          isOnline: firstOffer?.isOnline || false,
          isInStore: firstOffer?.isInStore || false,
          // Include first offer details for modal
          offers: firstOffer ? [{
            _id: firstOffer._id,
            title: firstOffer.title,
            description: firstOffer.description,
            discountPercentage: firstOffer.discountPercentage,
            image: firstOffer.image,
            category: firstOffer.category,
            location: firstOffer.location,
            redeemInstructions: firstOffer.redeemInstructions,
            isOnline: firstOffer.isOnline,
            isInStore: firstOffer.isInStore,
            isClaimed: offerData.isClaimed
          }] : [],
          // Quick stats
          totalOffers: offerData?.offerCount || 0
        };
      })
      .filter(Boolean); // Remove null entries

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const paginatedBrands = brandsWithOffers.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      brands: paginatedBrands,
      total: brandsWithOffers.length,
      page: parseInt(page),
      totalPages: Math.ceil(brandsWithOffers.length / limit),
      hasMore: startIndex + parseInt(limit) < brandsWithOffers.length
    });

  } catch (err) {
    console.error("Fast brands error:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error",
      error: err.message 
    });
  }
});

// Get all brands (original endpoint - keep for backward compatibility)
router.get("/", auth, async (req, res) => {
  try {
    const brands = await User.find({ role: "brand" }).select("name email logo category");
    res.json(brands);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get brand offers (original endpoint)
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