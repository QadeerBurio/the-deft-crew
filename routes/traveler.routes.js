const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Package = require('../models/Package');
const auth = require('../middleware/auth.middleware');
const User = require('../models/User');

// GET - Get all active packages for travelers to browse
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
      error: error.message 
    });
  }
});

// GET - Get single package details
router.get('/packages/:id', auth, async (req, res) => {
  try {
    const package = await Package.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: 'Package not found' });
    }
    res.json(package);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Get traveler's bookings
router.get('/bookings', auth, async (req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [
        { userId: req.user._id },
        { customerEmail: req.user.email }
      ]
    })
    .populate('packageId', 'name location image price')
    .sort({ createdAt: -1 });
    
    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch bookings', 
      error: error.message 
    });
  }
});

// POST - Create new booking
router.post('/bookings', auth, async (req, res) => {
  try {
    const { 
      packageId, 
      packageName, 
      travelDate, 
      numberOfTravelers, 
      totalAmount,
      specialRequests 
    } = req.body;

    // Validate required fields
    if (!packageId || !packageName || !travelDate || !totalAmount) {
      return res.status(400).json({ 
        message: 'Missing required fields: packageId, packageName, travelDate, totalAmount' 
      });
    }

    // Check if package exists
    const package = await Package.findById(packageId);
    if (!package) {
      return res.status(404).json({ message: 'Package not found' });
    }

    const booking = new Booking({
      userId: req.user._id,
      packageId,
      packageName,
      customerName: req.user.name,
      customerEmail: req.user.email,
      travelDate,
      numberOfTravelers: numberOfTravelers || 1,
      totalAmount,
      specialRequests,
      status: 'pending'
    });

    await booking.save();

    // Optional: Create notification for admin
    try {
      const Notification = require('../models/Notification');
      await Notification.create({
        recipient: null, // null means admin notification
        title: 'New Booking Received',
        description: `${req.user.name} booked ${packageName}`,
        type: 'Booking',
        icon: 'ticket',
        link: booking._id.toString()
      });
    } catch (notifError) {
      console.error('Notification creation failed:', notifError);
    }

    res.status(201).json({ 
      success: true, 
      message: 'Booking created successfully', 
      data: booking 
    });
  } catch (error) {
    console.error('Booking creation error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create booking', 
      error: error.message 
    });
  }
});

// PUT - Cancel booking (traveler can cancel pending bookings)
router.put('/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      $or: [
        { userId: req.user._id },
        { customerEmail: req.user.email }
      ]
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({ 
        message: 'Only pending bookings can be cancelled' 
      });
    }

    booking.status = 'cancelled';
    await booking.save();

    res.json({ 
      success: true, 
      message: 'Booking cancelled successfully', 
      data: booking 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Traveler's savings/wallet
router.get('/savings', auth, async (req, res) => {
  try {
    // Calculate total savings from confirmed/completed bookings
    const bookings = await Booking.find({
      userId: req.user._id,
      status: { $in: ['confirmed', 'completed'] }
    });

    const savings = bookings.map(booking => ({
      bookingId: booking._id,
      packageName: booking.packageName,
      amountSaved: booking.totalAmount * 0.1, // 10% student discount
      isActive: booking.status === 'confirmed',
      bookingDate: booking.createdAt
    }));

    res.json(savings);
  } catch (error) {
    console.error('Error fetching savings:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET - Travel history (completed bookings)
router.get('/history', auth, async (req, res) => {
  try {
    const history = await Booking.find({
      userId: req.user._id,
      status: 'completed'
    })
    .populate('packageId', 'name location image category')
    .sort({ travelDate: -1 });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;