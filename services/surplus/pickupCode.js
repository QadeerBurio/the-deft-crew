// services/surplus/pickupCode.js
// The pickup code: 6 characters (no 0/O/1/I/L) plus a QR of "TDCBOX1:<orderId>:<code>". It's derived
// from the order id and a random per-order nonce with an HMAC under the server's existing JWT_SECRET (no
// new secret), so the student's app can show it again any time while only its hash is stored. Single use
// (pickupCodeUsedAt) and expires at the pickup window's end; checked in services/surplus/orders.js.
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 6;
const QR_PREFIX = "TDCBOX1";

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
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

module.exports = { codeFor, hashOf, qrFor, parse, normalize, newNonce, looksValid, ALPHABET, LENGTH, QR_PREFIX };
