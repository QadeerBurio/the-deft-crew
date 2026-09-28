const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { uploadOffer } = require("../config/cloudinary"); // Changed from storage to uploadOffer
const Slider = require("../models/Slider");
const Notification = require("../models/Notification");
const Job = require("../models/Job");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const Exchange = require("../models/Exchange");
const Application = require("../models/Application");
const Package = require("../models/Package");
const Booking = require("../models/Booking");
const Scholarships = require("../models/Scholarships");
const Course = require('../models/Course');
const XLSX = require('xlsx');

// Configure multer for memory storage bulk upload
const bulkUploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Configure multer for course image uploads using Cloudinary
const courseUpload = multer({ 
  storage: uploadOffer.storage, // Use the storage from uploadOffer
  limits: { fileSize: 5 * 1024 * 1024 },
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
// In admin.routes.js - Modify the GET users by role endpoint
router.get("/users/:role", auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    const validRoles = ["student", "brand", "employee", "traveler", "admin"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role specified" });
    }

    // For admin users, include password
    const users = await User.find({ role })
      .populate("university", "name")
      .populate("referredBy", "name email")
      .select("+password") // THIS IS KEY - include password field
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: err.message });
  }
});

// Also update the single user details endpoint
router.get("/users/details/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate("university", "name location")
      .populate("referredBy", "name email role")
      .select("+password"); // Include password

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (err) {
    console.error("Error fetching user details:", err);
    res.status(500).json({ error: err.message });
  }
});

// Add a dedicated endpoint to get user password
// In admin.routes.js - Update the password endpoint
router.get("/users/password/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("+password name email role");
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Return the hashed password (this is what's stored)
    res.json({ 
      success: true,
      password: user.password || 'No password set',
      name: user.name,
      email: user.email
    });
  } catch (err) {
    console.error("Error fetching password:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
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

// // ✅ Get single user details (with full profile)
// router.get("/users/details/:id", auth, isAdmin, async (req, res) => {
//   try {
//     const user = await User.findById(req.params.id)
//       .populate("university", "name location")
//       .populate("referredBy", "name email role")
//       .select("-password");

//     if (!user) {
//       return res.status(404).json({ message: "User not found" });
//     }

//     res.json(user);
//   } catch (err) {
//     console.error("Error fetching user details:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// ✅ Toggle User Verification (Approve/Revoke)
router.post("/approve-user/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.status = user.status === "Verified" ? "Not Verified" : "Verified";
    await user.save();

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

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User with this email already exists" });
    }

    const bcrypt = require("bcryptjs");
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role: role || "employee",
      phone: phone || "",
      address: address || "",
      company: company || "",
      designation: designation || "",
      status: "Verified",
    });

    await newUser.save();

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

// ==================== SLIDER & OFFER ROUTES ====================

// 1. CREATE: Add new Slider or Offer - FIXED with uploadOffer
router.post("/add", auth, isAdmin, uploadOffer.single("image"), async (req, res) => {
  try {
    console.log("=== ADMIN ADD ROUTE HIT ===");
    console.log("Request body:", req.body);
    console.log("Request file:", req.file);
    
    const { type, title, description, link } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ message: "Image is required" });
    }
    
    if (!type || !title) {
      return res.status(400).json({ message: "Type and title are required" });
    }

    // Get the image URL - Cloudinary returns the URL in req.file.path
    const imageUrl = req.file.path || req.file.secure_url || req.file.filename;
    console.log("Image URL:", imageUrl);

    const sliderData = {
      type: type || 'slider',
      title: title || 'Untitled',
      description: description || '',
      link: link || '',
      image: imageUrl, // Store the full URL
      active: true,
    };

    console.log("Creating slider with data:", sliderData);

    const newEntry = new Slider(sliderData);
    await newEntry.save();

    console.log("Slider created successfully:", newEntry);

    // Send notification for offers
    if (type === 'offer') {
      try {
        const notificationData = {
          recipient: null,
          title: "New Exclusive Offer! 🔥",
          description: `A new deal has been posted: ${newEntry.title}! Check it out now.`,
          type: "System",
          icon: "megaphone",
          link: newEntry._id.toString(),
        };
        
        const notification = await Notification.create(notificationData);
        console.log("Notification sent successfully:", notification);
      } catch (nError) {
        console.error("Notification failed:", nError);
      }
    }

    res.status(201).json({ 
      message: "Content published successfully!", 
      data: newEntry 
    });

  } catch (error) {
    console.error("=== ERROR IN ADMIN ADD ROUTE ===");
    console.error("Error:", error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ 
        message: "Validation failed", 
        errors: errors 
      });
    }
    
    res.status(500).json({ 
      message: "Server error occurred", 
      error: error.message 
    });
  }
});

// READ: Get all items
router.get("/all", async (req, res) => {
  try {
    const { type } = req.query;
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

// 3. UPDATE: Toggle Active Status
router.patch("/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const item = await Slider.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }
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
    const deleted = await Slider.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Item not found" });
    }
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EXCHANGE PROGRAM ROUTES ====================

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
      newProgram.scholarship = newScholarship._id;
      await newProgram.save();
    }

    try {
      if (req.user?._id) {
        await Notification.create({
          recipient: req.user._id,
          title: `🌍 New Exchange Program: ${title}`,
          description: `${university} is now accepting applications! Deadline: ${new Date(deadline).toLocaleDateString()}`,
          type: "Exchange",
          icon: "globe",
          link: newProgram._id.toString()
        });
      }
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

// ==================== BULK IMPORT EXCHANGE / SCHOLARSHIP PROGRAMS ====================
router.post("/exchange/bulk-import", auth, isAdmin, bulkUploadMulter.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: "No file uploaded. Please attach a .csv or .xlsx file." });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "Uploaded file has no sheets." });
    }

    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ success: false, message: "Uploaded file has no data rows." });
    }

    const getVal = (row, ...keys) => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
          return String(row[k]).trim();
        }
        const lowerKey = k.toLowerCase();
        for (const rowKey of Object.keys(row)) {
          if (rowKey.toLowerCase() === lowerKey && row[rowKey] !== undefined && row[rowKey] !== null && String(row[rowKey]).trim() !== '') {
            return String(row[rowKey]).trim();
          }
        }
      }
      return '';
    };

    const detectDegree = (val) => {
      if (!val) return 'Bachelors';
      const str = String(val).toLowerCase().trim();
      if (str.includes('phd') || str.includes('doctor')) return 'PhD';
      if (str.includes('master') || str.includes('msc') || str.includes('ma')) return 'Masters';
      if (str.includes('bachelor') || str.includes('bsc') || str.includes('ba')) return 'Bachelors';
      if (str.includes('exchange')) return 'Exchange';
      return 'Bachelors';
    };

    const parseReqs = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val.map(s => String(s).trim()).filter(Boolean);
      return String(val).split(/;|\n|,/).map(s => s.trim()).filter(Boolean);
    };

    const formatDate = (val) => {
      if (!val) return '';
      try {
        const date = new Date(val);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0];
        }
        return String(val);
      } catch {
        return String(val);
      }
    };

    const todayStr = new Date().toISOString().split('T')[0];
    let createdCount = 0;
    let skippedCount = 0;
    const skippedRows = [];

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];

      const title = getVal(row, 'Program Title', 'Title', 'title', 'name', 'Program');
      const university = getVal(row, 'University', 'Institution', 'university', 'school');

      // Only skip if title or university is completely missing
      if (!title || !university) {
        skippedCount++;
        skippedRows.push({
          row: i + 1,
          title: title || 'N/A',
          university: university || 'N/A',
          reason: 'Missing mandatory field: Program Title or University is required'
        });
        continue;
      }

      // Duplicate check: Exchange.findOne({ title, university })
      const existing = await Exchange.findOne({
        title: { $regex: new RegExp(`^${title.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') },
        university: { $regex: new RegExp(`^${university.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') }
      });

      if (existing) {
        skippedCount++;
        skippedRows.push({
          row: i + 1,
          title,
          university,
          reason: 'Duplicate program already exists'
        });
        continue;
      }

      // Fallback defaults
      const location = getVal(row, 'Location', 'City/Country', 'location', 'city', 'country') || 'Worldwide';
      const degree = detectDegree(getVal(row, 'Degree', 'Program Type', 'degree'));

      const rawAppStart = getVal(row, 'Application Start', 'Start Date', 'appStart', 'start_date');
      const appStart = rawAppStart ? formatDate(rawAppStart) : todayStr;

      const rawDeadline = getVal(row, 'Application Deadline', 'Deadline', 'deadline', 'end_date');
      const deadline = rawDeadline ? formatDate(rawDeadline) : 'TBA';

      const duration = getVal(row, 'Duration', 'Program Length', 'duration') || '1 Year';
      const link = getVal(row, 'Application URL', 'Link', 'URL', 'link', 'url');
      const requirements = parseReqs(getVal(row, 'Requirements', 'Prerequisites', 'requirements'));

      const newProgram = new Exchange({
        title,
        university,
        location,
        degree,
        appStart,
        deadline,
        duration,
        link,
        requirements,
        active: true
      });

      await newProgram.save();

      // Linked scholarship document
      const scholarshipName = getVal(row, 'Scholarship Name', 'Scholarship', 'scholarshipName', 'scholarship_name');
      if (scholarshipName) {
        const amount = getVal(row, 'Scholarship Amount', 'Amount', 'scholarshipAmount', 'amount');
        const currency = getVal(row, 'Currency', 'currency') || 'USD';
        const description = getVal(row, 'Scholarship Description', 'Description', 'scholarshipDescription', 'description');
        const rawScholarshipDeadline = getVal(row, 'Scholarship Deadline', 'scholarshipDeadline');
        const scholarshipDeadlineStr = rawScholarshipDeadline ? formatDate(rawScholarshipDeadline) : (deadline !== 'TBA' ? deadline : '');

        let parsedScholarshipDeadline = undefined;
        if (scholarshipDeadlineStr) {
          const parsed = new Date(scholarshipDeadlineStr);
          if (!isNaN(parsed.getTime())) {
            parsedScholarshipDeadline = parsed;
          }
        }

        const scholarshipReqs = parseReqs(getVal(row, 'Scholarship Requirements', 'scholarshipRequirements'));

        const newScholarship = new Scholarships({
          programId: newProgram._id,
          name: scholarshipName,
          amount,
          currency,
          description,
          deadline: parsedScholarshipDeadline,
          requirements: scholarshipReqs,
          active: true
        });

        await newScholarship.save();
        newProgram.scholarship = newScholarship._id;
        await newProgram.save();
      }

      createdCount++;
    }

    return res.json({
      success: true,
      created: createdCount,
      skipped: skippedCount,
      totalRows: rawRows.length,
      skippedRows
    });
  } catch (err) {
    console.error("Error in exchange bulk-import:", err);
    return res.status(500).json({ success: false, error: "Bulk import failed: " + err.message });
  }
});

router.get("/exchange/all", async (req, res) => {
  try {
    const programs = await Exchange.find({ active: true })
      .sort({ createdAt: -1 })
      .populate('scholarship');
    res.json(programs || []);
  } catch (err) {
    console.error("Error fetching programs:", err);
    res.status(500).json({ error: "Server Error: " + err.message });
  }
});

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

    if (scholarship && scholarship.name) {
      let existingScholarship = await Scholarships.findOne({ programId: program._id });
      
      if (existingScholarship) {
        existingScholarship.name = scholarship.name;
        existingScholarship.amount = scholarship.amount || '';
        existingScholarship.currency = scholarship.currency || 'USD';
        existingScholarship.description = scholarship.description || '';
        existingScholarship.deadline = scholarship.deadline || program.deadline;
        existingScholarship.requirements = scholarship.requirements || [];
        await existingScholarship.save();
      } else {
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

router.patch("/exchange/toggle/:id", auth, isAdmin, async (req, res) => {
  try {
    const program = await Exchange.findById(req.params.id);
    if (!program) {
      return res.status(404).json({ message: "Program not found" });
    }

    program.active = !program.active;
    await program.save();

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

router.delete("/exchange/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    const program = await Exchange.findById(req.params.id);
    if (!program) {
      return res.status(404).json({ message: "Program not found" });
    }

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

// ==================== PACKAGE ROUTES ====================

router.post(
  "/packages/create",
  auth,
  isAdmin,
  uploadOffer.single("image"),
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

      if (!req.file) {
        return res.status(400).json({ message: "Package image is required." });
      }

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
        image: req.file.path,
      });

      await newPackage.save();
      res.status(201).json({ success: true, message: "Package published!" });
    } catch (error) {
      console.error("Error creating package:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

router.get("/packages/all", auth, isAdmin, async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/packages/delete/:id", auth, isAdmin, async (req, res) => {
  try {
    const deletedPackage = await Package.findByIdAndDelete(req.params.id);
    if (!deletedPackage) {
      return res.status(404).json({ message: "Package not found" });
    }
    res.json({ success: true, message: "Package deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put(
  "/packages/update/:id",
  auth,
  isAdmin,
  uploadOffer.single("image"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      try {
        if (updateData.requirements)
          updateData.requirements = JSON.parse(updateData.requirements);
        if (updateData.inclusions)
          updateData.inclusions = JSON.parse(updateData.inclusions);
      } catch (e) {
        return res.status(400).json({
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

      if (!updatedPackage) {
        return res.status(404).json({ message: "Package not found" });
      }

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

// ==================== CARD MANAGEMENT ROUTES ====================

router.get("/pending-cards", auth, isAdmin, async (req, res) => {
  try {
    const pendingUsers = await User.find({
      isVip: true,
      cardStatus: { $in: ["Ordered", "Printing"] },
    }).select("name rollNo phone email shippingDetails cardStatus createdAt");

    res.json(pendingUsers);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

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

router.get("/card-stats", auth, isAdmin, async (req, res) => {
  try {
    const printing = await User.countDocuments({ cardStatus: "Printing" });
    const shipped = await User.countDocuments({ cardStatus: "Shipped" });
    const delivered = await User.countDocuments({ cardStatus: "Delivered" });
    const pending = await User.countDocuments({ paymentStatus: "Pending Verification" });
    const approvedTotal = await User.countDocuments({ paymentStatus: "Verified" });
    const totalRevenue = approvedTotal * 750;

    res.json({ printing, shipped, delivered, pending, approvedTotal, totalRevenue });
  } catch (err) { 
    res.status(500).json({ message: "Error fetching stats" }); 
  }
});

router.get("/logistics/:status", auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({ cardStatus: req.params.status })
      .select("name rollNo phone shippingDetails cardStatus fcmToken");
    res.json(users);
  } catch (err) { 
    res.status(500).send("Error"); 
  }
});

router.post("/bulk-update-status", auth, isAdmin, async (req, res) => {
  const { userIds, newStatus } = req.body;
  try {
    await User.updateMany({ _id: { $in: userIds } }, { $set: { cardStatus: newStatus } });

    const users = await User.find({ _id: { $in: userIds }, fcmToken: { $exists: true } });
    
    users.forEach(u => {
      let msg = "";
      if (newStatus === "Printing") msg = "Your physical TDC card is now in the printing press! 🖨️";
      if (newStatus === "Shipped") msg = "Great news! Your TDC card has been dispatched via courier. 🚚";
      if (newStatus === "Delivered") msg = "Your TDC Gold Card has been delivered. Welcome to the elite! 🏁";
      
      // sendPushNotification(u.fcmToken, `Card Update: ${newStatus}`, msg);
    });

    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ message: "Failed" }); 
  }
});

router.post("/approve-payment/:id", auth, isAdmin, async (req, res) => {
  try {
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    const user = await User.findByIdAndUpdate(req.params.id, {
      isVip: true,
      vipExpiry: expiryDate,
      paymentStatus: "Verified",
      cardStatus: "Printing",
    }, { new: true });

    if (user.fcmToken) {
      // sendPushNotification(user.fcmToken, "Gold Activated! ✨", "Welcome to the Gold Club. Your card is being printed.");
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Approval failed" });
  }
});

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

// ==================== BOOKING ROUTES ====================

router.get("/bookings/all", auth, isAdmin, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .populate("packageId", "name location");
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: "Error fetching bookings", error: error.message });
  }
});

router.put("/bookings/:id", auth, isAdmin, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status, adminNotes },
      { new: true }
    );

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    let statusMsg = `Your booking for ${booking.packageName} is now ${status.toUpperCase()}.`;
    if (status === 'confirmed') statusMsg = `Pack your bags! Your booking for ${booking.packageName} is CONFIRMED! ✅`;
    if (status === 'cancelled') statusMsg = `Note: Your booking for ${booking.packageName} was cancelled. ❌`;

    await Notification.create({
      recipient: booking.userId,
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

router.get("/bookings/stats", auth, isAdmin, async (req, res) => {
  try {
    const totalBookings = await Booking.countDocuments();
    const pendingBookings = await Booking.countDocuments({ status: "pending" });
    const confirmedBookings = await Booking.countDocuments({ status: "confirmed" });
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
    res.status(500).json({ message: "Error fetching stats", error: error.message });
  }
});

router.delete("/bookings/:id", auth, isAdmin, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.status === 'confirmed' || booking.status === 'completed') {
      return res.status(400).json({ 
        message: "Cannot delete a confirmed or completed booking. Please cancel it first if necessary." 
      });
    }

    await Booking.findByIdAndDelete(req.params.id);

    try {
      await Notification.create({
        recipient: booking.userId,
        title: "Booking Removed",
        description: `Your booking for ${booking.packageName} has been removed from the system by an administrator.`,
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

// ==================== JOB ROUTES ====================

router.get("/jobs/all", auth, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== VERIFICATION ROUTES ====================

router.patch("/verify-user/:targetUserId", auth, isAdmin, async (req, res) => {
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.targetUserId,
      { isVerified: true },
      { new: true },
    );

    await Notification.create({
      recipient: updatedUser._id,
      title: "Account Verified! ✅",
      description: "Your student status is verified. You can now claim premium discounts!",
      type: "System",
      icon: "sparkles",
    });

    res.json({ message: "User verified and notified." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN — BROADCAST APP UPDATE
// ═══════════════════════════════════════════════════════════
router.post('/broadcast/app-update', auth, isAdmin, async (req, res) => {
  try {
    const { title, body, version, forceUpdate = false } = req.body;

    const pushGateway = require('../services/engagement/pushGateway');

    const result = await pushGateway.broadcastToAll({
      copyKey: 'app_update',
      title: title || 'tdc just got better',
      body: body || 'new features live. update now.',
      mood: 'sorted',
      data: {
        route: 'Home',
        params: { version, forceUpdate },
        screen: 'AppUpdate',
        version,
      },
    });

    console.log('[broadcast] app-update:', result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[broadcast/app-update]', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;