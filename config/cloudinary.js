// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Check for Cloudinary credentials
const hasCloudinary = process.env.CLOUDINARY_NAME && 
                      process.env.CLOUDINARY_API_KEY && 
                      process.env.CLOUDINARY_API_SECRET;

if (hasCloudinary) {
  // Configure Cloudinary with ALL required credentials
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true // Always use HTTPS
  });
  console.log("✅ Cloudinary configured successfully");
  console.log(`📁 Cloud Name: ${process.env.CLOUDINARY_NAME}`);
} else {
  console.log("⚠️ [Cloudinary] Credentials missing. Falling back to local disk storage.");
  console.log("   Required: CLOUDINARY_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
}

// Local Storage Fallback setup
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
    destination: (req, file, cb) => {
      cb(null, destDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}_${uniqueSuffix}${ext}`);
    }
  });
};

// Storage for profile images
const profileStorage = hasCloudinary 
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_Profiles",
        allowed_formats: ["jpg", "png", "jpeg", "webp"],
        transformation: [{ width: 500, height: 500, crop: "limit", quality: "auto" }],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1E9);
          const originalName = file.originalname.split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Profiles/profile_${originalName}_${timestamp}_${random}`;
        }
      },
    })
  : createLocalStorage("profiles");

// NEW: Storage for offer images
const offerStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_Offers",
        allowed_formats: ["jpg", "png", "jpeg", "webp", "svg"],
        transformation: [
          { width: 800, height: 600, crop: "limit", quality: "auto" }
        ],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1E9);
          const originalName = file.originalname.split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Offers/offer_${originalName}_${timestamp}_${random}`;
        }
      },
    })
  : createLocalStorage("offers");

// Storage for resumes (PDF, DOC, DOCX)
const resumeStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_Resumes",
        resource_type: "raw",
        allowed_formats: ["pdf", "doc", "docx"],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1E9);
          const originalName = file.originalname.split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Resumes/resume_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("resumes");

// Storage for job application resumes
const jobResumeStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_Job_Resumes",
        resource_type: "raw",
        allowed_formats: ["pdf", "doc", "docx"],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1E9);
          const originalName = file.originalname.split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Job_Resumes/job_resume_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("job_resumes");

// Storage for company logos
const logoStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_CompanyLogos",
        allowed_formats: ["jpg", "png", "jpeg", "webp", "svg"],
        transformation: [
          { width: 300, height: 300, crop: "limit", quality: "auto" }
        ],
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1E9);
          const originalName = file.originalname.split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_CompanyLogos/logo_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : createLocalStorage("logos");

// Multer upload instances
const uploadProfile = multer({ 
  storage: profileStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WEBP images are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// NEW: Upload instance for offers
const uploadOffer = multer({ 
  storage: offerStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WEBP, and SVG images are allowed'), false);
    }
  },
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
  if (!hasCloudinary) {
    try {
      const searchPaths = [
        path.join(uploadsDir, 'profiles', publicId),
        path.join(uploadsDir, 'resumes', publicId),
        path.join(uploadsDir, 'job_resumes', publicId),
        path.join(uploadsDir, 'logos', publicId),
        path.join(uploadsDir, 'offers', publicId) // Added offers path
      ];
      
      for (const fp of searchPaths) {
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`🗑️ Deleted local file: ${fp}`);
          return { result: 'deleted locally' };
        }
      }
      console.warn(`⚠️ Local file not found: ${publicId}`);
      return { result: 'not found' };
    } catch (err) {
      console.error('Error deleting local file:', err);
      return { error: err.message };
    }
  }

  try {
    let cleanPublicId = publicId;
    if (publicId.includes('/')) {
      const parts = publicId.split('/');
      cleanPublicId = parts.slice(1).join('/');
    }
    
    const result = await cloudinary.uploader.destroy(cleanPublicId, { 
      resource_type: resourceType,
      invalidate: true
    });
    console.log(`🗑️ Deleted from Cloudinary: ${publicId}`, result);
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    return { error: error.message };
  }
};

// Helper function to get file URL
const getCloudinaryUrl = (publicId, resourceType = 'image', options = {}) => {
  if (!hasCloudinary) {
    return `/uploads/${publicId}`;
  }
  
  try {
    let cleanPublicId = publicId;
    if (!publicId.includes('/')) {
      if (resourceType === 'raw') {
        cleanPublicId = `TDC_Resumes/${publicId}`;
      } else {
        cleanPublicId = `TDC_Profiles/${publicId}`;
      }
    }
    
    return cloudinary.url(cleanPublicId, {
      resource_type: resourceType,
      secure: true,
      ...options
    });
  } catch (error) {
    console.error('Error getting Cloudinary URL:', error);
    return null;
  }
};

// Export configured instances
module.exports = { 
  cloudinary, 
  upload: uploadProfile,
  uploadOffer, // NEW: Export offer upload
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
  offerStorage // Export offer storage for debugging
};