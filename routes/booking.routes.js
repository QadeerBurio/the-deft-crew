// routes/bookings.js
const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const authMiddleware = require('../middleware/auth.middleware');

// Create new booking
router.post('/', authMiddleware, async (req, res) => {
  try {
    console.log('Creating booking for user:', req.user.email);
    
    const bookingData = {
      ...req.body,
      userId: req.user._id,
      customerEmail: req.body.customerEmail || req.user.email,
      customerName: req.body.customerName || req.user.name,
    };
    
    const booking = new Booking(bookingData);
    await booking.save();
    
    console.log('Booking created successfully:', booking._id);
    res.status(201).json(booking);
  } catch (error) {
    console.error('Booking creation error:', error);
    res.status(500).json({ message: 'Error creating booking', error: error.message });
  }
});

// Get user's bookings
router.get('/my-bookings', authMiddleware, async (req, res) => {
  try {
    console.log('Fetching bookings for user:', req.user.email);
    console.log('User ID:', req.user._id);
    
    // Find bookings by either userId or customerEmail
    let bookings = await Booking.find({ 
      $or: [
        { userId: req.user._id },
        { customerEmail: req.user.email }
      ]
    }).sort({ createdAt: -1 });
    
    console.log(`Found ${bookings.length} bookings`);
    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ message: 'Error fetching bookings', error: error.message });
  }
});

// Get booking by ID
router.get('/:id', authMiddleware, async (req, res) => {
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
    
    res.json(booking);
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ message: 'Error fetching booking', error: error.message });
  }
});

// Cancel booking (user can cancel pending bookings)
router.put('/cancel/:id', authMiddleware, async (req, res) => {
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
      return res.status(400).json({ message: 'Only pending bookings can be cancelled' });
    }
    
    booking.status = 'cancelled';
    await booking.save();
    
    res.json({ message: 'Booking cancelled successfully', booking });
  } catch (error) {
    console.error('Error cancelling booking:', error);
    res.status(500).json({ message: 'Error cancelling booking', error: error.message });
  }
});

// Debug route to see all bookings (remove in production)
router.get('/debug/all', authMiddleware, async (req, res) => {
  try {
    const bookings = await Booking.find({});
    res.json({
      userInfo: {
        id: req.user._id,
        email: req.user.email,
        name: req.user.name
      },
      totalBookings: bookings.length,
      userBookings: bookings.filter(b => 
        b.userId?.toString() === req.user._id.toString() || 
        b.customerEmail === req.user.email
      ),
      allBookings: bookings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;