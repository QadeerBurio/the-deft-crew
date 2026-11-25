// middleware/shopifyAppLimit.js: a per-address limit on /api/shopify-app/* (the tdc Shopify app calls these server to
// server with X-API-KEY; brands use the link-shop pages). Generous so the app's normal traffic is never refused:
// RATE_LIMIT_SHOPIFY_APP_MAX a minute (default 300).
const { rateLimit } = require("express-rate-limit");
const { clientIp } = require("../services/loginGuard");

module.exports = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_SHOPIFY_APP_MAX) || 300),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `shopify-app:${clientIp(req)}`,
  validate: false,
  handler: (req, res) => res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" }),
});
