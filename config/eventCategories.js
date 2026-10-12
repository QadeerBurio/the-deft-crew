// config/eventCategories.js
// Event category templates: what the admin fills in when creating an event of a category
// (createFields) and what a student fills in when registering (registrationFields).
// Served publicly at GET /api/events/category-templates.
//
// Field: { key, label, type, required, options, helpText, store }
//   type    text | textarea | number | select | multiselect | date | time | url | phone |
//           email | list | file
//   store   "event"   → an Event field that already exists (title, city, prize, ...)
//           "details" → Event.details[key] (category specific)
//           "base"    → registration: top-level Registration field (studentName, ...)
//           "answers" → registration: Registration.answers[key]
//           "ticket"  → registration: Registration.ticket (tier / quantity)
//   options for select / multiselect. "fromEvent:ticketTiers" = the event's own tier names.
//
// Matching Event.type is case-insensitive ("hackathon" and "Hackathons" both match).
// An unknown type uses GENERIC, which is exactly today's fields.

const f = (key, label, type, extra = {}) => ({
  key,
  label,
  type,
  required: false,
  options: [],
  helpText: "",
  ...extra,
});

// ── create: fields every event already has (stored on the Event itself) ──
const COMMON_CREATE = [
  f("title", "Event title", "text", { required: true, store: "event" }),
  f("organizer", "Organizer", "text", { required: true, store: "event" }),
  f("city", "City", "text", { required: true, store: "event" }),
  f("description", "Description", "textarea", { store: "event" }),
  f("date", "Event date", "text", { store: "event", helpText: "As students should see it, e.g. 12 Nov 2026" }),
  f("location", "Venue", "text", { store: "event", helpText: "Venue name or \"Online\"" }),
  f("contact", "Contact", "text", { store: "event", helpText: "Email or phone for questions" }),
  f("image", "Event image", "file", { store: "event" }),
  f("registrationCloses", "Registration closes", "date", { store: "event", helpText: "Leave empty to keep registration open" }),
  f("capacity", "Capacity", "number", { store: "event", helpText: "Total seats. Leave empty for unlimited" }),
  f("fee", "Fee (PKR)", "number", { store: "event", helpText: "Whole rupees. 0 = free. Paid events need a payment account" }),
];

// today's text fields, kept for old app builds (filled from details where possible)
const LEGACY_CREATE = [
  f("prize", "Prize pool", "text", { store: "event" }),
  f("deadline", "Deadline", "text", { store: "event" }),
  f("teamSize", "Team size", "text", { store: "event" }),
];

// ── registration: every category ──
const BASE_REGISTRATION = [
  f("studentName", "Full name", "text", { required: true, store: "base" }),
  f("email", "University email", "email", { required: true, store: "base" }),
  f("whatsapp", "WhatsApp number", "phone", { required: true, store: "base", helpText: "03XXXXXXXXX" }),
  f("university", "University", "text", { required: true, store: "answers" }),
  f("studentId", "Student ID / CNIC", "text", { store: "base" }),
];

// today's registration form (no university): used by GENERIC and by events created
// without v2 fields, so old app builds can still register for them
const LEGACY_REGISTRATION = [
  f("studentName", "Full name", "text", { required: true, store: "base" }),
  f("email", "University email", "email", { required: true, store: "base" }),
  f("whatsapp", "WhatsApp number", "phone", { required: true, store: "base" }),
  f("studentId", "Student ID / CNIC", "text", { store: "base" }),
];

const TIER = f("ticketTier", "Ticket", "select", { required: true, store: "ticket", options: ["fromEvent:ticketTiers"] });

const CATEGORIES = [
  {
    name: "Hackathons",
    createFields: [
      f("teamSizeMin", "Minimum team size", "number", { required: true, store: "details" }),
      f("teamSizeMax", "Maximum team size", "number", { required: true, store: "details" }),
      f("tracks", "Tracks", "list", { store: "details", helpText: "One per line, e.g. AI, Fintech" }),
      f("prizePool", "Prize pool (PKR)", "number", { store: "details" }),
      f("themeDescription", "Theme", "textarea", { store: "details" }),
    ],
    registrationFields: [
      f("teamName", "Team name", "text", { required: true, store: "answers" }),
      f("teamMembers", "Team members", "textarea", { required: true, store: "answers", helpText: "Name and email of each member, one per line" }),
      f("skills", "Skills", "text", { required: true, store: "answers", helpText: "e.g. React, Python, design" }),
      f("portfolioUrl", "Portfolio / GitHub link", "url", { store: "answers" }),
    ],
  },
  {
    name: "Workshops",
    createFields: [
      f("level", "Level", "select", { required: true, store: "details", options: ["Beginner", "Intermediate", "Advanced", "All levels"] }),
      f("durationHours", "Duration (hours)", "number", { required: true, store: "details" }),
      f("seats", "Seats", "number", { store: "details", helpText: "Shown to students. Use Capacity to stop registrations when full" }),
      f("certificate", "Certificate", "select", { store: "details", options: ["Yes", "No"] }),
    ],
    registrationFields: [
      f("experienceLevel", "Your experience", "select", { required: true, store: "answers", options: ["Beginner", "Intermediate", "Advanced"] }),
      f("learningGoal", "What do you want to learn?", "textarea", { store: "answers" }),
    ],
  },
  {
    name: "Conferences",
    usesTicketTiers: true,
    createFields: [
      f("speakers", "Speakers", "list", { store: "details", helpText: "One per line" }),
      f("agenda", "Agenda", "textarea", { store: "details" }),
    ],
    registrationFields: [
      f("designation", "Designation", "text", { required: true, store: "answers", helpText: "e.g. Student, Software Engineer" }),
      f("organization", "University / organization", "text", { required: true, store: "answers" }),
      TIER,
    ],
  },
  {
    name: "Competitions",
    createFields: [
      f("domain", "Domain", "text", { required: true, store: "details", helpText: "e.g. Programming, Debate, Design" }),
      f("mode", "Mode", "select", { required: true, store: "details", options: ["Solo", "Team"] }),
      f("teamSizeMax", "Maximum team size", "number", { store: "details" }),
      f("rulesUrl", "Rules link", "url", { store: "details" }),
      f("prizePool", "Prize pool (PKR)", "number", { store: "details" }),
    ],
    registrationFields: [
      f("teamName", "Team name", "text", { store: "answers", helpText: "Team events only" }),
      f("teamMembers", "Team members", "textarea", { store: "answers", helpText: "Name and email of each member, one per line" }),
      f("entryCategory", "Entry category", "text", { required: true, store: "answers" }),
    ],
  },
  {
    name: "Career Fairs",
    createFields: [
      f("companies", "Companies", "list", { required: true, store: "details", helpText: "One per line" }),
      f("rolesOffered", "Roles offered", "list", { store: "details", helpText: "One per line" }),
    ],
    registrationFields: [
      f("degree", "Degree", "text", { required: true, store: "answers", helpText: "e.g. BS Computer Science" }),
      f("graduationYear", "Graduation year", "number", { required: true, store: "answers" }),
      f("fieldOfInterest", "Field of interest", "text", { required: true, store: "answers" }),
      f("cvUrl", "CV link", "url", { store: "answers" }),
    ],
  },
  {
    name: "Concerts",
    usesTicketTiers: true,
    createFields: [
      f("artists", "Artists", "list", { required: true, store: "details", helpText: "One per line" }),
      f("gateOpenTime", "Gates open", "time", { store: "details", helpText: "24h, e.g. 18:30" }),
      f("ageLimit", "Minimum age", "number", { store: "details" }),
      f("maxTicketsPerStudent", "Max tickets per student", "number", { required: true, store: "details" }),
    ],
    registrationFields: [
      TIER,
      f("quantity", "Number of tickets", "number", { required: true, store: "ticket", helpText: "Up to the event's limit" }),
    ],
  },
].map((c) => ({
  ...c,
  slug: c.name.toLowerCase().replace(/\s+/g, "-"),
  usesTicketTiers: !!c.usesTicketTiers,
  createFields: [...COMMON_CREATE, ...c.createFields],
  registrationFields: [...BASE_REGISTRATION, ...c.registrationFields],
}));

const GENERIC = {
  name: "General",
  slug: "general",
  generic: true,
  usesTicketTiers: false,
  createFields: [...COMMON_CREATE, ...LEGACY_CREATE],
  registrationFields: LEGACY_REGISTRATION,
};

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// "Hackathons", "hackathon", " HACKATHONS " → Hackathons; anything else → GENERIC
function getTemplate(type) {
  const t = norm(type);
  if (!t) return GENERIC;
  return (
    CATEGORIES.find((c) => norm(c.name) === t || norm(c.name).replace(/s$/, "") === t.replace(/s$/, "")) ||
    GENERIC
  );
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// public payload for GET /category-templates
function publicTemplates() {
  return { version: 1, categories: clone(CATEGORIES), generic: clone(GENERIC) };
}

module.exports = {
  CATEGORIES,
  GENERIC,
  LEGACY_REGISTRATION,
  BASE_REGISTRATION,
  FIELD_TYPES: ["text", "textarea", "number", "select", "multiselect", "date", "time", "url", "phone", "email", "list", "file"],
  getTemplate,
  publicTemplates,
};
