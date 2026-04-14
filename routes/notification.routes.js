const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");


// 1. SAVE TOKEN (Call this when app starts)
router.put("/save-token", auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { expoPushToken: req.body.token });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Error saving token" });
  }
});

// 2. CREATE AND SEND (The "WhatsApp" Trigger)
router.post("/send", auth, async (req, res) => {
  try {
    const { 
      recipientId, 
      title,          // e.g., "New Discount Alert! 🎁"
      description,    // e.g., "Get 20% off at Oceanic Pharma."
      type,           // "Offers", "System", or "All"
      screenToOpen    // Metadata: Tells the app which page to open
    } = req.body;

    // 1. Save to MongoDB (For the User's Notification History List)
    const newNotification = await Notification.create({
      recipient: recipientId,
      title,
      description,
      type,
      unread: true
    });

    // 2. Fetch User Token
    const user = await User.findById(recipientId);
    
    if (user && user.expoPushToken) {
      // 3. Send the "Heads-up" Pop-up
      await sendPushNotification(
        user.expoPushToken, 
        title, 
        description, 
        { notificationId: newNotification._id, screen: screenToOpen } // Extra Data
      );
    }

    res.status(201).json(newNotification);
  } catch (err) {
    res.status(500).json({ message: "Failed to process notification" });
  }
});

// GET USER NOTIFICATIONS
// router.get("/my-notifications", auth, async (req, res) => {
//   try {
//     const notifications = await Notification.find({
//       $or: [
//         { recipient: req.userId },
//         { recipient: null }
//       ],
//       // IMPORTANT: Exclude notifications where user ID is in deletedBy
//       deletedBy: { $ne: req.userId } 
//     })
//     .sort({ createdAt: -1 })
//     .limit(30)
//     .lean(); 

//     const formattedNotifications = notifications.map(n => ({
//       ...n,
//       isRead: n.readBy ? n.readBy.some(id => id.toString() === req.userId) : false
//     }));

//     res.json(formattedNotifications);
//   } catch (err) {
//     res.status(500).json({ message: "Error fetching notifications" });
//   }
// });

// MARK SINGLE AS READ
router.patch("/mark-read/:id", auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ recipient: req.userId }, { recipient: null }]
      },
      // $addToSet ensures the ID is only added once (preventing duplicates)
      { $addToSet: { readBy: req.userId } }, 
      { new: true }
    );

    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// MARK ALL AS READ
router.put("/mark-all-read", auth, async (req, res) => {
  try {
    await Notification.updateMany(
      {
        $or: [{ recipient: req.userId }, { recipient: null }],
        readBy: { $ne: req.userId } // Only update those NOT already read by this user
      },
      { $addToSet: { readBy: req.userId } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
// DELETE SINGLE NOTIFICATION
// GET ALL (Excluding deleted)
router.get("/my-notifications", auth, async (req, res) => {
  try {
    const notifications = await Notification.find({
      $or: [{ recipient: req.userId }, { recipient: null }],
      deletedBy: { $ne: req.userId } // Permanent Filter
    }).sort({ createdAt: -1 }).lean();

    const formatted = notifications.map(n => ({
      ...n,
      isRead: n.readBy ? n.readBy.some(id => id.toString() === req.userId) : false
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: "Error fetching" });
  }
});

// DELETE SINGLE
router.delete("/delete/:id", auth, async (req, res) => {
  try {
    const note = await Notification.findById(req.params.id);
    if (!note) return res.status(404).json({ message: "Not found" });

    if (note.recipient && note.recipient.toString() === req.userId) {
      await Notification.findByIdAndDelete(req.params.id); // Physical Delete
    } else {
      await Notification.findByIdAndUpdate(req.params.id, { 
        $addToSet: { deletedBy: req.userId } // Logical Permanent Hide
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
  }
});

// CLEAR ALL
router.delete("/clear-all", auth, async (req, res) => {
  try {
    // Delete private ones
    await Notification.deleteMany({ recipient: req.userId });
    // Hide global ones
    await Notification.updateMany(
      { recipient: null, deletedBy: { $ne: req.userId } },
      { $addToSet: { deletedBy: req.userId } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Clear failed" });
  }
});
module.exports = router;