// routes/shopifyWebhooks.js, mounted at /webhooks (same paths as before): the Shopify app's webhooks.
//   POST /webhooks/compliance          customers/data_request, customers/redact, shop/redact (GDPR; required by Shopify)
//   POST /webhooks/app/uninstalled     marks the store uninstalled
//   POST /webhooks/app/scopes_update   stores the granted scopes
// Each is signed by Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(SHOPIFY_API_SECRET, the raw body)). The raw bytes
// come from express.json's verify hook in server.js (req.rawBody); the parsed object can't be signed (key order,
// spacing). Bad or missing signature → 401; SHOPIFY_API_SECRET not set → 401 (logged once, never a crash); valid → 200.
// Rate-limited per address (RATE_LIMIT_SHOPIFY_WEBHOOK_MAX a minute, default 120).
const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const { clientIp } = require("../services/loginGuard");

const router = express.Router();

let warnedNoSecret = false;
/** true when the header is Shopify's signature of this raw body (length-safe, constant time) */
function validSignature(rawBody, header, secret = process.env.SHOPIFY_API_SECRET) {
  if (!secret) {
    if (!warnedNoSecret) { warnedNoSecret = true; console.warn("[shopify-webhooks] SHOPIFY_API_SECRET is not set: every webhook is refused (401)"); }
    return false;
  }
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || !header) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const limit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_SHOPIFY_WEBHOOK_MAX) || 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `shopify-webhook:${clientIp(req)}`,
  validate: false,
  handler: (req, res) => res.status(429).send("Too Many Requests"),
});

const signed = (req, res, next) => {
  if (validSignature(req.rawBody, req.get("X-Shopify-Hmac-Sha256"))) return next();
  console.warn(`[shopify-webhooks] ${req.path}: signature refused`);
  return res.status(401).send("Unauthorized");
};
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(`[shopify-webhooks] ${req.path} failed: ${e.message}`);
    if (!res.headersSent) res.status(500).send("Error");
  }
};
const shopOf = (req) => String(req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase();

router.post("/compliance", limit, signed, wrap(async (req, res) => {
  const topic = req.get("X-Shopify-Topic");
  const shop = shopOf(req);
  console.log(`[shopify-webhooks] compliance: ${topic} from ${shop}`);
  // tdc keeps no Shopify customer data; a shop's own record goes on shop/redact
  if (topic === "shop/redact" && shop) await require("../models/ShopifyStore").deleteMany({ shop });
  res.status(200).send("OK");
}));

router.post("/app/uninstalled", limit, signed, wrap(async (req, res) => {
  const shop = shopOf(req);
  if (shop) await require("../models/ShopifyStore").findOneAndUpdate({ shop }, { status: "uninstalled", uninstalledAt: new Date() });
  console.log(`[shopify-webhooks] app uninstalled: ${shop}`);
  res.status(200).send("OK");
}));

router.post("/app/scopes_update", limit, signed, wrap(async (req, res) => {
  const shop = shopOf(req);
  const current = req.body && Array.isArray(req.body.current) ? req.body.current.map(String) : null;
  if (shop && current) await require("../models/ShopifyStore").findOneAndUpdate({ shop }, { scopes: current });
  console.log(`[shopify-webhooks] scopes updated: ${shop}`);
  res.status(200).send("OK");
}));

module.exports = router;
module.exports.validSignature = validSignature;
module.exports._resetWarned = () => { warnedNoSecret = false; };
