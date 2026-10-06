// ==================== auth.routes.js (COMPLETE FIXED VERSION) ====================
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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
const EngagementEvent = require("../models/EngagementEvent");
// ==========================================
// EMAIL + OTP
// Email goes over HTTPS (Resend/Brevo) because Railway blocks SMTP.
// OTPs are stored hashed in MongoDB (models/OtpCode.js), not in memory.
// ==========================================
const crypto = require("crypto");
const { sendMail, logMailerStatus } = require("../utils/mailer");
const OtpCode = require("../models/OtpCode");

logMailerStatus();

const OTP_TTL_MS = 10 * 60 * 1000;   // code valid for 10 minutes
const OTP_RESEND_MS = 60 * 1000;     // 1 new code per minute
const OTP_MAX_ATTEMPTS = 5;          // wrong tries before code is burned

const hashOtp = (otp) =>
  crypto
    .createHash("sha256")
    .update(`${otp}:${process.env.JWT_SECRET || "abdulqadeer11111"}`)
    .digest("hex");

const otpEmailHtml = (name, otp) => `
  <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #1a1a1a;">Password reset code</h2>
    <p>Hi ${name || "there"},</p>
    <p>Use this code to reset your tdc password:</p>
    <div style="background: #f9c349; padding: 20px; text-align: center; border-radius: 10px; margin: 20px 0;">
      <h1 style="color: #1a1a1a; font-size: 36px; letter-spacing: 6px; margin: 0;">${otp}</h1>
    </div>
    <p>It expires in <strong>10 minutes</strong>.</p>
    <p>If you didn't ask for this, ignore this email. Your password stays the same.</p>
    <p>The Deft Crew</p>
  </div>`;

const signupOtpEmailHtml = (name, otp) => `
  <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #1a1a1a;">Verify your email</h2>
    <p>Hi ${name || "there"},</p>
    <p>Welcome to tdc. Enter this code in the app to finish creating your account:</p>
    <div style="background: #f9c349; padding: 20px; text-align: center; border-radius: 10px; margin: 20px 0;">
      <h1 style="color: #1a1a1a; font-size: 36px; letter-spacing: 6px; margin: 0;">${otp}</h1>
    </div>
    <p>It expires in <strong>10 minutes</strong>.</p>
    <p>If you didn't sign up for tdc, ignore this email.</p>
    <p>The Deft Crew</p>
  </div>`;

const maskEmail = (email = "") => {
  const [local = "", domain = ""] = String(email).split("@");
  return `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
};

const issueToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET || "abdulqadeer11111",
    { expiresIn: "180d" }
  );

// Creates + emails a signup code. Respects the 1-per-minute limit.
// Returns { sent, retryAfter?, error? }
async function sendSignupOtp(user, { force = false } = {}) {
  const last = await OtpCode.findOne({ user: user._id, purpose: "signup" })
    .sort({ createdAt: -1 })
    .lean();
  if (!force && last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_MS) {
    const retryAfter = Math.ceil((OTP_RESEND_MS - (Date.now() - new Date(last.createdAt).getTime())) / 1000);
    return { sent: false, retryAfter };
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  await OtpCode.deleteMany({ user: user._id, purpose: "signup" });
  const record = await OtpCode.create({
    user: user._id,
    purpose: "signup",
    codeHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  if (process.env.NODE_ENV !== "production") {
    console.log(`🔑 [dev] signup OTP for ${user.email}: ${otp}`);
  }

  try {
    await sendMail({
      to: user.email,
      subject: "Your tdc verification code",
      html: signupOtpEmailHtml(user.name, otp),
    });
    return { sent: true };
  } catch (e) {
    await OtpCode.deleteOne({ _id: record._id });
    return { sent: false, error: "mail_failed" };
  }
}

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
// After signup is confirmed: referral points, welcome notification + email.
// Students: runs after the email code is verified. Others: right away.
// ==========================================
async function completeSignup(user, referrer) {
  const name = user.name;
  const email = user.email;
  const role = user.role;

    // ═════════════════════════════════════════════════════════════
    // 7. REFERRAL PIPELINE — only when there's a referrer
    // ═════════════════════════════════════════════════════════════
    // ═════════════════════════════════════════════════════════════
// 7. REFERRAL PIPELINE — only when there's a referrer
// ═════════════════════════════════════════════════════════════
if (referrer) {
  // 7a. Increment RAW signup count
  const updatedReferrer = await User.findByIdAndUpdate(
    referrer._id,
    { $inc: { referralCount: 1 } },
    { new: true }
  );

  // 7b. Auto-unlock TDC card at 10 raw signups
  if (
    updatedReferrer.referralCount >= 10 &&
    !updatedReferrer.canApplyForTdcCard
  ) {
    updatedReferrer.canApplyForTdcCard = true;
    await updatedReferrer.save();
  }

  // ═══════════════════════════════════════════════════════════
  // 7c. AWARD +50 (signup bonus) + +100 (immediate verification)
  //     BOTH on signup — total +150 to referrer
  //     AND +100 welcome to referee (new user)
  // ═══════════════════════════════════════════════════════════
  try {
    const points = require("../services/engagement/points");

    // ── +50 to REFERRER (invite bonus) ──
    const signupKey = `referral_signup_bonus:${user._id}`;
    try {
      await EngagementEvent.create({
        user: referrer._id,
        name: 'referral_signup_bonus',
        feature: null,
        dayKey: new Date().toISOString().split('T')[0],
        meta: { refereeId: String(user._id) },
        source: 'system',
        dedupeKey: signupKey,
      });
    } catch (e) {
      // ignore duplicate event
    }

    const signupAward = await points.award(
      String(referrer._id),
      50,
      'referral:signup_bonus',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(user._id),
        idemKey: signupKey,
      }
    );
    console.log('[signup] referrer +50:', signupAward);

    // ── +100 to REFERRER (verified referral, immediate) ──
    const verifiedKey = `referral:verified:referrer:${referrer._id}:${user._id}`;
    const verifiedAward = await points.award(
      String(referrer._id),
      100,
      'referral:verified',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(user._id),
        idemKey: verifiedKey,
      }
    );
    console.log('[signup] referrer +100:', verifiedAward);

    // ── +100 to REFEREE (welcome bonus for new user) ──
    const welcomeKey = `referral:welcome:${user._id}`;
    const welcomeAward = await points.award(
      String(user._id),
      100,
      'referral:welcome',
      {
        actorRole: 'referral',
        refType: 'referral',
        refId: String(referrer._id),
        idemKey: welcomeKey,
      }
    );
    console.log('[signup] referee +100:', welcomeAward);

    // ── Update verifiedReferralCount on referrer's profile ──
    try {
      const EngagementProfile = require("../models/EngagementProfile");
      const User2 = require("../models/User");
      const referees = await User2.find({ referredBy: referrer._id })
        .select('_id')
        .lean();
      const refereeIds = referees.map((r) => r._id);

      // For immediate-credit model, all referees count as verified
      const verifiedCount = refereeIds.length;

      await EngagementProfile.findOneAndUpdate(
        { user: referrer._id },
        { $set: { verifiedReferralCount: verifiedCount } },
        { upsert: true }
      );
    } catch (e) {
      console.error('[signup] verifiedReferralCount sync failed:', e.message);
    }

    // ── Popup for referrer ──
    try {
      const popups = require("../services/engagement/popups");
      await popups.enqueue(String(referrer._id), {
        kind: 'referral_credited',
        mood: 'hype',
        line: `${user.name || 'someone'} just joined with your code! +150 pts.`,
        cta: { label: 'view crew', route: 'Points', params: {} },
        payload: { refereeId: String(user._id), amount: 150 },
        priority: 30,
      });
    } catch (e) {
      console.error('[signup] popup enqueue failed:', e.message);
    }

    // ── Re-evaluate referrer level + badges ──
    try {
      const { evaluateLevelsNow, evaluateBadgesNow } = require("../services/engagement/engine");
      await evaluateLevelsNow(String(referrer._id));
      setImmediate(() => evaluateBadgesNow(String(referrer._id)).catch(() => {}));
    } catch (e) {
      console.error('[signup] eval failed:', e.message);
    }
  } catch (e) {
    console.error("[signup] referral awards FAILED:", e.message);
    console.error(e.stack);
  }

  // 7d. Live badge eval — AFTER canApplyForTdcCard is updated
  try {
    const { evaluateBadgesNow } = require("../services/engagement/engine");
    const result = await evaluateBadgesNow(referrer._id);
    if (result?.granted?.length) {
      console.log(
        `[signup] granted badges to referrer ${referrer._id}:`,
        result.granted
      );
    }
  } catch (e) {
    console.error("[signup] referrer badge eval failed:", e.message);
  }
}
// ═════════════════════════════════════════════════════════════
// END referral pipeline
// ═════════════════════════════════════════════════════════════
    // ═════════════════════════════════════════════════════════════
    // END referral pipeline
    // ═════════════════════════════════════════════════════════════

    // 8. Welcome notification for new student (OUTSIDE the if-referrer block)
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

        sendMail({
          to: email,
          subject: "Welcome to the Crew! 🚀",
          html: `<p>Welcome <b>${name}</b>! Your account is now active.</p>`,
        }).catch((err) => console.log("Mail Error:", err.message));
      } catch (nError) {
        console.error("Notification/Email Error:", nError.message);
      }
    }

}

// ==========================================
// SIGNUP ROUTE - FIXED
// ==========================================
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
      city,
      gender,            // ← ADD
  academicLevel,     // ← ADD
    } = req.body;

    // 1. Validate required fields
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 2. Check if user already exists
    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      // Signed up before but never entered the code: start over cleanly
      if (existingUser.role === "student" && existingUser.emailVerified === false) {
        await OtpCode.deleteMany({ user: existingUser._id }).catch(() => {});
        await User.deleteOne({ _id: existingUser._id });
      } else {
        return res.status(400).json({ error: "Email already used" });
      }
    }

    // 3. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let universityId = null;
    let name = "";

    // 4. Role logic
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
      email: normalizedEmail,
      password: hashedPassword,
      role,
      isAlumni: !!isAlumni,
      rollNo,
      phone,
      university: universityId,
      address,
      instagram,
      status: role === "admin" ? "Verified" : "Not Verified",
      ...(role === "student" ? { emailVerified: false } : {}),
      city: city?.trim() || "Karachi",
      referredBy: referrer ? referrer._id : null,
       gender: gender || "",                 // ← ADD
  academicLevel: academicLevel || "",   // ← ADD
    };

    if (role === "brand") {
      userData.brandName = brandName;
      userData.companyName = brandName;
    } else if (role === "employee") {
      userData.companyName = fullName;
    }

    const user = await User.create(userData);

    // 🎯 Ensure the new user has an engagement profile from day one
    try {
      const { ensureProfile } = require("../services/engagement");
      await ensureProfile(user._id);
    } catch (e) {
      console.error("[engagement] ensureProfile on signup failed:", e.message);
    }

    // 7-8. Students: verify email first. Referral points and the welcome
    //      message only happen after the code is entered (no fake signups).
    if (role === "student") {
      const otp = await sendSignupOtp(user, { force: true });
      return res.status(201).json({
        message: otp.sent
          ? `We sent a 6-digit code to ${maskEmail(user.email)}`
          : "Account created. Tap resend to get your code.",
        requiresVerification: true,
        userId: user._id,
        email: maskEmail(user.email),
        emailSent: !!otp.sent,
        expiresIn: OTP_TTL_MS / 1000,
      });
    }

    await completeSignup(user, referrer);

    // 9. Return success response without password
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message: "Signup successful",
      user: userResponse,
    });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SIGNUP: VERIFY EMAIL CODE → account active + logged in
// ==========================================
router.post("/signup/verify-otp", async (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const otp = String(req.body?.otp || "").replace(/\D/g, "");

  if (!userId || !otp) {
    return res.status(400).json({ message: "User ID and code are required" });
  }
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid request. Please sign up again." });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Account not found. Please sign up again." });

    if (user.emailVerified !== false) {
      // Already verified (double tap / old account): just log in
      const populated = await User.findById(user._id).select("-password").populate("university");
      return res.json({ message: "Email already verified", token: issueToken(user), user: populated });
    }

    const record = await OtpCode.findOne({ user: user._id, purpose: "signup" }).sort({ createdAt: -1 });
    if (!record) {
      return res.status(400).json({ message: "No code found. Tap resend to get a new one." });
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await OtpCode.deleteMany({ user: user._id, purpose: "signup" });
      return res.status(400).json({ message: "Code expired. Tap resend to get a new one." });
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await OtpCode.deleteMany({ user: user._id, purpose: "signup" });
      return res.status(429).json({ message: "Too many wrong tries. Tap resend to get a new code." });
    }

    const ok =
      record.codeHash.length === hashOtp(otp).length &&
      crypto.timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(hashOtp(otp)));

    if (!ok) {
      record.attempts += 1;
      await record.save();
      const left = OTP_MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({
        message: left > 0 ? `Wrong code. ${left} tries left.` : "Too many wrong tries. Tap resend to get a new code.",
      });
    }

    await OtpCode.deleteMany({ user: user._id, purpose: "signup" });
    user.emailVerified = true;
    await user.save();

    // Referral points + welcome notification/email now that the email is real
    try {
      const referrer = user.referredBy ? await User.findById(user.referredBy) : null;
      await completeSignup(user, referrer);
    } catch (e) {
      console.error("[signup] completeSignup failed:", e.message);
    }

    const populated = await User.findById(user._id).select("-password").populate("university");
    return res.json({ message: "Email verified", token: issueToken(user), user: populated });
  } catch (err) {
    console.error("❌ Signup verify error:", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ==========================================
// SIGNUP: RESEND CODE
// ==========================================
router.post("/signup/resend-otp", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();

    let user = null;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) user = await User.findById(userId);
    else if (email) user = await User.findOne({ email });

    if (!user) return res.status(404).json({ message: "Account not found. Please sign up again." });
    if (user.emailVerified !== false) {
      return res.status(400).json({ message: "Email already verified. Please log in." });
    }

    const r = await sendSignupOtp(user);
    if (r.retryAfter) {
      return res.status(429).json({
        message: `Please wait ${r.retryAfter}s before requesting a new code.`,
        retryAfter: r.retryAfter,
      });
    }
    if (!r.sent) {
      return res.status(503).json({ message: "We couldn't send the email right now. Please try again in a minute." });
    }
    return res.json({ message: `New code sent to ${maskEmail(user.email)}`, email: maskEmail(user.email) });
  } catch (err) {
    console.error("❌ Signup resend error:", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ==========================================
// LOGIN ROUTE
// ==========================================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: String(email || "").trim().toLowerCase() }).populate("university");

    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password);

    if (!match) return res.status(401).json({ message: "Invalid password" });

    // Signed up but never entered the email code: send one and ask for it
    if (user.role === "student" && user.emailVerified === false) {
      const r = await sendSignupOtp(user);
      return res.status(403).json({
        message: "Please verify your email first. We sent you a code.",
        needsVerification: true,
        userId: user._id,
        email: maskEmail(user.email),
        retryAfter: r.retryAfter || 0,
      });
    }

    const token = issueToken(user);

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
  const emailOrPhone = String(req.body?.emailOrPhone || "").trim();

  if (!emailOrPhone) {
    return res.status(400).json({ message: "Email or phone required" });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }],
    }).select("_id name email");

    if (!user) {
      return res.status(404).json({ message: "No account found with this email or phone" });
    }
    if (!user.email) {
      return res.status(400).json({ message: "This account has no email. Contact support." });
    }

    // 1 code per minute
    const last = await OtpCode.findOne({ user: user._id, purpose: "password-reset" })
      .sort({ createdAt: -1 })
      .lean();
    if (last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - new Date(last.createdAt).getTime())) / 1000);
      return res.status(429).json({
        message: `Please wait ${wait}s before requesting a new code.`,
        userId: user._id,
        retryAfter: wait,
      });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();

    // Only the newest code is valid
    await OtpCode.deleteMany({ user: user._id, purpose: "password-reset" });
    const record = await OtpCode.create({
      user: user._id,
      purpose: "password-reset",
      codeHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });

    if (process.env.NODE_ENV !== "production") {
      console.log(`🔑 [dev] OTP for ${user.email}: ${otp}`);
    }

    try {
      await sendMail({
        to: user.email,
        subject: "Your tdc password reset code",
        html: otpEmailHtml(user.name, otp),
      });
    } catch (mailError) {
      await OtpCode.deleteOne({ _id: record._id });
      return res.status(503).json({
        message: "We couldn't send the email right now. Please try again in a minute.",
      });
    }

    // Masked email so the user knows where to look
    const [local, domain] = user.email.split("@");
    const masked = `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;

    return res.json({
      message: `Code sent to ${masked}`,
      userId: user._id,
      email: masked,
      expiresIn: OTP_TTL_MS / 1000,
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
  const userId = String(req.body?.userId || "").trim();
  const otp = String(req.body?.otp || "").replace(/\D/g, "");

  if (!userId || !otp) {
    return res.status(400).json({ message: "User ID and OTP are required" });
  }
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid request. Please request a new code." });
  }

  try {
    const record = await OtpCode.findOne({ user: userId, purpose: "password-reset" }).sort({ createdAt: -1 });

    if (!record) {
      return res.status(400).json({ message: "No code found. Please request a new one." });
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await OtpCode.deleteMany({ user: userId, purpose: "password-reset" });
      return res.status(400).json({ message: "Code expired. Please request a new one." });
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await OtpCode.deleteMany({ user: userId, purpose: "password-reset" });
      return res.status(429).json({ message: "Too many wrong tries. Please request a new code." });
    }

    const ok =
      record.codeHash.length === hashOtp(otp).length &&
      crypto.timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(hashOtp(otp)));

    if (!ok) {
      record.attempts += 1;
      await record.save();
      const left = OTP_MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({
        message: left > 0 ? `Wrong code. ${left} tries left.` : "Too many wrong tries. Please request a new code.",
      });
    }

    await OtpCode.deleteMany({ user: userId, purpose: "password-reset" });

    const resetToken = jwt.sign(
      { id: userId, purpose: "password-reset" },
      process.env.JWT_SECRET || "abdulqadeer11111",
      { expiresIn: "15m" }
    );

    return res.json({ message: "OTP verified", resetToken });
  } catch (err) {
    console.error("❌ Verify OTP error:", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ==========================================
// RESET PASSWORD
// ==========================================
router.post("/reset-password", async (req, res) => {
  const { resetToken, newPassword } = req.body || {};

  if (!resetToken || !newPassword) {
    return res.status(400).json({ message: "Token and new password required" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  let decoded;
  try {
    decoded = jwt.verify(resetToken, process.env.JWT_SECRET || "abdulqadeer11111");
  } catch (err) {
    return res.status(400).json({ message: "Session expired. Please request a new code." });
  }
  if (decoded.purpose !== "password-reset") {
    return res.status(400).json({ message: "Invalid reset session." });
  }

  try {
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(String(newPassword), 10);
    await user.save();

    await OtpCode.deleteMany({ user: user._id });

    sendMail({
      to: user.email,
      subject: "Your tdc password was changed",
      html: `<p>Hi ${user.name || "there"},</p><p>Your password was just reset. If this wasn't you, contact support right away.</p><p>The Deft Crew</p>`,
    }).catch(() => {});

    return res.json({ message: "Password reset successfully" });
  } catch (err) {
    console.error("❌ Reset password error:", err);
    return res.status(500).json({ message: "Server error. Please try again." });
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
try {
  const { track } = require('../services/engagement');
  await track(req.userId, 'scholarship_applied', {
    meta: { programId, applicationId: newApp._id.toString() },
    dedupeKey: `scholarship_apply:${req.userId}:${programId}`,
  });
} catch (e) {
  console.error('[engagement] scholarship_applied hook failed:', e.message);
}
    res.status(201).json({ success: true, message: "Application Submitted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SCHOLARSHIP — TRACK EXTERNAL APPLY (awards scholarship_applied points)
// Called when user taps "Apply Now" on a program and opens the university website.
// Idempotent: same user + same program = only one award ever.
// ==========================================
router.post("/exchange/track-external", authMiddleware, async (req, res) => {
  try {
    const { programId } = req.body;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!programId) {
      return res.status(400).json({ error: "programId is required" });
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(programId)) {
      return res.status(400).json({ error: "Invalid programId" });
    }

    // 🎯 Fire scholarship_applied with a stable dedupe key.
    //    Same dedupeKey as /exchange/apply so a user can't double-earn
    //    by both internally applying AND opening the external link.
    let engagement = null;
    try {
      const { track } = require("../services/engagement");
      engagement = await track(String(userId), "scholarship_applied", {
        meta: { programId: String(programId), viaExternal: true },
        dedupeKey: `scholarship_apply:${userId}:${programId}`,
      });
    } catch (e) {
      console.error("[engagement] external scholarship_applied failed:", e.message);
    }

    return res.json({
      success: true,
      message: "Scholarship link opened — points awarded",
      engagement: engagement || undefined,
    });
  } catch (err) {
    console.error("Track external scholarship error:", err);
    res.status(500).json({
      error: "Failed to track external scholarship",
      details: err.message,
    });
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

    await OtpCode.deleteMany({ user: userId }).catch(() => {});

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
      await sendMail({
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
// ADMIN LOGIN AS BRAND (Auto-Login)
// ==========================================
router.post("/admin-login-as-brand", authMiddleware, async (req, res) => {
  try {
    const { brandId } = req.body;
    
    // Verify the requesting user is an admin
    const adminUser = await User.findById(req.userId);
    if (adminUser.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: "Only admins can login as brands" 
      });
    }
    
    // Find the brand
    const brand = await User.findOne({ 
      _id: brandId, 
      role: 'brand' 
    }).select('+password');
    
    if (!brand) {
      return res.status(404).json({ 
        success: false, 
        message: "Brand not found" 
      });
    }
    
    // Check if brand is approved
    if (brand.brandApprovalStatus !== 'approved') {
      return res.status(400).json({ 
        success: false, 
        message: "Brand is not approved yet" 
      });
    }
    
    // Generate token for the brand
    const token = jwt.sign(
      { id: brand._id, role: brand.role },
      process.env.JWT_SECRET || "abdulqadeer11111",
      { expiresIn: "7d" }
    );
    
    // Remove password from response
    const brandResponse = brand.toObject();
    delete brandResponse.password;
    
    // Log the activity (optional)
    console.log(`✅ Admin ${adminUser.email} logged in as brand ${brand.brandName || brand.name}`);
    
    // Create notification for the brand (optional)
    try {
      await Notification.create({
        recipient: brand._id,
        title: "Admin Login 👤",
        description: `An administrator has logged into your brand dashboard. This is for administrative purposes.`,
        type: "Security",
        icon: "shield-lock",
        readBy: [],
      });
    } catch (notifError) {
      console.log("Notification error:", notifError.message);
    }
    
    res.json({
      success: true,
      message: "Logged in as brand successfully",
      token,
      user: brandResponse
    });
    
  } catch (error) {
    console.error("Admin login as brand error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to login as brand" 
    });
  }
});
// ==========================================
// EXPORT
// ==========================================
module.exports = router;