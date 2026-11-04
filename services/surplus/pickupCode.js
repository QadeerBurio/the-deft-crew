// services/surplus/pickupCode.js
// The pickup code: 6 characters (no 0/O/1/I/L) plus a QR of "TDCBOX1:<orderId>:<code>". It's derived
// from the order id and a random per-order nonce with an HMAC under SURPLUS_CODE_SECRET, a secret used for
// nothing else, so the student's app can show it again any time while only its hash is stored. Single use
// (pickupCodeUsedAt) and expires at the pickup window's end; checked in services/surplus/orders.js.
// SURPLUS_CODE_SECRET unset (or shorter than 32 characters): Surprise Box holds and orders are refused and
// the reason is logged. It is never taken from JWT_SECRET or any other secret.
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 6;
const QR_PREFIX = "TDCBOX1";
const MIN_SECRET_LENGTH = 32;
const NOT_CONFIGURED = "SURPLUS_CODE_SECRET is not set (or is shorter than 32 characters): Surprise Box holds and orders are refused until it is set on the server. It is never taken from JWT_SECRET.";

const configured = () => String(process.env.SURPLUS_CODE_SECRET || "").trim().length >= MIN_SECRET_LENGTH;
let lastLog = 0;
/** Log that the secret is missing (at most once a minute, so refusals stay visible without flooding) */
function logNotConfigured(where = "") {
  if (Date.now() - lastLog >= 60000) {
    lastLog = Date.now();
    console.error(`[surplus] ${NOT_CONFIGURED}${where ? ` (${where})` : ""}`);
  }
  return NOT_CONFIGURED;
}
const secret = () => {
  if (!configured()) {
    logNotConfigured("pickup code");
    throw Object.assign(new Error(NOT_CONFIGURED), { code: "SURPLUS_NOT_CONFIGURED" });
  }
  return String(process.env.SURPLUS_CODE_SECRET).trim();
};
const newNonce = () => crypto.randomBytes(12).toString("hex");

function codeFor(orderId, nonce) {
  const mac = crypto.createHmac("sha256", secret()).update(`surplus-pickup:${orderId}:${nonce}`).digest();
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[mac[i] % ALPHABET.length];
  return out;
}
const normalize = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashOf = (code) => crypto.createHash("sha256").update(`surplus-code:${normalize(code)}`).digest("hex");
const qrFor = (orderId, code) => `${QR_PREFIX}:${orderId}:${code}`;

/** "TDCBOX1:<orderId>:<code>" or a typed code -> { orderId | null, code } */
function parse(input) {
  const s = String(input || "").trim();
  const m = new RegExp(`^${QR_PREFIX}:([0-9a-fA-F]{24}):([A-Za-z0-9]{${LENGTH}})$`).exec(s);
  if (m) return { orderId: m[1], code: normalize(m[2]) };
  return { orderId: null, code: normalize(s) };
}
const looksValid = (code) => new RegExp(`^[${ALPHABET}]{${LENGTH}}$`).test(code);

module.exports = { configured, logNotConfigured, MIN_SECRET_LENGTH, NOT_CONFIGURED, codeFor, hashOf, qrFor, parse, normalize, newNonce, looksValid, ALPHABET, LENGTH, QR_PREFIX };
