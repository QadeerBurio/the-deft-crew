// "A new job that matches your skills" (models/CareerJobAlert.js, services/career/jobAlerts.js), FLAG_CAREER_MATCHING:
// when an internal job goes live (POST /api/jobs/add active, or PATCH /api/jobs/toggle/:id on), pilot students whose
// resume shows 70%+ of its skills (no mandatory criterion "not met") get one push through the REAL pushGateway
// (caps, quiet hours, the "jobsScholarships" opt-out) and an in-app note: at most one a day, never twice for the same
// job; never for external jobs, employers outside the pilot, students who applied, closed or past-deadline jobs.
// Name, university and city never decide who is alerted.
//   node tests/career-job-alerts/run.js [serverDir]
// Real routes, services, gateway and models on a fake MongoDB; only Expo's send, the quiet-hours clock and the job
// embedding call are stubbed. No database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "OPENAI_API_KEY"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

class Expo {
  static isExpoPushToken(t) { return /^ExponentPushToken\[.+\]$/.test(String(t)); }
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
const pushed = [];
let quiet = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  if (resolved.endsWith(path.join("services", "jobEmbeddingService.js"))) return { generateJobEmbedding: async () => null };
  if (resolved.endsWith(path.join("utils", "pushNotification.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, sendAllSafe: async (_x, messages) => { pushed.push(...messages); return messages.map((_, i) => ({ status: "ok", id: `t${pushed.length}-${i}` })); }, handleTickets: async () => {} };
  }
  if (resolved.endsWith(path.join("utils", "karachiTime.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, isQuietHour: () => quiet };
  }
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = async (url) => { throw new Error(`network blocked in test: ${url}`); };

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
// pilot checks: no built-in "on" default (as before this branch), so "outside the pilot" still means off
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "Resume", "CareerJobAlert", "Notification", "EngagementProfile", "PushLog"]) reqS(`./models/${m}`);
const alerts = reqS("./services/career/jobAlerts");
const outboxJob = reqS("./services/career/careerOutboxJob");
const { dayKey } = reqS("./utils/karachiTime");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/jobs", reqS("./routes/jobs.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["E", "EOUT", "ADM", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "SOUT"]) ids[k] = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
const student = (k, extra = {}) => ({ _id: ids[k], name: `Student ${k}`, email: `${k}@test.local`, phone: "03001234567", role: "student", status: "Verified", accountStatus: "active", pushTokens: [{ token: tok(k), platform: "android", channels: "snd_v2", updatedAt: new Date() }], createdAt: new Date(), ...extra });
fake.seed(coll("User"), [
  { _id: ids.E, name: "Hina", email: "e@test.local", role: "employee", companyName: "Bright Labs", status: "Verified", createdAt: new Date() },
  { _id: ids.EOUT, name: "Other", email: "eo@test.local", role: "employee", companyName: "Other Co", status: "Verified", createdAt: new Date() },
  { _id: ids.ADM, name: "admin", email: "adm@test.local", role: "admin", createdAt: new Date() },
  student("S1"), student("S2"), student("S3"), student("S4"), student("S5"), student("S6"), student("S7", { pushTokens: [] }), student("SOUT"),
]);
const blank = () => ({ personalInfo: {}, professionalSummary: { summary: "" }, workExperience: [], education: [], projects: [], skills: [], certifications: [], languages: [] });
function person(skills, { name = "Ayesha Khan", city = "Karachi", university = "NED University", degree = "BS" } = {}) {
  const c = blank();
  c.personalInfo = { firstName: name.split(" ")[0], lastName: name.split(" ")[1] || "", title: "Software developer", email: "x@example.com", phone: "+92 300 0000000", location: city };
  c.education = [{ institution: university, degree, fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", current: false }];
  c.skills = skills.map((s) => ({ name: s, category: "" }));
  c.projects = [{ name: "Final year project", description: `Built with ${skills.join(", ")}.`, technologies: skills }];
  return c;
}
const STRONG = ["JavaScript", "React", "Node.js"];
fake.seed(coll("Resume"), [
  { _id: oid(), user: ids.S1, isPrimary: true, ...person(STRONG), updatedAt: new Date() },
  { _id: oid(), user: ids.S2, isPrimary: true, ...person(STRONG, { name: "Bilal Ahmed", city: "Lahore", university: "Some Other University" }), updatedAt: new Date() },
  { _id: oid(), user: ids.S3, isPrimary: true, ...person(["JavaScript"]), updatedAt: new Date() }, // 33%: weak
  { _id: oid(), user: ids.S4, isPrimary: true, ...person(STRONG), updatedAt: new Date() }, // jobsScholarships off
  { _id: oid(), user: ids.S5, isPrimary: true, ...person(STRONG), updatedAt: new Date() }, // already had today's marketing push
  // S6: no resume; S7: no push token
  { _id: oid(), user: ids.S7, isPrimary: true, ...person(STRONG), updatedAt: new Date() },
  { _id: oid(), user: ids.SOUT, isPrimary: true, ...person(STRONG), updatedAt: new Date() }, // outside the pilot
]);
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: ids.S4, level: { id: "member" }, points: { balance: 0 }, streak: { count: 0, best: 0, freezesLeft: 1 }, notifPrefs: { jobsScholarships: false }, push: {} },
  { _id: oid(), user: ids.S5, level: { id: "member" }, points: { balance: 0 }, streak: { count: 0, best: 0, freezesLeft: 1 }, notifPrefs: { jobsScholarships: true }, push: { lastPushDay: dayKey(), weekKey: "", sentThisWeek: 1 } },
]);
process.env.FLAG_CAREER_MATCHING = `ids:${ids.E},${["S1", "S2", "S3", "S4", "S5", "S6", "S7"].map((k) => ids[k]).join(",")}`;
const jwtFor = (k, role) => jwt.sign({ id: String(ids[k]), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { body, t } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (t) h.authorization = `Bearer ${t}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const alertRows = (f = () => true) => rows("CareerJobAlert", f);
const who = (rs) => rs.map((x) => Object.keys(ids).find((k) => same(ids[k], x.student))).sort().join(",");
const pushedTo = (k) => pushed.filter((m) => m.to === tok(k));
const settle = async () => {
  let last = "", stable = 0;
  for (let i = 0; i < 250 && stable < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const busy = alertRows((x) => x.status === "sending" || (x.status === "pending" && new Date(x.nextAttemptAt) <= new Date())).length;
    const sig = `${alertRows().length}:${busy}:${pushed.length}`;
    stable = sig === last && !busy ? stable + 1 : 0;
    last = sig;
  }
};
const jobBody = (extra = {}) => ({ title: "React intern", department: "Eng", location: "Karachi", type: "Internship", salary: "PKR 40,000", email: "hr@brightlabs.test", description: "Build web apps", skills: ["JavaScript", "React", "Node.js"], companyName: "Bright Labs", minExperience: 0, ...extra });

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const TE = jwtFor("E", "employee"), TEOUT = jwtFor("EOUT", "employee");

  console.log("── 1. a pilot employer posts a job: strong matches hear about it");
  let r = await call("POST", "/api/jobs/add", { t: TE, body: jobBody() });
  const J1 = r.json?.data?._id;
  await settle();
  check("job posted (201)", r.status === 201 && !!J1, r.text.slice(0, 120));
  check("alert rows for strong matches in the pilot with a resume and a token: S1, S2 (another name, city, university), S4, S5", who(alertRows()) === "S1,S2,S4,S5", who(alertRows()));
  check("…not S3 (33%: weak), S6 (no resume), S7 (no push token), SOUT (outside the pilot)", ["S3", "S6", "S7", "SOUT"].every((k) => !alertRows((x) => same(x.student, ids[k])).length));
  check("S1 and S2 got the push: the job, the company, how many skills, which ones; a tap opens the job", pushedTo("S1").length === 1 && pushedTo("S2").length === 1 && /A new job that matches your skills/.test(pushedTo("S1")[0].title) && /React intern at Bright Labs: your resume shows 3 of its 3 skills \(JavaScript, React, Node\.js\)\./.test(pushedTo("S1")[0].body) && pushedTo("S1")[0].data.screen === "Career" && pushedTo("S1")[0].data.params.openJobId === String(J1), JSON.stringify(pushedTo("S1")[0]));
  check("…no employer e-mail or phone in it", !/hr@brightlabs\.test|0300/.test(JSON.stringify(pushed)));
  const s4 = alertRows((x) => same(x.student, ids.S4))[0], s5 = alertRows((x) => same(x.student, ids.S5))[0];
  check("S4 (jobs notifications off) → skipped: pref_off", pushedTo("S4").length === 0 && s4.status === "skipped" && s4.lastError === "pref_off", s4.lastError);
  check("S5 (already had today's marketing push) → skipped: daily_cap", pushedTo("S5").length === 0 && s5.status === "skipped" && s5.lastError === "daily_cap", s5.lastError);
  const notes = rows("Notification", (n) => n.metadata?.careerJobId === String(J1));
  check("an in-app note for each push sent (2)", notes.length === 2 && notes.every((n) => n.type === "Job Posting"), notes.length);

  console.log("── 2. at most one a day; never twice for the same job");
  r = await call("POST", "/api/jobs/add", { t: TE, body: jobBody({ title: "Node intern" }) });
  await settle();
  check("a second strong job the same day: no new rows", r.status === 201 && alertRows().length === 4, alertRows().length);
  await call("PATCH", `/api/jobs/toggle/${J1}`, { t: TE });
  await call("PATCH", `/api/jobs/toggle/${J1}`, { t: TE });
  await settle();
  const later = await alerts.onJobLive(J1, { now: new Date(Date.now() + 2 * 864e5), drainNow: false });
  check("switched off and on again, even on another day: nobody alerted twice for the same job", alertRows((x) => same(x.job, J1)).length === 4 && later.queued === 0, JSON.stringify(later));

  console.log("── 3. who never triggers alerts");
  const before = alertRows().length;
  r = await call("POST", "/api/jobs/add", { t: TEOUT, body: jobBody({ title: "Outsider React job" }) });
  await settle();
  check("an employer outside the pilot: no alerts", r.status === 201 && alertRows().length === before);
  const ext = await alerts.onJobLive({ ...r.json.data, _id: oid(), postedBy: ids.E, isExternal: true }, { drainNow: false });
  check("an external (imported) job: no alerts", ext.queued === 0 && /external/.test(ext.reason));
  r = await call("POST", "/api/jobs/add", { t: TE, body: jobBody({ title: "Inactive job", active: false }) });
  await settle();
  check("a job posted switched off: no alerts", alertRows().length === before);
  const noSkills = await alerts.onJobLive({ ...r.json.data, _id: oid(), active: true, skills: [] }, { drainNow: false });
  check("a job listing no skills: no alerts (no estimate)", noSkills.queued === 0 && /no skills/.test(noSkills.reason));

  console.log("── 4. quiet hours; closed jobs; applicants");
  const k = new Date(Date.now() + 5 * 3600e3);
  const at = (d, h, m = 0) => new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + d, h, m) - 5 * 3600e3);
  const J9 = { _id: oid(), title: "Night React job", companyName: "Bright Labs", skills: STRONG, requirements: [], minExperience: 0, active: true, isExternal: false, postedBy: ids.E, applicationDeadline: at(10, 12), location: "Karachi" };
  fake.seed(coll("Job"), [J9]);
  quiet = true;
  const q = await alerts.onJobLive(J9, { now: at(1, 23, 30), drainNow: false });
  const r1 = alertRows((x) => same(x.job, J9._id) && same(x.student, ids.S1))[0];
  await alerts.deliver(r1._id, at(1, 23, 30));
  const d1 = alertRows((x) => same(x._id, r1._id))[0];
  check("posted at 23:30 (quiet hours): queued, deferred to 09:00, nothing sent", q.queued >= 1 && d1.status === "pending" && new Date(d1.nextAttemptAt).getTime() === at(2, 9).getTime() && pushed.filter((m) => /Night React job/.test(m.body)).length === 0, `${d1.status} ${d1.nextAttemptAt}`);
  quiet = false;
  // the student applies before 09:00: the alert is dropped
  fake.seed(coll("JobApplication"), [{ _id: oid(), jobId: J9._id, userId: ids.S1, status: "pending", appliedAt: new Date() }]);
  const tick = await outboxJob.tick(at(2, 9));
  check("the careerOutbox tick at 09:00 delivers what's due; a student who applied meanwhile isn't alerted", alertRows((x) => same(x._id, r1._id))[0].status === "skipped" && alertRows((x) => same(x._id, r1._id))[0].lastError === "already applied" && typeof tick.jobAlerts === "number", JSON.stringify(tick));
  const J10 = { ...J9, _id: oid(), title: "Closing React job" };
  fake.seed(coll("Job"), [J10]);
  await alerts.onJobLive(J10, { now: at(3, 12), drainNow: false });
  rows("Job", (j) => same(j._id, J10._id))[0].active = false;
  for (const row of alertRows((x) => same(x.job, J10._id))) await alerts.deliver(row._id, at(3, 12, 1));
  const closed = alertRows((x) => same(x.job, J10._id));
  check("a job switched off before delivery: skipped, never sent", closed.length >= 1 && closed.every((x) => x.status === "skipped" && /no longer open/.test(x.lastError)) && pushed.filter((m) => /Closing React job/.test(m.body)).length === 0, JSON.stringify(closed.map((x) => x.lastError)));
  const past = await alerts.onJobLive({ ...J9, _id: oid(), applicationDeadline: at(-1, 12) }, { drainNow: false });
  check("a job past its deadline: no alerts", past.queued === 0);

  console.log("── 5. fairness: name, university and city don't decide who is alerted");
  const scoreOf = (k) => alertRows((x) => same(x.job, J1) && same(x.student, ids[k]))[0]?.score;
  check("S1 (Ayesha, NED, Karachi) and S2 (Bilal, another university, Lahore) with the same skills: the same score (100)", scoreOf("S1") === 100 && scoreOf("S2") === 100);

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
