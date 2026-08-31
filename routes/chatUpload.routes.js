const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary, hasCloudinary } = require('../config/cloudinary');
const auth = require('../middleware/auth.middleware');

// Dedicated storage just for chat media — built here rather than in
// config/cloudinary.js so the shared config file stays untouched.
// resource_type: 'auto' lets one config handle images, video, and raw
// docs, instead of needing separate storage configs per file type.
const chatStorage = hasCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: {
        folder: 'TDC_Chat',
        resource_type: 'auto',
        public_id: (req, file) => {
          const timestamp = Date.now();
          const random = Math.round(Math.random() * 1e9);
          const originalName = file.originalname
            .split('.')[0]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase()
            .substring(0, 30);
          return `TDC_Chat/chat_${originalName}_${timestamp}_${random}`;
        },
      },
    })
  : multer.memoryStorage();

const upload = multer({
  storage: chatStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap
});

const getMessageType = (mimetype) => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

router.post('/', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const mediaUrl = req.file.path || req.file.secure_url;
    const messageType = getMessageType(req.file.mimetype);

    res.json({
      success: true,
      mediaUrl,
      messageType,
      mediaMetadata: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
      },
    });
  } catch (err) {
    console.error('Chat upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

module.exports = router;