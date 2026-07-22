// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Check Cloudinary credentials
const cloudinaryName = process.env.CLOUDINARY_NAME;
const cloudinaryKey = process.env.CLOUDINARY_KEY;
const cloudinarySecret = process.env.CLOUDINARY_SECRET;

const hasCloudinary = !!(cloudinaryName && cloudinaryKey && cloudinarySecret);

// Configure Cloudinary if credentials exist
if (hasCloudinary) {
  try {
    cloudinary.config({
      cloud_name: cloudinaryName,
      api_key: cloudinaryKey,
      api_secret: cloudinarySecret,
    });
    console.log("✅ Cloudinary configured successfully");
  } catch (error) {
    console.error("❌ Cloudinary configuration error:", error.message);
    // Fall back to local storage
    process.env.FORCE_LOCAL_STORAGE = 'true';
  }
} else {
  console.log("⚠️ [Cloudinary] Credentials missing. Falling back to local disk storage.");
  console.log("   To enable Cloudinary, add these to your .env file:");
  console.log("   CLOUDINARY_NAME=your_cloud_name");
  console.log("   CLOUDINARY_KEY=your_api_key");
  console.log("   CLOUDINARY_SECRET=your_api_secret");
}

// Force local storage if Cloudinary is not available
const useCloudinary = hasCloudinary && !process.env.FORCE_LOCAL_STORAGE;

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
let profileStorage;
try {
  profileStorage = useCloudinary 
    ? new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
          folder: "TDC_Profiles",
          allowed_formats: ["jpg", "png", "jpeg", "webp"],
          transformation: [{ width: 500, height: 500, crop: "limit", quality: "auto" }],
        },
      })
    : createLocalStorage("profiles");
} catch (error) {
  console.warn("⚠️ Cloudinary storage error, falling back to local:", error.message);
  profileStorage = createLocalStorage("profiles");
}

// Storage for resumes (PDF, DOC, DOCX)
let resumeStorage;
try {
  resumeStorage = useCloudinary
    ? new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
          folder: "TDC_Resumes",
          resource_type: "raw",
          public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const originalName = file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, '_');
            return `resume_${originalName}_${uniqueSuffix}`;
          },
        },
      })
    : createLocalStorage("resumes");
} catch (error) {
  console.warn("⚠️ Cloudinary resume storage error, falling back to local:", error.message);
  resumeStorage = createLocalStorage("resumes");
}

// Storage for job application resumes
let jobResumeStorage;
try {
  jobResumeStorage = useCloudinary
    ? new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
          folder: "TDC_Job_Resumes",
          resource_type: "raw",
          public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const originalName = file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, '_');
            return `job_resume_${originalName}_${uniqueSuffix}`;
          },
        },
      })
    : createLocalStorage("job_resumes");
} catch (error) {
  console.warn("⚠️ Cloudinary job resume storage error, falling back to local:", error.message);
  jobResumeStorage = createLocalStorage("job_resumes");
}

// Storage for company logos
let logoStorage;
try {
  logoStorage = useCloudinary
    ? new CloudinaryStorage({
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
      })
    : createLocalStorage("logos");
} catch (error) {
  console.warn("⚠️ Cloudinary logo storage error, falling back to local:", error.message);
  logoStorage = createLocalStorage("logos");
}

// Multer upload instances
const uploadProfile = multer({ storage: profileStorage });

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

// Logo upload with specific config
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
  if (!useCloudinary) {
    try {
      const filePaths = [
        path.join(uploadsDir, 'profiles', publicId),
        path.join(uploadsDir, 'resumes', publicId),
        path.join(uploadsDir, 'job_resumes', publicId),
        path.join(uploadsDir, 'logos', publicId)
      ];
      for (const fp of filePaths) {
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`🗑️ Deleted local file: ${fp}`);
          break;
        }
      }
    } catch (err) {
      console.error('Error deleting local file:', err);
    }
    return null;
  }

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
  if (!useCloudinary) {
    // Return local file path
    return path.join(uploadsDir, publicId);
  }
  
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

// Helper to check if Cloudinary is being used
const isCloudinaryEnabled = useCloudinary;

console.log(`📁 Storage mode: ${useCloudinary ? 'Cloudinary' : 'Local Disk'}`);

module.exports = { 
  cloudinary, 
  storage: profileStorage, 
  upload: uploadProfile,
  uploadResume,
  uploadJobResume,
  uploadLogo,
  deleteFromCloudinary,
  getCloudinaryUrl,
  hasCloudinary: useCloudinary,
  isCloudinaryEnabled: useCloudinary
};