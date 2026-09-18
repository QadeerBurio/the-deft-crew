// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─────────────────────────────────────────────────────────
// Cloudinary credential check
// ─────────────────────────────────────────────────────────
const hasCloudinary =
  process.env.CLOUDINARY_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log("✅ Cloudinary configured successfully");
  console.log(`📁 Cloud Name: ${process.env.CLOUDINARY_NAME}`);
} else {
  console.log("⚠️ [Cloudinary] Credentials missing. Falling back to local disk storage.");
  console.log("   Required: CLOUDINARY_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
}

// ─────────────────────────────────────────────────────────
// Local storage fallback
// ─────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const createLocalStorage = (subfolder) => {
  const destDir = path.join(uploadsDir, subfolder);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}_${uniqueSuffix}${ext}`);
    },
  });
};

// ─────────────────────────────────────────────────────────
// ALLOWED FILE TYPES — shared constants
// ─────────────────────────────────────────────────────────
const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",      // some browsers
  "image/pjpeg",    // progressive JPEG
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/heic",     // iPhone
  "image/heif",     // iPhone
];

const IMAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".jpe", ".jfif",
  ".png", ".webp", ".gif", ".svg",
  ".heic", ".heif",
];

const DOC_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const DOC_EXTENSIONS = [".pdf", ".doc", ".docx"];

// ─────────────────────────────────────────────────────────
// Reusable, forgiving file filter factory
//   Accepts if EITHER mime OR extension matches (case-insensitive)
// ─────────────────────────────────────────────────────────
const makeFileFilter = (allowedMimes, allowedExts, label) => {
  return (req, file, cb) => {
    const rawMime = (file.mimetype || "").toLowerCase().trim();
    const mime = rawMime.split(";")[0].trim(); // strip charset
    const originalName = (file.originalname || "").toLowerCase().trim();
    const ext = originalName.includes(".")
      ? originalName.substring(originalName.lastIndexOf("."))
      : "";

    const mimeOk = allowedMimes.includes(mime);
    const extOk = allowedExts.includes(ext);

    console.log("📤 UPLOAD DEBUG:", {
      field: file.fieldname,
      originalname: file.originalname,
      rawMime: file.mimetype,
      normalizedMime: mime,
      ext,
      mimeOk,
      extOk,
      accepted: mimeOk || extOk,
    });

    if (mimeOk || extOk) {
      return cb(null, true);
    }

    console.error(
      `❌ [${label}] File rejected → name: "${file.originalname}", mime: "${file.mimetype}", ext: "${ext}"`
    );

    cb(
      new Error(
        `${label}: Only ${allowedExts.join(", ")} files are allowed. ` +
          `You uploaded: ${file.originalname} (${file.mimetype || "unknown type"})`
      ),
      false
    );
  };
};

// ─────────────────────────────────────────────────────────
// STORAGES
// ─────────────────────────────────────────────────────────

// Profile images
const profileStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: "TDC_Profiles",
        allowed_formats: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
        transformation: [{ width: 500, height: 500, crop: "limit", quality: "auto" }],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split(".")[0]
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Profiles/profile_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("profiles");

// Offer images
const offerStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: "TDC_Offers",
        allowed_formats: ["jpg", "jpeg", "png", "webp", "svg", "heic", "heif"],
        transformation: [{ width: 800, height: 600, crop: "limit", quality: "auto" }],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split(".")[0]
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Offers/offer_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("offers");

// Resume (raw docs)
const resumeStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: "TDC_Resumes",
        resource_type: "raw",
        allowed_formats: ["pdf", "doc", "docx"],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split(".")[0]
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Resumes/resume_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("resumes");

// Job application resumes
const jobResumeStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: "TDC_Job_Resumes",
        resource_type: "raw",
        allowed_formats: ["pdf", "doc", "docx"],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split(".")[0]
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Job_Resumes/job_resume_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("job_resumes");

// Company logos
const logoStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: "TDC_CompanyLogos",
        allowed_formats: ["jpg", "jpeg", "png", "webp", "svg", "gif", "heic", "heif"],
        transformation: [{ width: 300, height: 300, crop: "limit", quality: "auto" }],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split(".")[0]
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toLowerCase()
            .substring(0, 30);
          return `TDC_CompanyLogos/logo_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("logos");

// ─────────────────────────────────────────────────────────
// MULTER INSTANCES — all use the new forgiving filter
// ─────────────────────────────────────────────────────────

const uploadProfile = multer({
  storage: profileStorage,
  fileFilter: makeFileFilter(
    IMAGE_MIME_TYPES,
    IMAGE_EXTENSIONS,
    "Profile image"
  ),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ★ THE FIX — offers now accept HEIC, JPG, and any case variant
const uploadOffer = multer({
  storage: offerStorage,
  fileFilter: makeFileFilter(
    IMAGE_MIME_TYPES,
    IMAGE_EXTENSIONS,
    "Offer image"
  ),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadResume = multer({
  storage: resumeStorage,
  fileFilter: makeFileFilter(
    DOC_MIME_TYPES,
    DOC_EXTENSIONS,
    "Resume"
  ),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadJobResume = multer({
  storage: jobResumeStorage,
  fileFilter: makeFileFilter(
    DOC_MIME_TYPES,
    DOC_EXTENSIONS,
    "Job resume"
  ),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadLogo = multer({
  storage: logoStorage,
  fileFilter: makeFileFilter(
    IMAGE_MIME_TYPES,
    IMAGE_EXTENSIONS,
    "Logo"
  ),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
const deleteFromCloudinary = async (publicId, resourceType = "image") => {
  if (!hasCloudinary) {
    try {
      const searchPaths = [
        path.join(uploadsDir, "profiles", publicId),
        path.join(uploadsDir, "resumes", publicId),
        path.join(uploadsDir, "job_resumes", publicId),
        path.join(uploadsDir, "logos", publicId),
        path.join(uploadsDir, "offers", publicId),
      ];

      for (const fp of searchPaths) {
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`🗑️ Deleted local file: ${fp}`);
          return { result: "deleted locally" };
        }
      }
      console.warn(`⚠️ Local file not found: ${publicId}`);
      return { result: "not found" };
    } catch (err) {
      console.error("Error deleting local file:", err);
      return { error: err.message };
    }
  }

  try {
    let cleanPublicId = publicId;
    if (publicId.includes("/")) {
      const parts = publicId.split("/");
      cleanPublicId = parts.slice(1).join("/");
    }

    const result = await cloudinary.uploader.destroy(cleanPublicId, {
      resource_type: resourceType,
      invalidate: true,
    });
    console.log(`🗑️ Deleted from Cloudinary: ${publicId}`, result);
    return result;
  } catch (error) {
    console.error("Error deleting from Cloudinary:", error);
    return { error: error.message };
  }
};

const getCloudinaryUrl = (publicId, resourceType = "image", options = {}) => {
  if (!hasCloudinary) {
    return `/uploads/${publicId}`;
  }

  try {
    let cleanPublicId = publicId;
    if (!publicId.includes("/")) {
      if (resourceType === "raw") {
        cleanPublicId = `TDC_Resumes/${publicId}`;
      } else {
        cleanPublicId = `TDC_Profiles/${publicId}`;
      }
    }

    return cloudinary.url(cleanPublicId, {
      resource_type: resourceType,
      secure: true,
      ...options,
    });
  } catch (error) {
    console.error("Error getting Cloudinary URL:", error);
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────
module.exports = {
  cloudinary,
  upload: uploadProfile,
  uploadOffer,
  uploadResume,
  uploadJobResume,
  uploadLogo,
  deleteFromCloudinary,
  getCloudinaryUrl,
  hasCloudinary,
  profileStorage,
  resumeStorage,
  jobResumeStorage,
  logoStorage,
  offerStorage,
  // Expose constants for reuse / testing
  IMAGE_MIME_TYPES,
  IMAGE_EXTENSIONS,
  DOC_MIME_TYPES,
  DOC_EXTENSIONS,
  makeFileFilter,
};