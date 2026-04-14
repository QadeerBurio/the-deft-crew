const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "TDC_Profiles", // Changed to a specific project folder
    allowed_formats: ["jpg", "png", "jpeg"],
    transformation: [{ width: 1000, crop: "limit", quality: "auto" }],
  },
});

const upload = multer({ storage: storage });

// CRITICAL FIX: Added 'upload' here
module.exports = { cloudinary, storage, upload };