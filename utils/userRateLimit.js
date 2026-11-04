// utils/userRateLimit.js
// Per-user limits for expensive reads: Resume Studio PDFs (each one is rendered on the server) and the
// business analytics pages (each one scans many records). Put the limiter after the route's own sign-in and
// role checks, so it counts signed-in users only, keyed by their id.
//
//   perUser("resume_pdf", { max: 30, windowMin: 10 })
//     RATE_LIMIT_RESUME_PDF_MAX         requests per user per window (read on every request: a Railway
//                                       variable change applies after the restart, no code change)
//     RATE_LIMIT_RESUME_PDF_WINDOW_MIN  the window in minutes (read once at start)
//   A missing or unreadable value uses the default. Over the limit: 429 RATE_LIMITED with Retry-After.
//
// Counts are kept in this server's memory: with more than one instance, each counts on its own (the
// effective limit is max x instances), and a restart starts the counts again.
const { rateLimit } = require("express-rate-limit");

const LIMITS = {
  resume_pdf: { max: 30, windowMin: 10 }, // draft previews, approved exports, the employer's snapshot PDF
  analytics: { max: 60, windowMin: 10 }, // /api/analytics/*
};

const envKey = (name, part) => `RATE_LIMIT_${name.toUpperCase()}_${part}`;
const positive = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const settings = (name) => {
  const d = LIMITS[name];
  if (!d) throw new Error(`unknown rate limit: ${name}`);
  return { max: Math.floor(positive(process.env[envKey(name, "MAX")], d.max)), windowMin: positive(process.env[envKey(name, "WINDOW_MIN")], d.windowMin) };
};

function perUser(name) {
  const windowMs = Math.round(settings(name).windowMin * 60 * 1000);
  return rateLimit({
    windowMs,
    limit: () => settings(name).max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${req.userId}`,
    handler: (req, res) => {
      const reset = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : Date.now() + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        success: false,
        error: { code: "RATE_LIMITED", message: `Too many requests. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`, retryAfterSeconds },
        requestId: req.id || null,
      });
    },
  });
}

module.exports = { perUser, settings, LIMITS };
