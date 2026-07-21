// events.js - Updated with all necessary endpoints
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const admin = require('../middleware/adminMiddleware');
const { Event, Registration, EventNotification } = require('../models/Event');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');

// ─── Cloudinary Configuration ──────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'decaxpera',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── Multer Storage Configuration ──────────────────────────────────────
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'events',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 1200, height: 630, crop: 'limit' }]
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
});

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────

// GET ALL EVENTS (Public Feed)
router.get('/feed', async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ─── AUTHENTICATED ROUTES ──────────────────────────────────────────────

// GET USER'S CREATED EVENTS
router.get('/my-events', auth, async (req, res) => {
  try {
    const events = await Event.find({ creator: req.user.id }).sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch user events error:', err);
    res.status(500).json({ error: "Failed to fetch your events" });
  }
});

// GET USER'S REGISTRATIONS (with full event details)
router.get('/my-registrations', auth, async (req, res) => {
  try {
    const registrations = await Registration.find({ userId: req.user.id })
      .populate('eventId')
      .sort({ createdAt: -1 });
    
    // Return just the event IDs for checking registration status
    const registeredEventIds = registrations.map(reg => reg.eventId?._id?.toString()).filter(Boolean);
    res.json(registeredEventIds);
  } catch (err) {
    console.error('Fetch user registrations error:', err);
    res.status(500).json({ error: "Failed to fetch your registrations" });
  }
});

// GET FULL REGISTRATION DETAILS (for applied events view)
router.get('/my-registrations/details', auth, async (req, res) => {
  try {
    const registrations = await Registration.find({ userId: req.user.id })
      .populate('eventId')
      .sort({ createdAt: -1 });
    
    const appliedEvents = registrations
      .filter(reg => reg.eventId)
      .map(reg => ({
        registration: {
          _id: reg._id,
          studentName: reg.studentName,
          email: reg.email,
          whatsapp: reg.whatsapp,
          studentId: reg.studentId,
          registeredAt: reg.createdAt
        },
        event: reg.eventId
      }));
    
    res.json(appliedEvents);
  } catch (err) {
    console.error('Fetch registration details error:', err);
    res.status(500).json({ error: "Failed to fetch registration details" });
  }
});

// GET ALL NOTIFICATIONS FOR CREATOR
router.get('/notifications', auth, async (req, res) => {
  try {
    const notifications = await EventNotification.find({ creatorId: req.user.id })
      .sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET UNREAD NOTIFICATIONS COUNT
router.get('/notifications/unread/count', auth, async (req, res) => {
  try {
    const count = await EventNotification.countDocuments({ 
      creatorId: req.user.id,
      read: false 
    });
    res.json({ count });
  } catch (err) {
    console.error('Fetch unread count error:', err);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────────────

// GET ALL REGISTRATIONS (Admin only)
router.get('/all-registrations', auth, admin, async (req, res) => {
  try {
    const registrations = await Registration.find()
      .populate('eventId', 'title')
      .sort({ createdAt: -1 });
    
    const formatted = registrations.map(reg => ({
      _id: reg._id,
      studentName: reg.studentName,
      email: reg.email,
      whatsapp: reg.whatsapp,
      studentId: reg.studentId,
      eventTitle: reg.eventId?.title || 'Unknown Event',
      eventId: reg.eventId?._id,
      userId: reg.userId,
      userName: reg.userName,
      createdAt: reg.createdAt
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error('Fetch all registrations error:', err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// GET ALL EVENTS (Admin only)
router.get('/admin/events', auth, admin, async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch admin events error:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET EVENT STATS (Admin only)
router.get('/admin/events/stats', auth, admin, async (req, res) => {
  try {
    const totalEvents = await Event.countDocuments();
    const totalRegistrations = await Registration.countDocuments();
    
    res.json({
      totalEvents,
      totalRegistrations
    });
  } catch (err) {
    console.error('Fetch event stats error:', err);
    res.status(500).json({ error: 'Failed to fetch event stats' });
  }
});

// ─── PARAMETERIZED ROUTES ─────────────────────────────────────────────

// GET SINGLE EVENT
router.get('/:eventId', async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    console.error('Fetch event error:', err);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// CHECK IF USER IS REGISTERED FOR AN EVENT
router.get('/:eventId/registered', auth, async (req, res) => {
  try {
    const registration = await Registration.findOne({
      eventId: req.params.eventId,
      userId: req.user.id
    });
    res.json({ registered: !!registration });
  } catch (err) {
    console.error('Check registration error:', err);
    res.status(500).json({ error: 'Failed to check registration status' });
  }
});

// GET REGISTRATIONS FOR AN EVENT
router.get('/registrations/:eventId', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    if (event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: "You don't have permission to view these registrations" });
    }
    
    const registrations = await Registration.find({ eventId: req.params.eventId })
      .sort({ createdAt: -1 });
    
    res.json(registrations);
  } catch (err) {
    console.error('Fetch registrations error:', err);
    res.status(500).json({ error: "Failed to fetch registrations" });
  }
});

// CREATE EVENT (with image upload)
router.post('/create', auth, upload.single('image'), async (req, res) => {
  try {
    const { 
      title, organizer, city, type, description, prize, 
      deadline, location, contact, date, teamSize 
    } = req.body;

    if (!title || !organizer || !city || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    let imageUrl = 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800';
    if (req.file) {
      imageUrl = req.file.path;
    } else if (req.body.image && req.body.image.startsWith('http')) {
      imageUrl = req.body.image;
    }

    const newEvent = new Event({
      title,
      organizer,
      city,
      type,
      description: description || '',
      prize: prize || 'TBD',
      deadline: deadline || 'Limited spots',
      location: location || 'Online/Venue TBD',
      contact: contact || req.user.email || 'Not provided',
      image: imageUrl,
      date: date || 'TBA',
      teamSize: teamSize || '1-4 Members',
      creator: req.user.id,
      creatorEmail: req.user.email,
      creatorName: req.user.name || req.user.email
    });

    const event = await newEvent.save();
    res.status(201).json(event);
  } catch (err) {
    console.error('Event creation error:', err);
    res.status(400).json({ message: 'Event creation failed', error: err.message });
  }
});

// CREATE EVENT WITH BASE64 IMAGE
router.post('/create-base64', auth, async (req, res) => {
  try {
    const { 
      title, organizer, city, type, description, prize, 
      deadline, location, contact, date, teamSize, image 
    } = req.body;

    if (!title || !organizer || !city || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    let imageUrl = 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800';
    
    if (image && image.startsWith('data:image')) {
      try {
        const result = await cloudinary.uploader.upload(image, {
          folder: 'events',
          transformation: [{ width: 1200, height: 630, crop: 'limit' }]
        });
        imageUrl = result.secure_url;
      } catch (uploadError) {
        console.error('Image upload error:', uploadError);
      }
    } else if (image && image.startsWith('http')) {
      imageUrl = image;
    }

    const newEvent = new Event({
      title,
      organizer,
      city,
      type,
      description: description || '',
      prize: prize || 'TBD',
      deadline: deadline || 'Limited spots',
      location: location || 'Online/Venue TBD',
      contact: contact || req.user.email || 'Not provided',
      image: imageUrl,
      date: date || 'TBA',
      teamSize: teamSize || '1-4 Members',
      creator: req.user.id,
      creatorEmail: req.user.email,
      creatorName: req.user.name || req.user.email
    });

    const event = await newEvent.save();
    res.status(201).json(event);
  } catch (err) {
    console.error('Event creation error:', err);
    res.status(400).json({ message: 'Event creation failed', error: err.message });
  }
});

// REGISTER FOR EVENT
router.post('/register', auth, async (req, res) => {
  try {
    const { eventId, studentName, whatsapp, studentId, email } = req.body;
    
    if (!eventId || !studentName || !whatsapp) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    const existingRegistration = await Registration.findOne({ 
      eventId, 
      userId: req.user.id 
    });
    
    if (existingRegistration) {
      return res.status(400).json({ error: "You have already registered for this event" });
    }
    
    const newReg = new Registration({
      eventId,
      studentName,
      email: email || req.user.email,
      whatsapp,
      studentId: studentId || 'Not provided',
      userId: req.user.id,
      userName: req.user.name || req.user.email
    });
    await newReg.save();
    
    // Create notification for event creator
    const notification = new EventNotification({
      eventId: event._id,
      eventTitle: event.title,
      creatorId: event.creator,
      creatorEmail: event.creatorEmail,
      registrantId: req.user.id,
      registrantName: studentName,
      registrantEmail: email || req.user.email,
      registrantWhatsapp: whatsapp,
      registrantStudentId: studentId || 'Not provided',
      message: `${studentName} registered for your event: ${event.title}`,
      type: 'new_registration',
      read: false
    });
    await notification.save();
    
    res.status(201).json({ 
      message: "Registration successful! Creator will be notified." 
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(400).json({ error: "Registration failed", details: err.message });
  }
});

// CANCEL REGISTRATION
router.delete('/register/:eventId', auth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const registration = await Registration.findOneAndDelete({
      eventId,
      userId: req.user.id
    });
    
    if (!registration) {
      return res.status(404).json({ error: "Registration not found" });
    }
    
    // Delete associated notification
    await EventNotification.findOneAndDelete({
      eventId,
      registrantId: req.user.id,
      type: 'new_registration'
    });
    
    res.json({ message: "Registration cancelled successfully" });
  } catch (err) {
    console.error('Cancel registration error:', err);
    res.status(500).json({ error: "Failed to cancel registration" });
  }
});

// UPDATE EVENT
router.put('/event/:eventId', auth, upload.single('image'), async (req, res) => {
  try {
    const { eventId } = req.params;
    const updates = req.body;
    
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (req.file) {
      updates.image = req.file.path;
    }
    
    const updated = await Event.findByIdAndUpdate(eventId, updates, { new: true });
    res.json(updated);
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE EVENT
router.delete('/event/:eventId', auth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await Registration.deleteMany({ eventId });
    await EventNotification.deleteMany({ eventId });
    await Event.findByIdAndDelete(eventId);
    
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// MARK NOTIFICATION AS READ
router.put('/notifications/:id/read', auth, async (req, res) => {
  try {
    const notification = await EventNotification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    if (notification.creatorId.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    notification.read = true;
    await notification.save();
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    console.error('Mark notification error:', err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// MARK ALL NOTIFICATIONS AS READ
router.put('/notifications/mark-all-read', auth, async (req, res) => {
  try {
    await EventNotification.updateMany(
      { creatorId: req.user.id, read: false },
      { read: true }
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error('Mark all notifications error:', err);
    res.status(500).json({ error: "Failed to mark all notifications as read" });
  }
});

module.exports = router;