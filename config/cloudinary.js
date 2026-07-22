// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const path = require("path");
require("dotenv").config();

// Check Cloudinary credentials
const cloudinaryName = process.env.CLOUDINARY_NAME;
const cloudinaryKey = process.env.CLOUDINARY_KEY;
const cloudinarySecret = process.env.CLOUDINARY_SECRET;

// Validate credentials
if (!cloudinaryName || !cloudinaryKey || !cloudinarySecret) {
  console.error("❌ Cloudinary credentials missing!");
  console.error("Please set CLOUDINARY_NAME, CLOUDINARY_KEY, and CLOUDINARY_SECRET in .env");
  process.exit(1); // Exit if no credentials
}

// Configure Cloudinary
try {
  cloudinary.config({
    cloud_name: cloudinaryName,
    api_key: cloudinaryKey,
    api_secret: cloudinarySecret,
  });
  console.log("✅ Cloudinary configured successfully");
} catch (error) {
  console.error("❌ Cloudinary configuration error:", error.message);
  process.exit(1);
}

// Storage for profile images
const profileStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_Profiles",
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
    transformation: [{ width: 500, height: 500, crop: "limit", quality: "auto" }],
  },
});

// Storage for resumes (PDF, DOC, DOCX)
const resumeStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_Resumes",
    resource_type: "raw",
    allowed_formats: ["pdf", "doc", "docx"],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const originalName = file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, '_');
      return `resume_${originalName}_${uniqueSuffix}`;
    },
  },
});

// Storage for job application resumes
const jobResumeStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_Job_Resumes",
    resource_type: "raw",
    allowed_formats: ["pdf", "doc", "docx"],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const originalName = file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, '_');
      return `job_resume_${originalName}_${uniqueSuffix}`;
    },
  },
});

// Storage for company logos
const logoStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_CompanyLogos",
    allowed_formats: ["jpg", "png", "jpeg", "webp", "svg"],
    transformation: [
      { width: 300, height: 300, crop: "limit", quality: "auto" }
    ],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const originalName = file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, '_');
      return `logo_${originalName}_${uniqueSuffix}`;
    },
  },
});

// Multer upload instances
const uploadProfile = multer({ 
  storage: profileStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

const uploadResume = multer({ 
  storage: resumeStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.doc' || ext === '.docx') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents (.pdf, .doc, .docx) are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

const uploadJobResume = multer({ 
  storage: jobResumeStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.doc' || ext === '.docx') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents (.pdf, .doc, .docx) are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

const uploadLogo = multer({ 
  storage: logoStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF, WEBP, and SVG images are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Helper function to delete file from Cloudinary
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { 
      resource_type: resourceType 
    });
    console.log(`🗑️ Deleted from Cloudinary: ${publicId}`, result);
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    return null;
  }
};

// Helper function to get file URL
const getCloudinaryUrl = (publicId, resourceType = 'image', options = {}) => {
  try {
    return cloudinary.url(publicId, {
      resource_type: resourceType,
      ...options
    });
  } catch (error) {
    console.error('Error getting Cloudinary URL:', error);
    return null;
  }
};

console.log(`📁 Storage mode: Cloudinary (All uploads go to Cloudinary)`);

module.exports = { 
  cloudinary, 
  upload: uploadProfile,
  uploadResume,
  uploadJobResume,
  uploadLogo,
  deleteFromCloudinary,
  getCloudinaryUrl,
  isCloudinaryEnabled: true
};