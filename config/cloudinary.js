// config/cloudinary.js
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
require("dotenv").config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

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
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
    transformation: [{ width: 200, height: 200, crop: "limit", quality: "auto" }],
  },
});

// Multer upload instances
const uploadProfile = multer({ storage: profileStorage });
const uploadResume = multer({ storage: resumeStorage });
const uploadJobResume = multer({ storage: jobResumeStorage });
const uploadLogo = multer({ storage: logoStorage });

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