const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  organizer: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  type: { type: String, required: true },
  description: { type: String, default: '' },
  prize: { type: String, default: 'TBD' },
  deadline: { type: String, default: 'Limited spots' },
  location: { type: String, default: 'Online/Venue TBD' },
  contact: { type: String, default: '' },
  image: { type: String, default: 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800' },
  date: { type: String, default: 'TBA' },
  teamSize: { type: String, default: '1-4 Members' },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorEmail: { type: String, required: true },
  creatorName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

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

// Create indexes for better query performance
RegistrationSchema.index({ eventId: 1, userId: 1 }, { unique: true });
EventNotificationSchema.index({ creatorId: 1, createdAt: -1 });
EventNotificationSchema.index({ creatorId: 1, read: 1 });

const Event = mongoose.model('Event', EventSchema);
const Registration = mongoose.model('Registration', RegistrationSchema);
const EventNotification = mongoose.model('EventNotification', EventNotificationSchema);

module.exports = { Event, Registration, EventNotification };