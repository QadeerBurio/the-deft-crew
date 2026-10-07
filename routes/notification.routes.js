// routes/notification.routes.js
const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const User = require('../models/User');
const auth = require('../middleware/auth.middleware');
const { sendPushNotification, sendToUser } = require('../utils/pushNotification');
const pushGateway = require('../services/engagement/pushGateway');

// ── 1. SAVE TOKEN (multi-device) ──
router.put('/save-token', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    if (!userId || userId === 'guest-user') {
      return res.status(401).json({ message: 'User ID required' });
    }
    const { token, platform, channels } = req.body;
    if (!token) return res.status(400).json({ message: 'Push token required' });

    await User.updateMany(
      { 'pushTokens.token': token },
      { $pull: { pushTokens: { token } } }
    );

    await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });
    await User.updateOne(
      { _id: userId },
      {
        $push: {
          pushTokens: {
            token,
            platform: ['ios', 'android', 'web'].includes(platform) ? platform : 'unknown',
            channels: ['snd_v1', 'snd_v2'].includes(channels) ? channels : 'legacy',
            updatedAt: new Date(),
          },
        },
      }
    );

    // Keep only the 5 most recent devices
    await User.updateOne(
      { _id: userId },
      { $push: { pushTokens: { $each: [], $sort: { updatedAt: -1 }, $slice: 5 } } }
    );

    console.log('[Notification] Push token saved for user:', userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Notification] Error saving token:', err);
    res.status(500).json({ message: 'Error saving token' });
  }
});

// ── 2. TRACK PUSH OPENED (mobile calls on tap) ──
router.post('/push-opened/:logId', auth, async (req, res) => {
  try {
    const ok = await pushGateway.markOpened(req.params.logId);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── 3. CREATE AND SEND ──
// routes/notification.routes.js
// FIXED: mood variable properly defined

router.post('/send', auth, async (req, res) => {
  try {
    const { recipientId, title, description, type, screenToOpen, metadata, mood } = req.body;
    
    if (!recipientId) return res.status(400).json({ message: 'Recipient ID required' });

    const senderId = req.userId || req.user?._id || req.user?.id;
    const resolvedMood = mood || 'sorted'; // ✅ Define it here

    const newNotification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      title,
      description,
      type: type || 'System',
      mood: resolvedMood, // ✅ Use resolved value
      metadata: { ...(metadata || {}), ...(screenToOpen ? { screen: screenToOpen } : {}) },
      readBy: [],
      deletedBy: [],
    });

    // Push is sent automatically by the Notification model (post-save hook).

    console.log('[Notification] Sent:', newNotification._id, 'to:', recipientId);
    res.status(201).json(newNotification);
  } catch (err) {
    console.error('[Notification] Error sending:', err);
    res.status(500).json({ message: 'Failed to process notification' });
  }
});

// ── 4. GET USER NOTIFICATIONS ──
router.get('/my-notifications', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const notifications = await Notification.find({
      recipient: userId,
      deletedBy: { $ne: userId },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const formatted = notifications.map((n) => ({
      ...n,
      isRead: n.readBy ? n.readBy.some((id) => id.toString() === userId.toString()) : false,
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ message: 'Error fetching notifications' });
  }
});

// ── 5. GET UNREAD COUNT ──
router.get('/unread-count', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const count = await Notification.countDocuments({
      recipient: userId,
      deletedBy: { $ne: userId },
      readBy: { $ne: userId },
    });

    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: 'Error getting unread count' });
  }
});

// ── 6. MARK SINGLE AS READ ──
router.patch('/mark-read/:id', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: userId,
    });

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    if (!notification.readBy) notification.readBy = [];
    if (!notification.readBy.some((id) => id.toString() === userId.toString())) {
      notification.readBy.push(userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 7. MARK ALL AS READ ──
router.put('/mark-all-read', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    await Notification.updateMany(
      {
        recipient: userId,
        readBy: { $ne: userId },
        deletedBy: { $ne: userId },
      },
      { $addToSet: { readBy: userId } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 8. DELETE SINGLE ──
router.delete('/delete/:id', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: userId,
    });
    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    if (!notification.deletedBy) notification.deletedBy = [];
    if (!notification.deletedBy.some((id) => id.toString() === userId.toString())) {
      notification.deletedBy.push(userId);
      await notification.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed' });
  }
});

// ── 9. CLEAR ALL ──
router.delete('/clear-all', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    await Notification.updateMany(
      { recipient: userId, deletedBy: { $ne: userId } },
      { $addToSet: { deletedBy: userId } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Clear failed' });
  }
});

// ── PUSH SELF-TEST ──
// GET /api/notification/test-push  (logged-in user)
// Sends a push to your own devices and waits for Expo receipts, so you can see
// exactly why a push does not show outside the app.
router.get('/test-push', auth, async (req, res) => {
  try {
    const { Expo } = require('expo-server-sdk');
    const { buildMessage, iconUrlForMood, resolveSoundKey, channelForToken } = require('../utils/pushNotification');
    const expo = new Expo(process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {});

    const userId = req.userId || req.user?._id || req.user?.id;
    const user = await User.findById(userId).select('pushTokens').lean();
    const entries = (user?.pushTokens || []).filter((t) => t?.token);
    const tokens = entries.map((t) => t.token);

    if (!tokens.length) {
      return res.json({ ok: false, problem: 'NO_TOKEN', fix: 'App never saved a push token. Open the built app (not Expo Go), log in, allow notifications.' });
    }

    const validEntries = entries.filter((e) => Expo.isExpoPushToken(e.token));
    const valid = validEntries.map((e) => e.token);
    const { featureMood, titleWithEmoji } = require('../utils/pushNotification');

    // 4 different features → 4 different emojis + sounds, so you can hear it works
    const SAMPLES = [
      { type: 'new_offer', title: 'new offer', body: 'deal sound + 🤩' },
      { type: 'message', title: 'new message', body: 'message sound + 😜' },
      { type: 'streak_warning', title: 'streak at risk', body: 'streak sound + 😰' },
      { type: 'like', title: 'new like', body: 'like sound + 🤩' },
    ];
    const buildFor = (sample) =>
      validEntries.map((e) => {
        const mood = featureMood(sample.type);
        const soundKey = resolveSoundKey(sample.type, mood);
        return buildMessage(e.token, {
          title: titleWithEmoji(sample.title, mood),
          body: sample.body,
          data: { type: sample.type, mood, route: 'NotificationModal', soundKey },
          soundName: soundKey,
          channelId: channelForToken(e, soundKey),
          iconUrl: iconUrlForMood(mood),
        });
      });
    const messages = buildFor(SAMPLES[0]);
    // the other 3 follow 4s apart (fire and forget)
    SAMPLES.slice(1).forEach((sample, i) =>
      setTimeout(() => expo.sendPushNotificationsAsync(buildFor(sample)).catch(() => {}), (i + 1) * 4000)
    );

    const tickets = await expo.sendPushNotificationsAsync(messages);
    await new Promise((r) => setTimeout(r, 6000));
    const ids = tickets.filter((t) => t.id).map((t) => t.id);
    const receipts = ids.length ? await expo.getPushNotificationReceiptsAsync(ids) : {};

    const results = tickets.map((t, i) => {
      const receipt = t.id ? receipts[t.id] : null;
      const err = t.details?.error || receipt?.details?.error || null;
      const hints = {
        InvalidCredentials: 'Upload FCM V1 service account key: eas credentials → Android → Google Service Account → FCM V1.',
        DeviceNotRegistered: 'Token is dead (app uninstalled/reinstalled). Open the app and log in again.',
        MessageTooBig: 'Payload too large.',
        MismatchSenderId: 'google-services.json Firebase project does not match the FCM key uploaded to EAS.',
      };
      return {
        token: valid[i].slice(0, 30) + '…',
        channels: validEntries[i].channels || 'legacy',
        ticket: t.status,
        receipt: receipt?.status || (t.id ? 'pending' : null),
        error: err || t.message || receipt?.message || null,
        fix: err ? hints[err] || null : null,
      };
    });

    const legacy = validEntries.filter((e) => e.channels !== 'snd_v2').length;
    res.json({
      ok: results.every((r) => r.ticket === 'ok' && r.receipt !== 'error'),
      tokenCount: tokens.length,
      legacyDevices: legacy,
      note: legacy
        ? `${legacy} device(s) are on an old build: they play ONE sound for everything. Install the new build.`
        : 'all devices on the new build: each notification has its own sound.',
      results,
    });
  } catch (err) {
    console.error('[test-push]', err);
    res.status(500).json({ ok: false, problem: 'SEND_FAILED', error: err.message });
  }
});

module.exports = router;
