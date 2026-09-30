const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  organizer: { type: String, required: false, trim: true, default: 'Organizer' },
  city: { type: String, required: true, trim: true,  },
  type: { type: String, required: true, default: 'General' },
  description: { type: String, default: '' },
  prize: { type: String, default: 'TBD' },
  deadline: { type: String, default: 'Limited spots' },
  location: { type: String, default: 'Online/Venue TBD' },
  contact: { type: String, default: '' },
  image: { type: String, default: 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800' },
  date: { type: String, default: 'TBA' },
  teamSize: { type: String, default: '1-4 Members' },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  creatorEmail: { type: String, required: false, default: 'system@tdc.app' },
  creatorName: { type: String, default: 'System Aggregator' },

  // Extended Automatic Aggregation Fields
  source: { type: String, default: 'manual', index: true },
  sourceId: { type: String, default: null },
  externalUrl: { type: String, default: '' },
  registrationUrl: { type: String, default: '' },
  country: { type: String, default: 'Pakistan' },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  organizerWebsite: { type: String, default: '' },
  status: {
    type: String,
    enum: ['approved', 'pending', 'rejected', 'expired'],
    default: 'approved',
    index: true
  },
  verified: { type: Boolean, default: false },
  featured: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false },
  lastSynced: { type: Date, default: Date.now },
  syncProvider: { type: String, default: '' },
  imageSource: { type: String, default: '' },
  isImported: { type: Boolean, default: false, index: true },
  isExpired: { type: Boolean, default: false, index: true },
  expiredAt: { type: Date, default: null },
  parsedDate: { type: Date, default: null },
  tags: [{ type: String }],
  categories: [{ type: String }],
  searchKeywords: [{ type: String }],

  createdAt: { type: Date, default: Date.now }
});

// Registration Schema
const RegistrationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  studentName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  whatsapp: { type: String, required: true, trim: true },
  studentId: { type: String, default: 'Not provided' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// Event Notification Schema
const EventNotificationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  eventTitle: { type: String, required: true },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorEmail: { type: String, required: true },
  registrantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  registrantName: { type: String, required: true },
  registrantEmail: { type: String, required: true },
  registrantWhatsapp: { type: String, required: true },
  registrantStudentId: { type: String, default: 'Not provided' },
  message: { type: String, required: true },
  type: { type: String, default: 'new_registration' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Create indexes for performance and aggregation lookup
EventSchema.index({ source: 1, sourceId: 1 }, { unique: true, sparse: true });
EventSchema.index({ status: 1, isExpired: 1, createdAt: -1 });
EventSchema.index({ city: 1, isExpired: 1 });
EventSchema.index({ categories: 1 });
EventSchema.index({ tags: 1 });

RegistrationSchema.index({ eventId: 1, userId: 1 }, { unique: true });
EventNotificationSchema.index({ creatorId: 1, createdAt: -1 });
EventNotificationSchema.index({ creatorId: 1, read: 1 });

const Event = mongoose.model('Event', EventSchema);
const Registration = mongoose.model('Registration', RegistrationSchema);
const EventNotification = mongoose.model('EventNotification', EventNotificationSchema);

module.exports = { Event, Registration, EventNotification };