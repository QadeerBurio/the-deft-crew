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
// OTP STORE & EMAIL TRANSPORTER - FIXED
// ==========================================
const otpStore = {};

// ✅ FIXED EMAIL TRANSPORTER WITH MULTIPLE OPTIONS
const createTransporter = () => {
  // Option 1: Gmail with App Password (Most Reliable for Railway)
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      // ✅ Critical: These settings help with Railway deployment
      tls: {
        rejectUnauthorized: false
      },
      pool: true,
      maxConnections: 1,
    });
  }

  // Option 2: SMTP with custom settings
  if (process.env.SMTP_HOST && process.env.SMTP_PORT) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  // Option 3: Ethereal Email (for testing only)
  return nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: {
      user: 'your-ethereal-email@ethereal.email',
      pass: 'your-ethereal-password'
    }
  });
};

const transporter = createTransporter();

// ✅ Test email connection on startup
const testEmailConnection = async () => {
  try {
    await transporter.verify();
    console.log("✅ Email transporter is ready");
  } catch (error) {
    console.log("⚠️ Email transporter not ready:", error.message);
    console.log("📧 OTP will still be generated and logged in console");
  }
};
testEmailConnection();

// ✅ FALLBACK: Store OTP in MongoDB with expiry
const OTPSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  otp: String,
  expires: Date,
  createdAt: { type: Date, default: Date.now }
});

// Check if model exists before creating
let OTPModel;
try {
  OTPModel = mongoose.model('OTP');
} catch {
  OTPModel = mongoose.model('OTP', OTPSchema);
}

// Helper function to save OTP to database
const saveOTP = async (userId, otp) => {
  try {
    // Delete old OTPs for this user
    await OTPModel.deleteMany({ userId });
    
    // Create new OTP
    const newOTP = new OTPModel({
      userId,
      otp,
      expires: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
    });
    await newOTP.save();
    
    // Also store in memory for faster access
    otpStore[userId] = {
      otp,
      expires: Date.now() + 5 * 60 * 1000,
      dbId: newOTP._id
    };
    
    return newOTP;
  } catch (error) {
    console.error("Failed to save OTP to DB:", error);
    // Fallback to memory only
    otpStore[userId] = {
      otp,
      expires: Date.now() + 5 * 60 * 1000
    };
    return null;
  }
};

// Helper function to get OTP
const getOTP = async (userId) => {
  try {
    // Check memory first
    if (otpStore[userId]) {
      return otpStore[userId];
    }
    
    // Check database
    const otpDoc = await OTPModel.findOne({ 
      userId, 
      expires: { $gt: new Date() } 
    });
    
    if (otpDoc) {
      return {
        otp: otpDoc.otp,
        expires: otpDoc.expires.getTime(),
        dbId: otpDoc._id
      };
    }
    
    return null;
  } catch (error) {
    console.error("Failed to get OTP from DB:", error);
    return otpStore[userId] || null;
  }
};

// Helper function to delete OTP
const deleteOTP = async (userId) => {
  try {
    await OTPModel.deleteMany({ userId });
    delete otpStore[userId];
  } catch (error) {
    console.error("Failed to delete OTP:", error);
    delete otpStore[userId];
  }
};

// Cleanup function
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
// SIGNUP ROUTE
// ==========================================
router.post("/signup", uploadLogo.single('logo'), async (req, res) => {
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
      if (req.file) {
        await cleanupFile(req.file);
      }
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 2. Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      if (req.file) {
        await cleanupFile(req.file);
      }
      return res.status(400).json({ error: "Email already used" });
    }

    // 3. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let universityId = null;
    let name = "";
    let logoUrl = "";
    let logoPublicId = "";

    // Handle logo upload
    if (req.file) {
      if (hasCloudinary) {
        logoUrl = req.file.path;
        logoPublicId = req.file.filename;
      } else {
        logoUrl = req.file.path.replace(/\\/g, '/');
      }
    }

    // 4. Role Logic
    if (role === "student") {
      if (!fullName || !universityName) {
        if (req.file) {
          await cleanupFile(req.file);
        }
        return res.status(400).json({ error: "Name and university required" });
      }
      name = fullName;
      let uni = await University.findOne({ name: universityName });
      if (!uni) uni = await University.create({ name: universityName });
      universityId = uni._id;
    } else if (role === "brand") {
      if (!brandName) {
        if (req.file) {
          await cleanupFile(req.file);
        }
        return res.status(400).json({ error: "Brand name required" });
      }
      name = brandName;
      if (!req.file) {
        return res.status(400).json({ error: "Brand logo is required" });
      }
    } else if (role === "traveler") {
      if (!fullName) {
        if (req.file) {
          await cleanupFile(req.file);
        }
        return res.status(400).json({ error: "Full name required" });
      }
      name = fullName;
    } else if (role === "employee") {
      if (!fullName) {
        if (req.file) {
          await cleanupFile(req.file);
        }
        return res.status(400).json({ error: "Employee name required" });
      }
      name = fullName;
      if (!req.file) {
        return res.status(400).json({ error: "Company logo is required" });
      }
    } else if (role === "admin") {
      name = fullName || "Admin";
    }

    // 5. Handle Referrer lookup
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

    if (logoUrl) {
      userData.logo = logoUrl;
      userData.logoPublicId = logoPublicId;
    }

    if (role === "brand") {
      userData.brandName = brandName;
      userData.companyName = brandName;
    } else if (role === "employee") {
      userData.companyName = fullName;
    }

    const user = await User.create(userData);

    // ============================================
    // 7. UPDATE REFERRER - AUTO ACTIVATE VIP
    // ============================================
    if (referrer) {
      const updatedReferrer = await User.findByIdAndUpdate(
        referrer._id,
        { $inc: { referralCount: 1 } },
        { new: true }
      );

      // Check if referrer has reached 10 referrals
      if (updatedReferrer.referralCount >= 10) {
        // Auto-activate VIP
        updatedReferrer.isVip = true;
        updatedReferrer.canApplyForTdcCard = true;
        updatedReferrer.paymentStatus = "Verified";
        updatedReferrer.cardStatus = "Active";
        
        // Set VIP expiry to 1 year from now
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);
        updatedReferrer.vipExpiry = expiryDate;
        
        await updatedReferrer.save();

        console.log(`✅ VIP Activated for user: ${updatedReferrer.email} (${updatedReferrer.referralCount} referrals)`);

        // Send notification about VIP activation
        try {
          await Notification.create({
            recipient: updatedReferrer._id,
            title: "🎉 TDC Privilege Card Activated!",
            description: `Congratulations! You've reached 10 referrals and your TDC Privilege Card is now active. Tap "View My TDC Card" to see your digital card.`,
            type: "System",
            icon: "card-account-details-star",
            readBy: [],
          });

          // Send email notification
          await transporter.sendMail({
            from: `"The Deft Crew" <${process.env.EMAIL_USER}>`,
            to: updatedReferrer.email,
            subject: "🎉 TDC Privilege Card Activated!",
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #f9c349;">🎉 TDC Privilege Card Activated!</h2>
                <p>Congratulations <b>${updatedReferrer.name}</b>!</p>
                <p>You've reached <b>10 referrals</b> and your TDC Privilege Card is now active.</p>
                <div style="background: #f9c349; padding: 20px; text-align: center; border-radius: 10px; margin: 20px 0;">
                  <h3 style="color: #1a1a1a;">✨ TDC PRIVILEGE CARD ✨</h3>
                  <p style="color: #1a1a1a;">Valid until: ${expiryDate.toLocaleDateString()}</p>
                </div>
                <p>Open the app and tap "View My TDC Card" to see your digital card.</p>
              </div>
            `,
          }).catch(err => console.log("Email Error:", err.message));
          
        } catch (nError) {
          console.error("Notification Error:", nError.message);
        }
      }
    }

    // 8. Notification for new user
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
      } catch (nError) {
        console.error("Notification Error:", nError.message);
      }
    }

    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({ 
      message: "Signup successful", 
      user: userResponse,
      logoUploaded: !!req.file 
    });

  } catch (err) {
    console.error("Signup Error:", err);
    if (req.file) {
      await cleanupFile(req.file);
    }
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

    // Ensure VIP fields are included
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
// ACTIVATE VIP - UPDATED WITH MORE LOGGING
// ==========================================
router.post("/activate-vip/:userId", authMiddleware, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    console.log(`🔍 VIP Activation requested for user: ${userId}`);
    
    // Check if the requesting user is the same as the target or is admin
    const requestingUser = await User.findById(req.userId);
    const targetUser = await User.findById(userId);
    
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Allow if user is activating their own VIP or is admin
    if (req.userId !== userId && requestingUser.role !== 'admin') {
      return res.status(403).json({ message: "Unauthorized" });
    }

    console.log(`📊 User ${targetUser.email} has ${targetUser.referralCount} referrals, isVip: ${targetUser.isVip}`);

    // Check if user has 10+ referrals
    if (targetUser.referralCount >= 10) {
      // Activate VIP
      targetUser.isVip = true;
      targetUser.canApplyForTdcCard = true;
      targetUser.paymentStatus = "Verified";
      targetUser.cardStatus = "Active";
      
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      targetUser.vipExpiry = expiryDate;
      
      await targetUser.save();

      console.log(`✅ VIP Activated successfully for ${targetUser.email}`);

      // Create notification
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
// FORGOT PASSWORD (SEND OTP) - FIXED
// ==========================================
router.post("/forgot-password", async (req, res) => {
  const { emailOrPhone } = req.body;

  if (!emailOrPhone) {
    return res.status(400).json({ message: "Email or phone required" });
  }

  try {
    // Find user by email or phone
    const user = await User.findOne({
      $or: [
        { email: emailOrPhone.toLowerCase().trim() },
        { phone: emailOrPhone.trim() }
      ],
    });

    if (!user) {
      return res.status(404).json({ message: "No account found with this email or phone" });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    console.log(`🔑 OTP for ${user.email}: ${otp}`);

    // Save OTP to database and memory
    await saveOTP(user._id, otp);

    // Try to send email - but don't fail if it doesn't work
    let emailSent = false;
    try {
      // ✅ FIXED: Use transporter with proper configuration
      const mailOptions = {
        from: process.env.EMAIL_USER || "abdulqadeerburiro110@gmail.com",
        to: user.email,
        subject: "🔐 Password Reset OTP - The Deft Crew",
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h1 style="color: #1a1a1a; margin: 0;">🔐 The Deft Crew</h1>
              <p style="color: #666; margin: 5px 0;">Password Reset</p>
            </div>
            <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; text-align: center;">
              <p style="color: #333; font-size: 16px;">Hello <strong>${user.name || 'User'}</strong>,</p>
              <p style="color: #666;">Use the following OTP code to reset your password:</p>
              <div style="background: #1a1a1a; padding: 20px; text-align: center; border-radius: 10px; margin: 20px 0;">
                <h1 style="color: #f9c349; font-size: 40px; letter-spacing: 8px; margin: 0; font-weight: 900;">${otp}</h1>
              </div>
              <p style="color: #666; font-size: 14px;">This OTP expires in <strong>5 minutes</strong>.</p>
              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
              <p style="color: #999; font-size: 12px;">If you didn't request this, please ignore this email.</p>
            </div>
          </div>
        `,
      };

      // Send email with timeout
      const sendMailWithTimeout = async (mailOptions, timeoutMs = 10000) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Email sending timeout'));
          }, timeoutMs);
          
          transporter.sendMail(mailOptions, (error, info) => {
            clearTimeout(timeout);
            if (error) {
              reject(error);
            } else {
              resolve(info);
            }
          });
        });
      };

      await sendMailWithTimeout(mailOptions, 15000);
      emailSent = true;
      console.log(`✅ OTP email sent to ${user.email}`);
    } catch (mailError) {
      console.log(`⚠️ Email failed but OTP is stored: ${mailError.message}`);
      emailSent = false;
    }

    // Return success regardless of email status
    return res.json({
      message: emailSent 
        ? "OTP sent successfully to your email" 
        : "OTP generated. Please check your email (may take a moment) or contact support.",
      userId: user._id,
      emailSent: emailSent,
      // In development, return OTP for testing
      ...(process.env.NODE_ENV === 'development' && { debugOtp: otp })
    });

  } catch (err) {
    console.error("❌ Forgot password error:", err);
    return res.status(500).json({ 
      message: "Server error. Please try again.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// ==========================================
// VERIFY OTP - FIXED
// ==========================================
router.post("/verify-otp", async (req, res) => {
  const { userId, otp } = req.body;

  if (!userId || !otp) {
    return res.status(400).json({ message: "User ID and OTP are required" });
  }

  try {
    const record = await getOTP(userId);

    if (!record) {
      return res.status(400).json({ 
        message: "No OTP request found. Please request a new OTP." 
      });
    }

    if (record.expires < Date.now()) {
      await deleteOTP(userId);
      return res.status(400).json({ 
        message: "OTP has expired. Please request a new one." 
      });
    }

    if (record.otp !== otp.trim()) {
      // Check if this is a development environment and OTP matches debug
      if (process.env.NODE_ENV === 'development' && otp.trim() === '123456') {
        // Allow 123456 as debug OTP in development
        console.log('🔓 Debug OTP accepted');
      } else {
        return res.status(400).json({ 
          message: "Invalid OTP. Please check and try again." 
        });
      }
    }

    // Generate reset token
    const tempToken = jwt.sign(
      { id: userId, purpose: 'password-reset' },
      process.env.JWT_SECRET || "abdulqadeer11111",
      { expiresIn: "10m" }
    );

    // Delete used OTP
    await deleteOTP(userId);

    res.json({ 
      message: "OTP verified successfully", 
      resetToken: tempToken 
    });

  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ 
      message: "Server error during verification. Please try again." 
    });
  }
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
    
    // Verify this is a password reset token
    if (decoded.purpose !== 'password-reset') {
      return res.status(400).json({ message: "Invalid token type" });
    }
    
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Update password
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Clean up any remaining OTP
    await deleteOTP(decoded.id);

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    console.error("Password reset error:", err);
    res.status(400).json({ 
      message: "Session expired. Please request a new OTP." 
    });
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

    await deleteOTP(userId);

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
// EXPORT
// ==========================================
module.exports = router;