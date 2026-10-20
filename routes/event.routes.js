const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth.middleware');
const { Event, Registration, EventNotification } = require('../models/Event');
const Notification = require('../models/Notification');
const eventAggregator = require('../services/events/eventAggregator');
const eventCleanup = require('../services/events/eventCleanup');
const { importEventsToDatabase } = require('../services/events/csvImporter');
const { track } = require('../services/engagement');
const { publicTemplates, getTemplate, LEGACY_REGISTRATION } = require('../config/eventCategories');
const {
  validateEventV2,
  legacyText,
  isPaid,
  isV2Body,
  checkField,
  isProjectCloudinaryUrl,
} = require('../services/events/eventValidation');
const tickets = require('../services/events/tickets');

// ============================================================
// HELPERS
// ============================================================

// Auth middleware may set req.user.id, req.user._id, or req.userId
const getUserId = (req) => {
  return req.user?.id || req.user?._id || req.userId || null;
};

// A real signed-in user. The shared auth middleware lets a missing / guest token through
// as a guest; these routes write data or return personal data, so guests get 401.
// Both keys: the app reads `error`, the admin web reads `message`.
const SIGN_IN = 'Please sign in to continue.';
const requireUser = (req, res, next) => {
  const userId = getUserId(req);
  if (req.isGuest || !req.user || !userId || userId === 'guest-user') {
    return res.status(401).json({ success: false, message: SIGN_IN, error: SIGN_IN });
  }
  next();
};

// Admin role check middleware (no token / guest → 401, signed in but not admin → 403)
const isAdmin = (req, res, next) => {
  if (req.isGuest || !req.user) {
    return res.status(401).json({ success: false, message: SIGN_IN, error: SIGN_IN });
  }
  const role = req.user?.role || req.userRole;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Access denied. Admin role required.' });
  }
  next();
};

// 400 with a plain message in both keys (app reads `error`, admin web reads `message`)
const badRequest = (res, msg, extra = {}) =>
  res.status(400).json({ success: false, message: msg, error: msg, ...extra });

const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const BASE_KEYS = new Set(['studentName', 'email', 'whatsapp', 'university', 'studentId']);

// ── registration helpers ─────────────────────────────────────
const UPDATE_APP = 'update tdc to register for this event';
const ALREADY_REGISTERED = { error: 'You have already registered for this event', alreadyRegistered: true };
const TXN_USED = 'This transaction ID has already been used for this event.';
const conflict = (res, msg, extra = {}) =>
  res.status(409).json({ success: false, message: msg, error: msg, ...extra });

// transaction IDs as banks / wallets print them: letters, digits, dashes
const normTxn = (v) => {
  const t = String(v || '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9-]{6,40}$/.test(t) ? t : null;
};

// Take `qty` seats in ONE atomic update: the capacity (and the tier's remaining
// tickets) are checked by the same findOneAndUpdate that increments the count, so two
// students can't both get the last seat. Returns the updated event, or null if full.
async function reserveSeats(eventId, qty, tierName) {
  const filter = {
    _id: eventId,
    status: 'approved',
    isExpired: { $ne: true },
    $or: [
      { capacity: null },
      { $expr: { $lte: [{ $add: [{ $ifNull: ['$registeredCount', 0] }, qty] }, '$capacity'] } },
    ],
  };
  const update = { $inc: { registeredCount: qty } };
  if (tierName) {
    filter.ticketTiers = { $elemMatch: { name: tierName, remaining: { $gte: qty } } };
    update.$inc['ticketTiers.$.remaining'] = -qty;
    update.$inc['ticketTiers.$.sold'] = qty;
  }
  return Event.findOneAndUpdate(filter, update, { returnDocument: 'after' });
}

// Give seats back (cancel, rejected payment, failed save). Never goes below zero.
async function releaseSeats(eventId, qty, tierName) {
  if (!qty) return;
  try {
    const filter = { _id: eventId, registeredCount: { $gte: qty } };
    const update = { $inc: { registeredCount: -qty } };
    if (tierName) {
      filter.ticketTiers = { $elemMatch: { name: tierName, sold: { $gte: qty } } };
      update.$inc['ticketTiers.$.remaining'] = qty;
      update.$inc['ticketTiers.$.sold'] = -qty;
    }
    await Event.updateOne(filter, update);
  } catch (e) {
    console.warn('[events] seat release failed:', e.message);
  }
}

// why reserveSeats said no, in words
async function fullMessage(eventId, tierName) {
  const ev = await Event.findById(eventId);
  if (!ev || ev.status !== 'approved' || ev.isExpired) return 'Registration for this event is closed.';
  if (tierName) {
    const t = (ev.ticketTiers || []).find((x) => x.name === tierName);
    if (t && t.remaining < 1) return `${tierName} tickets are sold out.`;
    if (t) return `Only ${t.remaining} ${tierName} tickets left.`;
  }
  return 'This event is full.';
}

// Creator or admin. An event with no creator (imported / CSV) is admin only.
const canManageEvent = (req, event) => {
  const role = req.user?.role || req.userRole;
  if (role === 'admin') return true;
  const userId = getUserId(req);
  return !!(event.creator && userId && event.creator.toString() === String(userId));
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

router.post('/create', auth, requireUser, async (req, res) => {
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

    // v2 fields (details, registrationForm, fee, ticketTiers, paymentAccounts,
    // capacity, registrationCloses). A request without them creates the event as today.
    const v2 = validateEventV2(req.body, null);
    if (v2.errors.length) return badRequest(res, v2.errors[0], { errors: v2.errors });
    // v2 create: the category's registration form (unless one was sent).
    // Legacy create (today's admin web / app): no form → today's 4 fields, so every
    // app build can still register.
    if (isV2Body(req.body) && !v2.set.registrationForm) {
      v2.set.registrationForm = getTemplate(type).registrationFields.map((f) => ({ ...f }));
    }
    const legacy = legacyText(req.body, v2.set);

    const newEvent = new Event({
      title,
      organizer,
      city: city || 'Karachi',
      type,
      description: description || '',
      prize: prize || legacy.prize || 'TBD',
      deadline: deadline || legacy.deadline || 'Limited spots',
      location: location || 'Online/Venue TBD',
      contact: contact || req.user?.email || 'Not provided',
      image:
        image ||
        'https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800',
      date: date || 'TBA',
      teamSize: teamSize || legacy.teamSize || '1-4 Members',
      registrationUrl: regUrl,
      externalUrl: extUrl,
      creator: userId,
      creatorEmail: req.user?.email,
      creatorName: req.user?.name,
      source: 'manual',
      isImported: false,
      status: 'approved',
      ...v2.set,
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
//
// Old payload { eventId, studentName, email, whatsapp, studentId } works as today for
// free events whose form has no required extra fields. Paid events, ticketed events and
// events with required extra questions need formVersion 2 (new app); older builds get a
// plain "update tdc to register for this event".
// v2 payload adds: formVersion: 2, answers, ticket { tier, quantity },
// payment { method, transactionId, receiptUrl }. The amount is computed here.
// ============================================================
router.post('/register', auth, requireUser, async (req, res) => {
  let held = null; // { eventId, qty, tier } while seats are reserved but not saved
  try {
    const { eventId, studentName, whatsapp, studentId, email } = req.body;
    const userId = getUserId(req);
    const v2 = Number(req.body.formVersion) === 2;

    if (!eventId || !studentName || !whatsapp) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!isObjectId(eventId)) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = await Event.findById(eventId).select('+paymentAccounts');
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const existingRegistration = await Registration.findOne({
      eventId,
      userId,
    });

    if (existingRegistration) {
      return res.status(400).json(ALREADY_REGISTERED);
    }

    if (event.status !== 'approved' || event.isExpired) {
      return badRequest(res, 'Registration for this event is closed.');
    }
    if (event.registrationCloses && new Date(event.registrationCloses) <= new Date()) {
      return badRequest(res, 'Registration for this event has closed.');
    }

    // base fields are base whatever the saved form says (forms saved before university
    // became a base field have it under "answers")
    const form = (event.registrationForm?.length ? event.registrationForm : LEGACY_REGISTRATION).map((f) =>
      BASE_KEYS.has(f.key) ? { ...(f.toObject ? f.toObject() : f), store: 'base' } : f
    );
    const tiers = event.ticketTiers || [];
    const paid = isPaid(event.fee, tiers);
    // old builds need an update for: a price, ticket tiers, or a required extra question.
    // Base fields (incl. university) and ticket fields never count as extra questions.
    const extraRequired = form.some((f) => f.required && f.store === 'answers');
    if (!v2 && (paid || tiers.length || extraRequired)) {
      return badRequest(res, UPDATE_APP, { updateRequired: true });
    }

    // today's fields
    const base = {
      studentName,
      email: email || req.user?.email,
      whatsapp,
      studentId: studentId || 'Not provided',
    };
    // university: optional for old payloads (kept if sent), required for formVersion 2
    const uniRaw = req.body.university ?? req.body.answers?.university;
    if (!v2 && typeof uniRaw === 'string' && uniRaw.trim()) base.university = uniRaw.trim().slice(0, 200);
    let answers;
    let ticket;
    let qty = 1;
    let payment = { status: 'not_required', amount: 0 };

    if (v2) {
      const errors = [];
      // base fields, with their formats (old payloads are not re-validated)
      for (const f of form.filter((x) => x.store === 'base')) {
        const r = checkField(f, f.key === 'university' ? uniRaw : req.body[f.key]);
        if (!r.ok) errors.push(r.error);
        else if (r.value !== undefined) base[f.key] = r.value;
      }
      // the event's questions; nothing else
      const raw = req.body.answers == null ? {} : req.body.answers;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('answers must be an object');
      } else {
        const fields = form.filter((x) => x.store === 'answers');
        const known = new Set(fields.map((x) => x.key));
        // university may still come inside answers (step 2 clients): it's read above
        Object.keys(raw).filter((k) => !known.has(k) && k !== 'university').forEach((k) => errors.push(`"${k}" is not a question on this form`));
        answers = {};
        for (const f of fields) {
          const r = checkField(f, raw[f.key]);
          if (!r.ok) errors.push(r.error);
          else if (r.value !== undefined) answers[f.key] = r.value;
        }
        if (!Object.keys(answers).length) answers = undefined;
      }
      // a copy in answers too, so admin screens that list answers show it
      if (base.university) answers = { ...(answers || {}), university: base.university };

      // ticket and amount (never trust an amount from the client)
      let amount = event.fee?.amount || 0;
      if (tiers.length) {
        const t = req.body.ticket || {};
        const tier = tiers.find((x) => x.name.toLowerCase() === String(t.tier || '').trim().toLowerCase());
        if (!tier) {
          errors.push('Choose a ticket');
        } else {
          const max = Number(event.details?.maxTicketsPerStudent) || tier.maxPerStudent || 1;
          const q = Number(t.quantity ?? 1);
          if (!Number.isInteger(q) || q < 1 || q > max) {
            errors.push(`You can book 1 to ${max} ${max === 1 ? 'ticket' : 'tickets'}`);
          } else {
            qty = q;
            ticket = { tier: tier.name, quantity: q };
            amount = (tier.price || 0) * q;
          }
        }
      }

      if (amount > 0) {
        const p = req.body.payment || {};
        const methods = (event.paymentAccounts || []).map((a) => a.method);
        const method = String(p.method || '').toLowerCase();
        if (!methods.includes(method)) errors.push('Choose how you paid');
        const txn = normTxn(p.transactionId);
        if (!txn) errors.push('Enter the transaction ID from your payment (6 to 40 letters or numbers)');
        if (p.receiptUrl && !isProjectCloudinaryUrl(p.receiptUrl)) errors.push('Upload the receipt from the app');
        payment = {
          status: 'pending',
          method,
          transactionId: txn || undefined,
          receiptUrl: p.receiptUrl ? String(p.receiptUrl).trim() : undefined,
          amount,
          submittedAt: new Date(),
        };
      }

      if (errors.length) return badRequest(res, errors[0], { errors });

      if (payment.transactionId) {
        const used = await Registration.findOne({ eventId, 'payment.transactionId': payment.transactionId });
        if (used) return conflict(res, TXN_USED);
      }
    }

    // seats: capacity / tier check and count in one atomic update
    const reserved = await reserveSeats(event._id, qty, ticket?.tier);
    if (!reserved) {
      return conflict(res, await fullMessage(event._id, ticket?.tier), { full: true });
    }
    held = { eventId: event._id, qty, tier: ticket?.tier };

    const newReg = new Registration({
      eventId,
      ...base,
      userId,
      userName: req.user?.name,
      answers,
      ticket,
      seats: qty,
      payment,
    });
    try {
      await newReg.save();
    } catch (saveErr) {
      await releaseSeats(held.eventId, held.qty, held.tier);
      held = null;
      if (saveErr?.code === 11000) {
        // the race the findOne above can't see: same reply as today
        if (saveErr.keyPattern && saveErr.keyPattern['payment.transactionId']) return conflict(res, TXN_USED);
        return res.status(400).json(ALREADY_REGISTERED);
      }
      throw saveErr;
    }
    held = null;

    // free event: the ticket is issued now (once) and sent in the background. The reply
    // stays exactly as before (old builds); the app reads tickets from my-registrations.
    if (payment.status === 'not_required') await tickets.issueAndDeliver(newReg._id);

    if (event.creator) {
      try {
        const notification = new EventNotification({
          eventId: event._id,
          eventTitle: event.title,
          creatorId: event.creator,
          creatorEmail: event.creatorEmail || 'system@tdc.app',
          registrantId: userId,
          registrantName: base.studentName,
          registrantEmail: base.email,
          registrantWhatsapp: base.whatsapp,
          registrantStudentId: base.studentId,
          message: `${base.studentName} registered for your event: ${event.title}`,
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
        studentName: base.studentName,
        email: base.email,
        whatsapp: base.whatsapp,
        studentId: base.studentId,
        university: base.university || null,
        createdAt: newReg.createdAt,
        ticket: newReg.ticket || null,
        payment: { status: payment.status, amount: payment.amount || 0, method: payment.method || null },
      },
      engagement: engagement || undefined,
    });
  } catch (err) {
    if (held) await releaseSeats(held.eventId, held.qty, held.tier);
    console.error('Registration error:', err);
    res.status(400).json({ error: 'Registration failed', details: err.message });
  }
});

// ============================================================
// CANCEL REGISTRATION
// ============================================================
router.delete('/register/:eventId', auth, requireUser, async (req, res) => {
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

    // the seats it held go back (0 for old and rejected registrations)
    await releaseSeats(registration.eventId, registration.seats || 0, registration.ticket?.tier);

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
// RESUBMIT PAYMENT PROOF — the registering student, while pending or rejected
// { transactionId, receiptUrl, method? }. A rejected registration takes its seats again.
// ============================================================
router.patch('/registrations/:id/payment-proof', auth, requireUser, async (req, res) => {
  let reservedQty = 0;
  let reg;
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Registration not found', error: 'Registration not found' });
    reg = await Registration.findById(req.params.id);
    if (!reg) return res.status(404).json({ message: 'Registration not found', error: 'Registration not found' });
    if (String(reg.userId) !== String(getUserId(req))) {
      return res.status(403).json({ message: 'This is not your registration', error: 'This is not your registration' });
    }
    const status = reg.payment?.status;
    if (status !== 'pending' && status !== 'rejected') {
      return badRequest(res, status === 'verified' ? 'This payment is already verified.' : 'This registration has no payment to update.');
    }

    const event = await Event.findById(reg.eventId).select('+paymentAccounts');
    if (!event) return res.status(404).json({ message: 'Event not found', error: 'Event not found' });

    const txn = normTxn(req.body.transactionId);
    if (!txn) return badRequest(res, 'Enter the transaction ID from your payment (6 to 40 letters or numbers)');
    if (req.body.receiptUrl && !isProjectCloudinaryUrl(req.body.receiptUrl)) return badRequest(res, 'Upload the receipt from the app');
    let method = reg.payment.method;
    if (req.body.method) {
      method = String(req.body.method).toLowerCase();
      if (!(event.paymentAccounts || []).some((a) => a.method === method)) return badRequest(res, 'Choose how you paid');
    }
    const used = await Registration.findOne({ eventId: reg.eventId, 'payment.transactionId': txn, _id: { $ne: reg._id } });
    if (used) return conflict(res, TXN_USED);

    // rejected registrations gave their seats back: take them again
    if (status === 'rejected') {
      const qty = reg.ticket?.quantity || 1;
      const ok = await reserveSeats(reg.eventId, qty, reg.ticket?.tier);
      if (!ok) return conflict(res, await fullMessage(reg.eventId, reg.ticket?.tier), { full: true });
      reservedQty = qty;
      reg.seats = qty;
    }

    reg.payment.status = 'pending';
    reg.payment.method = method;
    reg.payment.transactionId = txn;
    reg.payment.receiptUrl = req.body.receiptUrl ? String(req.body.receiptUrl).trim() : reg.payment.receiptUrl;
    reg.payment.submittedAt = new Date();
    reg.payment.reviewedBy = undefined;
    reg.payment.reviewedAt = undefined;
    reg.payment.rejectReason = undefined;
    try {
      await reg.save();
    } catch (saveErr) {
      if (reservedQty) await releaseSeats(reg.eventId, reservedQty, reg.ticket?.tier);
      reservedQty = 0;
      if (saveErr?.code === 11000) return conflict(res, TXN_USED);
      throw saveErr;
    }
    reservedQty = 0;
    res.json({ success: true, message: 'Payment proof sent. We will check it soon.', payment: { status: reg.payment.status, amount: reg.payment.amount, method: reg.payment.method } });
  } catch (err) {
    if (reservedQty && reg) await releaseSeats(reg.eventId, reservedQty, reg.ticket?.tier);
    console.error('Payment proof error:', err);
    res.status(500).json({ message: 'Could not update the payment', error: 'Could not update the payment' });
  }
});

// ============================================================
// ADMIN: VERIFY / REJECT A PAYMENT  { action: "verify" | "reject", reason }
// Reject gives the seats back; verifying a rejected one takes them again.
// The student gets a plain in-app notification.
// ============================================================
router.patch('/registrations/:id/payment', auth, isAdmin, async (req, res) => {
  try {
    const action = String(req.body?.action || '');
    if (action !== 'verify' && action !== 'reject') return badRequest(res, 'action must be "verify" or "reject"');
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Registration not found', error: 'Registration not found' });
    const reg = await Registration.findById(req.params.id);
    if (!reg) return res.status(404).json({ message: 'Registration not found', error: 'Registration not found' });

    const status = reg.payment?.status || 'not_required';
    if (status === 'not_required') return badRequest(res, 'This registration has no payment.');
    if (action === 'verify' && status === 'verified') return badRequest(res, 'Already verified.');
    if (action === 'reject' && status === 'rejected') return badRequest(res, 'Already rejected.');
    const reason = String(req.body?.reason || '').trim().slice(0, 300);

    const qty = reg.ticket?.quantity || 1;
    if (action === 'verify' && status === 'rejected') {
      const ok = await reserveSeats(reg.eventId, qty, reg.ticket?.tier);
      if (!ok) return conflict(res, await fullMessage(reg.eventId, reg.ticket?.tier), { full: true });
      reg.seats = qty;
    }

    reg.payment.status = action === 'verify' ? 'verified' : 'rejected';
    reg.payment.reviewedBy = getUserId(req);
    reg.payment.reviewedAt = new Date();
    reg.payment.rejectReason = action === 'reject' ? reason || undefined : undefined;
    const release = action === 'reject' ? reg.seats || 0 : 0;
    if (action === 'reject') reg.seats = 0;
    // reject cancels the tickets; verifying again brings the same tickets back
    tickets.applyPaymentToTickets(reg, action);
    await reg.save();
    if (release) await releaseSeats(reg.eventId, release, reg.ticket?.tier);

    // first verify: the tickets are issued (once) and their "ticket is ready" notification
    // replaces the plain one below
    let issued = false;
    if (action === 'verify') issued = (await tickets.issueAndDeliver(reg._id)).issued;

    // plain notification for the student (never blocks the review)
    try {
      const event = issued ? null : await Event.findById(reg.eventId).select('title');
      const title = event?.title || 'your event';
      if (!issued) await Notification.create({
        recipient: reg.userId,
        title: action === 'verify' ? 'payment verified' : 'payment not accepted',
        description: action === 'verify'
          ? `your payment for ${title} is verified. you're in.`
          : `your payment for ${title} wasn't accepted${reason ? `: ${reason}` : '.'} open the event to send the correct transaction id.`,
        type: 'Payment',
        mood: action === 'verify' ? 'excited' : 'urgent',
        metadata: { eventId: String(reg.eventId), registrationId: String(reg._id), paymentStatus: reg.payment.status },
      });
    } catch (e) {
      console.warn('[events] payment notification failed:', e.message);
    }

    const fresh = issued ? (await Registration.findById(reg._id)) || reg : reg;
    res.json({ success: true, message: action === 'verify' ? 'Payment verified' : 'Payment rejected', registration: adminRow(fresh) });
  } catch (err) {
    console.error('Payment review error:', err);
    res.status(500).json({ message: 'Could not update the payment', error: 'Could not update the payment' });
  }
});

// ============================================================
// TICKETS
// GET  /registrations/:id/ticket               owner or admin
// PATCH /registrations/:id/tickets/:code        admin { action: "cancel" | "restore" }
// POST /registrations/:id/tickets/resend        admin { email, push } (no new in-app record)
// POST /admin/tickets/backfill                  admin { apply, includeFree } (sends nothing)
// ============================================================
const NO_REG = { message: 'Registration not found', error: 'Registration not found' };
const isAdminReq = (req) => (req.user?.role || req.userRole) === 'admin';

// Public ticket page (the email's "download ticket"): read-only, only ticket fields.
// Limited per visitor: Railway's proxy adds the visitor's address last in X-Forwarded-For
// ("trust proxy" is not set, so req.ip would be the proxy for everyone).
const { rateLimit } = require('express-rate-limit');
const ticketPageLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.ip || 'unknown',
  handler: (req, res) => res.status(429).type('text/plain').send('too many requests. try again in a minute.'),
});
const pageHeaders = (res, nonce) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
};

router.get('/ticket/:token', ticketPageLimit, async (req, res) => {
  const nonce = require('crypto').randomBytes(16).toString('base64');
  pageHeaders(res, nonce);
  try {
    const found = await tickets.findByPageToken(req.params.token);
    // unknown, malformed, or the registration is gone: the same page, no details
    if (!found) return res.status(404).type('html').send(tickets.ticketNotFoundHtml());
    const { reg, seat } = found;
    const event = await Event.findById(reg.eventId).select('title type date location city organizer details');
    const view = tickets.ticketView(reg, event);
    // payment rejected / pending again: the ticket is not usable
    view.revoked = !tickets.hasTicketRight(reg);
    const s = view.tickets.find((t) => t.code === seat.code) || { ...seat, status: seat.status };
    res.status(200).type('html').send(tickets.ticketPageHtml(view, s, { nonce }));
  } catch (err) {
    console.error('Ticket page error:', err.message);
    res.status(500).type('text/plain').send('could not open the ticket. try again later.');
  }
});

router.get('/registrations/:id/ticket', auth, requireUser, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json(NO_REG);
    const reg = await Registration.findById(req.params.id);
    // someone else's registration: same answer as a missing one (ids are not confirmed)
    if (!reg || (String(reg.userId) !== String(getUserId(req)) && !isAdminReq(req))) return res.status(404).json(NO_REG);
    const status = reg.payment?.status || 'not_required';
    if (!tickets.hasTicketRight(reg) || !reg.tickets?.length) {
      const msg = status === 'pending' ? 'your ticket comes when the payment is verified.'
        : status === 'rejected' ? "the payment wasn't accepted, so there is no ticket."
          : 'no ticket for this registration yet.';
      return res.status(404).json({ message: msg, error: msg, noTicket: true, paymentStatus: status });
    }
    const event = await Event.findById(reg.eventId).select('title type date location city organizer details');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ticket: tickets.ticketView(reg, event) });
  } catch (err) {
    console.error('Ticket error:', err);
    res.status(500).json({ message: 'Could not load the ticket', error: 'Could not load the ticket' });
  }
});

router.patch('/registrations/:id/tickets/:code', auth, isAdmin, async (req, res) => {
  try {
    const action = String(req.body?.action || '');
    if (action !== 'cancel' && action !== 'restore') return badRequest(res, 'action must be "cancel" or "restore"');
    if (!isObjectId(req.params.id)) return res.status(404).json(NO_REG);
    const reg = await Registration.findById(req.params.id);
    if (!reg) return res.status(404).json(NO_REG);
    const code = String(req.params.code || '').trim().toUpperCase();
    const t = (reg.tickets || []).find((x) => x.code === code);
    if (!t) return res.status(404).json({ message: 'Ticket not found', error: 'Ticket not found' });
    if (action === 'cancel') {
      if (t.status === 'cancelled') return badRequest(res, 'This ticket is already cancelled.');
      t.status = 'cancelled';
      t.cancelReason = 'admin';
      t.cancelledAt = new Date();
    } else {
      if (t.status !== 'cancelled') return badRequest(res, 'This ticket is not cancelled.');
      if (!tickets.hasTicketRight(reg)) return badRequest(res, 'Verify the payment first.');
      t.status = 'valid';
      t.cancelReason = undefined;
      t.cancelledAt = undefined;
    }
    reg.markModified('tickets');
    await reg.save();
    res.json({ success: true, message: action === 'cancel' ? 'Ticket cancelled' : 'Ticket restored', registration: adminRow(reg) });
  } catch (err) {
    console.error('Ticket update error:', err);
    res.status(500).json({ message: 'Could not update the ticket', error: 'Could not update the ticket' });
  }
});

router.post('/registrations/:id/tickets/resend', auth, isAdmin, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json(NO_REG);
    const reg = await Registration.findById(req.params.id);
    if (!reg) return res.status(404).json(NO_REG);
    if (!tickets.hasTicketRight(reg) || !reg.tickets?.length) return badRequest(res, 'This registration has no ticket.');
    if (!reg.tickets.some((t) => t.status === 'valid')) return badRequest(res, 'All tickets of this registration are cancelled.');
    const email = req.body?.email !== false;
    const push = req.body?.push !== false;
    if (!email && !push) return badRequest(res, 'Choose email, push or both.');
    const result = await tickets.deliverTickets(reg._id, { record: false, email, push });
    const words = { sent: 'sent', no_token: 'no phone signed in', no_email: 'no email on the registration', failed: 'failed', pref_off: 'turned off by the student' };
    const parts = [];
    if (push) parts.push(`push: ${words[result.push] || result.push || 'not sent'}`);
    if (email) parts.push(`email: ${words[result.email] || result.email || 'not sent'}${result.emailError ? ` (${result.emailError})` : ''}`);
    const fresh = await Registration.findById(reg._id);
    // links: each seat's ticket page, for the admin to copy
    res.json({ success: true, message: parts.join(' · '), result, links: result.links || [], registration: fresh ? adminRow(fresh) : undefined });
  } catch (err) {
    console.error('Ticket resend error:', err);
    res.status(500).json({ message: 'Could not send the ticket', error: 'Could not send the ticket' });
  }
});

router.post('/admin/tickets/backfill', auth, isAdmin, async (req, res) => {
  try {
    const apply = req.body?.apply === true;
    const includeFree = req.body?.includeFree === true;
    const report = await tickets.backfillTickets({ apply, includeFree });
    res.json({ success: true, ...report });
  } catch (err) {
    console.error('Ticket backfill error:', err);
    res.status(500).json({ message: 'Backfill failed', error: 'Backfill failed' });
  }
});

// ============================================================
// GET USER'S CREATED EVENTS
// ============================================================
router.get('/my-events', auth, requireUser, async (req, res) => {
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
router.get('/registrations/:eventId', auth, requireUser, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (!canManageEvent(req, event)) {
      return res
        .status(403)
        .json({ error: "You don't have permission to view these registrations" });
    }

    const registrations = await Registration.find({
      eventId: req.params.eventId,
    }).sort({ createdAt: -1 });

    // ticket page links open someone's ticket: only admins get them here
    if (isAdminReq(req)) return res.json(registrations);
    res.json(registrations.map((r) => {
      const o = r.toJSON();
      if (Array.isArray(o.tickets)) o.tickets = o.tickets.map(({ pageToken, ...t }) => t);
      return o;
    }));
  } catch (err) {
    console.error('Fetch registrations error:', err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// ============================================================
// NOTIFICATIONS
// ============================================================
router.get('/notifications', auth, requireUser, async (req, res) => {
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

router.get('/notifications/unread/count', auth, requireUser, async (req, res) => {
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

router.put('/notifications/:id/read', auth, requireUser, async (req, res) => {
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
router.get('/my-registrations', auth, requireUser, async (req, res) => {
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
router.get('/my-registrations/details', auth, requireUser, async (req, res) => {
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
// CATEGORY TEMPLATES (public): create fields + registration fields per category
// ============================================================
router.get('/category-templates', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(publicTemplates());
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

// Purge expired events (admin). Above DELETE /:id so it is reachable.
router.delete('/expired', auth, isAdmin, async (req, res) => {
  try {
    const count = await eventCleanup.purgeExpiredEvents();
    res.json({ message: `Purged ${count} expired events.`, count });
  } catch (err) {
    res.status(500).json({ message: 'Purge failed' });
  }
});

// ============================================================
// UPDATE & DELETE
// ============================================================
const updateEventController = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).select('+paymentAccounts');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (!canManageEvent(req, event)) {
      return res
        .status(403)
        .json({ message: 'Unauthorized to update this event' });
    }

    // v2 fields: validated against the merged result (e.g. paid → needs an account)
    const v2 = validateEventV2(req.body, event);
    if (v2.errors.length) return badRequest(res, v2.errors[0], { errors: v2.errors });
    const legacy = legacyText(req.body, v2.set);

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
    Object.entries(v2.set).forEach(([field, value]) => {
      event[field] = value;
    });
    // keep the old text fields in step for old app builds
    Object.entries(legacy).forEach(([field, value]) => {
      if (req.body[field] === undefined) event[field] = value;
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
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (!canManageEvent(req, event)) {
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

router.put('/:id', auth, requireUser, updateEventController);
router.put('/event/:id', auth, requireUser, updateEventController);
router.delete('/:id', auth, requireUser, deleteEventController);
router.delete('/event/:id', auth, requireUser, deleteEventController);

// ============================================================
// ADMIN: REGISTRATIONS (all events) — list, CSV, payment review
// ============================================================
const PAYMENT_STATUSES = ['not_required', 'pending', 'verified', 'rejected'];
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// filters shared by the list and the CSV: eventId, status (payment), q (search)
function registrationFilter(query) {
  const filter = {};
  if (query.eventId) {
    if (!isObjectId(query.eventId)) return null;
    filter.eventId = query.eventId;
  }
  if (query.status && query.status !== 'all') {
    if (!PAYMENT_STATUSES.includes(query.status)) return null;
    // old registrations have no payment object: they count as not_required
    filter['payment.status'] = query.status === 'not_required' ? { $in: ['not_required', null] } : query.status;
  }
  const q = String(query.q || '').trim().slice(0, 100);
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { studentName: re },
      { email: re },
      { whatsapp: re },
      { studentId: re },
      { 'payment.transactionId': re },
      { 'tickets.code': re }, // check-in: find a registration by its ticket code
    ];
  }
  return filter;
}

// one row as the admin web reads it (today's fields + event title + v2 data)
function adminRow(reg) {
  const r = typeof reg.toJSON === 'function' ? reg.toJSON() : { ...reg };
  const ev = reg.eventId && typeof reg.eventId === 'object' && reg.eventId.title !== undefined ? reg.eventId : null;
  return {
    ...r,
    eventId: ev ? ev._id : reg.eventId,
    eventTitle: ev ? ev.title : '',
    event: ev ? { _id: ev._id, title: ev.title, type: ev.type, date: ev.date, city: ev.city } : null,
    payment: { status: 'not_required', amount: 0, ...(r.payment || {}) },
  };
}

router.get('/admin/registrations', auth, isAdmin, async (req, res) => {
  try {
    const filter = registrationFilter(req.query);
    if (!filter) return badRequest(res, 'Invalid filter');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const [rows, total] = await Promise.all([
      Registration.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('eventId', 'title type date city'),
      Registration.countDocuments(filter),
    ]);
    res.json({
      registrations: rows.map(adminRow),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('Admin registrations error:', err);
    res.status(500).json({ message: 'Failed to load registrations', error: 'Failed to load registrations' });
  }
});

// The admin web's "Registrations" tab calls this path and expects a plain array.
router.get('/all-registrations', auth, isAdmin, async (req, res) => {
  try {
    const filter = registrationFilter(req.query);
    if (!filter) return badRequest(res, 'Invalid filter');
    const rows = await Registration.find(filter)
      .sort({ createdAt: -1 })
      .limit(2000)
      .populate('eventId', 'title type date city');
    res.json(rows.map(adminRow));
  } catch (err) {
    console.error('All registrations error:', err);
    res.status(500).json({ message: 'Failed to load registrations', error: 'Failed to load registrations' });
  }
});

// CSV cell: neutralise spreadsheet formulas (= + - @, tab, CR) and quote
function csvCell(v) {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/admin/registrations.csv', auth, isAdmin, async (req, res) => {
  try {
    const filter = registrationFilter(req.query);
    if (!filter) return badRequest(res, 'Invalid filter');
    const rows = await Registration.find(filter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .populate('eventId', 'title type date city');
    const header = [
      'Registered at', 'Event', 'Category', 'Name', 'Email', 'WhatsApp', 'Student ID', 'University',
      'Ticket', 'Quantity', 'Amount (PKR)', 'Payment status', 'Method', 'Transaction ID', 'Receipt',
      'Reviewed at', 'Reject reason', 'Answers', 'Ticket codes', 'Ticket status',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const reg of rows) {
      const row = adminRow(reg);
      const answers = row.answers || {};
      const other = Object.entries(answers)
        .filter(([k]) => k !== 'university')
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' / ') : v}`)
        .join('; ');
      lines.push([
        row.createdAt ? new Date(row.createdAt).toISOString() : '',
        row.eventTitle,
        row.event?.type || '',
        row.studentName,
        row.email,
        row.whatsapp,
        row.studentId,
        row.university || answers.university || '',
        row.ticket?.tier || '',
        row.ticket?.quantity || row.seats || '',
        row.payment.amount || 0,
        row.payment.status,
        row.payment.method || '',
        row.payment.transactionId || '',
        row.payment.receiptUrl || '',
        row.payment.reviewedAt ? new Date(row.payment.reviewedAt).toISOString() : '',
        row.payment.rejectReason || '',
        other,
        (row.tickets || []).map((t) => t.code).join(' / '),
        (row.tickets || []).map((t) => t.status).join(' / '),
      ].map(csvCell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="registrations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error('Registrations CSV error:', err);
    res.status(500).json({ message: 'Failed to export registrations', error: 'Failed to export registrations' });
  }
});

// ============================================================
// PAYMENT INFO (signed in): fee, tier prices, payment accounts, seats left.
// Not part of any list / feed response.
// ============================================================
router.get('/:id/payment-info', auth, requireUser, async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) {
      return res.status(404).json({ message: 'Event not found', error: 'Event not found' });
    }
    const event = await Event.findById(req.params.id).select('+paymentAccounts');
    if (!event) return res.status(404).json({ message: 'Event not found', error: 'Event not found' });

    const tiers = (event.ticketTiers || []).map((t) => ({
      name: t.name,
      price: t.price || 0,
      quantity: t.quantity,
      maxPerStudent: t.maxPerStudent || 1,
      remaining: t.remaining,
    }));
    const capacity = event.capacity ?? null;
    res.json({
      eventId: event._id,
      title: event.title,
      currency: 'PKR',
      fee: { amount: event.fee?.amount || 0, currency: 'PKR' },
      ticketTiers: tiers,
      paid: isPaid(event.fee, event.ticketTiers),
      paymentAccounts: (event.paymentAccounts || []).map((a) => ({
        method: a.method,
        accountTitle: a.accountTitle,
        accountNumber: a.accountNumber,
        bankName: a.bankName,
        iban: a.iban,
        note: a.note,
      })),
      capacity,
      registeredCount: event.registeredCount || 0,
      spotsLeft: capacity == null ? null : Math.max(0, capacity - (event.registeredCount || 0)),
      registrationCloses: event.registrationCloses || null,
    });
  } catch (err) {
    console.error('Payment info error:', err);
    res.status(500).json({ message: 'Failed to load payment info', error: 'Failed to load payment info' });
  }
});

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
router.post('/sync', auth, isAdmin, async (req, res) => {
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

router.get('/admin/stats', auth, isAdmin, async (req, res) => {
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

router.patch('/admin/moderate/:id', auth, isAdmin, async (req, res) => {
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

router.patch('/expire', auth, isAdmin, async (req, res) => {
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
module.exports = router;