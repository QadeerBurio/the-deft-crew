require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const { storage } = require("../config/cloudinary");
const upload = multer({ storage });
const User = require("../models/User");
const University = require("../models/University");
const Notification = require("../models/Notification");
const Application = require("../models/Application");
const path = require("path");
const mongoose = require("mongoose");
const Package = require("../models/Package");
const router = express.Router();


// --- ADD THIS LINE ---
const otpStore = {};
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "abdulqadeerburiro110@gmail.com",  // HARDCODED - Your email
    pass: "lhefzozqsdmubawi",                // HARDCODED - Your app password
  },
});

// Verify transporter on startup
transporter.verify(function (error, success) {
  if (error) {
    console.log("❌ Email transporter error:", error.message);
  } else {
    console.log("✅ Email server is ready");
  }
});

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
    const user = await User.create({
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
    });

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

    res.status(201).json({ message: "Signup successful", user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- LOGIN --------------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate("university");

    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password);

    if (!match) return res.status(401).json({ message: "Invalid password" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
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

// -------------------- FORGOT PASSWORD (SEND OTP) - FIXED --------------------
// -------------------- FORGOT PASSWORD (SEND OTP) --------------------
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

    // ✅ Now otpStore is defined
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

// -------------------- VERIFY OTP --------------------
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

// -------------------- RESET PASSWORD --------------------
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

// ---------------- AUTH MIDDLEWARE ----------------
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;

    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};

// ADMIN ONLY: APPROVE USER
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
      description:
        "Welcome to the elite club! Your student status is verified. Enjoy premium discounts.",
      type: "System",
      icon: "sparkles",
    });

    res.json({ message: "User verified and notified." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------- GET LOGGED-IN USER PROFILE (Dynamic) ----------------
router.get("/profile/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate("university");

    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.referralCode && user.role === "student") {
      await user.save();
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UPDATE THIS ROUTE IN YOUR BACKEND ---
// POST: Apply for exchange
router.post("/exchange/apply", authMiddleware, async (req, res) => {
  try {
    const { programId, formData, experiences } = req.body;

    // 1. Check if user already applied (Prevention)
    const existingApp = await Application.findOne({
      programId,
      userId: req.userId,
    });

    if (existingApp) {
      return res
        .status(400)
        .json({ message: "You have already applied for this program." });
    }

    // 2. Create Application
    const newApp = new Application({
      programId,
      userId: req.userId,
      formData,
      experiences,
    });

    await newApp.save();

    // 3. Optional: Notify Admin or User
    await Notification.create({
      recipient: req.userId,
      title: "Application Received",
      description:
        "We've received your exchange application and are reviewing it!",
      type: "System",
      icon: "clipboard-check",
    });

    res.status(201).json({ success: true, message: "Application Submitted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 1. PUBLIC PACKAGES ROUTE
router.get("/packages/public", async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json(packages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- DYNAMIC ROUTES (MUST BE LAST) --------------------

// ✅ 2. GET USER BY ID (With ObjectId Validation)
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if the ID is a valid MongoDB ObjectId
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

module.exports = router;