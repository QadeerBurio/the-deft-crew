// routes/branch.routes.js
const express = require("express");
const router = express.Router();
const Branch = require("../models/Branch");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const { buildAddress, geocodeInBackground } = require("../services/geo/geocoder");

// ==========================================
// CREATE: Add a new branch
// POST /api/branches
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select("role");
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const {
      name,
      description,
      discountPercentage,
      isOnline,
      isInStore,
      location,
      phone,
      city,
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Branch name is required" });
    }
    if (!discountPercentage) {
      return res
        .status(400)
        .json({ message: "Discount percentage is required" });
    }
    if (!isOnline && !isInStore) {
      return res
        .status(400)
        .json({ message: "Select at least one availability type" });
    }
    if (isInStore && (!location || !location.trim())) {
      return res
        .status(400)
        .json({ message: "Location is required for in-store branches" });
    }

    const branch = await Branch.create({
      brand: req.userId,
      name: name.trim(),
      description: description?.trim() || "",
      discountPercentage: Number(discountPercentage),
      isOnline: Boolean(isOnline),
      isInStore: Boolean(isInStore),
      location: isInStore ? (location?.trim() || "") : "",
      phone: phone?.trim() || "",
      city: city?.trim() || "",
      isActive: true,
    });

    res.json({
      success: true,
      message: "Branch created successfully",
      branch,
    });

    // "near me": map point for the address, after the response (never blocks the save)
    if (branch.isInStore && branch.location) {
      geocodeInBackground(Branch, branch._id, buildAddress([branch.location, branch.city]));
    }
  } catch (err) {
    console.error("Error creating branch:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// READ: Get all branches for the logged-in brand
// GET /api/branches/my-branches
// ==========================================
router.get("/my-branches", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean().select("role");
    if (!user || user.role !== "brand") {
      return res.status(403).json({ message: "Only brands allowed" });
    }

    const branches = await Branch.find({ brand: req.userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: branches.length,
      branches,
    });
  } catch (err) {
    console.error("Error fetching branches:", err);
    res.status(500).json({ message: err.message });
  }
});
// Place AFTER router.get("/my-branches") and BEFORE router.get("/:branchId")
router.get("/brand/:brandId", async (req, res) => {
  try {
    const branches = await Branch.find({
      brand: req.params.brandId,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: branches.length, branches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ==========================================
// READ: Get a single branch
// GET /api/branches/:branchId
// ==========================================
router.get("/:branchId", auth, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.branchId).lean();
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    // Only owner or admin can view
    const user = await User.findById(req.userId).lean().select("role");
    if (
      user?.role !== "admin" &&
      branch.brand.toString() !== req.userId.toString()
    ) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    res.json({ success: true, branch });
  } catch (err) {
    console.error("Error fetching branch:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// UPDATE: Modify an existing branch
// PUT /api/branches/:branchId
// ==========================================
router.put("/:branchId", auth, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.branchId);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (branch.brand.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    const addressBefore = buildAddress([branch.location, branch.city]);

    const {
      name,
      description,
      discountPercentage,
      isOnline,
      isInStore,
      location,
      phone,
      city,
      isActive,
    } = req.body;

    if (name !== undefined) branch.name = name.trim();
    if (description !== undefined) branch.description = description.trim();
    if (discountPercentage !== undefined)
      branch.discountPercentage = Number(discountPercentage);
    if (isOnline !== undefined) branch.isOnline = Boolean(isOnline);
    if (isInStore !== undefined) branch.isInStore = Boolean(isInStore);
    if (location !== undefined) branch.location = location.trim();
    if (phone !== undefined) branch.phone = phone.trim();
    if (city !== undefined) branch.city = city.trim();
    if (isActive !== undefined) branch.isActive = Boolean(isActive);

    // Validate: at least one of isOnline / isInStore must be true
    if (!branch.isOnline && !branch.isInStore) {
      return res
        .status(400)
        .json({ message: "Select at least one availability type" });
    }
    // If in-store, location is required
    if (branch.isInStore && (!branch.location || !branch.location.trim())) {
      return res
        .status(400)
        .json({ message: "Location is required for in-store branches" });
    }
    // If not in-store, clear location
    if (!branch.isInStore) {
      branch.location = "";
    }

    await branch.save();

    res.json({
      success: true,
      message: "Branch updated successfully",
      branch,
    });

    // "near me": re-geocode only when the address changed (after the response)
    const addressAfter = branch.isInStore ? buildAddress([branch.location, branch.city]) : "";
    if (addressAfter !== addressBefore) {
      geocodeInBackground(Branch, branch._id, addressAfter, { clearOnFail: true });
    }
  } catch (err) {
    console.error("Error updating branch:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// DELETE: Remove a branch
// DELETE /api/branches/:branchId
// ==========================================
router.delete("/:branchId", auth, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.branchId);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (branch.brand.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await Branch.findByIdAndDelete(req.params.branchId);

    res.json({
      success: true,
      message: "Branch deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting branch:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// TOGGLE: Toggle active status
// PATCH /api/branches/:branchId/toggle
// ==========================================
router.patch("/:branchId/toggle", auth, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.branchId);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (branch.brand.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    branch.isActive = !branch.isActive;
    await branch.save();

    res.json({
      success: true,
      message: `Branch ${branch.isActive ? "activated" : "deactivated"}`,
      branch,
    });
  } catch (err) {
    console.error("Error toggling branch:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;