// Per-user rate limits (pre-pilot): Resume Studio PDF previews / exports / the employer's snapshot PDF share one
// limit per user; /api/analytics/* has its own. Defaults, variables, 429 + Retry-After, per user, after the
// sign-in and role checks, window reset, simultaneous requests, flag off.
//   node tests/rate-limits/run.js [serverDir]
// No database, no network, no .env (the fake in-memory database from tests/hide-user-secrets).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "" }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
  { get: (t, k) => (k in t ? t[k] : multerLike) }
);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "CareerResumeDraft", "CareerResumeApprovedVersion"]) reqS(`./models/${m}`);

// small limits so the test is quick; the analytics window is 3 seconds so a reset can be seen
process.env.RATE_LIMIT_ANALYTICS_MAX = "3";
process.env.RATE_LIMIT_ANALYTICS_WINDOW_MIN = "0.05";
process.env.RATE_LIMIT_RESUME_PDF_MAX = "4";
const responses = [];
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode }); return send(body); };
  next();
});
app.use("/api/analytics", reqS("./routes/analytics.routes"));
app.use("/api/career/resume", reqS("./routes/careerResume.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["admin", "A", "E1", "S1", "S2", "S3"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, role, status: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.admin, "admin", "admin"), user(ids.A, "brand", "alpha"), user(ids.E1, "employee", "hireco"), user(ids.S1, "student", "s1"), user(ids.S2, "student", "s2"), user(ids.S3, "student", "s3")]);
process.env.FLAG_RESUME_STUDIO_V2 = `ids:${ids.S1},${ids.S2},${ids.S3}`;
const content = {
  personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "Frontend Developer", email: "ayesha@example.com", location: "Karachi" },
  professionalSummary: { summary: "Computer science student who builds web apps with React." },
  education: [{ institution: "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: "2022-09-01", endDate: "2026-06-30" }],
  workExperience: [], projects: [{ name: "Campus Eats", description: "A food ordering web app.", technologies: ["React"] }],
  skills: [{ name: "JavaScript" }, { name: "React" }], certifications: [], languages: [{ name: "English", proficiency: "Fluent" }],
};
const draftOf = (u) => ({ _id: oid(), userId: u, resumeId: oid(), target: { kind: "pasted", title: "Frontend intern" }, sourceRevisionHash: "h", sourceContent: content, suggestions: [], status: "ready", createdAt: new Date() });
const versionOf = (u) => ({ _id: oid(), userId: u, sourceResumeId: oid(), draftId: oid(), label: "Frontend intern", contentSnapshot: content, contentHash: "h", rendererVersion: "1", approvedAt: new Date() });
const D1 = draftOf(ids.S1), V1 = versionOf(ids.S1), V2 = versionOf(ids.S2), V3 = versionOf(ids.S3);
fake.seed(coll("CareerResumeDraft"), [D1]);
fake.seed(coll("CareerResumeApprovedVersion"), [V1, V2, V3]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { tok } = {}) {
  return new Promise((resolve) => {
    const h = tok ? { authorization: `Bearer ${tok}` } : {};
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString("latin1"); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e), headers: {} }));
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const statuses = (rs) => rs.map((x) => x.status).join(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { admin: token(ids.admin, "admin"), A: token(ids.A, "brand"), E1: token(ids.E1, "employee"), S1: token(ids.S1, "student"), S2: token(ids.S2, "student"), S3: token(ids.S3, "student") };
  const { settings } = reqS("./utils/userRateLimit");
  let r, rs;

  console.log("-- settings");
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("RATE_LIMIT_")) delete process.env[k];
  check("defaults: Resume Studio PDFs 30 per 10 minutes, analytics 60 per 10 minutes", JSON.stringify(settings("resume_pdf")) === '{"max":30,"windowMin":10}' && JSON.stringify(settings("analytics")) === '{"max":60,"windowMin":10}');
  process.env.RATE_LIMIT_ANALYTICS_MAX = "abc"; process.env.RATE_LIMIT_ANALYTICS_WINDOW_MIN = "-5"; process.env.RATE_LIMIT_RESUME_PDF_MAX = "0";
  check("unreadable, negative or zero values use the defaults (a typo never removes the limit)", settings("analytics").max === 60 && settings("analytics").windowMin === 10 && settings("resume_pdf").max === 30);
  process.env.RATE_LIMIT_ANALYTICS_MAX = "120"; process.env.RATE_LIMIT_ANALYTICS_WINDOW_MIN = "15";
  check("variables override the defaults", settings("analytics").max === 120 && settings("analytics").windowMin === 15);
  for (const k of Object.keys(process.env)) if (k.startsWith("RATE_LIMIT_")) delete process.env[k];
  for (const k of Object.keys(saved)) if (k.startsWith("RATE_LIMIT_")) process.env[k] = saved[k];

  console.log("-- /api/analytics (3 per 3 seconds in this test)");
  rs = [];
  for (let i = 0; i < 4; i++) rs.push(await call("GET", "/api/analytics/admin/overview", { tok: T.admin }));
  check("admin: 3 overviews → 200, the 4th → 429", statuses(rs) === "200,200,200,429", statuses(rs));
  const lim = rs[3];
  check("…429 says RATE_LIMITED, how long to wait, with a Retry-After header", lim.json?.success === false && lim.json.error.code === "RATE_LIMITED" && lim.json.error.retryAfterSeconds >= 1 && lim.json.error.retryAfterSeconds <= 3 && Number(lim.headers["retry-after"]) >= 1, `${lim.text} ${lim.headers["retry-after"]}`);
  r = await call("GET", "/api/analytics/brands/me", { tok: T.A });
  const r2 = await call("GET", "/api/analytics/employers/me", { tok: T.E1 });
  check("per user: the brand and the employer are not affected by the admin's limit", r.status === 200 && r2.status === 200, `${r.status} ${r2.status}`);
  rs = [];
  for (let i = 0; i < 6; i++) rs.push(await call("GET", "/api/analytics/admin/overview", { tok: T.S1 }));
  r = await call("GET", "/api/analytics/admin/overview");
  check("the limit comes after the sign-in and role checks: a student keeps getting 403 and a guest 401, never 429", rs.every((x) => x.status === 403) && r.status === 401, `${statuses(rs)} ${r.status}`);
  process.env.RATE_LIMIT_ANALYTICS_MAX = "6";
  r = await call("GET", "/api/analytics/admin/overview", { tok: T.admin });
  check("raising RATE_LIMIT_ANALYTICS_MAX applies to the next request (no restart for the count)", r.status === 200, r.status);
  process.env.RATE_LIMIT_ANALYTICS_MAX = "3";
  await sleep(3300);
  r = await call("GET", "/api/analytics/admin/overview", { tok: T.admin });
  check("after the window the admin can read again", r.status === 200, r.status);
  await sleep(3300);
  rs = await Promise.all(Array.from({ length: 20 }, () => call("GET", "/api/analytics/brands/me", { tok: T.A })));
  check("20 simultaneous requests from one user: exactly 3 answered, 17 limited", rs.filter((x) => x.status === 200).length === 3 && rs.filter((x) => x.status === 429).length === 17, statuses(rs));

  console.log("-- Resume Studio PDFs (4 per user per window, shared)");
  rs = [
    await call("GET", `/api/career/resume/drafts/${D1._id}/preview.pdf`, { tok: T.S1 }),
    await call("GET", `/api/career/resume/versions/${V1._id}/export.pdf`, { tok: T.S1 }),
    await call("GET", `/api/career/resume/drafts/${D1._id}/preview.pdf`, { tok: T.S1 }),
    await call("GET", `/api/career/resume/versions/${V1._id}/export.pdf`, { tok: T.S1 }),
  ];
  check("previews and exports: 4 PDFs", rs.every((x) => x.status === 200 && x.headers["content-type"] === "application/pdf" && x.text.startsWith("%PDF")), statuses(rs));
  r = await call("GET", `/api/career/resume/drafts/${D1._id}/preview.pdf`, { tok: T.S1 });
  const r3 = await call("GET", `/api/career/resume/versions/${V1._id}/export.pdf`, { tok: T.S1 });
  check("the 5th PDF (preview or export, one shared count) → 429 RATE_LIMITED", r.status === 429 && r3.status === 429 && r.json?.error?.code === "RATE_LIMITED", `${r.status} ${r3.status}`);
  r = await call("GET", `/api/career/resume/drafts/${D1._id}`, { tok: T.S1 });
  check("…the student can still open the draft itself (only PDFs are limited)", r.status === 200, r.status);
  r = await call("GET", `/api/career/resume/versions/${V2._id}/export.pdf`, { tok: T.S2 });
  check("another student's PDF isn't affected", r.status === 200 && r.headers["content-type"] === "application/pdf", r.status);
  rs = await Promise.all(Array.from({ length: 10 }, () => call("GET", `/api/career/resume/versions/${V3._id}/export.pdf`, { tok: T.S3 })));
  check("10 simultaneous exports from one student: exactly 4 rendered", rs.filter((x) => x.status === 200).length === 4 && rs.filter((x) => x.status === 429).length === 6, statuses(rs));
  delete process.env.FLAG_RESUME_STUDIO_V2;
  rs = await Promise.all(Array.from({ length: 6 }, () => call("GET", `/api/career/resume/versions/${V2._id}/export.pdf`, { tok: T.S2 })));
  check("flag off: 404 STUDIO_OFF every time (the limit never shows a feature that is off)", rs.every((x) => x.status === 404), statuses(rs));

  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url).join(" | "));
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
