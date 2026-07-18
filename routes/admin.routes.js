const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { storage } = require("../config/cloudinary");
const Slider = require("../models/Slider"); // Your unified model
const Notification = require("../models/Notification");
const Job = require("../models/Job");
const User = require("../models/User"); // ADDED
const auth = require("../middleware/auth.middleware"); // ADDED
const Exchange = require("../models/Exchange");
const Application = require("../models/Application");
const Package = require("../models/Package");
const upload = multer({ storage });
const Booking = require("../models/Booking");
const Scholarships =require("../models/Scholarships")
const Course =require('../models/Course')



// Configure multer for course image uploads using Cloudinary
const courseUpload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});


// --- Routes ---
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (user && user.role === "admin") {
      next();
    } else {
      res.status(403).json({ message: "Access denied. Admins only." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== USER MANAGEMENT ROUTES ====================

// ✅ Get users by ANY role (Student, Brand, Employee, Traveler)
router.get("/users/:role", auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    // Validate role
    const validRoles = ["student", "brand", "employee", "traveler", "admin"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role specified" });
    }

    const users = await User.find({ role })
      .populate("university", "name")
      .populate("referredBy", "name email")
      .select("-password")
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get ALL users (for super admin)
router.get("/users/all", auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .populate("university", "name")
      .populate("referredBy", "name email")
      .select("-password")
      .sort({ createdAt: -1 });

    // Group by role for statistics
    const stats = {
      total: users.length,
      students: users.filter(u => u.role === "student").length,
      brands: users.filter(u => u.role === "brand").length,
      employees: users.filter(u => u.role === "employee").length,
      travelers: users.filter(u => u.role === "traveler").length,
      admins: users.filter(u => u.role === "admin").length,
    };

    res.json({ users, stats });
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get single user details (with full profile)
router.get("/users/details/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate("university", "name location")
      .populate("referredBy", "name email role")
      .select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (err) {
    console.error("Error fetching user details:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Toggle User Verification (Approve/Revoke)
router.post("/approve-user/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.status = user.status === "Verified" ? "Not Verified" : "Verified";
    await user.save();

    // Send notification to user
    if (user.status === "Verified") {
      await Notification.create({
        recipient: user._id,
        title: "Account Verified! ✅",
        description: "Your account has been verified by the admin.",
        type: "System",
        icon: "checkmark-circle",
      });
    }

    res.json({ message: "Status Updated", user: { ...user.toObject(), password: undefined } });
  } catch (err) {
    console.error("Error toggling verification:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update user role (Admin only)
router.put("/users/role/:id", auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ["student", "brand", "employee", "traveler", "admin"];
    
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "Role updated successfully", user });
  } catch (err) {
    console.error("Error updating role:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Delete user (Admin only)
router.delete("/users/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create user (Admin only - for adding brands/employees)
router.post("/users/create", auth, isAdmin, async (req, res) => {
  try {
    const { name, email, password, role, phone, address, company, designation } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User with this email already exists" });
    }

    // Hash password
    const bcrypt = require("bcryptjs");
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role: role || "employee",
      phone: phone || "",
      address: address || "",
      // Brand-specific fields
      company: company || "",
      designation: designation || "",
      // Auto-verify if created by admin
      status: "Verified",
    });

    await newUser.save();

    // Send welcome email/notification
    await Notification.create({
      recipient: newUser._id,
      title: `Welcome to TechDegree Club! 🎉`,
      description: `Your account has been created. You can now login with your email: ${email}`,
      type: "System",
      icon: "sparkles",
    });

    res.status(201).json({
      message: "User created successfully",
      user: { ...newUser.toObject(), password: undefined }
    });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get employee and brand users with credentials (show emails)
router.get("/users/credentials/:role", auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    if (!["brand", "employee"].includes(role)) {
      return res.status(400).json({ message: "Invalid role. Use 'brand' or 'employee'" });
    }

    const users = await User.find({ role })
      .select("name email phone role status company designation createdAt")
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    console.error("Error fetching credentials:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Reset user password (Admin only)
router.post("/users/reset-password/:id", auth, isAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const bcrypt = require("bcryptjs");
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { password: hashedPassword },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Notify user
    await Notification.create({
      recipient: user._id,
      title: "Password Reset 🔐",
      description: "Your password has been reset by the admin.",
      type: "System",
      icon: "key",
    });

    res.json({ message: "Password reset successfully", user });
  } catch (err) {
    console.error("Error resetting password:", err);
    res.status(500).json({ error: err.message });
  }
});

// 1. CREATE: Add new Slider or Offer
// 1. CREATE: Add new Slider or Offer
router.post("/add", auth, isAdmin, upload.single("image"), async (req, res) => {
  try {
    console.log("=== ADMIN ADD ROUTE HIT ===");
    console.log("Request body:", req.body);
    console.log("Request file:", req.file);
    
    const { type, title, description, link } = req.body;
    
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({ message: "Image is required" });
    }
    
    if (!type || !title) {
      return res.status(400).json({ message: "Type and title are required" });
    }

    // Build the slider object
    const sliderData = {
      type: type || 'slider',
      title: title || 'Untitled',
      description: description || '',
      link: link || '',
      image: req.file.path,
      active: true,
    };

    console.log("Creating slider with data:", sliderData);

    const newEntry = new Slider(sliderData);
    await newEntry.save();

    console.log("Slider created successfully:", newEntry);

    // ✅ SEND NOTIFICATION HERE - BEFORE RESPONSE
    if (type === 'offer') {
      try {
        console.log("Attempting to send notification for offer...");
        
        const notificationData = {
          recipient: null, // Public broadcast
          title: "New Exclusive Offer! 🔥",
          description: `A new deal has been posted: ${newEntry.title}! Check it out now.`,
          type: "System", // Changed from "Offers" to "System" - more likely to be valid
          icon: "megaphone",
          link: newEntry._id.toString(),
        };
        
        console.log("Notification data:", notificationData);
        
        const notification = await Notification.create(notificationData);
        console.log("Notification sent successfully:", notification);
        
      } catch (nError) {
        console.error("Notification failed:", nError);
        // Don't fail the request if notification fails
        console.error("Error details:", {
          name: nError.name,
          message: nError.message,
          code: nError.code
        });
      }
    }

    // ✅ NOW SEND THE RESPONSE
    res.status(201).json({ 
      message: "Content published successfully!", 
      data: newEntry 
    });

  } catch (error) {
    console.error("=== ERROR IN ADMIN ADD ROUTE ===");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    // Check for validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ 
        message: "Validation failed", 
        errors: errors 
      });
    }
    
    // Check for duplicate key errors
    if (error.code === 11000) {
      return res.status(400).json({ 
        message: "Duplicate entry", 
        field: Object.keys(error.keyPattern)[0] 
      });
    }
    
    res.status(500).json({ 
      message: "Server error occurred", 
      error: error.message 
    });
  }
});

// READ: Get all items (Used by the Combined Slider)

router.get("/all", async (req, res) => {
  try {
    const { type } = req.query;
    // We only want items where active is explicitly NOT false
    const filter = { active: { $ne: false } };

    if (type) {
      filter.type = type;
    }

    const items = await Slider.find(filter).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. UPDATE: Toggle Active Status (Hide/Show on App)
router.patch("/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const item = await Slider.findById(req.params.id);
    item.active = !item.active;
    await item.save();
    res.json({ message: "Status updated", active: item.active });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. DELETE: Remove an item
router.delete("/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    await Slider.findByIdAndDelete(req.params.id);
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




router.patch("/verify-user/:targetUserId", auth, isAdmin, async (req, res) => {
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.targetUserId,
      { isVerified: true },
      { new: true },
    );

    await Notification.create({
      recipient: updatedUser._id, // Private
      title: "Account Verified! ✅",
      description:
        "Your student status is verified. You can now claim premium discounts!",
      type: "System",
      icon: "sparkles",
    });

    res.json({ message: "User verified and notified." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Jobs Portal API's

// // Create a new Job
// router.post("/jobs/add", auth, isAdmin, async (req, res) => {
//   try {
//     const newJob = new Job(req.body);
//     await newJob.save();
//     res.status(201).json({ message: "Job posted successfully", data: newJob });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
// Get all jobs (Admin view)
router.get("/jobs/all", auth, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// // Get only active jobs for the mobile app
// router.get("/jobs/public", async (req, res) => {
//   try {
//     const jobs = await Job.find({ active: true }).sort({ createdAt: -1 });
//     res.json(jobs);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // --- ADMIN MANAGEMENT ---
// // Toggle job status (Active/Inactive)
// router.patch("/jobs/toggle/:id", auth, isAdmin, async (req, res) => {
//   try {
//     const job = await Job.findById(req.params.id);
//     job.active = !job.active;
//     await job.save();
//     res.json({ message: "Status updated", active: job.active });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// router.delete("/jobs/delete/:id", auth, isAdmin, async (req, res) => {
//   try {
//     await Job.findByIdAndDelete(req.params.id);
//     res.json({ message: "Job deleted successfully" });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// ==================== EXCHANGE PROGRAM ROUTES ====================

// ==================== EXCHANGE PROGRAM ROUTES ====================

// @route   POST /admin/exchange/add
// @desc    Create a new program with scholarship support
router.post("/exchange/add", auth, isAdmin, async (req, res) => {
  try {
    const {
      title,
      university,
      location,
      degree,
      appStart,
      deadline,
      duration,
      link,
      requirements,
      scholarship
    } = req.body;

    if (!title || !university || !location || !appStart || !deadline || !duration) {
      return res.status(400).json({ message: "All required fields must be filled." });
    }

    // Create the exchange program
    const newProgram = new Exchange({
      title,
      university,
      location,
      degree: degree || 'Bachelors',
      appStart,
      deadline,
      duration,
      link: link || '',
      requirements: requirements || [],
      active: true
    });

    await newProgram.save();

    // Auto-create scholarship if provided
    if (scholarship && scholarship.name) {
      const newScholarship = new Scholarships({
        programId: newProgram._id,
        name: scholarship.name,
        amount: scholarship.amount || '',
        currency: scholarship.currency || 'USD',
        description: scholarship.description || '',
        deadline: scholarship.deadline || newProgram.deadline,
        requirements: scholarship.requirements || [],
        active: true
      });
      await newScholarship.save();
      
      // Update program with scholarship reference
      newProgram.scholarship = newScholarship._id;
      await newProgram.save();
    }

    // Broadcast notification to all students - Using valid type
    try {
      await Notification.create({
        recipient: null, // Public broadcast
        title: `🌍 New Exchange Program: ${title}`,
        description: `${university} is now accepting applications! Deadline: ${new Date(deadline).toLocaleDateString()}`,
        type: "Exchange", // Now valid in the updated Notification model
        icon: "globe",
        link: newProgram._id.toString()
      });
    } catch (nError) {
      console.error("Notification failed:", nError);
    }

    res.status(201).json({ 
      message: "Program published successfully!", 
      data: newProgram 
    });
  } catch (err) {
    console.error("Error creating exchange program:", err);
    res.status(500).json({ error: "Server Error: " + err.message });
  }
});

// In admin.routes.js - Add this public route BEFORE the authenticated ones

// ==================== PUBLIC EXCHANGE ROUTES ====================

// @route   GET /admin/exchange/all (PUBLIC - for guests)
// @desc    Get all active programs with scholarship data
router.get("/exchange/all", async (req, res) => {
  try {
    const programs = await Exchange.find({ active: true })
      .sort({ createdAt: -1 })
      .populate('scholarship');
    
    // Ensure we return an array even if empty
    res.json(programs || []);
  } catch (err) {
    console.error("Error fetching programs:", err);
    res.status(500).json({ error: "Server Error: " + err.message });
  }
});

// @route   GET /admin/exchange/all-admin (PROTECTED - for admin)
// @desc    Get ALL programs including inactive
router.get("/exchange/all-admin", auth, isAdmin, async (req, res) => {
  try {
    const programs = await Exchange.find()
      .sort({ createdAt: -1 })
      .populate('scholarship');
    res.json(programs);
  } catch (err) {
    console.error("Error fetching programs:", err);
    res.status(500).json({ error: err.message });
  }
});

// @route   PUT /admin/exchange/update/:id
// @desc    Update an existing program
router.put("/exchange/update/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      university,
      location,
      degree,
      appStart,
      deadline,
      duration,
      link,
      requirements,
      scholarship
    } = req.body;

    const program = await Exchange.findById(id);
    if (!program) {
      return res.status(404).json({ message: "Program not found" });
    }

    // Update program fields
    program.title = title;
    program.university = university;
    program.location = location;
    program.degree = degree || 'Bachelors';
    program.appStart = appStart;
    program.deadline = deadline;
    program.duration = duration;
    program.link = link || '';
    program.requirements = requirements || [];

    await program.save();

    // Update or create scholarship
    if (scholarship && scholarship.name) {
      let existingScholarship = await Scholarships.findOne({ programId: program._id });
      
      if (existingScholarship) {
        // Update existing scholarship
        existingScholarship.name = scholarship.name;
        existingScholarship.amount = scholarship.amount || '';
        existingScholarship.currency = scholarship.currency || 'USD';
        existingScholarship.description = scholarship.description || '';
        existingScholarship.deadline = scholarship.deadline || program.deadline;
        existingScholarship.requirements = scholarship.requirements || [];
        await existingScholarship.save();
      } else {
        // Create new scholarship
        const newScholarship = new Scholarships({
          programId: program._id,
          name: scholarship.name,
          amount: scholarship.amount || '',
          currency: scholarship.currency || 'USD',
          description: scholarship.description || '',
          deadline: scholarship.deadline || program.deadline,
          requirements: scholarship.requirements || [],
          active: true
        });
        await newScholarship.save();
        program.scholarship = newScholarship._id;
        await program.save();
      }
    } else {
      // If scholarship data is removed, delete existing scholarship
      if (program.scholarship) {
        await Scholarships.findByIdAndDelete(program.scholarship);
        program.scholarship = null;
        await program.save();
      }
    }

    const updatedProgram = await Exchange.findById(id).populate('scholarship');
    res.json({ 
      message: "Program updated successfully", 
      data: updatedProgram 
    });
  } catch (err) {
    console.error("Error updating program:", err);
    res.status(500).json({ error: "Update failed: " + err.message });
  }
});

// @route   PATCH /admin/exchange/toggle/:id
// @desc    Show/Hide a program
router.patch("/exchange/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const program = await Exchange.findById(req.params.id);
    if (!program) {
      return res.status(404).json({ message: "Program not found" });
    }

    program.active = !program.active;
    await program.save();

    // Also toggle associated scholarship
    if (program.scholarship) {
      await Scholarships.findByIdAndUpdate(program.scholarship, { active: program.active });
    }

    res.json({
      message: `Program is now ${program.active ? "Visible" : "Hidden"}`,
      active: program.active
    });
  } catch (err) {
    console.error("Error toggling program:", err);
    res.status(500).json({ error: err.message });
  }
});

// @route   DELETE /admin/exchange/delete/:id
// @desc    Permanently remove a program
router.delete("/exchange/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    const program = await Exchange.findById(req.params.id);
    if (!program) {
      return res.status(404).json({ message: "Program not found" });
    }

    // Delete associated scholarship
    if (program.scholarship) {
      await Scholarships.findByIdAndDelete(program.scholarship);
    }

    await program.deleteOne();
    res.json({ message: "Program permanently removed." });
  } catch (err) {
    console.error("Error deleting program:", err);
    res.status(500).json({ error: "Delete operation failed." });
  }
});

// @route   GET /admin/exchange/applications/:programId
// @desc    Get applications for a specific program
router.get("/exchange/applications/:programId", auth, isAdmin, async (req, res) => {
  try {
    const applications = await Application.find({
      programId: req.params.programId
    }).populate('userId', 'name email phone university');
    res.json(applications);
  } catch (err) {
    console.error("Error fetching applications:", err);
    res.status(500).json({ error: err.message });
  }
});


// 3. POST Route: Create Package (Admin)
// POST: Create Package
router.post(
  "/packages/create",
  auth,
  isAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        name,
        location,
        category,
        price,
        description,
        requirements,
        inclusions,
      } = req.body;

      if (!req.file)
        return res.status(400).json({ message: "Package image is required." });

      // Safely parse JSON arrays
      const parsedRequirements = requirements ? JSON.parse(requirements) : [];
      const parsedInclusions = inclusions ? JSON.parse(inclusions) : [];

      const newPackage = new Package({
        name,
        location,
        category,
        price: parseFloat(price),
        description,
        requirements: parsedRequirements,
        inclusions: parsedInclusions,
        image: req.file.path, // Cloudinary path
      });

      await newPackage.save();
      res.status(201).json({ success: true, message: "Package published!" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// GET all packages for Admin list (Shows even inactive ones if you add an active field)
router.get("/packages/all", auth, isAdmin, async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Package
router.delete("/packages/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    const deletedPackage = await Package.findByIdAndDelete(req.params.id);
    if (!deletedPackage)
      return res.status(404).json({ message: "Package not found" });
    res.json({ success: true, message: "Package deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- UPDATE PACKAGE (Improved for Safety) ---
router.put(
  "/packages/update/:id",
  auth,
  isAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      // Safety parse for arrays
      try {
        if (updateData.requirements)
          updateData.requirements = JSON.parse(updateData.requirements);
        if (updateData.inclusions)
          updateData.inclusions = JSON.parse(updateData.inclusions);
      } catch (e) {
        return res
          .status(400)
          .json({
            message: "Requirements or Inclusions must be valid JSON strings",
          });
      }

      if (updateData.price) updateData.price = parseFloat(updateData.price);

      if (req.file) {
        updateData.image = req.file.path || req.file.filename;
      }

      const updatedPackage = await Package.findByIdAndUpdate(id, updateData, {
        new: true,
      });

      if (!updatedPackage)
        return res.status(404).json({ message: "Package not found" });

      res.json({
        success: true,
        message: "Package updated!",
        package: updatedPackage,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Admin

// @desc    Get all users waiting for physical cards
// @route   GET /api/admin/pending-cards
router.get("/pending-cards", auth, isAdmin, async (req, res) => {
  try {
    // Only fetch VIPs who haven't received their card yet
    const pendingUsers = await User.find({
      isVip: true,
      cardStatus: { $in: ["Ordered", "Printing"] },
    }).select("name rollNo phone email shippingDetails cardStatus createdAt");

    res.json(pendingUsers);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});
// Get users waiting for payment approval
router.get("/pending-payments", auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({
      paymentStatus: "Pending Verification",
    }).select("name rollNo paymentReceipt shippingDetails");
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Error fetching payments" });
  }
});


// 1. Get stats for the dashboard tabs
// 1. Get stats for the dashboard including Revenue
router.get("/card-stats", auth, isAdmin, async (req, res) => {
  try {
    const printing = await User.countDocuments({ cardStatus: "Printing" });
    const shipped = await User.countDocuments({ cardStatus: "Shipped" });
    const delivered = await User.countDocuments({ cardStatus: "Delivered" });
    const pending = await User.countDocuments({ paymentStatus: "Pending Verification" });
    
    // Count all users who have successfully paid
    const approvedTotal = await User.countDocuments({ paymentStatus: "Verified" });
    const totalRevenue = approvedTotal * 750;

    res.json({ 
      printing, 
      shipped, 
      delivered, 
      pending, 
      approvedTotal, 
      totalRevenue 
    });
  } catch (err) { 
    res.status(500).json({ message: "Error fetching stats" }); 
  }
});

// 2. Comprehensive fetch for Logistics
router.get("/logistics/:status", auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({ cardStatus: req.params.status })
      .select("name rollNo phone shippingDetails cardStatus fcmToken");
    res.json(users);
  } catch (err) { res.status(500).send("Error"); }
});

// 3. Bulk Update with Dynamic Notifications
router.post("/bulk-update-status", auth, isAdmin, async (req, res) => {
  const { userIds, newStatus } = req.body;
  try {
    await User.updateMany({ _id: { $in: userIds } }, { $set: { cardStatus: newStatus } });

    // Send Notifications to all selected users
    const users = await User.find({ _id: { $in: userIds }, fcmToken: { $exists: true } });
    
    users.forEach(u => {
      let msg = "";
      if (newStatus === "Printing") msg = "Your physical TDC card is now in the printing press! 🖨️";
      if (newStatus === "Shipped") msg = "Great news! Your TDC card has been dispatched via courier. 🚚";
      if (newStatus === "Delivered") msg = "Your TDC Gold Card has been delivered. Welcome to the elite! 🏁";
      
      sendPushNotification(u.fcmToken, `Card Update: ${newStatus}`, msg);
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed" }); }
});
// @desc    Approve a manual payment
// POST /api/admin/approve-payment/:id
router.post("/approve-payment/:id", auth, isAdmin, async (req, res) => {
  try {
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    const user = await User.findByIdAndUpdate(req.params.id, {
      isVip: true,
      vipExpiry: expiryDate,
      paymentStatus: "Verified",
      cardStatus: "Printing", // Moves to printing phase
    }, { new: true });

    // Trigger Notification
    if (user.fcmToken) {
       sendPushNotification(user.fcmToken, "Gold Activated! ✨", "Welcome to the Gold Club. Your card is being printed.");
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Approval failed" });
  }
});

// @desc    Reject a payment
// @route   POST /api/admin/reject-payment/:id
router.post("/reject-payment/:id", auth, isAdmin, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, {
      paymentStatus: "Rejected",
      cardStatus: "None"
    });
    res.json({ success: true, message: "Payment rejected" });
  } catch (error) {
    res.status(500).json({ message: "Rejection failed" });
  }
});

// Get all bookings (admin only)
router.get("/bookings/all", auth, isAdmin, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .populate("packageId", "name location");
    res.json(bookings);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching bookings", error: error.message });
  }
});

// --- 3. NOTIFY ON BOOKING STATUS (The "Response" Step) ---
router.put("/bookings/:id", auth, isAdmin, async (req, res) => {
    try {
        const { status, adminNotes } = req.body;
        const booking = await Booking.findByIdAndUpdate(
            req.params.id,
            { status, adminNotes },
            { new: true }
        );

        if (!booking) return res.status(404).json({ message: "Booking not found" });

        // Build a friendly message based on status
        let statusMsg = `Your booking for ${booking.packageName} is now ${status.toUpperCase()}.`;
        if (status === 'confirmed') statusMsg = `Pack your bags! Your booking for ${booking.packageName} is CONFIRMED! ✅`;
        if (status === 'cancelled') statusMsg = `Note: Your booking for ${booking.packageName} was cancelled. ❌`;

        // PRIVATE NOTIFICATION to the specific user
        await Notification.create({
            recipient: booking.userId, // Send only to this user
            title: `Booking Update: ${status.toUpperCase()}`,
            description: statusMsg,
            type: "System",
            icon: status === 'confirmed' ? "checkmark-circle" : "information-circle",
            link: `/my-bookings/${booking._id}`
        });

        res.json({ success: true, message: "User notified of status change", booking });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get booking statistics (admin only)
router.get("/bookings/stats", auth, isAdmin, async (req, res) => {
  try {
    const totalBookings = await Booking.countDocuments();
    const pendingBookings = await Booking.countDocuments({ status: "pending" });
    const confirmedBookings = await Booking.countDocuments({
      status: "confirmed",
    });
    const totalRevenue = await Booking.aggregate([
      { $match: { status: { $in: ["confirmed", "completed"] } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);

    res.json({
      totalBookings,
      pendingBookings,
      confirmedBookings,
      totalRevenue: totalRevenue[0]?.total || 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching stats", error: error.message });
  }
});
// @desc    Delete a booking permanently
router.delete("/bookings/:id", auth, isAdmin, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Optional: Prevent deletion of confirmed/completed bookings to keep financial records
    // If you want to allow it anyway, just remove this if block
    if (booking.status === 'confirmed' || booking.status === 'completed') {
      return res.status(400).json({ 
        message: "Cannot delete a confirmed or completed booking. Please cancel it first if necessary." 
      });
    }

    await Booking.findByIdAndDelete(req.params.id);

    // Send a final notification to the user (Optional)
    try {
      await Notification.create({
        recipient: booking.userId,
        title: "Booking Removed",
        description: `Your booking for ${booking.packageName} has been Reject from the system by an administrator.`,
        type: "System",
        icon: "trash-outline"
      });
    } catch (nErr) {
      console.error("Silent notification failure during delete:", nErr);
    }

    res.json({ success: true, message: "Booking deleted successfully" });
  } catch (error) {
    res.status(500).json({ 
      message: "Error deleting booking", 
      error: error.message 
    });
  }
});





module.exports = router;
