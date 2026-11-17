// config/corsOrigins.js
// Which browser pages may call this server (Express cors and socket.io), instead of any origin:
//   - the website and portal: https://gettdc.pk, https://www.gettdc.pk, https://tdc-admin-portal.vercel.app and the
//     portal's Vercel previews (tdc-admin-portal-<hash>-abdul-qadeers-projects-04dc2951.vercel.app)
//   - the server's own Railway domains (pages it serves itself; on iPhone the app's socket connection sends the
//     server's own address as its origin)
//   - CORS_EXTRA_ORIGINS: more, comma-separated (e.g. a new domain, or http://localhost:3000 to point a local portal at
//     this server); localhost is also allowed on staging (APP_ENV / RAILWAY_ENVIRONMENT_NAME = staging)
// A request without an Origin header (the mobile app, webhooks, server-to-server, curl) is never a browser page from
// somewhere else: allowed. A page from any other origin gets no CORS headers, so the browser blocks it (nothing
// changes for the API itself: it uses bearer tokens, not cookies).
const BASE = [
  "https://gettdc.pk",
  "https://www.gettdc.pk",
  "https://tdc-admin-portal.vercel.app",
  "https://the-deft-crew-production.up.railway.app",
  "https://tdc-server-staging.up.railway.app",
];
const PREVIEW = /^https:\/\/tdc-admin-portal-[a-z0-9-]+-abdul-qadeers-projects-04dc2951\.vercel\.app$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/;
const isStaging = () => [process.env.APP_ENV, process.env.RAILWAY_ENVIRONMENT_NAME].some((v) => String(v || "").trim().toLowerCase() === "staging");
const extra = () => String(process.env.CORS_EXTRA_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // no Origin header: not a browser page from elsewhere
  const o = String(origin).trim().replace(/\/+$/, "");
  if (BASE.includes(o) || PREVIEW.test(o) || extra().includes(o)) return true;
  if (LOCAL.test(o) && isStaging()) return true;
  return false;
}

// the same answer for Express's cors() and socket.io's cors option
const corsOptions = {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
};

module.exports = { isAllowedOrigin, corsOptions, BASE, PREVIEW };
