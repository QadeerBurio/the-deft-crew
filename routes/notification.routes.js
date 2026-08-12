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

    // IMPORTANT: Always set recipient for user-specific notifications
    const newNotification = await Notification.create({
      recipient: recipientId, // Never null for user-specific notifications
      title,
      description,
      type: type || "System",
      readBy: [],
      deletedBy: []
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

// 3. GET USER NOTIFICATIONS - FIXED: Only return user's own notifications
router.get("/my-notifications", auth, async (req, res) => {
  try {
    // ✅ CRITICAL FIX: Only fetch notifications where the user is the recipient
    const notifications = await Notification.find({
      recipient: req.userId, // This ensures only this user's notifications
      deletedBy: { $ne: req.userId } // Exclude soft-deleted
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

// 4. GET UNREAD COUNT - FIXED
router.get("/unread-count", auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.userId, // Only this user's notifications
      deletedBy: { $ne: req.userId },
      readBy: { $ne: req.userId } // Only count unread
    });

    res.json({ count });
  } catch (err) {
    console.error("Error getting unread count:", err);
    res.status(500).json({ message: "Error getting unread count" });
  }
});

// 5. MARK SINGLE AS READ - FIXED
router.patch("/mark-read/:id", auth, async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: req.userId // Only allow if user owns it
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    // Add user to readBy if not already there
    if (!notification.readBy) {
      notification.readBy = [];
    }
    
    if (!notification.readBy.some(id => id.toString() === req.userId)) {
      notification.readBy.push(req.userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 6. MARK ALL AS READ - FIXED
router.put("/mark-all-read", auth, async (req, res) => {
  try {
    // Only update notifications belonging to the user
    await Notification.updateMany(
      {
        recipient: req.userId,
        readBy: { $ne: req.userId },
        deletedBy: { $ne: req.userId }
      },
      { $addToSet: { readBy: req.userId } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking all as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 7. DELETE SINGLE NOTIFICATION - FIXED
router.delete("/delete/:id", auth, async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: req.userId // Only allow if user owns it
    });
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    // Soft delete - add to deletedBy array
    if (!notification.deletedBy) {
      notification.deletedBy = [];
    }
    
    if (!notification.deletedBy.some(id => id.toString() === req.userId)) {
      notification.deletedBy.push(req.userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting notification:", err);
    res.status(500).json({ message: "Delete failed" });
  }
});

// 8. CLEAR ALL - FIXED
router.delete("/clear-all", auth, async (req, res) => {
  try {
    // Soft delete all notifications for this user
    await Notification.updateMany(
      { 
        recipient: req.userId,
        deletedBy: { $ne: req.userId }
      },
      { $addToSet: { deletedBy: req.userId } }
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing all notifications:", err);
    res.status(500).json({ message: "Clear failed" });
  }
});

module.exports = router;