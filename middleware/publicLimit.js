// middleware/publicLimit.js (r8): a per-address limit for public routes that had none (no sign-in, cheap, but open to
// anyone): publicLimit("safety-action", "RATE_LIMIT_SAFETY_ACTION_MAX", 30) → N requests a minute per address.
// Generous on purpose: a real visitor never meets it; a script hammering one route does (429).
const { rateLimit } = require("express-rate-limit");
const { clientIp } = require("../services/loginGuard");

module.exports = function publicLimit(name, envVar, perMinute) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: () => Math.max(1, Number(process.env[envVar]) || perMinute),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${clientIp(req)}`,
    validate: false,
    handler: (req, res) => res.status(429).json({ success: false, code: "RATE_LIMITED", message: "too many requests. try again in a minute.", error: "too many requests. try again in a minute." }),
  });
};
