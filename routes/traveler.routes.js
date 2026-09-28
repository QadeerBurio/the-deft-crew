const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Package = require('../models/Package');
const auth = require('../middleware/auth.middleware');
const User = require('../models/User');

// ============================================================
// HELPER
// ============================================================
const getUserId = (req) => {
  return req.user?._id || req.user?.id || req.userId || null;
};

// ============================================================
// GET — All active packages (browse)
// ============================================================
router.get('/packages', auth, async (req, res) => {
  try {
    const packages = await Package.find({ active: { $ne: false } })
      .sort({ createdAt: -1 })
      .select('-__v');
    res.json(packages);
  } catch (error) {
    console.error('Error fetching packages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch packages',
      error: error.message,
    });
  }
});

// ============================================================
// GET — Traveler's bookings (READ-ONLY — no engagement hook here)
// ============================================================
router.get('/bookings', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const bookings = await Booking.find({
      $or: [
        { userId: userId },
        { customerEmail: req.user?.email },
      ],
    })
      .populate('packageId', 'name location image price')
      .sort({ createdAt: -1 });

    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message,
    });
  }
});

// ============================================================
// POST — Create new booking (awards trip_booked +50 pts)
// ============================================================
router.post('/bookings', auth, async (req, res) => {
  try {
    const {
      packageId,
      packageName,
      travelDate,
      numberOfTravelers,
      totalAmount,
      specialRequests,
    } = req.body;

    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!packageId || !packageName || !travelDate || !totalAmount) {
      return res.status(400).json({
        message:
          'Missing required fields: packageId, packageName, travelDate, totalAmount',
      });
    }

    const pkg = await Package.findById(packageId);
    if (!pkg) {
      return res.status(404).json({ message: 'Package not found' });
    }

    const booking = new Booking({
      userId,
      packageId,
      packageName,
      customerName: req.user?.name,
      customerEmail: req.user?.email,
      travelDate,
      numberOfTravelers: numberOfTravelers || 1,
      totalAmount,
      specialRequests,
      status: 'pending',
    });

    await booking.save();

    // Notify admin (optional, non-blocking)
    try {
      const Notification = require('../models/Notification');
      await Notification.create({
        recipient: null,
        title: 'New Booking Received',
        description: `${req.user?.name || 'A traveler'} booked ${packageName}`,
        type: 'Booking',
        icon: 'ticket',
        link: booking._id.toString(),
      });
    } catch (notifError) {
      console.error('Notification creation failed:', notifError.message);
    }

    // 🎯 Engagement: fire trip_booked +50 pts
    let engagement = null;
    try {
      const { track } = require('../services/engagement');
      engagement = await track(String(userId), 'trip_booked', {
        meta: {
          bookingId: booking._id.toString(),
          packageId: String(packageId),
        },
        dedupeKey: `trip_book:${userId}:${booking._id}`,
      });
    } catch (e) {
      console.error('[engagement] trip_booked hook failed:', e.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: booking,
      engagement: engagement || undefined,
    });
  } catch (error) {
    console.error('Booking creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message,
    });
  }
});

// ============================================================
// POST — Travel chatbot prompt (awards travel_prompt +50 pts)
// Called once per session when user sends their first prompt.
// Idempotent per user per day (so users can't farm points).
// ============================================================
router.post('/travel-prompt', auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Build Karachi-day key so the dedupe matches the engagement engine's day boundary
    let dayKeyStr;
    try {
      const { dayKey } = require('../utils/karachiTime');
      dayKeyStr = dayKey();
    } catch (e) {
      // Fallback to UTC date if karachiTime util isn't available
      dayKeyStr = new Date().toISOString().slice(0, 10);
    }

    // 🎯 Fire travel_prompt — engine recognizes this as a 'traveling' card sort
    let engagement = null;
    try {
      const { track } = require('../services/engagement');
      engagement = await track(String(userId), 'travel_prompt', {
        meta: { source: 'chatbot' },
        dedupeKey: `travel_prompt:${userId}:${dayKeyStr}`,
      });
    } catch (e) {
      console.error('[engagement] travel_prompt hook failed:', e.message);
    }

    return res.json({
      success: true,
      message: 'Travel prompt tracked',
      engagement: engagement || undefined,
    });
  } catch (err) {
    console.error('Track travel prompt error:', err);
    res.status(500).json({ error: 'Failed to track travel prompt' });
  }
});

// ============================================================
// PUT — Cancel booking (only pending bookings can be cancelled)
// ============================================================
router.put('/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const booking = await Booking.findOne({
      _id: req.params.id,
      $or: [
        { userId: userId },
        { customerEmail: req.user?.email },
      ],
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({
        message: 'Only pending bookings can be cancelled',
      });
    }

    booking.status = 'cancelled';
    await booking.save();

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: booking,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// GET — Traveler's savings / wallet
// ============================================================
router.get('/savings', auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const bookings = await Booking.find({
      userId,
      status: { $in: ['confirmed', 'completed'] },
    });

    const savings = bookings.map((booking) => ({
      bookingId: booking._id,
      packageName: booking.packageName,
      amountSaved: booking.totalAmount * 0.1, // 10% student discount
      isActive: booking.status === 'confirmed',
      bookingDate: booking.createdAt,
    }));

    res.json(savings);
  } catch (error) {
    console.error('Error fetching savings:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// GET — Travel history (completed bookings)
// ============================================================
router.get('/history', auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const history = await Booking.find({
      userId,
      status: 'completed',
    })
      .populate('packageId', 'name location image category')
      .sort({ travelDate: -1 });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;