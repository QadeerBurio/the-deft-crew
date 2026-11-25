// middleware/rejectGuestWrites.js
// A signed-out caller can't change anything: every POST / PUT / PATCH / DELETE under /api from a guest gets 401
// SIGN_IN_REQUIRED, unless the route is public on purpose (ALLOW below). Reads (GET / HEAD / OPTIONS) are untouched.
// A guest is what middleware/auth.middleware.js lets through as one: no Authorization header, "Bearer" with an empty,
// "undefined" or "null" token, or the app's guest token. A request with a real token goes on to the route's own checks
// (a bad token is still answered there).
// Before this, 129 of the server's 293 write routes answered signed-out callers past their sign-in middleware (most
// then failed on the guest id; a few, like sending a notification, didn't). tests/reject-guest-writes checks every
// write route the server mounts.
// GUEST_WRITES_GUARD=off switches it off (emergency only; a Railway variable, applies after the restart).
const ALLOW = [
  // signing up and in, codes and password reset
  ["POST", /^\/auth\/(signup|login|signup\/verify-otp|signup\/resend-otp|forgot-password|resend-otp|verify-otp|reset-password)\/?$/i],
  // an admin's sign-in code (Phase A, adminSessionsV1) and accepting an admin invitation
  ["POST", /^\/auth\/admin\/(verify-code|accept-invite)\/?$/i],
  // store webhooks: each checks its own signature or secret
  ["POST", /^\/webhooks\/woocommerce\/[^/]+\/?$/i],
  ["POST", /^\/webhooks\/confirm\/?$/i],
  ["POST", /^\/webhooks\/shopify\/confirm\/?$/i],
  ["POST", /^\/brand\/store\/woocommerce\/callback\/?$/i], // WooCommerce sends the store's keys here after the brand approves
  // the tdc Shopify app, server to server: each checks X-API-KEY (routes/shopifyApp.routes.js verifyApiKey)
  ["POST", /^\/shopify-app\/(link-shop|link-shop\/start|discount|order-webhook|compliance)\/?$/i],
  // the app at launch, before sign-in: which build it is (no user data), and app-open style events (a no-op for guests)
  ["POST", /^\/app\/meta-build\/?$/i],
  ["POST", /^\/engagement\/events\/?$/i],
  // the daily streak warnings: a scheduled job with CRON_SECRET (or an admin)
  ["POST", /^\/engagement\/streak\/expiry-warnings\/send\/?$/i],
  // the chat service's knowledge search (read-only)
  ["POST", /^\/v1\/knowledge\/search\/?$/i],
];
const GUEST_TOKENS = new Set(["", "undefined", "null", "guest-token-2024"]);

function isGuest(req) {
  const h = req.headers?.authorization;
  if (!h) return true;
  const parts = String(h).split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false; // a malformed header: the route's own 401
  return GUEST_TOKENS.has(parts[1].trim());
}

const allowed = (method, path) => ALLOW.some(([m, re]) => m === method && re.test(path));

function rejectGuestWrites(req, res, next) {
  if (String(process.env.GUEST_WRITES_GUARD || "").toLowerCase() === "off") return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!isGuest(req)) return next();
  if (allowed(req.method, req.path)) return next();
  return res.status(401).json({ code: "SIGN_IN_REQUIRED", message: "Sign in to do this." });
}

module.exports = rejectGuestWrites;
module.exports.ALLOW = ALLOW;
module.exports.isGuest = isGuest;
module.exports.allowed = allowed;
