// ==================== auth.routes.js (COMPLETE FIXED VERSION) ====================
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const { storage, uploadLogo, hasCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const User = require("../models/User");
const University = require("../models/University");
const Notification = require("../models/Notification");
const Application = require("../models/Application");
const path = require("path");
const mongoose = require("mongoose");
const Package = require("../models/Package");
const fs = require("fs");
const router = express.Router();

// ==========================================
// OTP STORE & EMAIL TRANSPORTER
// ==========================================
const otpStore = {};
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "abdulqadeerburiro110@gmail.com",
    pass: process.env.EMAIL_PASS || "lhefzozqsdmubawi",
  },
});

transporter.verify(function (error, success) {
  if (error) {
    console.log("❌ Email transporter error:", error.message);
  } else {
    console.log("✅ Email server is ready");
  }
});

// Helper function to cleanup uploaded files
const cleanupFile = async (file) => {
  if (!file) return;
  try {
    if (hasCloudinary && file.filename) {
      await deleteFromCloudinary(file.filename);
      console.log(`🗑️ Deleted Cloudinary file: ${file.filename}`);
    } else if (file.path) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Deleted local file: ${file.path}`);
      }
    }
  } catch (error) {
    console.error("Error cleaning up file:", error);
  }
};

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "abdulqadeer11111");
    req.userId = decoded.id;
    req.userRole = decoded.role;

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ==========================================
// SIGNUP ROUTE - FIXED
// ==========================================
router.post("/signup", async (req, res) => {
  try {
    const {
      role,
      email,
      password,
      fullName,
      brandName,
      rollNo,
      isAlumni,
      phone,
      universityName,
      address,
      instagram,
      referralCodeInput,
    } = req.body;

    // 1. Validate required fields
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 2. Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already used" });
    }

    // 3. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let universityId = null;
    let name = "";

    // 4. Role Logic
    if (role === "student") {
      if (!fullName || !universityName) {
        return res.status(400).json({ error: "Name and university required" });
      }
      name = fullName;
      let uni = await University.findOne({ name: universityName });
      if (!uni) uni = await University.create({ name: universityName });
      universityId = uni._id;
    } else if (role === "brand") {
      if (!brandName) {
        return res.status(400).json({ error: "Brand name required" });
      }
      name = brandName;
    } else if (role === "traveler") {
      if (!fullName) {
        return res.status(400).json({ error: "Full name required" });
      }
      name = fullName;
    } else if (role === "employee") {
      if (!fullName) {
        return res.status(400).json({ error: "Employee name required" });
      }
      name = fullName;
    } else if (role === "admin") {
      name = fullName || "Admin";
    }

    // 5. Handle Referrer lookup (One time only)
    let referrer = null;
    if (referralCodeInput) {
      referrer = await User.findOne({
        referralCode: referralCodeInput.toUpperCase(),
      });
    }

    // 6. Create the User
    const userData = {
      name,
      email,
      password: hashedPassword,
      role,
      isAlumni: !!isAlumni,
      rollNo,
      phone,
      university: universityId,
      address,
      instagram,
      status: role === "admin" ? "Verified" : "Not Verified",
      referredBy: referrer ? referrer._id : null,
    };

    // Add role-specific fields
    if (role === "brand") {
      userData.brandName = brandName;
      userData.companyName = brandName;
    } else if (role === "employee") {
      userData.companyName = fullName;
    }

    const user = await User.create(userData);

    // 7. Update referral count
    if (referrer) {
      const updatedReferrer = await User.findByIdAndUpdate(
        referrer._id,
        { $inc: { referralCount: 1 } },
        { new: true }
      );

      if (
        updatedReferrer.referralCount >= 10 &&
        !updatedReferrer.canApplyForTdcCard
      ) {
        updatedReferrer.canApplyForTdcCard = true;
        await updatedReferrer.save();
      }
    }

    // 8. Notification for student
    if (role === "student") {
      try {
        await Notification.create({
          recipient: user._id,
          title: "Welcome to the Crew! 🚀",
          description: `Hey ${name}! Your student account is ready. Explore exclusive deals.`,
          type: "System",
          icon: "party-popper",
          readBy: [],
        });

        transporter
          .sendMail({
            from: `"The Deft Crew" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Welcome to the Crew! 🚀",
            html: `<p>Welcome <b>${name}</b>! Your account is now active.</p>`,
          })
          .catch((err) => console.log("Mail Error:", err.message));
      } catch (nError) {
        console.error("Notification/Email Error:", nError.message);
      }
    }

    // Return success response without password
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({ 
      message: "Signup successful", 
      user: userResponse
    });

  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// LOGIN ROUTE
// ==========================================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate("university");

    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password);

    if (!match) return res.status(401).json({ message: "Invalid password" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || "abdulqadeer11111",
      { expiresIn: "180d" }
    );

    res.json({
      token,
      user,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GET PROFILE (ME) - UPDATED
// ==========================================
router.get("/profile/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select("-password")
      .populate("university");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = {
      ...user.toObject(),
      isVip: user.isVip || false,
      canApplyForTdcCard: user.canApplyForTdcCard || false,
      paymentStatus: user.paymentStatus || "None",
      cardStatus: user.cardStatus || "Inactive",
      vipExpiry: user.vipExpiry || null,
      referralCount: user.referralCount || 0,
      referralCode: user.referralCode || "GENERATING...",
    };

    res.json(userData);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ACTIVATE VIP - UPDATED
// ==========================================
router.post("/activate-vip/:userId", authMiddleware, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    console.log(`🔍 VIP Activation requested for user: ${userId}`);
    
    const requestingUser = await User.findById(req.userId);
    const targetUser = await User.findById(userId);
    
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    if (req.userId !== userId && requestingUser.role !== 'admin') {
      return res.status(403).json({ message: "Unauthorized" });
    }

    console.log(`📊 User ${targetUser.email} has ${targetUser.referralCount} referrals, isVip: ${targetUser.isVip}`);

    if (targetUser.referralCount >= 10) {
      targetUser.isVip = true;
      targetUser.canApplyForTdcCard = true;
      targetUser.paymentStatus = "Verified";
      targetUser.cardStatus = "Active";
      
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      targetUser.vipExpiry = expiryDate;
      
      await targetUser.save();

      console.log(`✅ VIP Activated successfully for ${targetUser.email}`);

      await Notification.create({
        recipient: targetUser._id,
        title: "🎉 TDC Privilege Card Activated!",
        description: `Your TDC Privilege Card is now active! Tap "View My TDC Card" to see your digital card.`,
        type: "System",
        icon: "card-account-details-star",
        readBy: [],
      });

      res.json({ 
        success: true, 
        message: "VIP activated successfully",
        user: {
          isVip: targetUser.isVip,
          canApplyForTdcCard: targetUser.canApplyForTdcCard,
          paymentStatus: targetUser.paymentStatus,
          vipExpiry: targetUser.vipExpiry,
          referralCount: targetUser.referralCount
        }
      });
    } else {
      console.log(`❌ User ${targetUser.email} only has ${targetUser.referralCount} referrals, needs 10`);
      res.status(400).json({ 
        message: `Need ${10 - targetUser.referralCount} more referrals to activate VIP`,
        referralCount: targetUser.referralCount,
        needed: 10 - targetUser.referralCount
      });
    }
  } catch (error) {
    console.error("VIP activation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CHECK VIP STATUS
// ==========================================
router.get("/check-vip-status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const canActivate = user.referralCount >= 10 && !user.isVip;
    
    res.json({
      referralCount: user.referralCount,
      isVip: user.isVip,
      canActivate: canActivate,
      canApplyForTdcCard: user.canApplyForTdcCard,
      paymentStatus: user.paymentStatus,
      vipExpiry: user.vipExpiry
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// FORGOT PASSWORD (SEND OTP)
// ==========================================
router.post("/forgot-password", async (req, res) => {
  const { emailOrPhone } = req.body;

  if (!emailOrPhone) {
    return res.status(400).json({ message: "Email or phone required" });
  }

  try {
    const user = await User.findOne({
      $or: [
        { email: emailOrPhone.toLowerCase().trim() },
        { phone: emailOrPhone.trim() }
      ],
    });

    if (!user) {
      return res.status(404).json({ message: "No account found with this email or phone" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    otpStore[user._id] = {
      otp,
      expires: Date.now() + 5 * 60 * 1000,
    };

    console.log(`🔑 OTP for ${user.email}: ${otp}`);

    try {
      await transporter.sendMail({
        from: `"The Deft Crew" <abdulqadeerburiro110@gmail.com>`,
        to: user.email,
        subject: "Password Reset OTP - The Deft Crew",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a1a1a;">Password Reset Request</h2>
            <p>Hello ${user.name || 'User'},</p>
            <p>Use the following OTP code:</p>
            <div style="background: #f9c349; padding: 20px; text-align: center; border-radius: 10px; margin: 20px 0;">
              <h1 style="color: #1a1a1a; font-size: 36px; letter-spacing: 5px; margin: 0;">${otp}</h1>
            </div>
            <p style="color: #666;">This OTP expires in <strong>5 minutes</strong>.</p>
          </div>
        `,
      });
      console.log(`✅ OTP email sent to ${user.email}`);
    } catch (mailError) {
      console.log("⚠️ Email failed but OTP generated:", otp);
    }

    return res.json({
      message: "OTP sent successfully to your email",
      userId: user._id,
    });

  } catch (err) {
    console.error("❌ Forgot password error:", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ==========================================
// VERIFY OTP
// ==========================================
router.post("/verify-otp", async (req, res) => {
  const { userId, otp } = req.body;

  if (!userId || !otp) {
    return res.status(400).json({ message: "User ID and OTP are required" });
  }

  const record = otpStore[userId];

  if (!record) return res.status(400).json({ message: "No OTP request found. Please request a new OTP." });
  if (record.expires < Date.now()) {
    delete otpStore[userId];
    return res.status(400).json({ message: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp.trim()) {
    return res.status(400).json({ message: "Invalid OTP. Please check and try again." });
  }

  const tempToken = jwt.sign(
    { id: userId, purpose: 'password-reset' },
    process.env.JWT_SECRET || "abdulqadeer11111",
    { expiresIn: "10m" }
  );

  delete otpStore[userId];

  res.json({ message: "OTP verified", resetToken: tempToken });
});

// ==========================================
// RESET PASSWORD
// ==========================================
router.post("/reset-password", async (req, res) => {
  const { resetToken, newPassword } = req.body;

  if (!resetToken || !newPassword) {
    return res.status(400).json({ message: "Token and new password required" });
  }

  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET || "abdulqadeer11111");
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    delete otpStore[decoded.id];

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(400).json({ message: "Session expired. Please request a new OTP." });
  }
});

// ==========================================
// ADMIN: APPROVE USER
// ==========================================
router.post("/approve-user/:id", authMiddleware, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: "Verified" },
      { new: true }
    );
    res.json({ message: "User Verified", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ADMIN: VERIFY USER
// ==========================================
router.patch("/verify-user/:targetUserId", authMiddleware, async (req, res) => {
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.targetUserId,
      { isVerified: true },
      { new: true }
    );

    await Notification.create({
      recipient: updatedUser._id,
      title: "Account Verified! ✅",
      description: "Welcome to the elite club! Your student status is verified. Enjoy premium discounts.",
      type: "System",
      icon: "sparkles",
    });

    res.json({ message: "User verified and notified." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// EXCHANGE APPLICATION
// ==========================================
router.post("/exchange/apply", authMiddleware, async (req, res) => {
  try {
    const { programId, formData, experiences } = req.body;

    const existingApp = await Application.findOne({
      programId,
      userId: req.userId,
    });

    if (existingApp) {
      return res
        .status(400)
        .json({ message: "You have already applied for this program." });
    }

    const newApp = new Application({
      programId,
      userId: req.userId,
      formData,
      experiences,
    });

    await newApp.save();

    await Notification.create({
      recipient: req.userId,
      title: "Application Received",
      description: "We've received your exchange application and are reviewing it!",
      type: "System",
      icon: "clipboard-check",
    });

    res.status(201).json({ success: true, message: "Application Submitted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PUBLIC PACKAGES
// ==========================================
router.get("/packages/public", async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json(packages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET USER BY ID
// ==========================================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid User ID format or route not found.",
      });
    }

    const user = await User.findById(id)
      .select("-password")
      .populate("university");

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DELETE ACCOUNT
// ==========================================
router.delete("/delete-account", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await Notification.deleteMany({ recipient: userId });
    await Application.deleteMany({ userId: userId });

    await User.updateMany(
      { connections: userId },
      { $pull: { connections: userId } }
    );

    await User.updateMany(
      { sentRequests: userId },
      { $pull: { sentRequests: userId } }
    );

    await User.updateMany(
      { referredBy: userId },
      { $unset: { referredBy: "" } }
    );

    await User.findByIdAndDelete(userId);

    if (otpStore[userId]) {
      delete otpStore[userId];
    }

    console.log(`✅ Account deleted: ${user.email} (${userId})`);

    res.status(200).json({ 
      message: "Account deleted successfully",
      success: true 
    });
  } catch (error) {
    console.error("❌ Delete account error:", error);
    res.status(500).json({ error: "Failed to delete account. Please try again." });
  }
});

// ==========================================
// UPDATE USER (Admin only)
// ==========================================
router.put("/update/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const requestingUser = await User.findById(req.userId);
    if (requestingUser.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }

    const allowedFields = [
      'name', 'email', 'phone', 'address', 'location', 
      'headline', 'bio', 'rollNo', 'instagram', 'skills',
      'status', 'isAlumni', 'isVip', 'vipExpiry',
      'cardStatus', 'paymentStatus'
    ];

    const updateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('university');

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ 
      success: true, 
      message: "User updated successfully", 
      user: updatedUser 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GET STUDENT WITH FULL DETAILS
// ==========================================
router.get("/student/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid User ID format" });
    }

    const user = await User.findById(id)
      .populate('university')
      .populate('referredBy', 'name email');

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const applications = await Application.find({ userId: id })
      .populate('programId');

    res.json({
      user,
      applications,
      referralCount: user.referralCount,
      referredBy: user.referredBy,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GET CURRENT USER (ME)
// ==========================================
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select("-password")
      .populate("university");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = {
      ...user.toObject(),
      logo: user.logo || "",
      companyName: user.companyName || user.brandName || "",
      brandName: user.brandName || "",
    };

    res.json(userData);
  } catch (err) {
    console.error("Error fetching user data:", err);
    res.status(500).json({ error: err.message });
  }
});
// ==========================================
// CHANGE PASSWORD ROUTE
// ==========================================
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: "Current password and new password are required" 
      });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: "New password must be at least 6 characters long" 
      });
    }
    
    // Find user
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }
    
    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: "Current password is incorrect" 
      });
    }
    
    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ 
        success: false, 
        message: "New password must be different from current password" 
      });
    }
    
    // Hash and update new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();
    
    // Send notification
    try {
      await Notification.create({
        recipient: user._id,
        title: "Password Changed 🔒",
        description: "Your password has been updated successfully. If you didn't make this change, please contact support immediately.",
        type: "Security",
        icon: "shield-lock",
        readBy: [],
      });
    } catch (notifError) {
      console.log("Notification error:", notifError.message);
    }
    
    // Send email notification
    try {
      await transporter.sendMail({
        from: `"The Deft Crew" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: "Password Changed Successfully - The Deft Crew",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a1a1a;">Password Changed 🔒</h2>
            <p>Hello ${user.name || 'User'},</p>
            <p>Your password was changed successfully on <strong>${new Date().toLocaleString()}</strong>.</p>
            <p style="color: #666; font-size: 14px;">If you did not make this change, please contact our support team immediately.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="color: #999; font-size: 12px;">The Deft Crew Security Team</p>
          </div>
        `,
      });
    } catch (mailError) {
      console.log("Email notification error:", mailError.message);
    }
    
    res.json({ 
      success: true, 
      message: "Password changed successfully" 
    });
    
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to change password. Please try again later." 
    });
  }
});
// ==========================================
// EXPORT
// ==========================================
module.exports = router;