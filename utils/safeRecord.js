// utils/safeRecord.js
// Phase A (owner): what an admin reply may carry about a user, brand or employer. One helper for every admin route
// (applied by middleware/adminAccess.js to each mapped admin route's JSON reply).
//   SECRETS     never, for anyone: passwords, one-time / reset codes, push tokens, webhook and store secrets
//   DOCUMENTS   ID-card and live pictures: only with pii.view, or the route's own
//               verify permission (students.verify, employers.verify)
//   contact     phone and e-mail are masked ("03••••••67", "ay••@gmail.com") for an admin without pii.view, but only
//               while permissions are enforced (adminRbacEnforce); every admin today has pii.view
// Any depth (lists, populated records), never the Mongoose model itself; returns a copy.
const SECRETS = new Set([
  "password", "otp", "otpCode", "codeHash", "resetPasswordToken", "resetPasswordExpires", "resetToken", "resetCode",
  "pushTokens", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "shopifyClientId",
  "shopifyClientSecret", "shopifyWebhookSecret", "pickupCodeHash", "pickupCodeNonce",
]);
// (company document bytes are select: false and only leave through their own logged download route)
const DOCUMENTS = new Set(["idCardFront", "idCardBack", "livePicture"]);
const DOC_PERMISSIONS = new Set(["pii.view", "students.verify", "employers.verify"]);

const maskPhone = (v) => { const s = String(v || ""); const d = s.replace(/\D/g, ""); return d.length < 5 ? (s ? "••••" : s) : `${d.slice(0, 2)}${"•".repeat(Math.max(4, d.length - 4))}${d.slice(-2)}`; };
const maskEmail = (v) => { const s = String(v || ""); const at = s.indexOf("@"); return at < 1 ? (s ? "••••" : s) : `${s.slice(0, Math.min(2, at))}••@${s.slice(at + 1)}`; };

/**
 * opts: { documents: boolean (keep ID cards / document bytes), mask: boolean (mask phone / e-mail) }
 */
function safeRecord(value, opts = {}, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => safeRecord(v, opts, depth + 1));
  if (typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (value._bsontype || value instanceof Map) return value; // ObjectId, Decimal128…: JSON handles them as before
  if (typeof value.toJSON === "function" && typeof value.toObject !== "function") return value; // its own JSON form
  // a Mongoose document: its own JSON (the schema's toJSON options), as res.json would send it
  const obj = typeof value.toJSON === "function" && typeof value.toObject === "function" ? value.toJSON() : value;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRETS.has(k)) continue;
    if (DOCUMENTS.has(k) && !opts.documents) continue;
    if (opts.mask && (k === "phone" || k === "whatsapp" || k === "customerPhone") && typeof v === "string") { out[k] = maskPhone(v); continue; }
    if (opts.mask && (k === "email" || k === "customerEmail") && typeof v === "string") { out[k] = maskEmail(v); continue; }
    out[k] = safeRecord(v, opts, depth + 1);
  }
  return out;
}

/** The options for this admin caller on a route that needs `permission` */
function optionsFor(user, permission) {
  const access = require("../services/adminAccess");
  const hasPii = access.has(user, "pii.view");
  return {
    documents: hasPii || (DOC_PERMISSIONS.has(permission) && access.has(user, permission)),
    mask: !hasPii && access.enforcing(),
  };
}

module.exports = { safeRecord, optionsFor, maskPhone, maskEmail, SECRETS, DOCUMENTS };
