// routes/brandApproval.routes.js - FIXED VERSION
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Notification = require("../models/Notification");
const auth = require("../middleware/auth.middleware");

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (user && user.role === "admin") {
      next();
    } else {
      res.status(403).json({ 
        success: false,
        message: "Access denied. Admins only." 
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
};

// ==========================================
// GET ALL BRANDS WITH APPROVAL STATUS
// ==========================================
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    
    const filter = { role: "brand" };
    if (status && status !== 'all') {
      filter.brandApprovalStatus = status;
    }

    const brands = await User.find(filter)
      .select("name email brandName logo category address isOnline isInStore brandApprovalStatus brandApprovalNote brandApprovedAt brandRejectedAt createdAt phone")
      .sort({ createdAt: -1 });

    const stats = {
      total: await User.countDocuments({ role: "brand" }),
      pending: await User.countDocuments({ role: "brand", brandApprovalStatus: "pending" }),
      approved: await User.countDocuments({ role: "brand", brandApprovalStatus: "approved" }),
      rejected: await User.countDocuments({ role: "brand", brandApprovalStatus: "rejected" }),
      draft: await User.countDocuments({ role: "brand", brandApprovalStatus: "draft" }),
    };

    res.json({
      success: true,
      brands,
      stats
    });
  } catch (err) {
    console.error("Error fetching brands:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// ==========================================
// GET SINGLE BRAND DETAILS
// ==========================================
router.get("/:id", auth, isAdmin, async (req, res) => {
  try {
    const brand = await User.findOne({ 
      _id: req.params.id, 
      role: "brand" 
    }).select("-password");

    if (!brand) {
      return res.status(404).json({ 
        success: false,
        message: "Brand not found" 
      });
    }

    res.json({
      success: true,
      brand
    });
  } catch (err) {
    console.error("Error fetching brand:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// ==========================================
// UPDATE BRAND APPROVAL STATUS
// ==========================================
router.put("/:id/status", auth, isAdmin, async (req, res) => {
  try {
    const { status, note } = req.body;
    const { id } = req.params;

    const validStatuses = ["pending", "approved", "rejected", "draft"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`
      });
    }

    const brand = await User.findOne({ _id: id, role: "brand" });
    if (!brand) {
      return res.status(404).json({
        success: false,
        message: "Brand not found"
      });
    }

    brand.brandApprovalStatus = status;
    
    if (note) {
      brand.brandApprovalNote = note;
    }

    if (status === "approved") {
      brand.brandApprovedAt = new Date();
      brand.brandRejectedAt = null;
    } else if (status === "rejected") {
      brand.brandRejectedAt = new Date();
      brand.brandApprovedAt = null;
    } else {
      brand.brandApprovedAt = null;
      brand.brandRejectedAt = null;
    }

    await brand.save();

    // Create notification
    let notificationTitle = "";
    let notificationDescription = "";

    switch (status) {
      case "approved":
        notificationTitle = "🎉 Brand Approved!";
        notificationDescription = `Your brand "${brand.brandName || brand.name}" has been approved and is now visible to students!`;
        break;
      case "rejected":
        notificationTitle = "Brand Application Update";
        notificationDescription = `Your brand "${brand.brandName || brand.name}" application has been reviewed. Please check your dashboard for more details.`;
        break;
      case "draft":
        notificationTitle = "Brand Saved as Draft";
        notificationDescription = `Your brand "${brand.brandName || brand.name}" has been saved as a draft. It is not visible to students yet.`;
        break;
      case "pending":
        notificationTitle = "Brand Status Updated";
        notificationDescription = `Your brand "${brand.brandName || brand.name}" is under review. We'll notify you once it's approved.`;
        break;
    }

    try {
      await Notification.create({
        recipient: brand._id,
        title: notificationTitle,
        description: notificationDescription,
        type: "Brand",
        icon: "information",
        link: "/brands/my-brand",
      });
    } catch (notifError) {
      console.error("Notification creation error:", notifError);
    }

    const updatedBrand = await User.findById(id).select("-password");

    res.json({
      success: true,
      message: `Brand status updated to ${status}`,
      brand: updatedBrand
    });

  } catch (err) {
    console.error("Error updating brand status:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ==========================================
// BULK UPDATE BRAND STATUSES
// ==========================================
router.put("/bulk-status", auth, isAdmin, async (req, res) => {
  try {
    const { brandIds, status, note } = req.body;

    if (!brandIds || !Array.isArray(brandIds) || brandIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide brand IDs"
      });
    }

    const validStatuses = ["pending", "approved", "rejected", "draft"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`
      });
    }

    const updateData = {
      brandApprovalStatus: status
    };

    if (note) {
      updateData.brandApprovalNote = note;
    }

    if (status === "approved") {
      updateData.brandApprovedAt = new Date();
      updateData.brandRejectedAt = null;
    } else if (status === "rejected") {
      updateData.brandRejectedAt = new Date();
      updateData.brandApprovedAt = null;
    } else {
      updateData.brandApprovedAt = null;
      updateData.brandRejectedAt = null;
    }

    const result = await User.updateMany(
      { _id: { $in: brandIds }, role: "brand" },
      { $set: updateData }
    );

    for (const brandId of brandIds) {
      try {
        const brand = await User.findById(brandId);
        if (brand) {
          await Notification.create({
            recipient: brand._id,
            title: "Brand Status Updated",
            description: `Your brand "${brand.brandName || brand.name}" status has been updated to ${status}.`,
            type: "Brand",
            icon: "information",
          });
        }
      } catch (notifError) {
        console.error("Notification error for brand:", brandId);
      }
    }

    res.json({
      success: true,
      message: `${result.modifiedCount} brands updated successfully`,
      updatedCount: result.modifiedCount
    });

  } catch (err) {
    console.error("Error bulk updating brands:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ==========================================
// GET APPROVED BRANDS (Public)
// ==========================================
router.get("/approved", async (req, res) => {
  try {
    const brands = await User.find({ 
      role: "brand",
      brandApprovalStatus: "approved"
    })
    .select("name email brandName logo category address isOnline isInStore phone")
    .sort({ createdAt: -1 });

    res.json({
      success: true,
      brands
    });
  } catch (err) {
    console.error("Error fetching approved brands:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ==========================================
// GET BRAND STATS FOR DASHBOARD
// ==========================================
router.get("/stats", auth, isAdmin, async (req, res) => {
  try {
    const stats = {
      total: await User.countDocuments({ role: "brand" }),
      pending: await User.countDocuments({ role: "brand", brandApprovalStatus: "pending" }),
      approved: await User.countDocuments({ role: "brand", brandApprovalStatus: "approved" }),
      rejected: await User.countDocuments({ role: "brand", brandApprovalStatus: "rejected" }),
      draft: await User.countDocuments({ role: "brand", brandApprovalStatus: "draft" }),
    };

    const recentBrands = await User.find({ role: "brand" })
      .select("name brandName email brandApprovalStatus createdAt")
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      stats,
      recentBrands
    });
  } catch (err) {
    console.error("Error fetching brand stats:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});


module.exports = router;