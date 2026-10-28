// middleware/perfLog.js
// Response time + size for the routes the app opens most (App speed work).
//   per request:  [perf] GET /api/brands 200 412ms 29338B
//   every 10 min: [perf-summary] GET /api/brands n=57 p50=380ms p90=910ms p50size=29338B
// Logs the route pattern only (never the query string, ids, user or body). Size is the
// body before compression. PERF_LOG=0 turns it off.

const WATCHED = new Set([
  "GET /api/brands/",
  "GET /api/brands/nearby",
  "GET /api/offers/brandss",
  "GET /api/offers/summary",
  "GET /api/offers/claimed",
  "GET /api/offers/my-total-savings",
  "GET /api/engagement/home",
  "GET /api/engagement/me",
  "GET /api/auth/me",
  "GET /api/notification/my-notifications",
  "GET /api/notification/unread-count",
  "GET /api/social/feed",
  "GET /api/social/confessions/feed",
  "GET /api/events/feed",
  "GET /api/admin/all",
]);

const SUMMARY_EVERY_MS = 10 * 60 * 1000;
const KEEP = 500; // samples per route between summaries

const samples = new Map(); // route -> [{ ms, bytes }]

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

function logSummary() {
  for (const [route, list] of samples) {
    if (!list.length) continue;
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    const bytes = list.map((s) => s.bytes).sort((a, b) => a - b);
    console.log(`[perf-summary] ${route} n=${list.length} p50=${pct(ms, 0.5)}ms p90=${pct(ms, 0.9)}ms p50size=${pct(bytes, 0.5)}B`);
    list.length = 0;
  }
}

function perfLog() {
  if (process.env.PERF_LOG === "0") return (req, res, next) => next();

  const timer = setInterval(logSummary, SUMMARY_EVERY_MS);
  if (timer.unref) timer.unref();

  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const start = process.hrtime.bigint();
    let bytes = 0;
    const count = (chunk, encoding) => {
      if (chunk && typeof chunk !== "function") bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === "string" ? encoding : "utf8");
    };
    const write = res.write;
    const end = res.end;
    res.write = function (chunk, encoding, cb) { count(chunk, encoding); return write.call(this, chunk, encoding, cb); };
    res.end = function (chunk, encoding, cb) { count(chunk, encoding); return end.call(this, chunk, encoding, cb); };

    res.on("finish", () => {
      const route = `GET ${req.baseUrl || ""}${req.route?.path || ""}`;
      if (!WATCHED.has(route)) return;
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      console.log(`[perf] ${route} ${res.statusCode} ${ms}ms ${bytes}B`);
      if (!samples.has(route)) samples.set(route, []);
      const list = samples.get(route);
      if (list.length < KEEP) list.push({ ms, bytes });
    });
    next();
  };
}

module.exports = perfLog;
module.exports.logSummary = logSummary;
module.exports.WATCHED = WATCHED;
