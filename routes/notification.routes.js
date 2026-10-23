// routes/notification.routes.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const auth = require('../middleware/auth.middleware');
const pushGateway = require('../services/engagement/pushGateway');

// ── Helpers ──
// Consistent user-id resolution across all handlers (also rejects guests).
function resolveUserId(req) {
  const id = req.userId || req.user?._id || req.user?.id;
  if (!id || id === 'guest-user' || req.isGuest) return null;
  return id;
}

// Cast a string id to ObjectId when valid, so $ne / $addToSet / $pull
// comparisons against ObjectId arrays actually match.
function toId(v) {
  if (typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)) {
    return new mongoose.Types.ObjectId(v);
  }
  return v;
}

// ── 1. SAVE TOKEN (multi-device) ──
router.put('/save-token', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ message: 'User ID required' });
    }

    const { token, platform, channels } = req.body;
    if (!token) return res.status(400).json({ message: 'Push token required' });

    // The EAS project the app was built under. New builds send it; old builds don't,
    // in which case a project learned earlier for this token is kept.
    const { isProjectId } = require('../utils/expoProjects');
    let projectId = isProjectId(req.body.projectId)
      ? String(req.body.projectId).toLowerCase()
      : null;

    if (!projectId) {
      const prev = await User.findOne(
        { 'pushTokens.token': token },
        { 'pushTokens.$': 1 }
      ).lean();
      projectId = isProjectId(prev?.pushTokens?.[0]?.projectId)
        ? String(prev.pushTokens[0].projectId).toLowerCase()
        : null;
    }

    // Remove this token from every other user (device transferred accounts).
    await User.updateMany(
      { 'pushTokens.token': token },
      { $pull: { pushTokens: { token } } }
    );

    // Remove from this user too, then push fresh entry + trim to 5 newest in ONE op.
    await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });

    await User.updateOne(
      { _id: userId },
      {
        $push: {
          pushTokens: {
            $each: [
              {
                token,
                platform: ['ios', 'android', 'web'].includes(platform) ? platform : 'unknown',
                channels: ['snd_v1', 'snd_v2'].includes(channels) ? channels : 'legacy',
                ...(projectId ? { projectId } : {}),
                updatedAt: new Date(),
              },
            ],
            $sort: { updatedAt: -1 },
            $slice: 5,
          },
        },
      }
    );

    console.log('[Notification] Push token saved for user:', userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Notification] Error saving token:', err);
    res.status(500).json({ message: 'Error saving token' });
  }
});

// ── 2. TRACK PUSH OPENED (mobile calls on tap) ──
// DELETE /api/notification/remove-token  { token }
// Logout: this phone stops getting this user's pushes. Only removes the token from the
// signed-in user's own list.
router.delete('/remove-token', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ message: 'User ID required' });
    }
    const token = req.body?.token || req.query?.token;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'Push token required' });
    }
    const r = await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });
    res.json({ success: true, removed: r.modifiedCount || 0 });
  } catch (err) {
    console.error('[Notification] Error removing token:', err.message);
    res.status(500).json({ message: 'Error removing token' });
  }
});

router.post('/push-opened/:logId', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    // markOpened should accept the user so it can verify ownership.
    const ok = await pushGateway.markOpened(req.params.logId, userId);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── 3. CREATE AND SEND ──
router.post('/send', auth, async (req, res) => {
  try {
    const { recipientId, title, description, type, screenToOpen, metadata, mood } = req.body;

    if (!recipientId) {
      return res.status(400).json({ message: 'Recipient ID required' });
    }

    const senderId = resolveUserId(req);
    if (!senderId) return res.status(401).json({ message: 'User ID required' });

    const resolvedMood = mood || 'sorted';

    // TODO: authorize — only admins/system, or users with a relationship,
    // should be able to send to arbitrary recipients.
    if (String(recipientId) === String(senderId)) {
      // optional: return res.status(400).json({ message: 'Cannot notify yourself' });
    }

    const newNotification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      title,
      description,
      type: type || 'System',
      mood: resolvedMood,
      metadata: {
        ...(metadata || {}),
        ...(screenToOpen ? { screen: screenToOpen } : {}),
      },
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
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    const notifications = await Notification.find({
      recipient: uid,
      deletedBy: { $ne: uid },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const formatted = notifications.map((n) => ({
      ...n,
      isRead: Array.isArray(n.readBy)
        ? n.readBy.some((id) => id.toString() === uid.toString())
        : false,
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
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    const count = await Notification.countDocuments({
      recipient: uid,
      deletedBy: { $ne: uid },
      readBy: { $ne: uid },
    });

    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: 'Error getting unread count' });
  }
});

// ── 6. MARK SINGLE AS READ ──
router.patch('/mark-read/:id', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: uid,
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    if (!Array.isArray(notification.readBy)) notification.readBy = [];
    if (!notification.readBy.some((id) => id.toString() === uid.toString())) {
      notification.readBy.push(uid);
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
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    await Notification.updateMany(
      {
        recipient: uid,
        readBy: { $ne: uid },
        deletedBy: { $ne: uid },
      },
      { $addToSet: { readBy: uid } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 8. DELETE SINGLE ──
router.delete('/delete/:id', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: uid,
    });
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    if (!Array.isArray(notification.deletedBy)) notification.deletedBy = [];
    if (!notification.deletedBy.some((id) => id.toString() === uid.toString())) {
      notification.deletedBy.push(uid);
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
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const uid = toId(userId);

    await Notification.updateMany(
      { recipient: uid, deletedBy: { $ne: uid } },
      { $addToSet: { deletedBy: uid } }
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
    const {
      buildMessage,
      iconUrlForMood,
      resolveSoundKey,
      channelForToken,
      sendAllSafe,
      featureMood,
      titleWithEmoji,
    } = require('../utils/pushNotification');

    // Each EAS project with its own access token.
    const { getReceipts, projectOfEntries } = require('../utils/expoProjects');
    const expo = new Expo(
      process.env.EXPO_ACCESS_TOKEN
        ? { accessToken: process.env.EXPO_ACCESS_TOKEN }
        : {}
    );

    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ message: 'User ID required' });

    const user = await User.findById(userId).select('pushTokens').lean();
    const entries = (user?.pushTokens || []).filter((t) => t?.token);
    const tokens = entries.map((t) => t.token);

    if (!tokens.length) {
      return res.json({
        ok: false,
        problem: 'NO_TOKEN',
        fix: 'App never saved a push token. Open the built app (not Expo Go), log in, allow notifications.',
      });
    }

    const validEntries = entries.filter((e) => Expo.isExpoPushToken(e.token));
    const valid = validEntries.map((e) => e.token);
    if (!valid.length) {
      return res.json({
        ok: false,
        problem: 'NO_VALID_TOKEN',
        fix: 'The saved tokens are not Expo push tokens. Open the installed app, log in, allow notifications.',
      });
    }

    // 4 different features → 4 different emojis + sounds, so you can hear it works.
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

    const projectOf = projectOfEntries(validEntries);

    // First sample sent synchronously so we get tickets in order.
    const tickets = await sendAllSafe(expo, buildFor(SAMPLES[0]), projectOf);

    // Remaining samples 4s apart, fire-and-forget.
    SAMPLES.slice(1).forEach((sample, i) => {
      setTimeout(() => {
        sendAllSafe(expo, buildFor(sample), projectOf).catch(() => {});
      }, (i + 1) * 4000);
    });

    await new Promise((r) => setTimeout(r, 6000));

    const ids = tickets.filter((t) => t.id).map((t) => t.id);
    const receipts = ids.length
      ? await getReceipts(
          ids,
          Object.fromEntries(
            tickets.filter((t) => t.id).map((t) => [t.id, t.projectId])
          )
        )
      : {};

    const hints = {
      InvalidCredentials:
        'Upload FCM V1 service account key: eas credentials → Android → Google Service Account → FCM V1.',
      DeviceNotRegistered:
        'Token is dead (app uninstalled/reinstalled). Open the app and log in again.',
      MessageTooBig: 'Payload too large.',
      MismatchSenderId:
        'google-services.json Firebase project does not match the FCM key uploaded to EAS.',
      UNAUTHORIZED:
        "Expo refused the access token for this phone's project. Set EXPO_ACCESS_TOKEN_<PROJECTPREFIX> on Railway (a token of the account that owns the project).",
      PUSH_TOO_MANY_EXPERIENCE_IDS:
        'Tokens from several Expo projects could not be split. Log out and in on the new build.',
    };

    const results = tickets.map((t, i) => {
      const receipt = t.id ? receipts[t.id] : null;
      const err =
        t.details?.error || receipt?.details?.error || null;
      return {
        token: valid[i].slice(0, 30) + '…',
        channels: validEntries[i].channels || 'legacy',
        project: t.projectId ? String(t.projectId).slice(0, 8) : 'unknown',
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