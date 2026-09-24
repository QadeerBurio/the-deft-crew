const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const { sendPushNotification } = require("../utils/notificationHelper");

// 1. SAVE TOKEN (Call this when app starts)
router.put("/save-token", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ message: "User ID required" });
    }

    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ message: "Push token required" });
    }

    await User.findByIdAndUpdate(userId, { 
      expoPushToken: token,
      pushTokenUpdatedAt: new Date(),
    });
    
    console.log('[Notification] Push token saved for user:', userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Notification] Error saving token:', err);
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
      screenToOpen,
      metadata,
    } = req.body;

    if (!recipientId) {
      return res.status(400).json({ message: "Recipient ID required" });
    }

    const senderId = req.userId || req.user?._id || req.user?.id;

    // Create notification
    const newNotification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      title,
      description,
      type: type || "System",
      metadata: metadata || {},
      readBy: [],
      deletedBy: []
    });

    // Send push notification
    const user = await User.findById(recipientId).select('expoPushToken');
    
    if (user?.expoPushToken) {
      await sendPushNotification(
        user.expoPushToken, 
        title, 
        description, 
        { 
          notificationId: newNotification._id.toString(),
          screen: screenToOpen,
          ...metadata,
        }
      );
    }

    console.log('[Notification] Sent:', newNotification._id, 'to:', recipientId);
    res.status(201).json(newNotification);
  } catch (err) {
    console.error('[Notification] Error sending:', err);
    res.status(500).json({ message: "Failed to process notification" });
  }
});

// 3. GET USER NOTIFICATIONS - Only return user's own notifications
router.get("/my-notifications", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "User ID required" });
    }

    const notifications = await Notification.find({
      recipient: userId,
      deletedBy: { $ne: userId }
    })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

    const formatted = notifications.map(n => ({
      ...n,
      isRead: n.readBy ? n.readBy.some(id => id.toString() === userId.toString()) : false
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ message: "Error fetching notifications" });
  }
});

// 4. GET UNREAD COUNT
router.get("/unread-count", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "User ID required" });
    }

    const count = await Notification.countDocuments({
      recipient: userId,
      deletedBy: { $ne: userId },
      readBy: { $ne: userId }
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
    const userId = req.userId || req.user?._id || req.user?.id;

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: userId
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    if (!notification.readBy) {
      notification.readBy = [];
    }
    
    if (!notification.readBy.some(id => id.toString() === userId.toString())) {
      notification.readBy.push(userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 6. MARK ALL AS READ
router.put("/mark-all-read", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    await Notification.updateMany(
      {
        recipient: userId,
        readBy: { $ne: userId },
        deletedBy: { $ne: userId }
      },
      { $addToSet: { readBy: userId } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking all as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 7. DELETE SINGLE NOTIFICATION
router.delete("/delete/:id", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: userId
    });
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    if (!notification.deletedBy) {
      notification.deletedBy = [];
    }
    
    if (!notification.deletedBy.some(id => id.toString() === userId.toString())) {
      notification.deletedBy.push(userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting notification:", err);
    res.status(500).json({ message: "Delete failed" });
  }
});

// 8. CLEAR ALL
router.delete("/clear-all", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    await Notification.updateMany(
      { 
        recipient: userId,
        deletedBy: { $ne: userId }
      },
      { $addToSet: { deletedBy: userId } }
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing all notifications:", err);
    res.status(500).json({ message: "Clear failed" });
  }
});

module.exports = router;