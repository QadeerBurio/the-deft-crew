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

// --- USER MANAGEMENT ROUTES ---

// Get users by role (Used by AdminUserList.js)
router.get("/users/:role", auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    const users = await User.find({ role })
      .populate("university", "name")
      .select("-password");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Verification (Approve/Revoke)
router.post("/approve-user/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.status = user.status === "Verified" ? "Not Verified" : "Verified";
    await user.save();
    res.json({ message: "Status Updated", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. CREATE: Add new Slider or Offer
router.post("/add", upload.single("image"), async (req, res) => {
  try {
    const { type, title, description, link } = req.body;
    if (!req.file)
      return res.status(400).json({ message: "Image is required" });

    const newEntry = new Slider({
      type, // 'slider' or 'offer'
      title,
      description,
      link,
      // image: `/uploads/${req.file.filename}`,
      image: req.file.path,
      active: true,
    });

    await newEntry.save();

    res.status(201).json({ message: "Content published!", data: newEntry });
    // BROADCAST NOTIFICATION - Fixed variable names
    // BROADCAST NOTIFICATION
    try {
      await Notification.create({
        recipient: null, // Public broadcast
        title: "New Exclusive Offer! 🔥",
        description: `A new deal has been posted: ${newEntry.title}! Check it out now.`,
        type: "Offers",
        icon: "megaphone",
        link: newEntry._id.toString(),
      });
    } catch (nError) {
      console.error("Notification failed to send:", nError);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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
router.patch("/toggle/:id", async (req, res) => {
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
router.delete("/delete/:id", async (req, res) => {
  try {
    await Slider.findByIdAndDelete(req.params.id);
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// GET users by role (student or brand)
// Get users by role (student/brand)
router.get("/users/:role", auth, async (req, res) => {
  try {
    const users = await User.find({ role: req.params.role })
      .populate("university", "name")
      .select("-password");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Verification
router.post("/approve-user/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    user.status = user.status === "Verified" ? "Not Verified" : "Verified";
    await user.save();
    res.json({ message: "Status Updated", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/verify-user/:targetUserId", auth, async (req, res) => {
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

// Create a new Job
router.post("/jobs/add", auth, isAdmin, async (req, res) => {
  try {
    const newJob = new Job(req.body);
    await newJob.save();
    res.status(201).json({ message: "Job posted successfully", data: newJob });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get all jobs (Admin view)
router.get("/jobs/all", auth, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get only active jobs for the mobile app
router.get("/jobs/public", async (req, res) => {
  try {
    const jobs = await Job.find({ active: true }).sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN MANAGEMENT ---
// Toggle job status (Active/Inactive)
router.patch("/jobs/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    job.active = !job.active;
    await job.save();
    res.json({ message: "Status updated", active: job.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/jobs/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    await Job.findByIdAndDelete(req.params.id);
    res.json({ message: "Job deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/// @route   POST /admin/exchange/add
// @desc    Create a new program & notify students
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
    } = req.body;

    if (
      !title ||
      !university ||
      !location ||
      !appStart ||
      !deadline ||
      !duration
    ) {
      return res
        .status(400)
        .json({ message: "All required fields must be filled." });
    }

    const newProgram = new Exchange({
      title,
      university,
      location,
      degree,
      appStart,
      deadline,
      duration,
      link,
      requirements: requirements || [], // <--- Save the requirements array
      active: true,
    });

    await newProgram.save();

    // Notification logic...
    res
      .status(201)
      .json({ message: "Program published successfully!", data: newProgram });
  } catch (err) {
    res.status(500).json({ error: "Server Error: " + err.message });
  }
});

// @route   GET /admin/exchange/all
// @desc    Get all programs for admin management
// Example: Get all exchange programs
router.get("/exchange/all", async (req, res) => {
  try {
    const programs = await Exchange.find().sort({ createdAt: -1 });
    res.json(programs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// / @route    PUT /api/admin/exchange/update/:id
// @desc     Update an existing program (Complete Data Update)
router.put("/exchange/update/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    const updatedProgram = await Exchange.findByIdAndUpdate(
      id,
      { $set: updatedData },
      { new: true, runValidators: true },
    );

    if (!updatedProgram) {
      return res.status(404).json({ message: "Program not found" });
    }

    res.json({ message: "Program updated successfully", data: updatedProgram });
  } catch (err) {
    res.status(500).json({ error: "Update failed: " + err.message });
  }
});

// @route   PATCH /admin/exchange/toggle/:id
// @desc    Show/Hide a program from the public
router.patch("/exchange/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const program = await Exchange.findById(req.params.id);
    if (!program) return res.status(404).json({ message: "Program not found" });

    program.active = !program.active;
    await program.save();

    res.json({
      message: `Program is now ${program.active ? "Visible" : "Hidden"}`,
      active: program.active,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// @route   DELETE /admin/exchange/delete/:id
// @desc    Permanently remove a program
router.delete("/exchange/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    const deletedProgram = await Exchange.findByIdAndDelete(req.params.id);
    if (!deletedProgram)
      return res.status(404).json({ message: "Program already deleted." });

    res.json({ message: "Program permanently removed." });
  } catch (err) {
    res.status(500).json({ error: "Delete operation failed." });
  }
});

// / routes/admin.js (Add these endpoints
router.post("/exchange/apply", async (req, res) => {
  try {
    const newApp = new Application({
      programId: req.body.programId,
      userId: req.user.id, // From your auth middleware
      formData: req.body.formData,
      experiences: req.body.experiences,
    });
    await newApp.save();
    res.status(201).json({ message: "Application Submitted" });
  } catch (err) {
    res.status(500).json(err);
  }
});

// Get applications for a specific program (Admin only)
router.get("/exchange/applications/:programId", async (req, res) => {
  try {
    const apps = await Application.find({
      programId: req.params.programId,
    }).populate("userId", "name email");
    res.json(apps);
  } catch (err) {
    res.status(500).json(err);
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
// @desc    Bulk update card status (e.g., Change 100 users to 'Shipped')
// @route   POST /api/admin/bulk-update-status
// backend/routes/admin.js

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
// @route   POST /api/admin/approve-payment/:id
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
// @route   DELETE /api/admin/bookings/:id
// @access  Private/Admin
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



// ==================== COURSE MANAGEMENT ROUTES ====================

// GET ALL COURSES (For Admin)
router.get('/courses', auth, isAdmin, async (req, res) => {
  try {
    const courses = await Course.find().sort({ createdAt: -1 });
    res.json(courses);
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ message: 'Failed to fetch courses', error: error.message });
  }
});

// GET SINGLE COURSE (For Admin)
router.get('/courses/:id', auth, isAdmin, async (req, res) => {
  try {
    const course = await Course.findOne({ id: req.params.id });
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }
    res.json(course);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE COURSE
router.post('/courses/create', auth, isAdmin, courseUpload.single('courseImage'), async (req, res) => {
  try {
    const { 
      id, title, category, provider, description, level, 
      duration, color, courseUrl, instructorName, instructorRole, 
      instructorBio, skills 
    } = req.body;

    const existingCourse = await Course.findOne({ id });
    if (existingCourse) {
      return res.status(400).json({ message: 'Course ID already exists. Please use a unique ID.' });
    }

    if (!id || !title || !description || !duration) {
      return res.status(400).json({ message: 'Please provide all required fields: id, title, description, duration' });
    }

    let imagePath = '';
    if (req.file) {
      imagePath = req.file.path; // Cloudinary URL
    } else {
      imagePath = 'https://via.placeholder.com/800x450?text=Course+Image';
    }

    const skillsArray = skills ? skills.split(',').map(s => s.trim()).filter(s => s) : [];

    const newCourse = new Course({
      id,
      title,
      category,
      provider: provider || 'TechDegree Club',
      instructor: {
        name: instructorName || 'TechDegree Team',
        role: instructorRole || 'Instructor',
        bio: instructorBio || ''
      },
      level,
      duration,
      image: imagePath,
      color: color || '#3b82f6',
      skills: skillsArray,
      description,
      courseUrl: courseUrl || '',
      modules: [],
      isActive: true
    });

    await newCourse.save();

    res.status(201).json({ 
      success: true, 
      message: 'Course created successfully', 
      data: newCourse 
    });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create course', 
      error: error.message 
    });
  }
});

// UPDATE COURSE
router.put('/courses/:id', auth, isAdmin, courseUpload.single('courseImage'), async (req, res) => {
  try {
    const courseId = req.params.id;
    
    const existingCourse = await Course.findOne({ id: courseId });
    if (!existingCourse) {
      return res.status(404).json({ message: 'Course not found' });
    }

    const updateData = {
      title: req.body.title,
      category: req.body.category,
      provider: req.body.provider,
      level: req.body.level,
      duration: req.body.duration,
      color: req.body.color,
      description: req.body.description,
      courseUrl: req.body.courseUrl,
      updatedAt: Date.now()
    };

    if (req.body.instructorName || req.body.instructorRole || req.body.instructorBio) {
      updateData.instructor = {
        name: req.body.instructorName || existingCourse.instructor?.name,
        role: req.body.instructorRole || existingCourse.instructor?.role,
        bio: req.body.instructorBio || existingCourse.instructor?.bio
      };
    }

    if (req.body.skills) {
      updateData.skills = req.body.skills.split(',').map(s => s.trim()).filter(s => s);
    }

    if (req.file) {
      // Delete old image from Cloudinary if it's not a placeholder
      if (existingCourse.image && !existingCourse.image.includes('placeholder')) {
        const publicId = existingCourse.image.split('/').slice(-2).join('/').split('.')[0];
        await cloudinary.uploader.destroy(publicId);
      }
      updateData.image = req.file.path; // Cloudinary URL
    }

    const updatedCourse = await Course.findOneAndUpdate(
      { id: courseId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    res.json({ 
      success: true, 
      message: 'Course updated successfully', 
      data: updatedCourse 
    });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update course', 
      error: error.message 
    });
  }
});

// DELETE COURSE
router.delete('/courses/:id', auth, isAdmin, async (req, res) => {
  try {
    const courseId = req.params.id;
    
    const course = await Course.findOne({ id: courseId });
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    // Delete image from Cloudinary if it's not a placeholder
    if (course.image && !course.image.includes('placeholder')) {
      const publicId = course.image.split('/').slice(-2).join('/').split('.')[0];
      await cloudinary.uploader.destroy(publicId);
    }

    await Course.findOneAndDelete({ id: courseId });

    res.json({ 
      success: true, 
      message: 'Course deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete course', 
      error: error.message 
    });
  }
});

// TOGGLE COURSE ACTIVE STATUS
router.patch('/courses/:id/toggle', auth, isAdmin, async (req, res) => {
  try {
    const course = await Course.findOne({ id: req.params.id });
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    course.isActive = !course.isActive;
    await course.save();

    res.json({ 
      success: true, 
      message: `Course ${course.isActive ? 'activated' : 'deactivated'} successfully`,
      isActive: course.isActive 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// ==================== GET COURSE ENROLLMENTS ====================
router.get('/courses/:courseId/enrollments', auth, isAdmin, async (req, res) => {
  try {
    const { courseId } = req.params;
    
    // Find all users enrolled in this course
    const users = await User.find({
      'enrolledCourses.courseId': courseId
    }).select('name email enrolledCourses');
    
    // Extract enrollment data for this specific course
    const enrollments = users.map(user => {
      const enrollment = user.enrolledCourses.find(e => e.courseId === courseId);
      return {
        userId: user._id,
        userName: user.name,
        userEmail: user.email,
        progress: enrollment?.progress || 0,
        currentModule: enrollment?.currentModule,
        completed: enrollment?.completed || false,
        enrolledAt: enrollment?.enrolledAt,
        completedLessons: enrollment?.completedLessons || [],
        lastAccessed: enrollment?.lastAccessed
      };
    });
    
    res.json({
      success: true,
      count: enrollments.length,
      enrollments
    });
  } catch (error) {
    console.error('Error fetching enrollments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch enrollments', 
      error: error.message 
    });
  }
});

// ==================== SEND RESPONSE TO STUDENT ====================
router.post('/courses/:courseId/respond/:userId', auth, isAdmin, async (req, res) => {
  try {
    const { courseId, userId } = req.params;
    const { message, courseTitle } = req.body;

    if (!message) {
      return res.status(400).json({ message: 'Response message is required' });
    }

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Create notification for the user
    await Notification.create({
      recipient: userId,
      title: `Response from Admin: ${courseTitle || 'Course Update'}`,
      description: message,
      type: "Course",
      icon: "message-circle",
      link: `/courses/${courseId}`
    });

    // Optional: Send push notification if FCM token exists
    if (user.fcmToken) {
      // You can implement push notification here
      console.log(`Push notification would be sent to ${user.fcmToken}`);
    }

    res.json({ 
      success: true, 
      message: 'Response sent successfully to student' 
    });
  } catch (error) {
    console.error('Error sending response:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send response', 
      error: error.message 
    });
  }
});


module.exports = router;
