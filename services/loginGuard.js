// services/loginGuard.js
// Brute-force protection for POST /api/auth/login (every role: students, brands, employers, admins).
//   - per email: LOGIN_MAX_FAILS_PER_EMAIL wrong tries (default 5) within LOGIN_WINDOW_MIN (default 15) lock that
//     email for LOGIN_LOCK_MIN (default 15), whatever IP the tries come from
//   - per IP: LOGIN_MAX_FAILS_PER_IP wrong tries (default 30) within the window lock that IP for the same time (one
//     address trying many emails); higher than the email limit so a campus or office behind one address isn't
//     locked out by a few typos
//   - a locked email or IP gets 429 LOGIN_LOCKED with Retry-After and a plain message; nothing is checked meanwhile
//     (no password comparison, so a lock can't be used to test passwords)
//   - a correct password clears that email's count (not the IP's)
// Unknown emails count like wrong passwords (no free guessing of which emails exist).
// The client's address: the last X-Forwarded-For entry (the one Railway's proxy appends; earlier entries can be
// set by the client), else the socket address. Counts live in this server's memory: with more than one instance each
// counts on its own, and a restart clears them. The values are read on every request (a Railway variable change
// applies after the restart).
const DEFAULTS = { LOGIN_MAX_FAILS_PER_EMAIL: 5, LOGIN_MAX_FAILS_PER_IP: 30, LOGIN_WINDOW_MIN: 15, LOGIN_LOCK_MIN: 15 };
const num = (k) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : DEFAULTS[k]; };
const MIN = 60 * 1000;

const entries = new Map(); // key -> { fails: [times], lockedUntil }

function clientIp(req) {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String(req.socket?.remoteAddress || req.ip || "unknown");
}
const emailKey = (email) => `email:${String(email || "").trim().toLowerCase()}`;
const ipKey = (req) => `ip:${clientIp(req)}`;

function entry(key, now) {
  let e = entries.get(key);
  if (!e) { e = { fails: [], lockedUntil: 0 }; entries.set(key, e); }
  const from = now - num("LOGIN_WINDOW_MIN") * MIN;
  e.fails = e.fails.filter((t) => t > from);
  return e;
}

/** Is this login locked? { locked: false } or { locked: true, retryAfterSeconds, scope: "email" | "ip" } */
function check(req, email, now = Date.now()) {
  for (const [scope, key] of [["email", emailKey(email)], ["ip", ipKey(req)]]) {
    const e = entries.get(key);
    if (e && e.lockedUntil > now) return { locked: true, scope, retryAfterSeconds: Math.max(1, Math.ceil((e.lockedUntil - now) / 1000)) };
  }
  return { locked: false };
}

/** A wrong password or an unknown email: count it for the email and the IP; lock either when it passes its limit. */
function fail(req, email, now = Date.now()) {
  const lockMs = num("LOGIN_LOCK_MIN") * MIN;
  for (const [key, max] of [[emailKey(email), num("LOGIN_MAX_FAILS_PER_EMAIL")], [ipKey(req), num("LOGIN_MAX_FAILS_PER_IP")]]) {
    const e = entry(key, now);
    e.fails.push(now);
    if (e.fails.length >= max) { e.lockedUntil = now + lockMs; e.fails = []; }
  }
}

/** The right password: this email starts again (the IP's count stays). */
function success(req, email) {
  entries.delete(emailKey(email));
}

/** The 429 reply (Retry-After + a message that says when, and that a password reset works now). */
function reply(res, lock) {
  const minutes = Math.ceil(lock.retryAfterSeconds / 60);
  res.setHeader("Retry-After", String(lock.retryAfterSeconds));
  return res.status(429).json({
    code: "LOGIN_LOCKED",
    message: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`,
    retryAfterSeconds: lock.retryAfterSeconds,
  });
}

// old entries leave memory (no growth from many emails / addresses)
const sweep = setInterval(() => {
  const now = Date.now();
  const from = now - num("LOGIN_WINDOW_MIN") * MIN;
  for (const [k, e] of entries) if (e.lockedUntil <= now && !e.fails.some((t) => t > from)) entries.delete(k);
}, 5 * MIN);
if (sweep.unref) sweep.unref();

module.exports = { check, fail, success, reply, clientIp, _reset: () => entries.clear(), DEFAULTS };
