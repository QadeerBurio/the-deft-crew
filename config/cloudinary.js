// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const hasCloudinary = process.env.CLOUDINARY_NAME && process.env.CLOUDINARY_KEY && process.env.CLOUDINARY_SECRET;

if (hasCloudinary) {
  // Configure Cloudinary
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET,
  });
} else {
  console.log("⚠️ [Cloudinary] Credentials missing. Falling back to local disk storage.");
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
      },
    })
  : createLocalStorage("profiles");

// Storage for resumes (PDF, DOC, DOCX)
const resumeStorage = hasCloudinary
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

// Storage for job application resumes
const jobResumeStorage = hasCloudinary
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

// Storage for company logos
const logoStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: {
        folder: "TDC_CompanyLogos",
        allowed_formats: ["jpg", "png", "jpeg", "webp"],
        transformation: [{ width: 200, height: 200, crop: "limit", quality: "auto" }],
      },
    })
  : createLocalStorage("logos");

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
const uploadLogo = multer({ storage: logoStorage });

// Helper function to delete file from Cloudinary
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  if (!hasCloudinary) {
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

module.exports = { 
  cloudinary, 
  storage: profileStorage, 
  upload: uploadProfile,
  uploadResume,
  uploadJobResume,
  uploadLogo,
  deleteFromCloudinary,
  getCloudinaryUrl
};