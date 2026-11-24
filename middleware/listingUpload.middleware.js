// backend/middleware/listingUpload.middleware.js
// A separate multer config from upload.middleware.js (which handles "logo"/"image"
// fieldnames for brands/offers) — kept independent so that file is never touched.
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', 'uploads', 'listings');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

// Owner (25 Nov 2026): with Cloudinary configured (config/cloudinary.js), attachments go there (folder TDC_Listings,
// images and videos: resource_type auto) instead of the container's disk, which is wiped on every deploy. Without
// it: the disk, exactly as before. The route answers with the Cloudinary link (req.file.path) when there is one.
const { cloudinary, hasCloudinary } = require('../config/cloudinary');
const storage = hasCloudinary
  ? new (require('multer-storage-cloudinary').CloudinaryStorage)({
      cloudinary,
      params: {
        folder: 'TDC_Listings',
        resource_type: 'auto',
        public_id: () => `listing_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
      },
    })
  : diskStorage;

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPG, PNG, WEBP, MP4, MOV'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, matches the "up to 10MB" copy in the UI
});

module.exports = upload;