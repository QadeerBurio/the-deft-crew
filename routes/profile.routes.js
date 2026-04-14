const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { upload } = require('../config/cloudinary'); 
const authMiddleware = require('../middleware/auth.middleware'); 

// Update Profile Route
// router.post('/update-profile', authMiddleware, upload.single('profileImage'), async (req, res) => {
//   try {
//     // 1. Check if Cloudinary successfully uploaded the file
//     if (!req.file || !req.file.path) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "No image uploaded or upload failed." 
//       });
//     }

//     // 2. IMPORTANT: Match the key from your authMiddleware (req.userId)
//     // We use a fallback just in case: req.userId || req.user?.id
//     const targetId = req.userId || req.user?.id || req.user?._id;

//     if (!targetId) {
//       return res.status(401).json({ 
//         success: false, 
//         message: "Authentication failed: User ID not found in request." 
//       });
//     }

//     // 3. Update the profileImage field in MongoDB
//     const updatedUser = await User.findByIdAndUpdate(
//       targetId,
//       { profileImage: req.file.path }, // Cloudinary URL
//       { new: true, runValidators: true }
//     ).select("-password").populate("university");

//     if (!updatedUser) {
//       return res.status(404).json({ success: false, message: "User not found in database." });
//     }

//     // 4. Return success
//     res.status(200).json({
//       success: true,
//       message: "Profile picture updated successfully!",
//       user: updatedUser
//     });

//   } catch (error) {
//     console.error("Profile Update Error:", error);
//     res.status(500).json({ 
//       success: false, 
//       message: "Server error during profile update",
//       error: error.message 
//     });
//   }
// });
router.post("/update-profile", authMiddleware, async (req, res) => {
  try {
    const { profileImage } = req.body;

    const updatedUser = await User.findByIdAndUpdate(
      req.userId,
      { profileImage },
      { new: true }
    );

    res.json({
      success: true,
      user: updatedUser
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;