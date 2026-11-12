// Best matches for the employer's job (Part 1): GET /api/career/matching/jobs/:jobId/ranked and the "best" view on
// GET /applications/:id (the candidate drawer and profile). Every applicant listed, highest estimate first, each
// with the band, a one-line summary, top strengths (skill + resume line), gaps and each skill's status (compare).
// FLAG_CAREER_MATCHING + FLAG_CAREER_TIMELINE for the employer. Fairness: name, university and city never change it.
// Nothing is rejected or hidden.
//   node tests/career-best-matches/run.js [serverDir]
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
for (const m of ["User", "Job", "JobApplication", "Resume", "CareerMatchSnapshot", "CareerApplicationResumeAttachment", "CareerResumeApprovedVersion", "DomainEvent"]) reqS(`./models/${m}`);
const matching = reqS("./services/career/matchingService");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S1", "S2", "S3", "S4", "S5", "S6", "E", "E2", "A", "J", "J2"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [
  user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "bilal"), user(ids.S4, "student", "zara"), user(ids.S5, "student", "omar"), user(ids.S6, "student", "hina"),
  user(ids.E, "employee", "hireco"), user(ids.E2, "employee", "otherco"), user(ids.A, "admin", "admin"),
]);
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
const JOB_SKILLS = ["JavaScript", "React", "Node.js", "Express", "Git", "MongoDB"];
const job = (id, extra) => ({ _id: id, title: "Full-stack intern", department: "Eng", location: "Karachi", type: "Internship", salary: "x", email: "hr@hireco.test", description: "d", postedBy: ids.E, isExternal: false, active: true, skills: JOB_SKILLS, requirements: ["Must know React"], minExperience: 0, createdAt: new Date(now - 864e5), ...extra });
fake.seed(coll("Job"), [job(ids.J), job(ids.J2, { title: "Other employer's job", postedBy: ids.E2 })]);
const FIVE = ["JavaScript", "React", "Node.js", "Express", "Git"];
fake.seed(coll("Resume"), [
  { _id: oid(), user: ids.S1, isPrimary: true, ...person({ skills: FIVE }), updatedAt: new Date(now - 7200e3) },
  { _id: oid(), user: ids.S2, isPrimary: true, ...person({ skills: ["React", "Git"], name: "Taha Raza" }), updatedAt: new Date(now - 7200e3) },
  // S3: S1's skills, a different name, university and city
  { _id: oid(), user: ids.S3, isPrimary: true, ...person({ skills: FIVE, name: "Bilal Ahmed", university: "Some Other University", city: "Lahore" }), updatedAt: new Date(now - 7200e3) },
  // S4: no resume
  { _id: oid(), user: ids.S5, isPrimary: true, ...person({ skills: FIVE, name: "Omar Shah" }), updatedAt: new Date(now - 7200e3) },
  { _id: oid(), user: ids.S6, isPrimary: true, ...person({ skills: ["JavaScript", "React", "Node.js"], name: "Hina Malik" }), updatedAt: new Date(now - 7200e3) },
]);
const A = {};
const apply = (k, hoursAgo) => { A[k] = oid(); return { _id: A[k], jobId: ids.J, userId: ids[k], fullName: `${k} full name`, email: `${k}@test.local`, phone: "0300", coverLetter: "c", status: "pending", appliedAt: new Date(now - hoursAgo * 3600e3) }; };
fake.seed(coll("JobApplication"), [apply("S1", 50), apply("S2", 40), apply("S3", 30), apply("S4", 20), apply("S5", 10), apply("S6", 5)]);
const setFlags = ({ matching = true, timeline = true } = {}) => {
  process.env.FLAG_CAREER_MATCHING = matching ? `ids:${ids.E},${ids.E2},${ids.S1},${ids.S2},${ids.S3},${ids.S4},${ids.S6}` : "";
  process.env.FLAG_CAREER_TIMELINE = timeline ? `ids:${ids.E},${ids.E2}` : "";
};
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
const strip = (m) => { const { computedAt, ...rest } = m || {}; return rest; };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { E: token(ids.E, "employee"), E2: token(ids.E2, "employee"), A: token(ids.A, "admin"), S1: token(ids.S1, "student") };
  const ranked = (jobId, tok) => call("GET", `/api/career/matching/jobs/${jobId}/ranked`, tok);
  setFlags();

  console.log("── 1. best matches for the employer's job");
  let r = await ranked(ids.J, T.E);
  const d = r.json?.data || {};
  const rows = d.applications || [];
  const order = rows.map((x) => Object.keys(A).find((k) => A[k].toString() === x.applicationId));
  check("200, every applicant listed (nobody hidden)", r.status === 200 && rows.length === 6, r.text.slice(0, 300));
  check("highest estimate first; ties newest first; 'not enough info' after the estimates; outside the pilot last", order.join() === "S3,S1,S6,S2,S4,S5", order.join());
  check("ranks number the estimates only (1..4), not the rest", rows.map((x) => x.rank).join() === "1,2,3,4,,", rows.map((x) => x.rank).join());
  const s1 = rows.find((x) => x.applicationId === String(A.S1)).match;
  check("each: percentage and band (83%, strong)", s1.score === 83 && s1.quality === "strong" && s1.qualityLabel === "strong");
  check("…a one-line summary built from the evidence", s1.summary === "Matches 5 of 6 skills, missing MongoDB, meets all requirements", s1.summary);
  check("…top strengths: at most 3, each a matched skill with the resume line", s1.strengths.length === 3 && s1.strengths.every((x) => FIVE.includes(x.skill) && x.evidence.length > 0), JSON.stringify(s1.strengths));
  check("…gaps: the missing skill, no requirement gap", JSON.stringify(s1.gaps.missingSkills) === '["MongoDB"]' && s1.gaps.unknownSkills.length === 0 && s1.gaps.requirements.length === 0);
  check("…every listed skill's status (to compare side by side)", JOB_SKILLS.every((k) => s1.skillStatus[k] === (k === "MongoDB" ? "missing" : "matched")), JSON.stringify(s1.skillStatus));
  const s2 = rows.find((x) => x.applicationId === String(A.S2)).match;
  check("a weak match: 33%, weak, its gaps", s2.score === 33 && s2.quality === "weak" && s2.gaps.missingSkills.length === 4 && s2.summary === "Matches 2 of 6 skills, missing JavaScript, Node.js, Express +1 more, meets all requirements", s2.summary);
  const s6 = rows.find((x) => x.applicationId === String(A.S6)).match;
  check("a medium match: 50%, medium", s6.score === 50 && s6.quality === "medium");
  const s4 = rows.find((x) => x.applicationId === String(A.S4)).match;
  check("no resume: not enough info, no percentage, still listed", s4 && s4.score === null && s4.quality === "insufficient" && s4.qualityLabel === "not enough info" && /^Not enough information/.test(s4.summary));
  check("outside the pilot: listed with match null", rows.find((x) => x.applicationId === String(A.S5)).match === null);
  check("the job's skills in order (the compare columns)", d.job?.title === "Full-stack intern" && JSON.stringify(d.job.skills) === JSON.stringify(JOB_SKILLS));
  check("quality counts and an honest note (check before deciding, nobody hidden, what's never read)", d.summary?.strong === 2 && d.summary.medium === 1 && d.summary.weak === 1 && d.summary.insufficient === 1 && d.summary.outsidePilot === 1 && /check before deciding/.test(d.note) && /Nobody is rejected or hidden/.test(d.note) && /never read/.test(d.note));
  check("model, formula and thresholds", d.modelVersion === "skill-evidence-1" && /evidence/.test(d.formula) && d.thresholds?.strong === 70 && d.thresholds?.medium === 40);

  console.log("── 2. fairness (docs/MATCHING_FAIRNESS.md)");
  const s3 = rows.find((x) => x.applicationId === String(A.S3)).match;
  check("same skills, different name / university / city → the same match", JSON.stringify(strip(s1)) === JSON.stringify(strip(s3)));
  check("the reply carries no name, email, phone, university or city", !/full name|sana|taha|bilal|Ayesha|Khan|example\.com|test\.local|\+92|0300|NED University|Some Other University|Lahore|Karachi/i.test(r.text), r.text.match(/full name|sana|taha|bilal|Ayesha|Khan|example\.com|test\.local|\+92|0300|NED University|Some Other University|Lahore|Karachi/i)?.[0]);

  console.log("── 3. the drawer / profile reply carries the same view");
  r = await call("GET", `/api/career/matching/applications/${A.S1}`, T.E);
  const best = r.json?.data?.best || {};
  check("GET /applications/:id has best: the same band, summary, strengths, gaps and skill status", r.status === 200 && best.summary === s1.summary && best.quality === "strong" && JSON.stringify(best.strengths) === JSON.stringify(s1.strengths) && JSON.stringify(best.gaps) === JSON.stringify(s1.gaps) && JSON.stringify(best.skillStatus) === JSON.stringify(s1.skillStatus), r.text.slice(0, 200));

  console.log("── 4. who can read it");
  r = await ranked(ids.J, T.E2);
  check("another employer: 404", r.status === 404 && r.json?.error?.code === "NOT_FOUND");
  r = await ranked(ids.J, T.S1);
  check("a student: 404", r.status === 404);
  r = await ranked(ids.J, T.A);
  check("an admin: 404 (the employer's own view)", r.status === 404);
  r = await ranked(ids.J);
  check("no login: 401", r.status === 401);
  r = await ranked("nope", T.E);
  check("a bad id: 404", r.status === 404);
  setFlags({ timeline: false });
  r = await ranked(ids.J, T.E);
  check("FLAG_CAREER_TIMELINE off for the employer: 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");
  setFlags({ matching: false });
  r = await ranked(ids.J, T.E);
  check("FLAG_CAREER_MATCHING off: 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");
  setFlags();

  console.log("── 5. nothing changes");
  const snapshot = () => JSON.stringify(fake.STORE.get(coll("JobApplication")));
  const before = snapshot();
  await ranked(ids.J, T.E);
  check("reading best matches changes no application (no status, nothing rejected)", snapshot() === before);

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
