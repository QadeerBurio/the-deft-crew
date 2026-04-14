const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { Event, Registration, EventNotification } = require('../models/Event');

// GET ALL EVENTS
router.get('/feed', async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

// CREATE EVENT
router.post('/create', auth, async (req, res) => {
  try {
    const { 
      title, organizer, city, type, description, prize, 
      deadline, location, contact, image, date, teamSize 
    } = req.body;

    if (!title || !organizer || !city || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
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
      image: image || 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800',
      date: date || 'TBA',
      teamSize: teamSize || '1-4 Members',
      creator: req.user.id,
      creatorEmail: req.user.email,
      creatorName: req.user.name
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
      userName: req.user.name
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

// GET USER'S CREATED EVENTS (Events where user is the creator)
router.get('/my-events', auth, async (req, res) => {
  try {
    const events = await Event.find({ creator: req.user.id }).sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch user events error:', err);
    res.status(500).json({ error: "Failed to fetch your events" });
  }
});

// GET REGISTRATIONS FOR AN EVENT (For event creator - shows who registered for their event)
router.get('/registrations/:eventId', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    // Check if user is the event creator
    if (event.creator.toString() !== req.user.id) {
      return res.status(403).json({ error: "You don't have permission to view these registrations" });
    }
    
    // Get all registrations for this event (students who registered)
    const registrations = await Registration.find({ eventId: req.params.eventId })
      .sort({ createdAt: -1 });
    
    res.json(registrations);
  } catch (err) {
    console.error('Fetch registrations error:', err);
    res.status(500).json({ error: "Failed to fetch registrations" });
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

// MARK NOTIFICATION AS READ
router.put('/notifications/:id/read', auth, async (req, res) => {
  try {
    const notification = await EventNotification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    if (notification.creatorId.toString() !== req.user.id) {
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

// GET USER'S OWN REGISTRATIONS (Events user registered for)
router.get('/my-registrations', auth, async (req, res) => {
  try {
    const registrations = await Registration.find({ userId: req.user.id })
      .populate('eventId')
      .sort({ createdAt: -1 });
    res.json(registrations);
  } catch (err) {
    console.error('Fetch user registrations error:', err);
    res.status(500).json({ error: "Failed to fetch your registrations" });
  }
});

module.exports = router;