// models/Booking.js
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    required: true,
  },
  packageName: {
    type: String,
    required: true,
  },
  packageCategory: String,
  packageLocation: String,
  packagePrice: Number,
  customerName: {
    type: String,
    required: true,
  },
  customerEmail: {
    type: String,
    required: true,
    lowercase: true,
  },
  customerPhone: {
    type: String,
    required: true,
  },
  travelDate: {
    type: Date,
    required: true,
  },
  numberOfTravelers: {
    type: Number,
    required: true,
    min: 1,
  },
  totalAmount: {
    type: Number,
    required: true,
  },
  specialRequests: String,
  paymentMethod: {
    type: String,
    enum: ['Cash on Delivery', 'Credit Card', 'Bank Transfer'],
    default: 'Cash on Delivery',
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed'],
    default: 'pending',
  },
  bookingDate: {
    type: Date,
    default: Date.now,
  },
  adminNotes: String,
}, {
  timestamps: true,
});

module.exports = mongoose.model('Booking', bookingSchema);