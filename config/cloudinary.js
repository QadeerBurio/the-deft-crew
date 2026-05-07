const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
require("dotenv").config();

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

// Storage for company logos
const logoStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_CompanyLogos",
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
    transformation: [{ width: 200, height: 200, crop: "limit", quality: "auto" }],
  },
});

const uploadProfile = multer({ storage: profileStorage });
const uploadResume = multer({ storage: resumeStorage });
const uploadLogo = multer({ storage: logoStorage });

module.exports = { 
  cloudinary, 
  storage: profileStorage, 
  upload: uploadProfile,
  uploadResume,
  uploadLogo
};