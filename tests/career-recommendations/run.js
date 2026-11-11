// Job recommendations for students with FLAG_CAREER_MATCHING (services/career/recommendations.js,
// GET /api/career/matching/recommended): the skill-evidence matcher only (score >= 60, no mandatory criterion "not
// met", already-applied / closed / past-deadline jobs left out), the same matcher behind every older recommendation
// route for pilot students (/api/jobs/recommendations, /:resumeId, /top, /feed, /api/resume/:id/recommendations),
// in their existing reply shapes; students outside the pilot keep the older engines. Fairness: name, university and
// city never change the list. The in-memory cache: a resume or job change gives a fresh score.
//   node tests/career-recommendations/run.js [serverDir]
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
process.env.OPENAI_API_KEY = "test-only-not-a-key"; // routes/resume.routes.js makes its client at load; nothing is ever sent

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
// the older engine, recorded instead of run (it needs embeddings): which students reach it
const hybridCalls = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  if (resolved.endsWith(path.join("services", "recommendationService.js"))) {
    return { getHybridRecommendations: async (resumeId, userId) => { hybridCalls.push(String(userId)); return [{ _id: "old", title: "From the older engine", matchPercentage: 77 }]; }, getSimilarJobs: async () => [] };
  }
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
const recs = reqS("./services/career/recommendations");
const Resume = reqS("./models/Resume");
const realGetRecommendedJobs = Resume.getRecommendedJobs;
const resumeEngineCalls = [];
Resume.getRecommendedJobs = async (id) => { resumeEngineCalls.push(String(id)); return [{ _id: "old2", title: "From Resume.getRecommendedJobs" }]; };

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
const responses = [];
app.use((req, res, next) => { const send = res.send.bind(res); res.send = (b) => { responses.push(typeof b === "string" ? b : JSON.stringify(b)); return send(b); }; next(); });
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));
app.use("/api/jobs", reqS("./routes/jobs.routes"));
app.use("/api/resume", reqS("./routes/resume.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S1", "S2", "S3", "OUT", "E", "R1", "R2", "R3", "ROUT", "J1", "J2", "J3", "J4", "J5", "J6", "J7"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "zara"), user(ids.OUT, "student", "omar"), user(ids.E, "employee", "hireco")]);
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
  job(ids.J1, { title: "React intern", skills: ["JavaScript", "React", "Node.js"], createdAt: new Date(now - 1000) }), // S1: 3/3
  job(ids.J2, { title: "Full-stack intern", skills: ["JavaScript", "React", "MongoDB", "Docker", "AWS"] }), // S1: 2/5 = 40
  job(ids.J3, { title: "Data intern", skills: ["Python", "Pandas", "SQL"] }), // S1: 0
  job(ids.J4, { title: "Senior React dev", skills: ["React", "JavaScript"], minExperience: 5 }), // S1: 100 but "not met"
  job(ids.J5, { title: "Closed React job", skills: ["React"], active: false }),
  job(ids.J6, { title: "Past deadline React job", skills: ["React"], applicationDeadline: new Date(now - 864e5) }),
  job(ids.J7, { title: "External React job", skills: ["React", "JavaScript"], isExternal: true, createdAt: new Date(now - 2000) }), // external
]);
fake.seed(coll("Resume"), [
  { _id: ids.R1, user: ids.S1, isPrimary: true, ...person({ skills: ["JavaScript", "React", "Node.js"] }), updatedAt: new Date(now - 7200e3) },
  // S2: the same skills, different name, university, city, degree text
  { _id: ids.R2, user: ids.S2, isPrimary: true, ...person({ skills: ["JavaScript", "React", "Node.js"], name: "Bilal Ahmed", university: "Some Other University", city: "Lahore" }), updatedAt: new Date(now - 7200e3) },
  { _id: ids.ROUT, user: ids.OUT, isPrimary: true, ...person({ skills: ["JavaScript", "React", "Node.js"] }), updatedAt: new Date(now - 7200e3) },
]);
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
const titles = (list) => (list || []).map((j) => j.title);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { S1: token(ids.S1, "student"), S2: token(ids.S2, "student"), S3: token(ids.S3, "student"), OUT: token(ids.OUT, "student"), E: token(ids.E, "employee") };

  console.log("── 1. GET /api/career/matching/recommended");
  let r = await call("GET", "/api/career/matching/recommended", T.S1);
  const L = r.json?.data?.recommendations || [];
  check("S1: the matching jobs, best first (React intern 100, External React job 100); not 40% or 0% matches", r.status === 200 && titles(L).join("|") === "React intern|External React job", titles(L).join("|"));
  check("…never a job with a mandatory criterion not met (Senior React dev: 5 years)", !titles(L).includes("Senior React dev"));
  check("…never closed or past-deadline jobs", !titles(L).some((t) => /Closed|Past deadline/.test(t)));
  check("…each with the matched skills and where the resume shows them", L[0].matchPercentage === 100 && L[0].matchedSkills.join() === "JavaScript,React,Node.js" && L[0].matchReasons.length === 3 && /React: "/.test(L[0].matchReasons.join(" ")) && L[0].match.skills.matched.every((s) => s.evidence.length > 0), JSON.stringify(L[0].matchReasons));
  check("…the model, formula and an honest note", r.json.data.modelVersion === "skill-evidence-1" && /evidence/.test(r.json.data.formula) && /not a promise/.test(r.json.data.note));
  check("…no employer contact e-mail in the reply", !/hr@hireco\.test/.test(r.text));
  fake.seed(coll("JobApplication"), [{ _id: oid(), jobId: ids.J1, userId: ids.S1, status: "pending", appliedAt: new Date() }]);
  r = await call("GET", "/api/career/matching/recommended", T.S1);
  check("a job S1 already applied to drops out", !titles(r.json.data.recommendations).includes("React intern") && titles(r.json.data.recommendations).includes("External React job"), titles(r.json.data.recommendations).join("|"));
  r = await call("GET", "/api/career/matching/recommended", T.S3);
  check("no resume: hasResume false, nothing recommended", r.status === 200 && r.json.data.hasResume === false && r.json.data.recommendations.length === 0);
  r = await call("GET", "/api/career/matching/recommended", T.OUT);
  check("a student outside the pilot → 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");
  r = await call("GET", "/api/career/matching/recommended", T.E);
  check("an employer → 404 (students only)", r.status === 404);
  r = await call("GET", "/api/career/matching/recommended");
  check("signed out → 401", r.status === 401);

  console.log("── 2. fairness: name, university, city never change the list");
  const a = await recs.recommend(ids.S2, { limit: 0, all: true });
  const b = await recs.recommend(ids.OUT, { limit: 0, all: true }); // the same skills as S2, Ayesha / NED / Karachi (OUT's resume)
  const key = (x) => x.recommendations.map((j) => `${j.title}:${j.matchPercentage}`).join("|");
  check("S2 (Bilal, another university, Lahore) and the same skills under another name / university / city: identical scores", key(a) === key(b), `${key(a)} vs ${key(b)}`);
  check("the location of the job never counts (Karachi jobs score the same for a Lahore resume)", a.recommendations.find((j) => j.title === "React intern")?.matchPercentage === 100);

  console.log("── 3. the older routes: pilot students get the new matcher, in the same reply shape; others unchanged");
  hybridCalls.length = 0; resumeEngineCalls.length = 0;
  r = await call("GET", "/api/jobs/recommendations", T.S2);
  check("/api/jobs/recommendations (external jobs only, as before): the skill-evidence matcher, same fields", r.status === 200 && r.json.engine === "skill-evidence-1" && titles(r.json.recommendations).join("|") === "External React job" && r.json.recommendations[0].matchPercentage === 100 && Array.isArray(r.json.recommendations[0].matchReasons) && r.json.hasResume === true && r.json.total === 1, JSON.stringify(r.json).slice(0, 300));
  r = await call("GET", `/api/jobs/recommendations/${ids.R2}`, T.S2);
  check("/api/jobs/recommendations/:resumeId: the new matcher (internal and external jobs)", r.status === 200 && r.json.engine === "skill-evidence-1" && titles(r.json.recommendations).join("|") === "React intern|External React job", titles(r.json.recommendations).join("|"));
  r = await call("GET", "/api/jobs/feed", T.S2);
  check("/api/jobs/feed: every open job in skill-evidence order, nothing hidden (40% and 0% included, last)", r.status === 200 && r.json.engine === "skill-evidence-1" && r.json.jobs.length === 5 && r.json.jobs[0].matchPercentage >= r.json.jobs[r.json.jobs.length - 1].matchPercentage && titles(r.json.jobs).includes("Data intern"), titles(r.json.jobs).join("|"));
  r = await call("GET", "/api/jobs/feed?search=data", T.S2);
  check("…the feed's filters still apply", r.json.jobs.length === 1 && r.json.jobs[0].title === "Data intern");
  r = await call("GET", `/api/resume/${ids.R2}/recommendations`, T.S2);
  check("/api/resume/:id/recommendations (Resume dashboard): the new matcher, { success, data } as before", r.status === 200 && r.json.success === true && titles(r.json.data).join("|") === "React intern|External React job", titles(r.json?.data).join("|"));
  check("…none of those reached the older engines", hybridCalls.length === 0 && resumeEngineCalls.length === 0, `${hybridCalls.length} ${resumeEngineCalls.length}`);
  r = await call("GET", "/api/jobs/recommendations", T.OUT);
  const r2 = await call("GET", `/api/resume/${ids.ROUT}/recommendations`, T.OUT);
  check("a student outside the pilot: the older engines, unchanged", r.json?.recommendations?.[0]?.title === "From the older engine" && r.json.engine !== "skill-evidence-1" && r2.json?.data?.[0]?.title === "From Resume.getRecommendedJobs" && hybridCalls.includes(String(ids.OUT)) && resumeEngineCalls.includes(String(ids.ROUT)));
  r = await call("GET", `/api/resume/${ids.R1}/recommendations`, T.S2);
  check("someone else's resume → 404 (as before)", r.status === 404);

  console.log("── 4. the cache: a resume or job change gives a fresh score");
  let x = await recs.recommend(ids.S2, { limit: 0, all: true });
  check("before: Full-stack intern 40%", x.recommendations.find((j) => j.title === "Full-stack intern").matchPercentage === 40);
  const r2doc = (fake.STORE.get(coll("Resume")) || []).find((d) => String(d._id) === String(ids.R2));
  r2doc.skills.push({ name: "MongoDB", category: "" }, { name: "Docker", category: "" });
  x = await recs.recommend(ids.S2, { limit: 0, all: true });
  check("the resume gains MongoDB and Docker: 80% at once (not the cached 40%)", x.recommendations.find((j) => j.title === "Full-stack intern").matchPercentage === 80);
  const j2 = (fake.STORE.get(coll("Job")) || []).find((d) => String(d._id) === String(ids.J2));
  j2.skills = ["MongoDB", "Docker"];
  x = await recs.recommend(ids.S2, { limit: 0, all: true });
  check("the job's skills change: scored again (100%)", x.recommendations.find((j) => j.title === "Full-stack intern").matchPercentage === 100);

  check("no 500s", !responses.some((t) => /"error"/.test(t) && /Cannot|TypeError|undefined/.test(t)));
  Resume.getRecommendedJobs = realGetRecommendedJobs;
  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
