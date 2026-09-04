// routes/brands.js - VERIFY THIS IS CORRECT
const express = require("express");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");

const router = express.Router();

// GET brands - Only show APPROVED brands, sorted by newest first
router.get("/", async (req, res) => {
  try {
    // Only fetch brands that are approved
    const brands = await User.find({ 
      role: "brand",
      brandApprovalStatus: "approved" // Only show approved brands
    })
      .select("name email logo category brandName address isOnline isInStore phone createdAt")
      .sort({ createdAt: -1 }) // NEWEST FIRST
      .lean()
      .exec();
    
    // Format brand data
    const formattedBrands = brands.map(brand => ({
      _id: brand._id,
      name: brand.brandName || brand.name,
      logo: brand.logo || null,
      category: brand.category || "General",
      email: brand.email,
      isOnline: brand.isOnline || false,
      isInStore: brand.isInStore || false,
      address: brand.address || "",
      phone: brand.phone || "",
      displayImage: brand.logo || null,
      createdAt: brand.createdAt || new Date().toISOString(),
    }));
    
    res.json(formattedBrands);
  } catch (err) {
    console.error("Error fetching brands:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get offers by brand - with auth check
router.get("/:brandId/offers", auth, async (req, res) => {
  try {
    // First verify the brand exists and is approved
    const brand = await User.findOne({ 
      _id: req.params.brandId,
      role: "brand",
      brandApprovalStatus: "approved" // Only approved brands can have offers visible
    });

    if (!brand) {
      return res.status(404).json({ 
        success: false,
        message: "Brand not found or not approved" 
      });
    }

    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name brandName logo")
      .populate("university", "name")
      .sort({ createdAt: -1 }); // NEWEST OFFERS FIRST
    
    res.json(offers);
  } catch (err) {
    console.error("Error fetching brand offers:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error" 
    });
  }
});

// ==========================================
// GET BRAND DETAILS (with auth check)
// ==========================================
router.get("/:brandId", auth, async (req, res) => {
  try {
    const brand = await User.findOne({ 
      _id: req.params.brandId,
      role: "brand"
    }).select("-password -__v");
    
    if (!brand) {
      return res.status(404).json({ 
        success: false,
        message: "Brand not found" 
      });
    }
    
    // If brand is not approved and user is not admin or the brand owner
    if (brand.brandApprovalStatus !== 'approved') {
      const requestingUser = await User.findById(req.userId);
      if (requestingUser.role !== 'admin' && req.userId !== brand._id.toString()) {
        return res.status(403).json({ 
          success: false,
          message: "This brand is not yet approved" 
        });
      }
    }
    
    res.json({
      success: true,
      brand
    });
  } catch (err) {
    console.error("Error fetching brand:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error" 
    });
  }
});

// ==========================================
// GET BRAND OFFERS WITH DETAILS
// ==========================================
router.get("/:brandId/offers/details", auth, async (req, res) => {
  try {
    const brand = await User.findOne({ 
      _id: req.params.brandId,
      role: "brand"
    });
    
    if (!brand) {
      return res.status(404).json({ 
        success: false,
        message: "Brand not found" 
      });
    }
    
    const offers = await Offer.find({ brand: req.params.brandId })
      .populate("brand", "name brandName logo")
      .populate("claimedBy", "name email rollNo")
      .sort({ createdAt: -1 }) // NEWEST OFFERS FIRST
      .lean()
      .exec();
    
    // Calculate stats
    const stats = {
      totalOffers: offers.length,
      activeOffers: offers.filter(o => o.isActive !== false).length,
      totalClaims: offers.reduce((sum, o) => sum + (o.claimedBy?.length || 0), 0),
      totalSavings: offers.reduce((sum, o) => sum + (o.totalSavings || 0), 0),
      totalRedemptions: offers.reduce((sum, o) => sum + (o.redemptions?.length || 0), 0)
    };
    
    res.json({
      success: true,
      offers,
      stats
    });
  } catch (err) {
    console.error("Error fetching brand offers:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error" 
    });
  }
});

// ==========================================
// GET BRAND STATS (for admin dashboard)
// ==========================================
router.get("/:brandId/stats", auth, async (req, res) => {
  try {
    const brand = await User.findOne({ 
      _id: req.params.brandId,
      role: "brand"
    });
    
    if (!brand) {
      return res.status(404).json({ 
        success: false,
        message: "Brand not found" 
      });
    }
    
    const offers = await Offer.find({ brand: req.params.brandId });
    
    // Get all redemptions
    const allRedemptions = offers.flatMap(o => o.redemptions || []);
    
    const stats = {
      totalOffers: offers.length,
      activeOffers: offers.filter(o => o.isActive !== false).length,
      totalClaims: offers.reduce((sum, o) => sum + (o.claimedBy?.length || 0), 0),
      totalRedemptions: allRedemptions.length,
      totalSavings: offers.reduce((sum, o) => sum + (o.totalSavings || 0), 0),
      totalRevenue: allRedemptions.reduce((sum, r) => sum + (r.billAmount || 0), 0),
      uniqueStudents: new Set(allRedemptions.map(r => r.student?.toString())).size
    };
    
    res.json({
      success: true,
      stats
    });
  } catch (err) {
    console.error("Error fetching brand stats:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error" 
    });
  }
});

module.exports = router;