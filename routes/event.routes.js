const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth.middleware');
const { Event, Registration, EventNotification } = require('../models/Event');
const eventAggregator = require('../services/events/eventAggregator');
const eventCleanup = require('../services/events/eventCleanup');
const { importEventsToDatabase } = require('../services/events/csvImporter');
const { track } = require('../services/engagement');

// ============================================================
// HELPERS
// ============================================================

// Auth middleware may set req.user.id, req.user._id, or req.userId
const getUserId = (req) => {
  return req.user?.id || req.user?._id || req.userId || null;
};

// Admin role check middleware
const isAdmin = (req, res, next) => {
  const role = req.user?.role || req.userRole;
  if (!req.user || req.isGuest || role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Access denied. Admin role required.' });
  }
  next();
};

// ============================================================
// MULTER — CSV / XLSX uploads
// ============================================================
const uploadCsvMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.csv', '.xlsx', '.xls'];
    const allowedMimetypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
      'application/csv',
    ];
    if (allowedExts.includes(ext) || allowedMimetypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE'));
    }
  },
});

// ============================================================
// PUBLIC & USER FEED ENDPOINTS
// ============================================================

router.get('/feed', async (req, res) => {
  try {
    const {
      category,
      search,
      timeframe,
      isFree,
      sort = 'newest',
      page = 1,
      limit = 100,
       city, 
    } = req.query;

    const query = {
      isExpired: false,
      status: { $ne: 'rejected' },
    };
     // 👇 City filter
    if (city && city !== 'All') {
      query.city = new RegExp(`^${city}$`, 'i');   // case-insensitive exact match
    }

    if (category && category !== 'All') {
      query.$or = [
        { type: new RegExp(`^${category}$`, 'i') },
        { categories: new RegExp(`^${category}$`, 'i') },
      ];
    }

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
            { searchKeywords: searchRegex },
          ],
        },
      ];
    }

    if (timeframe) {
      const now = new Date();
      let startRange, endRange;

      if (timeframe === 'today') {
        startRange = new Date(now.setHours(0, 0, 0, 0));
        endRange = new Date(now.setHours(23, 59, 59, 999));
      } else if (timeframe === 'tomorrow') {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        startRange = new Date(tomorrow.setHours(0, 0, 0, 0));
        endRange = new Date(tomorrow.setHours(23, 59, 59, 999));
      } else if (timeframe === 'this_week') {
        startRange = new Date(now.setHours(0, 0, 0, 0));
        endRange = new Date(now.getTime() + 7 * 86400000);
      } else if (timeframe === 'this_month') {
        startRange = new Date(now.setHours(0, 0, 0, 0));
        endRange = new Date(now.getTime() + 30 * 86400000);
      }

      if (startRange && endRange) {
        query.createdAt = { $gte: startRange, $lte: endRange };
      }
    }

    if (isFree !== undefined && isFree === 'true') {
      query.tags = { $in: [/free/i] };
    }

    let sortOptions = { pinned: -1, createdAt: -1 };
    if (sort === 'popular') {
      sortOptions = { featured: -1, createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      Event.find(query).sort(sortOptions).skip(skip).limit(parseInt(limit)),
      Event.countDocuments(query),
    ]);

    res.json({
      events,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
});

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

router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === '') return res.json([]);

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
        { searchKeywords: regex },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(events);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
});

router.get('/category/:category', async (req, res) => {
  try {
    const category = req.params.category;
    const events = await Event.find({
      isExpired: false,
      status: { $ne: 'rejected' },
      $or: [
        { type: new RegExp(`^${category}$`, 'i') },
        { categories: new RegExp(`^${category}$`, 'i') },
      ],
    }).sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch category error:', err);
    res.status(500).json({ message: 'Failed to fetch category events' });
  }
});

router.get('/provider/:provider', async (req, res) => {
  try {
    const provider = req.params.provider.toLowerCase();
    const events = await Event.find({
      source: provider,
      isExpired: false,
    }).sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch provider error:', err);
    res.status(500).json({ message: 'Failed to fetch provider events' });
  }
});

// ============================================================
// USER CREATION & REGISTRATION
// ============================================================

router.post('/create', auth, async (req, res) => {
  try {
    const {
      title,
      organizer,
      city,
      type,
      description,
      prize,
      deadline,
      location,
      contact,
      image,
      date,
      teamSize,
      registrationUrl,
      externalUrl,
    } = req.body;

    if (!title || !organizer || !city || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const regUrl = registrationUrl || externalUrl || '';
    const extUrl = externalUrl || registrationUrl || '';
    const userId = getUserId(req);

    const newEvent = new Event({
      title,
      organizer,
      city: city || 'Karachi',
      type,
      description: description || '',
      prize: prize || 'TBD',
      deadline: deadline || 'Limited spots',
      location: location || 'Online/Venue TBD',
      contact: contact || req.user?.email || 'Not provided',
      image:
        image ||
        'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800',
      date: date || 'TBA',
      teamSize: teamSize || '1-4 Members',
      registrationUrl: regUrl,
      externalUrl: extUrl,
      creator: userId,
      creatorEmail: req.user?.email,
      creatorName: req.user?.name,
      source: 'manual',
      isImported: false,
      status: 'approved',
    });

    const event = await newEvent.save();
    res.status(201).json(event);
  } catch (err) {
    console.error('Event creation error:', err);
    res.status(400).json({ message: 'Event creation failed', error: err.message });
  }
});

// ============================================================
// REGISTER FOR EVENT — awwwards event_rsvp + attaches engagement
// ============================================================
router.post('/register', auth, async (req, res) => {
  try {
    const { eventId, studentName, whatsapp, studentId, email } = req.body;
    const userId = getUserId(req);

    if (!eventId || !studentName || !whatsapp) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const existingRegistration = await Registration.findOne({
      eventId,
      userId,
    });

    if (existingRegistration) {
      return res.status(400).json({
        error: 'You have already registered for this event',
        alreadyRegistered: true,
      });
    }

    const newReg = new Registration({
      eventId,
      studentName,
      email: email || req.user?.email,
      whatsapp,
      studentId: studentId || 'Not provided',
      userId,
      userName: req.user?.name,
    });
    await newReg.save();

    if (event.creator) {
      try {
        const notification = new EventNotification({
          eventId: event._id,
          eventTitle: event.title,
          creatorId: event.creator,
          creatorEmail: event.creatorEmail || 'system@tdc.app',
          registrantId: userId,
          registrantName: studentName,
          registrantEmail: email || req.user?.email,
          registrantWhatsapp: whatsapp,
          registrantStudentId: studentId || 'Not provided',
          message: `${studentName} registered for your event: ${event.title}`,
          type: 'new_registration',
          read: false,
        });
        await notification.save();
      } catch (notifErr) {
        console.warn('[events] notification create failed:', notifErr.message);
      }
    }

    // 🎯 Engagement: fire event_rsvp, attach result to response
    let engagement = null;
    try {
      engagement = await track(String(userId), 'event_rsvp', {
        meta: { eventId: event._id.toString() },
        dedupeKey: `event_rsvp:${userId}:${event._id}`,
      });
    } catch (e) {
      console.error('[engagement] event_rsvp hook failed:', e.message);
    }

    return res.status(201).json({
      message: 'Registration successful! Organizer notified.',
      registration: {
        _id: newReg._id,
        eventId: event._id,
        studentName,
        email: email || req.user?.email,
        whatsapp,
        studentId: studentId || 'Not provided',
        createdAt: newReg.createdAt,
      },
      engagement: engagement || undefined,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(400).json({ error: 'Registration failed', details: err.message });
  }
});

// ============================================================
// CANCEL REGISTRATION
// ============================================================
router.delete('/register/:eventId', auth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const registration = await Registration.findOneAndDelete({
      eventId,
      userId,
    });

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    try {
      await EventNotification.deleteMany({
        eventId,
        registrantId: userId,
        type: 'new_registration',
      });
    } catch (e) {
      console.warn('[events] notification cleanup failed:', e.message);
    }

    res.json({ success: true, message: 'Registration cancelled' });
  } catch (err) {
    console.error('Cancel registration error:', err);
    res.status(500).json({ error: 'Failed to cancel registration' });
  }
});

// ============================================================
// GET USER'S CREATED EVENTS
// ============================================================
router.get('/my-events', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const events = await Event.find({ creator: userId }).sort({ createdAt: -1 });
    res.json(events);
  } catch (err) {
    console.error('Fetch user events error:', err);
    res.status(500).json({ error: 'Failed to fetch your events' });
  }
});

// ============================================================
// GET REGISTRATIONS FOR AN EVENT
// ============================================================
router.get('/registrations/:eventId', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const role = req.user?.role || req.userRole;
    if (
      event.creator &&
      event.creator.toString() !== userId &&
      role !== 'admin'
    ) {
      return res
        .status(403)
        .json({ error: "You don't have permission to view these registrations" });
    }

    const registrations = await Registration.find({
      eventId: req.params.eventId,
    }).sort({ createdAt: -1 });

    res.json(registrations);
  } catch (err) {
    console.error('Fetch registrations error:', err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// ============================================================
// NOTIFICATIONS
// ============================================================
router.get('/notifications', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const notifications = await EventNotification.find({ creatorId: userId })
      .sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.get('/notifications/unread/count', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const count = await EventNotification.countDocuments({
      creatorId: userId,
      read: false,
    });
    res.json({ count });
  } catch (err) {
    console.error('Fetch unread count error:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

router.put('/notifications/:id/read', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const notification = await EventNotification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    if (notification.creatorId.toString() !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    notification.read = true;
    await notification.save();
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error('Mark notification error:', err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// ============================================================
// MY REGISTRATIONS
// ============================================================
router.get('/my-registrations', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const registrations = await Registration.find({ userId })
      .populate('eventId')
      .sort({ createdAt: -1 });
    res.json(registrations);
  } catch (err) {
    console.error('Fetch user registrations error:', err);
    res.status(500).json({ error: 'Failed to fetch your registrations' });
  }
});

// Alias — returns the same data shaped as { event, registration }[]
router.get('/my-registrations/details', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const registrations = await Registration.find({ userId })
      .populate('eventId')
      .sort({ createdAt: -1 });

    const shaped = registrations
      .filter((r) => r.eventId && typeof r.eventId === 'object')
      .map((r) => ({
        event: r.eventId,
        registration: r,
      }));

    res.json(shaped);
  } catch (err) {
    console.error('Fetch user registrations details error:', err);
    res.status(500).json({ error: 'Failed to fetch your registrations' });
  }
});

// ============================================================
// UPDATE & DELETE
// ============================================================
const updateEventController = async (req, res) => {
  try {
    const userId = getUserId(req);
    const role = req.user?.role || req.userRole;
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (
      event.creator &&
      event.creator.toString() !== userId &&
      role !== 'admin'
    ) {
      return res
        .status(403)
        .json({ message: 'Unauthorized to update this event' });
    }

    const fieldsToUpdate = [
      'title', 'organizer', 'city', 'type', 'description', 'prize',
      'deadline', 'location', 'contact', 'image', 'date', 'teamSize',
      'externalUrl', 'registrationUrl', 'verified', 'featured', 'pinned',
    ];

    fieldsToUpdate.forEach((field) => {
      if (req.body[field] !== undefined) {
        event[field] = req.body[field];
      }
    });

    const updatedEvent = await event.save();
    res.json({ message: 'Event updated successfully', event: updatedEvent });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ message: 'Failed to update event', error: err.message });
  }
};

const deleteEventController = async (req, res) => {
  try {
    const userId = getUserId(req);
    const role = req.user?.role || req.userRole;
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (
      event.creator &&
      event.creator.toString() !== userId &&
      role !== 'admin'
    ) {
      return res
        .status(403)
        .json({ message: 'Unauthorized to delete this event' });
    }

    await Event.findByIdAndDelete(req.params.id);
    await Registration.deleteMany({ eventId: req.params.id });
    await EventNotification.deleteMany({ eventId: req.params.id });

    res.json({ message: 'Event and associated registrations deleted successfully' });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ message: 'Failed to delete event', error: err.message });
  }
};

router.put('/:id', auth, updateEventController);
router.put('/event/:id', auth, updateEventController);
router.delete('/:id', auth, deleteEventController);
router.delete('/event/:id', auth, deleteEventController);

// ============================================================
// SINGLE EVENT DETAILS
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// ============================================================
// ADMIN & AUTOMATION
// ============================================================
router.post('/sync', auth, async (req, res) => {
  try {
    const { provider } = req.body;
    console.log(`⚡ [API] Manual sync triggered for provider: ${provider || 'All'}`);
    const result = await eventAggregator.runAggregation(provider);
    res.json({ message: 'Sync triggered successfully', result });
  } catch (err) {
    console.error('Manual sync trigger error:', err);
    res.status(500).json({ message: 'Sync failed', error: err.message });
  }
});

router.get('/admin/stats', auth, async (req, res) => {
  try {
    const [
      totalEvents,
      importedEvents,
      pending,
      expiredEvents,
      hiddenEvents,
      totalRegistrations,
      eventsPerProviderRaw,
    ] = await Promise.all([
      Event.countDocuments({}),
      Event.countDocuments({ isImported: true }),
      Event.countDocuments({ status: 'pending' }),
      Event.countDocuments({ isExpired: true }),
      Event.countDocuments({
        $or: [{ status: 'rejected' }, { isExpired: true }],
      }),
      Registration.countDocuments({}),
      Event.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]),
    ]);

    const eventsPerProvider = {};
    eventsPerProviderRaw.forEach((item) => {
      eventsPerProvider[item._id || 'manual'] = item.count;
    });

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
      aggregationEngine: stats,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ message: 'Failed to fetch admin stats' });
  }
});

router.patch('/admin/moderate/:id', auth, async (req, res) => {
  try {
    const { status, verified, featured, pinned } = req.body;
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (status) event.status = status;
    if (verified !== undefined) event.verified = verified;
    if (featured !== undefined) event.featured = featured;
    if (pinned !== undefined) event.pinned = pinned;

    await event.save();
    res.json({ message: 'Event moderation status updated', event });
  } catch (err) {
    console.error('Moderation error:', err);
    res.status(500).json({ message: 'Moderation update failed' });
  }
});

router.patch('/expire', auth, async (req, res) => {
  try {
    const count = await eventCleanup.expirePastEvents();
    res.json({
      message: `Expiration scan completed. Flagged ${count} events.`,
      count,
    });
  } catch (err) {
    res.status(500).json({ message: 'Expiration pass failed' });
  }
});

router.delete('/expired', auth, async (req, res) => {
  try {
    const count = await eventCleanup.purgeExpiredEvents();
    res.json({ message: `Purged ${count} expired events.`, count });
  } catch (err) {
    res.status(500).json({ message: 'Purge failed' });
  }
});

router.post(
  '/admin/import-csv',
  auth,
  isAdmin,
  (req, res, next) => {
    uploadCsvMulter.single('file')(req, res, (err) => {
      if (err) {
        if (
          err.message === 'INVALID_FILE_TYPE' ||
          err.code === 'LIMIT_UNEXPECTED_FILE'
        ) {
          return res.status(400).json({
            success: false,
            message: 'Invalid file type. Only .csv and .xlsx files are allowed.',
          });
        }
        return res
          .status(400)
          .json({ success: false, message: err.message || 'File upload failed.' });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded. Please attach a .csv or .xlsx file.',
        });
      }

      const fileSource = req.file.buffer || req.file.path;
      const result = await importEventsToDatabase(
        fileSource,
        req.file.originalname
      );

      if (req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupErr) {
          console.warn('⚠️ Temp file cleanup failed:', cleanupErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        added: result.added,
        skipped: result.skipped,
      });
    } catch (err) {
      console.error('❌ Error in /admin/import-csv endpoint:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Internal server error' });
    }
  }
);
// ============================================================
// TRACK EXTERNAL EVENT OPEN — awards event_rsvp points
// Used when user taps "Open Link" on an imported/CSV event.
// No Registration row is created (there's nothing to track inside TDC).
// The dedupeKey ensures the user can only earn points once per event.
// ============================================================
router.post('/track-external/:eventId', auth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const event = await Event.findById(eventId).select('_id title isImported source');
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // 🎯 Fire event_rsvp — the engagement engine dedupes by
    //    `${userId}:${eventId}` so the user only earns points once per event.
    let engagement = null;
    try {
      engagement = await track(String(userId), 'event_rsvp', {
        meta: { eventId: event._id.toString(), viaExternal: true },
        dedupeKey: `event_rsvp:${userId}:${event._id}`,
      });
    } catch (e) {
      console.error('[engagement] external event_rsvp hook failed:', e.message);
    }

    return res.json({
      success: true,
      message: 'External event opened — points awarded',
      engagement: engagement || undefined,
    });
  } catch (err) {
    console.error('Track external event error:', err);
    res.status(500).json({ error: 'Failed to track external event', details: err.message });
  }
});
// ============================================================
// GET DISTINCT CATEGORIES (type + categories[] + tags[])
// Mirrors how cities are derived — used by the mobile client
// to build the category filter chips dynamically.
// ============================================================
router.get('/categories', async (req, res) => {
  try {
    const [types, cats, tags] = await Promise.all([
      Event.distinct('type', { isExpired: false, status: { $ne: 'rejected' } }),
      Event.distinct('categories', { isExpired: false, status: { $ne: 'rejected' } }),
      Event.distinct('tags', { isExpired: false, status: { $ne: 'rejected' } }),
    ]);

    const set = new Set();
    const push = (v) => {
      if (!v) return;
      const s = String(v).trim();
      if (s && s.toLowerCase() !== 'general') set.add(s);
    };

    (types || []).forEach(push);
    (cats  || []).forEach(push);
    (tags  || []).forEach(push);

    const categories = Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );

    res.json({ categories });
  } catch (err) {
    console.error('Fetch categories error:', err);
    res.status(500).json({ message: 'Failed to fetch categories' });
  }
});
router.get('/cities', async (req, res) => {
  try {
    const cities = await Event.distinct('city', {
      isExpired: false,
      status: { $ne: 'rejected' },
      city: { $ne: '' },
    });
    const cleaned = (cities || [])
      .map((c) => (c || '').toString().trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    res.json({ cities: cleaned });
  } catch (err) {
    console.error('Fetch cities error:', err);
    res.status(500).json({ message: 'Failed to fetch cities' });
  }
});
module.exports = router;