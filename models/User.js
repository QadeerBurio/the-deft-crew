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
    // Email OTP check at signup. false = signed up but code not entered yet.
    // Missing (old accounts) is treated as verified.
    emailVerified: { type: Boolean },
    password: {
      type: String,
      required: [true, "Password is required"],
      select: false, // hidden by default; .select("+password") where needed (login, change-password)
    },
    role: {
      type: String,
      enum: ["student", "brand", "admin", "traveler", "employee"],
      default: "student",
    },
    // Phase A: what an admin account may do (services/adminAccess.js). Missing = every admin today (all permissions
    // except team.manage). Only on role "admin"; set by a super admin on the team page.
    adminAccess: {
      type: new mongoose.Schema({
        level: { type: String, enum: ["super", "member"] },
        roleTemplate: { type: String, maxlength: 60 },
        permissions: { type: [String], default: undefined },
        status: { type: String, enum: ["active", "suspended"], default: "active" },
        invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        invitedAt: { type: Date },
        lastActiveAt: { type: Date },
        note: { type: String, maxlength: 120 },
        suspendedReason: { type: String, maxlength: 300 },
        removedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
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

    // --- CONFESSION SAFETY (plan P4-1 / P4-1b, flag confessionSafety). All optional. ---
    // the confession rules were accepted (the app shows them once before the first post)
    confessionRulesAcceptedAt: { type: Date },
    // no confessions or confession comments until then (strikes, repeated blocked attempts)
    confessionBanUntil: { type: Date },
    // strikes in the last 90 days count; internal only
    confessionStrikes: {
      type: [{ at: Date, reason: String, ref: String, _id: false }],
      select: false,
      default: undefined,
    },
    // posts / comments blocked by the pre-post check (warning only; 3 in 24 h = a 24 h ban + a strike)
    confessionBlocks: { type: [Date], select: false, default: undefined },
    // authors this student muted ("don't show me posts from this person"); never sent to the app
    mutedConfessionAuthors: { type: [mongoose.Schema.Types.ObjectId], select: false, default: undefined },
    // reports rejected as false (3 in 30 days = no reporting for 30 days)
    falseReportMarks: { type: [Date], select: false, default: undefined },
    reportingBlockedUntil: { type: Date },
    isBlocked: {
      type: Boolean,
      default: false
    },

    // --- KYC / DOCUMENTATION ---
    profileImage: { type: String, default: "" },
    idCardFront: { type: String, default: "", select: false },
    idCardBack: { type: String, default: "", select: false },
    livePicture: { type: String, default: "", select: false },

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

    // the brand's connected online store: "none" until a connection works (BrandStoreConnection for
    // WooCommerce, ShopifyStore for Shopify); set by those flows and scripts/migrate-store-platform.js
    platform: {
      type: String,
      enum: ["none", "woocommerce", "shopify", "custom"],
      default: "none",
    },
    websiteUrl: {
      type: String,
      default: "",
    },
    webhookSecret: {
      type: String,
      default: "",
      select: false,
    },
    wooConsumerKey: {
      type: String,
      default: "",
      select: false,
    },
    wooConsumerSecret: {
      type: String,
      default: "",
      select: false,
    },
    shopifyStoreUrl: {
      type: String,
      default: "",
    },
    shopifyAccessToken: {
      type: String,
      default: "",
      select: false,
    },
    shopifyClientId: {
      type: String,
      default: "",
      select: false,
    },
    shopifyClientSecret: {
      type: String,
      default: "",
      select: false,
    },
    shopifyTokenExpiresAt: {
      type: Date,
    },
    shopifyWebhookSecret: {
      type: String,
      default: "",
      select: false,
    },

    address: {
      type: String,
      default: "",
    },
    // ✅ ADD THIS BLOCK
city: {
  type: String,
  default: "Karachi",
  trim: true,
},
    // --- STUDENT SPECIFICS ---
    rollNo: { type: String },
    phone: { type: String },
    university: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
    },
    // the university's name as shown (the shared list's, models/University.js); set with `university`
    universityName: { type: String, default: "", trim: true },
    instagram: { type: String },
// Add these fields inside the userSchema, near the student-specific section:
gender: {
  type: String,
  enum: ["Male", "Female", ""],
  default: "",
},
academicLevel: {
  type: String,
  enum: [
    "Metric / O-levels",
    "Intermediate / A-levels",
    "1st year",
    "2nd year",
    "3rd year",
    "4th year",
    "5th year",
    "",
  ],
  default: "",
},
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
        // --- PUSH NOTIFICATIONS (multi-device) ---
    pushTokens: {
      select: false, // read only by the push code, which selects it by name
      type: [
      {
        token: { type: String, required: true },
        platform: { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
        // Which Android notification channels this app build created:
        // 'snd_v1' = one channel per sound (new builds), 'legacy' = old builds
        channels: { type: String, default: 'legacy' },
        // EAS project the app was built under (sent by the app, or learned from Expo)
        projectId: { type: String },
        updatedAt: { type: Date, default: Date.now },
      },
      ],
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

// --- SECRETS NEVER LEAVE THE SERVER ---
// The fields above marked select: false are not loaded unless a query asks for them. If one
// was selected on purpose (login, webhooks, Woo), this strips it from every JSON response.
const HIDDEN_FIELDS = [
  "password",
  "webhookSecret",
  "wooConsumerKey",
  "wooConsumerSecret",
  "shopifyAccessToken",
  "shopifyClientId",
  "shopifyClientSecret",
  "shopifyWebhookSecret",
  "pushTokens",
  "idCardFront",
  "idCardBack",
  "livePicture",
];
userSchema.set("toJSON", {
  transform(doc, ret) {
    for (const f of HIDDEN_FIELDS) delete ret[f];
    return ret;
  },
});
userSchema.statics.HIDDEN_FIELDS = HIDDEN_FIELDS;

// --- INDEXES ---
userSchema.index({ shopifyStoreUrl: 1 }, {
  name: "unique_brand_shopify_store",
  unique: true,
  partialFilterExpression: { role: "brand", shopifyStoreUrl: { $gt: "" } },
});
userSchema.index({ role: 1, status: 1 });
userSchema.index({ university: 1, role: 1 });
userSchema.index({ brandApprovalStatus: 1, role: 1 }); // For filtering brands
userSchema.index({ accountStatus: 1 });
userSchema.index({ blockedUsers: 1 });
userSchema.index({ 'pushTokens.token': 1 });

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

// feature flags (config/featureFlags.js): a student default never applies to an employer, brand or admin. The list of
// non-student accounts is refreshed every 30 s; a new or changed account saved on this server is marked at once.
userSchema.post("save", function (doc) {
  try { require("../config/featureFlags").markAccountRole(String(doc._id), doc.role); } catch { /* never blocks a save */ }
});

module.exports = mongoose.model("User", userSchema);