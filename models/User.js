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
      enum: ["student", "brand", "admin"],
      default: "student",
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

    // --- KYC / DOCUMENTATION ---
    profileImage: { type: String, default: "" },
    idCardFront: { type: String, default: "" },
    idCardBack: { type: String, default: "" },
    livePicture: { type: String, default: "" },

    // --- STUDENT SPECIFICS ---
    rollNo: { type: String },
    phone: { type: String },
    university: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
    },
    address: { type: String },
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
      enum: ["None", "Ordered", "Printing", "Shipped", "Delivered"],
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
  },
  {
    timestamps: true,
  }
);

// --- PRE-SAVE HOOK: AUTOMATIC REFERRAL CODE GENERATION ---
userSchema.pre("save", async function () {
  // Only generate a code for students who don't have one yet
  if (this.role === "student" && !this.referralCode) {
    let isUnique = false;
    let newCode = "";
    let attempts = 0;
    const maxAttempts = 15;

    while (!isUnique && attempts < maxAttempts) {
      attempts++;
      newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const existing = await this.constructor.findOne({ referralCode: newCode });

      if (!existing) {
        isUnique = true;
      }
    }

    if (isUnique) {
      this.referralCode = newCode;
    } else {
      return next(new Error("Failed to generate a unique referral code."));
    }
  }
  // next();
});

module.exports = mongoose.model("User", userSchema);