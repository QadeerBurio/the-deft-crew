// models/User.js - Add status field if not present, and add brandApprovalStatus

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // --- BASIC INFORMATION ---
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    role: {
      type: String,
      enum: ["student", "brand", "admin", "traveler", "employee"],
      default: "student",
    },

    // --- BRAND APPROVAL STATUS (NEW) ---
    brandApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "draft"],
      default: "pending", // All new brands start as pending
    },
    brandApprovalNote: {
      type: String,
      default: "",
    },
    brandApprovedAt: {
      type: Date,
    },
    brandRejectedAt: {
      type: Date,
    },

    // --- VERIFICATION & STATUS ---
    isAlumni: { type: Boolean, default: false },
    isVip: { type: Boolean, default: false },
    vipExpiry: { type: Date },
    status: {
      type: String,
      enum: ["Not Verified", "Pending", "Verified"],
      default: "Not Verified",
    },

    // --- ACCOUNT STATUS (NEW) ---
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'banned', 'deactivated'],
      default: 'active'
    },
    suspensionReason: {
      type: String,
      default: ''
    },
    suspensionExpiry: {
      type: Date
    },
    isBlocked: {
      type: Boolean,
      default: false
    },

    // --- KYC / DOCUMENTATION ---
    profileImage: { type: String, default: "" },
    idCardFront: { type: String, default: "" },
    idCardBack: { type: String, default: "" },
    livePicture: { type: String, default: "" },

    // --- BRAND/EMPLOYEE LOGO ---
    logo: {
      type: String,
      default: "",
    },
    brandName: { type: String },
    companyName: { type: String },
    category: {
      type: String,
      default: "General",
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    isInStore: {
      type: Boolean,
      default: false,
    },

    websiteUrl: {
      type: String,
      default: "",
    },
    webhookSecret: {
      type: String,
      default: "",
    },
    wooConsumerKey: {
      type: String,
      default: "",
    },
    wooConsumerSecret: {
      type: String,
      default: "",
    },

    address: {
      type: String,
      default: "",
    },
    // --- STUDENT SPECIFICS ---
    rollNo: { type: String },
    phone: { type: String },
    university: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
    },
    instagram: { type: String },

    // --- REFERRAL SYSTEM ---
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    referralCount: {
      type: Number,
      default: 0,
    },
    canApplyForTdcCard: {
      type: Boolean,
      default: false,
    },

    // --- PHYSICAL TDC CARD LOGIC ---
    cardStatus: {
      type: String,
      enum: ["None", "Ordered", "Printing", "Shipped", "Delivered", "Active"],
      default: "None",
    },
    shippingDetails: {
      address: String,
      city: String,
      phone: String,
      zipCode: String,
    },

    // --- PAYMENT & BILLING ---
    paymentReceipt: { type: String, default: "" },
    paymentStatus: {
      type: String,
      enum: ["None", "Pending Verification", "Verified", "Rejected"],
      default: "None",
    },
    paymentId: { type: String },

    // --- SOCIAL & PROFESSIONAL ---
    avatar: { type: String },
    headline: { type: String, default: "" },
    bio: { type: String, default: "" },
    location: { type: String, default: "Karachi, Pakistan" },
    skills: [{ type: String }],
    education: [
      {
        school: String,
        degree: String,
        startYear: String,
        endYear: String,
      },
    ],
    enrolledCourses: [
      {
        courseId: { type: String, required: true },
        progress: { type: Number, default: 0 },
        currentModule: { type: String },
        enrolledAt: { type: Date, default: Date.now },
        lastAccessed: { type: Date },
        completed: { type: Boolean, default: false },
        completedLessons: [{ type: String }],
      },
    ],
    connections: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    receivedRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // --- BLOCKED USERS (NEW) ---
    blockedUsers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    // --- CAREER INTELLIGENCE ---
    savedJobs: [
      {
        jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
        savedAt: { type: Date, default: Date.now },
        tag: { type: String, default: "" },
      },
    ],
    careerProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Resume",
    },
    quickProfile: {
      topSkills: [{ type: String }],
      seniority: { type: String, default: "" },
      targetRole: { type: String, default: "" },
      lastSyncedAt: { type: Date },
    },

    // --- LIFETIME RESUME CREATION TRACKER ---
    resumeCreationCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

// --- INDEXES ---
userSchema.index({ role: 1, status: 1 });
userSchema.index({ university: 1, role: 1 });
userSchema.index({ brandApprovalStatus: 1, role: 1 }); // For filtering brands
userSchema.index({ accountStatus: 1 });
userSchema.index({ blockedUsers: 1 });

// --- PRE-SAVE HOOK: AUTOMATIC REFERRAL CODE GENERATION ---
userSchema.pre("save", async function () {
  if (this.role === "student" && !this.referralCode) {
    let isUnique = false;
    let newCode = "";
    let attempts = 0;
    const maxAttempts = 15;

    while (!isUnique && attempts < maxAttempts) {
      attempts++;
      newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const existing = await this.constructor.findOne({
        referralCode: newCode,
      });

      if (!existing) {
        isUnique = true;
      }
    }

    if (isUnique) {
      this.referralCode = newCode;
    } else {
      throw new Error("Failed to generate a unique referral code.");
    }
  }
});

module.exports = mongoose.model("User", userSchema);