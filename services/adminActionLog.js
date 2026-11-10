// services/adminActionLog.js
// The unified admin action log (models/AdminActionLog.js): who (admin id), what (action), on what (target type
// and id), the changed fields before / after, the reason, when. Server-side writes only; read by the admin page
// (routes/adminActions.routes.js). No backfill: it starts with the first admin write after it shipped.
//
//   record(entry, { session })  write one row; throws (use inside a write that must be logged)
//   recordSafe(entry)           write one row; never throws (an existing action keeps working if logging fails)
//   summarize(value)            the before / after summary: personal data and secrets removed, sizes capped
//   list(filters)               newest first, filtered, paged with a cursor
const mongoose = require("mongoose");
const AdminActionLog = require("../models/AdminActionLog");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
// keys never stored in a summary (personal data, contact details, secrets)
const BLOCKED_KEY = /(e-?mail|phone|mobile|whats ?app|password|passcode|pin$|otp|token|secret|api_?key|^key$|credential|cnic|national ?id|id ?card|passport|dob|birth|address|street|coords|latitude|longitude|geo|location|^ip$|ip_?addr|user ?agent|device|push|^name$|^(first|last|full|user|student|candidate|actor|display|real|legal)_? ?name$|roll ?no|resume|cv|photo|selfie|avatar|picture|comment|message|note$|notes)/i;
const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_KEYS = 30;

function scrub(value, depth) {
  if (value == null) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value._bsontype === "ObjectId") return String(value);
  if (typeof value === "string") {
    // e-mail addresses and phone-like numbers inside free text are cut out too
    const s = value.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]").replace(/\+?\d[\d\s-]{8,}\d/g, "[number]");
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1)).concat(value.length > MAX_ARRAY ? [`+${value.length - MAX_ARRAY} more`] : []);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (BLOCKED_KEY.test(k) || typeof v === "function") continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}
const summarize = (value) => (value == null ? null : scrub(value, 0));
// only the listed fields of an object (then scrubbed)
const pick = (obj, keys) => (obj ? summarize(Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]))) : null);

function clean(entry) {
  const admin = entry.adminId || entry.admin;
  if (!isId(admin)) throw new Error("admin action log: an admin id is required");
  if (!entry.action) throw new Error("admin action log: an action is required");
  if (!entry.targetType || entry.targetId == null || entry.targetId === "") throw new Error("admin action log: a target is required");
  return {
    admin,
    action: String(entry.action).slice(0, 80),
    targetType: String(entry.targetType).slice(0, 60),
    targetId: String(entry.targetId).slice(0, 64),
    before: summarize(entry.before),
    after: summarize(entry.after),
    // the reason is the admin's own words: kept, with e-mails / numbers cut out
    reason: summarize(String(entry.reason || "").trim().slice(0, 500)) || "",
    requestId: String(entry.requestId || "").slice(0, 80),
    at: entry.at instanceof Date ? entry.at : new Date(),
  };
}

async function record(entry, { session = null } = {}) {
  const [row] = await AdminActionLog.create([clean(entry)], { session });
  return row.toObject();
}

async function recordSafe(entry) {
  try {
    return await record(entry);
  } catch (err) {
    console.error(`[admin-actions] could not log ${entry?.action || "?"} on ${entry?.targetType || "?"} ${entry?.targetId || "?"}: ${err.message}`);
    return null;
  }
}

// filters: adminId, action (exact, or "prefix.*"), targetType, targetId, from, to, limit (max 200), before (cursor: row id)
async function list({ adminId, action, targetType, targetId, from, to, limit = 50, before } = {}) {
  const q = {};
  if (adminId) { if (!isId(adminId)) return { rows: [], next: null }; q.admin = adminId; }
  if (action) {
    const a = String(action).slice(0, 80);
    q.action = a.endsWith(".*") ? { $regex: `^${a.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.` } : a;
  }
  if (targetType) q.targetType = String(targetType).slice(0, 60);
  if (targetId) q.targetId = String(targetId).slice(0, 64);
  const range = {};
  if (from && !Number.isNaN(new Date(from).getTime())) range.$gte = new Date(from);
  if (to && !Number.isNaN(new Date(to).getTime())) range.$lte = new Date(to);
  if (Object.keys(range).length) q.at = range;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (before) {
    if (!isId(before)) return { rows: [], next: null };
    const cursor = await AdminActionLog.findById(before).select("at").lean();
    if (cursor) q.$or = [{ at: { $lt: cursor.at } }, { at: cursor.at, _id: { $lt: cursor._id } }];
  }
  const rows = await AdminActionLog.find(q).sort({ at: -1, _id: -1 }).limit(n + 1).lean();
  const page = rows.slice(0, n);
  return { rows: page, next: rows.length > n ? String(page[page.length - 1]._id) : null };
}

module.exports = { record, recordSafe, summarize, pick, list, BLOCKED_KEY };
