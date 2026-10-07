// routes/brands.js - VERIFY THIS IS CORRECT
const express = require("express");
const Offer = require("../models/Offer");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");

const {
  DEFAULT_CITY,
  getBrandCitiesMap,
  matchesCity,
  normalizeCity,
} = require("../utils/brandCities");

const router = express.Router();

// Brand lists change often (claims, new offers), never let a phone/proxy cache them
router.use((req, res, next) => {
  if (req.method === "GET") res.set("Cache-Control", "no-store");
  next();
});

// Loads approved brands with their cities (brand city + active branch cities)
async function loadApprovedBrands() {
  const brands = await User.find({
    role: "brand",
    brandApprovalStatus: "approved",
  })
    .select("name email logo category brandName address city isOnline isInStore phone createdAt")
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  const citiesMap = await getBrandCitiesMap(brands);

  return brands.map((brand) => {
    const cities = citiesMap.get(brand._id.toString()) || [DEFAULT_CITY];
    return {
      _id: brand._id,
      name: brand.brandName || brand.name,
      logo: brand.logo || null,
      category: brand.category || "General",
      email: brand.email,
      isOnline: brand.isOnline || false,
      isInStore: brand.isInStore || false,
      address: brand.address || "",
      phone: brand.phone || "",
      city: cities[0],
      cities,
      displayImage: brand.logo || null,
      createdAt: brand.createdAt || new Date().toISOString(),
    };
  });
}

// GET brands - only APPROVED brands, newest first
// Optional: ?city=Karachi  (strict: only brands that are in that city)
router.get("/", async (req, res) => {
  try {
    let list = await loadApprovedBrands();

    const city = normalizeCity(req.query.city || "");
    if (city && city.toLowerCase() !== "all") {
      list = list.filter((b) => matchesCity(b.cities, city));
    }

    res.json(list);
  } catch (err) {
    console.error("Error fetching brands:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/brands/cities → [{ city, count }], only cities that have brands, most first
router.get("/cities", async (req, res) => {
  try {
    const list = await loadApprovedBrands();
    const counts = new Map();
    for (const b of list) {
      for (const c of b.cities) counts.set(c, (counts.get(c) || 0) + 1);
    }
    const cities = [...counts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

    res.json({ success: true, default: "All", total: list.length, cities });
  } catch (err) {
    console.error("Error fetching brand cities:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
router.get("/stats", auth, async (req, res) => {
  try {
    const brands = await User.find({ role: "brand" }).select("_id").lean();
    const offers = await Offer.find({ brand: { $in: brands.map(b => b._id) } });

    const allRedemptions = offers.flatMap(o => o.redemptions || []);

    const stats = {
      totalBrands: brands.length,
      totalOffers: offers.length,
      activeOffers: offers.filter(o => o.isActive !== false).length,
      totalClaims: offers.reduce((sum, o) => sum + (o.claimedBy?.length || 0), 0),
      totalRedemptions: allRedemptions.length,
      totalSavings: offers.reduce((sum, o) => sum + (o.totalSavings || 0), 0),
      totalRevenue: allRedemptions.reduce((sum, r) => sum + (r.billAmount || 0), 0),
      uniqueStudents: new Set(allRedemptions.map(r => r.student?.toString())).size
    };

    res.json({ success: true, stats });
  } catch (err) {
    console.error("Error fetching overall brand stats:", err);
    res.status(500).json({ success: false, message: "Server error" });
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
// router.get("/:brandId/stats", auth, async (req, res) => {
//   try {
//     const brand = await User.findOne({ 
//       _id: req.params.brandId,
//       role: "brand"
//     });
    
//     if (!brand) {
//       return res.status(404).json({ 
//         success: false,
//         message: "Brand not found" 
//       });
//     }
    
//     const offers = await Offer.find({ brand: req.params.brandId });
    
//     // Get all redemptions
//     const allRedemptions = offers.flatMap(o => o.redemptions || []);
    
//     const stats = {
//       totalOffers: offers.length,
//       activeOffers: offers.filter(o => o.isActive !== false).length,
//       totalClaims: offers.reduce((sum, o) => sum + (o.claimedBy?.length || 0), 0),
//       totalRedemptions: allRedemptions.length,
//       totalSavings: offers.reduce((sum, o) => sum + (o.totalSavings || 0), 0),
//       totalRevenue: allRedemptions.reduce((sum, r) => sum + (r.billAmount || 0), 0),
//       uniqueStudents: new Set(allRedemptions.map(r => r.student?.toString())).size
//     };
    
//     res.json({
//       success: true,
//       stats
//     });
//   } catch (err) {
//     console.error("Error fetching brand stats:", err);
//     res.status(500).json({ 
//       success: false,
//       message: "Server error" 
//     });
//   }
// });
// ==========================================
// GET OVERALL BRAND STATS (for admin dashboard)
// ==========================================

// ==========================================
// READ: Get all active branches for a specific brand (PUBLIC)
// GET /api/branches/brand/:brandId
// ==========================================
// router.get("/brand/:brandId", async (req, res) => {
//   try {
//     const branches = await Branch.find({
//       brand: req.params.brandId,
//       isActive: true,
//     })
//       .sort({ createdAt: -1 })
//       .lean();

//     res.json({
//       success: true,
//       count: branches.length,
//       branches,
//     });
//   } catch (err) {
//     console.error("Error fetching brand branches:", err);
//     res.status(500).json({ success: false, message: err.message });
//   }
// });

// ==========================================
// READ: Get all active branches for a specific brand (PUBLIC)
// GET /api/branches/brand/:brandId
// ==========================================
router.get("/brand/:brandId", async (req, res) => {
  try {
    const branches = await Branch.find({
      brand: req.params.brandId,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: branches.length,
      branches,
    });
  } catch (err) {
    console.error("Error fetching brand branches:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;