const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { Event, Registration, EventNotification } = require('../models/Event');
const eventAggregator = require('../services/events/eventAggregator');
const eventCleanup = require('../services/events/eventCleanup');

// ==========================================
// PUBLIC & USER FEED ENDPOINTS
// ==========================================

/**
 * GET /api/events/feed
 * Enhanced public feed supporting search, category, timeframe, price filters, and pagination.
 * Excludes rejected and expired events.
 */
router.get('/feed', async (req, res) => {
  try {
    const { 
      category, 
      search, 
      timeframe, 
      isFree, 
      sort = 'newest',
      page = 1, 
      limit = 100 
    } = req.query;

    const query = {
      isExpired: false,
      status: { $ne: 'rejected' }
    };

    // Category Filter
    if (category && category !== 'All') {
      query.$or = [
        { type: new RegExp(`^${category}$`, 'i') },
        { categories: new RegExp(`^${category}$`, 'i') }
      ];
    }

    // Search Filter
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$and = [
        {
          $or: [
            { title: searchRegex },
            { description: searchRegex },
            { organizer: searchRegex },
            { location: searchRegex },
            { tags: searchRegex },
            { searchKeywords: searchRegex }
          ]
        }
      ];
    }

    // Timeframe Filter (Today, Tomorrow, This Week, This Month)
    if (timeframe) {
      const now = new Date();
      let startRange, endRange;

      if (timeframe === 'today') {
        startRange = new Date(now.setHours(0,0,0,0));
        endRange = new Date(now.setHours(23,59,59,999));
      } else if (timeframe === 'tomorrow') {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        startRange = new Date(tomorrow.setHours(0,0,0,0));
        endRange = new Date(tomorrow.setHours(23,59,59,999));
      } else if (timeframe === 'this_week') {
        startRange = new Date(now.setHours(0,0,0,0));
        endRange = new Date(now.getTime() + 7 * 86400000);
      } else if (timeframe === 'this_month') {
        startRange = new Date(now.setHours(0,0,0,0));
        endRange = new Date(now.getTime() + 30 * 86400000);
      }

      if (startRange && endRange) {
        query.createdAt = { $gte: startRange, $lte: endRange };
      }
    }

    // Price Filter
    if (isFree !== undefined) {
      if (isFree === 'true') {
        query.tags = { $in: [/free/i] };
      }
    }

    // Sorting
    let sortOptions = { pinned: -1, createdAt: -1 };
    if (sort === 'popular') {
      sortOptions = { featured: -1, createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      Event.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit)),
      Event.countDocuments(query)
    ]);

    res.json({
      events,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
});

/**
 * GET /api/events/latest
 * Get top 10 newest imported & active events
 */
router.get('/latest', async (req, res) => {
  try {
    const events = await Event.find({ isExpired: false, status: 'approved' })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json(events);
  } catch (err) {
    console.error('Fetch latest events error:', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

/**
 * GET /api/events/search
 * Full text search endpoint
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === '') {
      return res.json([]);
    }
    const regex = new RegExp(q.trim(), 'i');
    const events = await Event.find({
      isExpired: false,
      status: { $ne: 'rejected' },
      $or: [
        { title: regex },
        { description: regex },
        { organizer: regex },
        { location: regex },
        { tags: regex },
        { searchKeywords: regex }
      ]
    }).sort({ createdAt: -1 }).limit(50);

    res.json(events);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
});

/**
 * GET /api/events/category/:category
 */
router.get('/category/:category', async (req, res) => {
  try {
    const category = req.params.category;
    const events = await Event.find({
      isExpired: false,
      status: { $ne: 'rejected' },
      $or: [
        { type: new RegExp(`^${category}$`, 'i') },
        { categories: new RegExp(`^${category}$`, 'i') }
      ]
    }).sort({ createdAt: -1 });

    res.json(events);
  } catch (err) {
    console.error('Fetch category error:', err);
    res.status(500).json({ message: 'Failed to fetch category events' });
  }
});

/**
 * GET /api/events/provider/:provider
 */
router.get('/provider/:provider', async (req, res) => {
  try {
    const provider = req.params.provider.toLowerCase();
    const events = await Event.find({
      source: provider,
      isExpired: false
    }).sort({ createdAt: -1 });

    res.json(events);
  } catch (err) {
    console.error('Fetch provider error:', err);
    res.status(500).json({ message: 'Failed to fetch provider events' });
  }
});

// ==========================================
// USER CREATION & REGISTRATION
// ==========================================

// CREATE EVENT
router.post('/create', auth, async (req, res) => {
  try {
    const { 
      title, organizer, city, type, description, prize, 
      deadline, location, contact, image, date, teamSize,
      registrationUrl, externalUrl 
    } = req.body;

    if (!title || !organizer || !city || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const regUrl = registrationUrl || externalUrl || '';
    const extUrl = externalUrl || registrationUrl || '';

    const newEvent = new Event({
      title,
      organizer,
      city: city || 'Karachi',
      type,
      description: description || '',
      prize: prize || 'TBD',
      deadline: deadline || 'Limited spots',
      location: location || 'Online/Venue TBD',
      contact: contact || req.user.email || 'Not provided',
      image: image || 'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800',
      date: date || 'TBA',
      teamSize: teamSize || '1-4 Members',
      registrationUrl: regUrl,
      externalUrl: extUrl,
      creator: req.user.id,
      creatorEmail: req.user.email,
      creatorName: req.user.name,
      source: 'manual',
      isImported: false,
      status: 'approved'
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
    
    // Create notification if creator exists
    if (event.creator) {
      const notification = new EventNotification({
        eventId: event._id,
        eventTitle: event.title,
        creatorId: event.creator,
        creatorEmail: event.creatorEmail || 'system@tdc.app',
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
    }
    
    res.status(201).json({ 
      message: "Registration successful! Organizer notified." 
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(400).json({ error: "Registration failed", details: err.message });
  }
});

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

// GET REGISTRATIONS FOR AN EVENT
router.get('/registrations/:eventId', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    if (event.creator && event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: "You don't have permission to view these registrations" });
    }
    
    const registrations = await Registration.find({ eventId: req.params.eventId }).sort({ createdAt: -1 });
    res.json(registrations);
  } catch (err) {
    console.error('Fetch registrations error:', err);
    res.status(500).json({ error: "Failed to fetch registrations" });
  }
});

// GET ALL NOTIFICATIONS FOR CREATOR
router.get('/notifications', auth, async (req, res) => {
  try {
    const notifications = await EventNotification.find({ creatorId: req.user.id }).sort({ createdAt: -1 });
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

// GET USER'S OWN REGISTRATIONS
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

// ==========================================
// AUDIT FIXES: UPDATE & DELETE ENDPOINTS
// ==========================================

const updateEventController = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.creator && event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Unauthorized to update this event" });
    }

    const fieldsToUpdate = [
      'title', 'organizer', 'city', 'type', 'description', 'prize', 
      'deadline', 'location', 'contact', 'image', 'date', 'teamSize',
      'externalUrl', 'registrationUrl', 'verified', 'featured', 'pinned'
    ];

    fieldsToUpdate.forEach(field => {
      if (req.body[field] !== undefined) {
        event[field] = req.body[field];
      }
    });

    const updatedEvent = await event.save();
    res.json({ message: "Event updated successfully", event: updatedEvent });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ message: "Failed to update event", error: err.message });
  }
};

const deleteEventController = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.creator && event.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Unauthorized to delete this event" });
    }

    await Event.findByIdAndDelete(req.params.id);
    await Registration.deleteMany({ eventId: req.params.id });
    await EventNotification.deleteMany({ eventId: req.params.id });

    res.json({ message: "Event and associated registrations deleted successfully" });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ message: "Failed to delete event", error: err.message });
  }
};

// PUT /api/events/:id AND /api/events/event/:id
router.put('/:id', auth, updateEventController);
router.put('/event/:id', auth, updateEventController);

// DELETE /api/events/:id AND /api/events/event/:id
router.delete('/:id', auth, deleteEventController);
router.delete('/event/:id', auth, deleteEventController);

// Single Event Details
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// ADMIN & AUTOMATION ENDPOINTS
// ==========================================

/**
 * POST /api/events/sync
 * Trigger manual sync pass for all or specified provider
 */
router.post('/sync', auth, async (req, res) => {
  try {
    const { provider } = req.body;
    console.log(`⚡ [API] Manual sync triggered for provider: ${provider || 'All'}`);
    
    // Run in background or wait for completion
    const result = await eventAggregator.runAggregation(provider);
    res.json({
      message: "Sync triggered successfully",
      result
    });
  } catch (err) {
    console.error('Manual sync trigger error:', err);
    res.status(500).json({ message: "Sync failed", error: err.message });
  }
});

/**
 * GET /api/events/admin/stats
 * Admin dashboard overview stats
 */
router.get('/admin/stats', auth, async (req, res) => {
  try {
    const [totalEvents, importedEvents, pending, expiredEvents, hiddenEvents, totalRegistrations, eventsPerProviderRaw] = await Promise.all([
      Event.countDocuments({}),
      Event.countDocuments({ isImported: true }),
      Event.countDocuments({ status: 'pending' }),
      Event.countDocuments({ isExpired: true }),
      Event.countDocuments({ $or: [{ status: 'rejected' }, { isExpired: true }] }),
      Registration.countDocuments({}),
      Event.aggregate([
        { $group: { _id: '$source', count: { $sum: 1 } } }
      ])
    ]);

    const eventsPerProvider = {};
    eventsPerProviderRaw.forEach(item => {
      eventsPerProvider[item._id || 'manual'] = item.count;
    });

    console.log(`📊 [MongoDB Event Stats]\n   Total Events: ${totalEvents}\n   Imported Events: ${importedEvents}\n   Expired Events: ${expiredEvents}\n   Hidden Events: ${hiddenEvents}\n   Events Per Provider:`, eventsPerProvider);

    const stats = eventAggregator.getAggregationStats();

    res.json({
      total: totalEvents,
      totalEvents,
      imported: importedEvents,
      importedEvents,
      pending,
      expired: expiredEvents,
      expiredEvents,
      hiddenEvents,
      totalRegistrations,
      eventsPerProvider,
      aggregationEngine: stats
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ message: "Failed to fetch admin stats" });
  }
});

/**
 * PATCH /api/events/admin/moderate/:id
 * Moderate event (approve, reject, feature, pin, verify)
 */
router.patch('/admin/moderate/:id', auth, async (req, res) => {
  try {
    const { status, verified, featured, pinned } = req.body;
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found" });

    if (status) event.status = status;
    if (verified !== undefined) event.verified = verified;
    if (featured !== undefined) event.featured = featured;
    if (pinned !== undefined) event.pinned = pinned;

    await event.save();
    res.json({ message: "Event moderation status updated", event });
  } catch (err) {
    console.error('Moderation error:', err);
    res.status(500).json({ message: "Moderation update failed" });
  }
});

/**
 * PATCH /api/events/expire
 * Trigger immediate expiration scan
 */
router.patch('/expire', auth, async (req, res) => {
  try {
    const count = await eventCleanup.expirePastEvents();
    res.json({ message: `Expiration scan completed. Flagged ${count} events.`, count });
  } catch (err) {
    res.status(500).json({ message: "Expiration pass failed" });
  }
});

/**
 * DELETE /api/events/expired
 * Trigger immediate purge of expired events
 */
router.delete('/expired', auth, async (req, res) => {
  try {
    const count = await eventCleanup.purgeExpiredEvents();
    res.json({ message: `Purged ${count} expired events.`, count });
  } catch (err) {
    res.status(500).json({ message: "Purge failed" });
  }
});

module.exports = router;