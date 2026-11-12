// A job's contact email (Job.email) never reaches students or the public: GET /api/jobs/public/job/:id,
// /public/all, /public/tdc and the no-resume fallbacks of /recommendations, /recommendations/top and /feed leave it
// out. The employer who posted the job (/my-jobs) and admins (/all) still read it (the portal's job editor).
//   node tests/public-job-contact/run.js [serverDir]
// No database, no network, no .env (the fake in-memory database from tests/hide-user-secrets).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "OPENAI_API_KEY"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];
process.env.OPENAI_API_KEY = "test-only-not-a-key";

class Expo {
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
  if (resolved.endsWith(path.join("services", "recommendationService.js"))) return { getHybridRecommendations: async () => [], getSimilarJobs: async () => [] };
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = async (url) => { throw new Error(`network blocked in test: ${url}`); };

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "Resume"]) reqS(`./models/${m}`);

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/jobs", reqS("./routes/jobs.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S", "E", "E2", "A", "J1", "J2", "J3"]) ids[k] = oid();
const now = Date.now();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.S, "student", "sana"), user(ids.E, "employee", "hireco"), user(ids.E2, "employee", "otherco"), user(ids.A, "admin", "admin")]);
const CONTACT = "hr-contact@hireco.test";
const job = (id, extra) => ({ _id: id, title: "Job", department: "Eng", category: "Technology", location: "Karachi, Pakistan", type: "Internship", salary: "x", email: CONTACT, description: "d", postedBy: ids.E, isExternal: false, active: true, requirements: [], skills: ["React"], applicationDeadline: new Date(now + 7 * 864e5), createdAt: new Date(now - 3600e3), ...extra });
fake.seed(coll("Job"), [
  job(ids.J1, { title: "External featured internship", isExternal: true, featured: true }),
  job(ids.J2, { title: "TDC internship", isExternal: false }),
  job(ids.J3, { title: "Other employer's job", postedBy: ids.E2, email: "jobs@otherco.test" }),
]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, tok) {
  return new Promise((resolve) => {
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: tok ? { authorization: `Bearer ${tok}` } : {} }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const noContact = (r) => !/@hireco\.test|@otherco\.test/.test(r.text) && !/"email"\s*:/.test(r.text);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { S: token(ids.S, "student"), E: token(ids.E, "employee"), A: token(ids.A, "admin") };

  console.log("── public and student replies: no contact email");
  let r = await call("GET", `/api/jobs/public/job/${ids.J1}`);
  check("GET /public/job/:id (no login): the job, without its contact email", r.status === 200 && r.json?.title === "External featured internship" && !("email" in (r.json || {})) && noContact(r), r.text.slice(0, 200));
  check("…the rest of the job is still there (description, skills, deadline, isExpired)", r.json?.description === "d" && r.json?.skills?.[0] === "React" && !!r.json?.applicationDeadline && r.json?.isExpired === false);
  r = await call("GET", `/api/jobs/public/job/${ids.J1}`, T.S);
  check("…same for a logged-in student", r.status === 200 && noContact(r));
  r = await call("GET", "/api/jobs/public/all");
  check("GET /public/all: jobs listed, no contact email", r.status === 200 && (r.json?.jobs || []).length === 3 && noContact(r), `${r.status} ${(r.json?.jobs || []).length}`);
  r = await call("GET", "/api/jobs/public/tdc");
  check("GET /public/tdc: jobs listed, no contact email", r.status === 200 && (r.json?.jobs || []).length >= 1 && noContact(r), `${r.status} ${(r.json?.jobs || []).length}`);
  r = await call("GET", "/api/jobs/recommendations", T.S);
  check("GET /recommendations (no resume, featured fallback): no contact email", r.status === 200 && (r.json?.recommendations || []).length === 1 && noContact(r), r.text.slice(0, 200));
  r = await call("GET", "/api/jobs/recommendations/top", T.S);
  check("GET /recommendations/top (no resume): no contact email", r.status === 200 && (r.json?.recommendations || []).length >= 1 && noContact(r), r.text.slice(0, 200));
  r = await call("GET", "/api/jobs/feed", T.S);
  check("GET /feed (no resume): jobs listed, no contact email", r.status === 200 && (r.json?.jobs || []).length >= 1 && noContact(r), r.text.slice(0, 200));

  console.log("── the employer who posted it, and admins: still read it");
  r = await call("GET", "/api/jobs/my-jobs", T.E);
  const mine = r.json || [];
  check("GET /my-jobs (the employer): their jobs with the contact email", r.status === 200 && mine.length === 2 && mine.every((j) => j.email === CONTACT), r.text.slice(0, 200));
  check("…and never another employer's job", !/otherco\.test/.test(r.text));
  r = await call("GET", "/api/jobs/all", T.A);
  check("GET /all (admin): every job with its contact email", r.status === 200 && (r.json || []).length === 3 && (r.json || []).every((j) => /@(hireco|otherco)\.test$/.test(j.email)), r.text.slice(0, 200));
  r = await call("GET", "/api/jobs/all", T.S);
  check("GET /all as a student: refused", r.status === 401 || r.status === 403, String(r.status));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
