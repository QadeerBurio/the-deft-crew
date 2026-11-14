// A student's own match for one job (job details "your match"): GET /api/career/matching/jobs/:jobId/me and
// matchingService.summaryLine. FLAG_CAREER_MATCHING students only; the estimate and band, the job's skills found in
// the resume (with where), the missing ones, the mandatory criteria and a one-line summary built from that evidence.
// Fairness (docs/MATCHING_FAIRNESS.md): name, university and city never change it. Nothing about another student.
//   node tests/career-job-match-me/run.js [serverDir]
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
// pilot checks: no built-in "on" default (as before this branch), so "outside the pilot" still means off
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "Resume"]) reqS(`./models/${m}`);
const matching = reqS("./services/career/matchingService");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S1", "S2", "S3", "OUT", "E", "A", "R1", "R2", "ROUT", "J1", "J2", "J3", "J4", "J5"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "zara"), user(ids.OUT, "student", "omar"), user(ids.E, "employee", "hireco"), user(ids.A, "admin", "admin")]);
const blank = () => ({ personalInfo: {}, professionalSummary: { summary: "" }, workExperience: [], education: [], projects: [], skills: [], certifications: [], languages: [] });
function person({ skills, name = "Ayesha Khan", city = "Karachi", university = "NED University", degree = "BS" }) {
  const c = blank();
  c.personalInfo = { firstName: name.split(" ")[0], lastName: name.split(" ")[1] || "", title: "Software developer", email: `${name.split(" ")[0].toLowerCase()}@example.com`, phone: "+92 300 0000000", location: city };
  c.education = [{ institution: university, degree, fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", current: false, description: `Studied at ${university}, ${city}` }];
  c.skills = skills.map((s) => ({ name: s, category: "" }));
  c.projects = [{ name: "Final year project", description: `A web app built with ${skills.join(", ")}.`, technologies: skills }];
  return c;
}
const now = Date.now();
const job = (id, extra) => ({ _id: id, department: "Eng", location: "Karachi", type: "Internship", salary: "x", email: "hr@hireco.test", description: "d", postedBy: ids.E, isExternal: false, active: true, requirements: [], minExperience: 0, createdAt: new Date(now - 3600e3), ...extra });
fake.seed(coll("Job"), [
  job(ids.J1, { title: "Full-stack intern", skills: ["JavaScript", "React", "Node.js", "Express", "Git", "MongoDB"], requirements: ["Must know React"] }),
  job(ids.J2, { title: "React intern", skills: ["JavaScript", "React"] }),
  job(ids.J3, { title: "No skills listed", skills: [] }),
  job(ids.J4, { title: "Senior dev", skills: ["React"], minExperience: 5 }),
  job(ids.J5, { title: "Deleted job", skills: ["React"], archivedAt: new Date(now - 1000) }),
]);
const SKILLS = ["JavaScript", "React", "Node.js", "Express", "Git"];
fake.seed(coll("Resume"), [
  { _id: ids.R1, user: ids.S1, isPrimary: true, ...person({ skills: SKILLS }), updatedAt: new Date(now - 7200e3) },
  // S2: the same skills, different name, university, city
  { _id: ids.R2, user: ids.S2, isPrimary: true, ...person({ skills: SKILLS, name: "Bilal Ahmed", university: "Some Other University", city: "Lahore" }), updatedAt: new Date(now - 7200e3) },
  { _id: ids.ROUT, user: ids.OUT, isPrimary: true, ...person({ skills: SKILLS }), updatedAt: new Date(now - 7200e3) },
]);
fake.seed(coll("JobApplication"), [{ _id: oid(), jobId: ids.J2, userId: ids.S1, fullName: "x", email: "x@test.local", phone: "1", coverLetter: "c", status: "pending", appliedAt: new Date(now - 1000) }]);
// S3 has no resume. OUT is a student outside the pilot.
process.env.FLAG_CAREER_MATCHING = `ids:${ids.S1},${ids.S2},${ids.S3},${ids.E}`;
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

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { S1: token(ids.S1, "student"), S2: token(ids.S2, "student"), S3: token(ids.S3, "student"), OUT: token(ids.OUT, "student"), E: token(ids.E, "employee"), A: token(ids.A, "admin") };
  const me = (jobId, tok) => call("GET", `/api/career/matching/jobs/${jobId}/me`, tok);

  console.log("── 1. the student's match for one job");
  let r = await me(ids.J1, T.S1);
  const d = r.json?.data || {};
  const m = d.match || {};
  check("200 with the estimate: 5 of 6 skills = 83, band strong", r.status === 200 && m.score === 83 && m.quality === "strong", r.text.slice(0, 300));
  check("…the matched skills, each with where the resume shows it", m.matched?.length === 5 && m.matched.every((s) => s.evidence.length >= 1 && s.evidence.length <= 2) && m.matched.map((s) => s.skill).join() === SKILLS.join(), JSON.stringify(m.matched));
  check("…the missing skill", JSON.stringify(m.missing) === '["MongoDB"]' && Array.isArray(m.unknown) && m.unknown.length === 0);
  check("…the mandatory criteria (\"Must know React\": met, with the evidence)", m.mandatory?.length === 1 && m.mandatory[0].status === "met" && /React/.test(m.mandatory[0].evidence) && m.mandatorySummary?.met === 1);
  check("…one line built from the evidence", m.summary === "Matches 5 of 6 skills, missing MongoDB, meets all requirements", m.summary);
  check("…model, formula, hasResume, applied: false, and an honest note", d.modelVersion === "skill-evidence-1" && /evidence/.test(d.formula) && d.hasResume === true && d.applied === false && /not a promise/.test(d.note) && /Check the job yourself/.test(d.note));
  check("…nothing about the person or the employer (no name, email, phone, university, city, employer id)", !/sana|Ayesha|Khan|example\.com|\+92|NED University|Karachi|hireco|hr@/i.test(r.text) && !new RegExp(String(ids.E)).test(r.text), r.text.slice(0, 300));

  r = await me(ids.J2, T.S1);
  check("a job they applied to: applied true, 100%, \"Matches 2 of 2 skills\"", r.status === 200 && r.json.data.applied === true && r.json.data.match.score === 100 && r.json.data.match.summary === "Matches 2 of 2 skills", JSON.stringify(r.json?.data?.match?.summary));
  r = await me(ids.J4, T.S1);
  check("a mandatory criterion not met is shown, the estimate isn't lowered by it", r.status === 200 && r.json.data.match.score === 100 && r.json.data.match.mandatorySummary.notMet === 1 && r.json.data.match.summary === "Matches 1 of 1 skill, 1 requirement not met", r.json?.data?.match?.summary);
  r = await me(ids.J3, T.S1);
  check("a job with no skills listed: not enough information, no score", r.status === 200 && r.json.data.match.score === null && r.json.data.match.quality === "insufficient" && r.json.data.match.summary === "Not enough information: the job lists no skills", r.json?.data?.match?.summary);

  console.log("── 2. fairness: name, university and city never change it");
  const a = (await me(ids.J1, T.S1)).json.data.match, b = (await me(ids.J1, T.S2)).json.data.match;
  check("same skills, different name / university / city → the same match", JSON.stringify(a) === JSON.stringify(b));

  console.log("── 3. who can read it");
  r = await me(ids.J1, T.S3);
  check("a pilot student without a resume: hasResume false, match null", r.status === 200 && r.json.data.hasResume === false && r.json.data.match === null);
  r = await me(ids.J1, T.OUT);
  check("a student outside FLAG_CAREER_MATCHING: 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");
  r = await me(ids.J1, T.E);
  check("the employer (not a student): 404", r.status === 404 && r.json?.error?.code === "NOT_FOUND");
  r = await me(ids.J1, T.A);
  check("an admin: 404 (a student's own view)", r.status === 404);
  r = await me(ids.J1);
  check("no login: 401", r.status === 401);
  r = await me(ids.J5, T.S1);
  check("a deleted job: 404", r.status === 404 && r.json?.error?.code === "NOT_FOUND");
  r = await me("not-an-id", T.S1);
  check("a bad id: 404", r.status === 404);
  r = await me(oid(), T.S1);
  check("an unknown job: 404", r.status === 404);

  console.log("── 4. summaryLine");
  const line = (skills, mandatorySummary, insufficient = null) => matching.summaryLine({ relevance: { insufficient }, skills, mandatorySummary });
  const S = (...n) => n.map((skill) => ({ skill }));
  check("many missing: the first three, then +N more", line({ matched: S("a"), missing: S("b", "c", "d", "e", "f"), unknown: [] }, { met: 0, notMet: 0, unknown: 0 }) === "Matches 1 of 6 skills, missing b, c, d +2 more");
  check("requirements to check", line({ matched: S("a", "b"), missing: [], unknown: [] }, { met: 1, notMet: 0, unknown: 2 }) === "Matches 2 of 2 skills, 2 requirements to check");
  check("insufficient", line({ matched: [], missing: [], unknown: S("a") }, {}, "the resume has too little information") === "Not enough information: the resume has too little information");
  check("no criteria: no claim about requirements", line({ matched: S("a"), missing: S("b"), unknown: [] }, { met: 0, notMet: 0, unknown: 0 }) === "Matches 1 of 2 skills, missing b");

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
