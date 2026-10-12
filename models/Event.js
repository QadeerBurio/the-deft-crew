const mongoose = require('mongoose');

// ── Events v2 sub-documents ─────────────────────────────────────
const FormFieldSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 40 },
  label: { type: String, default: '', maxlength: 80 },
  type: {
    type: String,
    required: true,
    enum: ['text', 'textarea', 'number', 'select', 'multiselect', 'date', 'time', 'url', 'phone', 'email', 'list', 'file'],
  },
  required: { type: Boolean, default: false },
  options: [{ type: String, maxlength: 60 }],
  helpText: { type: String, default: '', maxlength: 200 },
  store: { type: String, enum: ['base', 'answers', 'ticket'], default: 'answers' },
}, { _id: false });

const TicketTierSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  price: { type: Number, default: 0, min: 0 }, // whole PKR
  quantity: { type: Number, required: true, min: 1 },
  maxPerStudent: { type: Number, default: 1, min: 1 },
  sold: { type: Number, default: 0, min: 0 }, // internal
  remaining: { type: Number, default: 0, min: 0 }, // quantity - sold; the atomic seat check uses it
}, { _id: false });

const PaymentAccountSchema = new mongoose.Schema({
  method: { type: String, required: true, enum: ['easypaisa', 'jazzcash', 'bank'] },
  accountTitle: { type: String, default: '', maxlength: 80 },
  accountNumber: { type: String, default: '', maxlength: 40 },
  bankName: { type: String, default: '', maxlength: 80 },
  iban: { type: String, default: '', maxlength: 24 },
  note: { type: String, default: '', maxlength: 200 },
}, { _id: false });

// Public JSON: no payment accounts, no tier prices (only GET /:id/payment-info has them)
function hidePaymentData(doc, ret) {
  delete ret.paymentAccounts;
  if (Array.isArray(ret.ticketTiers)) {
    ret.ticketTiers = ret.ticketTiers.map((t) => ({
      name: t.name,
      quantity: t.quantity,
      maxPerStudent: t.maxPerStudent,
      remaining: t.remaining,
    }));
  }
  return ret;
}

const EventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  organizer: { type: String, required: false, trim: true, default: 'Organizer' },
city: { type: String, required: false, default: '', trim: true },
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

  // ── Events v2 (all optional; old documents and old clients are unaffected) ──
  // values for the category's createFields (config/eventCategories.js)
  details: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // the registration form for this event; absent = today's form (old events, old clients)
  registrationForm: { type: [FormFieldSchema], default: undefined },
  // whole PKR; 0 = free
  fee: {
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'PKR', enum: ['PKR'] },
  },
  ticketTiers: { type: [TicketTierSchema], default: [] },
  // never in list / feed responses (select: false + toJSON); see GET /:id/payment-info
  paymentAccounts: { type: [PaymentAccountSchema], default: [], select: false },
  capacity: { type: Number, default: null, min: 0 }, // null = unlimited
  registeredCount: { type: Number, default: 0, min: 0 }, // seats taken (ticket quantity)
  registrationCloses: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now }
}, {
  toJSON: { transform: hidePaymentData },
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

  // ── Events v2 (optional; old registrations unaffected) ──
  answers: { type: mongoose.Schema.Types.Mixed, default: undefined }, // the event's extra questions
  ticket: {
    type: new mongoose.Schema({
      tier: { type: String, maxlength: 60 },
      quantity: { type: Number, min: 1 },
    }, { _id: false }),
    default: undefined,
  },
  // seats this registration holds in Event.registeredCount (0 for old registrations)
  seats: { type: Number, default: 0, min: 0 },
  payment: {
    status: {
      type: String,
      enum: ['not_required', 'pending', 'verified', 'rejected'],
      default: 'not_required',
    },
    method: { type: String, enum: ['easypaisa', 'jazzcash', 'bank'] },
    transactionId: { type: String, trim: true, maxlength: 40 },
    receiptUrl: { type: String, maxlength: 500 },
    amount: { type: Number, default: 0, min: 0 }, // whole PKR, computed by the server
    submittedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectReason: { type: String, maxlength: 300 },
  },
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
// one transaction ID can pay for one registration per event. Partial (not sparse): a
// sparse compound index would still index every row by eventId and clash on "no id".
RegistrationSchema.index(
  { eventId: 1, 'payment.transactionId': 1 },
  { unique: true, partialFilterExpression: { 'payment.transactionId': { $type: 'string' } } }
);
RegistrationSchema.index({ 'payment.status': 1, createdAt: -1 });
EventNotificationSchema.index({ creatorId: 1, createdAt: -1 });
EventNotificationSchema.index({ creatorId: 1, read: 1 });

const Event = mongoose.model('Event', EventSchema);
const Registration = mongoose.model('Registration', RegistrationSchema);
const EventNotification = mongoose.model('EventNotification', EventNotificationSchema);

module.exports = { Event, Registration, EventNotification };