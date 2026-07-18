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
      title,
      description,
      type,
      screenToOpen
    } = req.body;

    const newNotification = await Notification.create({
      recipient: recipientId,
      title,
      description,
      type,
      unread: true
    });

    const user = await User.findById(recipientId);
    
    if (user && user.expoPushToken) {
      await sendPushNotification(
        user.expoPushToken, 
        title, 
        description, 
        { notificationId: newNotification._id, screen: screenToOpen }
      );
    }

    res.status(201).json(newNotification);
  } catch (err) {
    res.status(500).json({ message: "Failed to process notification" });
  }
});

// 3. GET USER NOTIFICATIONS - FIXED: Filter by user creation date
router.get("/my-notifications", auth, async (req, res) => {
  try {
    // Get the user's creation date
    const user = await User.findById(req.userId).select('createdAt');
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get user's join date (when they signed up)
    const userJoinDate = user.createdAt;

    const notifications = await Notification.find({
      $or: [
        // Personal notifications - always show
        { recipient: req.userId },
        { 
          // Global notifications - ONLY show those created AFTER user joined
          recipient: null,
          createdAt: { $gte: userJoinDate }
        }
      ],
      // Exclude notifications the user has deleted
      deletedBy: { $ne: req.userId }
    })
    .sort({ createdAt: -1 })
    .lean();

    // Format notifications with read status
    const formatted = notifications.map(n => ({
      ...n,
      isRead: n.readBy ? n.readBy.some(id => id.toString() === req.userId) : false
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ message: "Error fetching notifications" });
  }
});

// 4. GET UNREAD COUNT - NEW ENDPOINT
router.get("/unread-count", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('createdAt');
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userJoinDate = user.createdAt;

    const count = await Notification.countDocuments({
      $or: [
        { recipient: req.userId },
        { 
          recipient: null,
          createdAt: { $gte: userJoinDate }
        }
      ],
      deletedBy: { $ne: req.userId },
      readBy: { $ne: req.userId } // Only count unread
    });

    res.json({ count });
  } catch (err) {
    console.error("Error getting unread count:", err);
    res.status(500).json({ message: "Error getting unread count" });
  }
});

// 5. MARK SINGLE AS READ
router.patch("/mark-read/:id", auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ recipient: req.userId }, { recipient: null }]
      },
      { $addToSet: { readBy: req.userId } }, 
      { new: true }
    );

    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// 6. MARK ALL AS READ
router.put("/mark-all-read", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('createdAt');
    const userJoinDate = user.createdAt;

    await Notification.updateMany(
      {
        $or: [
          { recipient: req.userId },
          { 
            recipient: null,
            createdAt: { $gte: userJoinDate }
          }
        ],
        readBy: { $ne: req.userId },
        deletedBy: { $ne: req.userId }
      },
      { $addToSet: { readBy: req.userId } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// 7. DELETE SINGLE NOTIFICATION
router.delete("/delete/:id", auth, async (req, res) => {
  try {
    const note = await Notification.findById(req.params.id);
    if (!note) return res.status(404).json({ message: "Not found" });

    if (note.recipient && note.recipient.toString() === req.userId) {
      await Notification.findByIdAndDelete(req.params.id);
    } else {
      await Notification.findByIdAndUpdate(req.params.id, { 
        $addToSet: { deletedBy: req.userId }
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
  }
});

// 8. CLEAR ALL
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