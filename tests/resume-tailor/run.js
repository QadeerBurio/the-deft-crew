// Resume Studio "tailor for this job" (fix/tailor-resume): a full resume keeps every section and item; a bad, cut-off or
// timed-out AI answer saves nothing and says "try again"; skills the resume shows in projects / experience go into
// skills in the job's wording; a skill the resume doesn't show is never added by the AI, only after the student ticks
// "I have this" with a proof line, and the % recalculates; the % is computed on the tailored version (draft, approved
// version, JobDetails' before → after).
//   node tests/resume-tailor/run.js [serverDir]
// Real routes, services and models; fake MongoDB; the AI replaced by fixed answers; no network.
const path = require("path");
const fs = require("fs");
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
for (const m of ["User", "Resume", "Job", "JobApplication", "CareerResumeTailorJob", "CareerResumeDraft", "CareerResumeApprovedVersion", "CareerApplicationResumeAttachment", "CareerResumeSourceConfirmation"]) reqS(`./models/${m}`);
const ai = reqS("./services/resumeStudio/ai");
const { revisionHashOf } = reqS("./services/resumeStudio/facts");

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "pushTokens", "idCardFront", "idCardBack", "livePicture", "resumeCreationCount"];
// what students must never see from the studio: simulated hiring verdicts, percentiles, probabilities
const NO_VERDICTS = ["hiringDecision", "percentileRank", "industryBenchmarking", "hrScorecard", "resumeScores", "probability", "overallScore", "atsScore"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const isPdf = Buffer.isBuffer(body);
    const text = isPdf ? "" : typeof body === "string" ? body : JSON.stringify(body);
    let keys = new Set();
    try { keys = keysIn(JSON.parse(text)); } catch {}
    const leaks = [...HIDDEN, ...NO_VERDICTS].filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks });
    return send(body);
  };
  next();
});
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/career/resume", reqS("./routes/careerResume.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S1", "S2", "S3", "E1", "E2", "R1", "R1b", "R2", "R3", "J1", "J2", "A1", "A2", "A3", "uni"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", resumeCreationCount: 2, createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("User"), [user(ids.S1, "student", "s1"), user(ids.S2, "student", "s2"), user(ids.S3, "student", "s3"), user(ids.E1, "employee", "e1"), user(ids.E2, "employee", "e2")]);
const resume = (id, owner, extra = {}) => ({
  _id: id, user: owner, title: "My resume", createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-10-01"),
  personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92 300 0000000", location: "Karachi", linkedin: "linkedin.com/in/ayesha" },
  professionalSummary: { summary: "Computer science student who builds web apps with React and Node.js." },
  workExperience: [{ company: "Bright Labs", position: "Frontend Intern", location: "Karachi", startDate: new Date("2025-06-01"), endDate: new Date("2025-08-31"), description: "Worked on the customer dashboard.", achievements: ["Built a React page for order tracking", "Fixed 12 layout bugs"] }],
  education: [{ institution: "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: new Date("2022-09-01"), endDate: new Date("2026-06-30") }],
  projects: [{ name: "Campus Eats", description: "A food ordering web app built with React and MongoDB.", technologies: ["React", "MongoDB"] }],
  skills: [{ name: "JavaScript" }, { name: "React" }, { name: "Node.js" }, { name: "MongoDB" }],
  certifications: [], languages: [],
  hiringDecision: { decision: "MAYBE" }, industryBenchmarking: { percentileRank: "Average" },
  ...extra,
});
fake.seed(coll("Resume"), [
  resume(ids.R1, ids.S1),
  resume(ids.R1b, ids.S1, { uploadedResume: { fileName: "cv.pdf", fileUrl: "https://res.example.com/cv.pdf", uploadDate: new Date("2026-09-01") } }),
  resume(ids.R2, ids.S2),
  resume(ids.R3, ids.S3),
]);
const JD = "We are hiring a Frontend Developer to build customer-facing web apps.\nRequirements: JavaScript, React, TypeScript, 2+ years of experience.\nNice to have: Node.js, Docker.";
fake.seed(coll("Job"), [
  { _id: ids.J1, title: "Frontend Developer", description: JD, requirements: ["React", "TypeScript"], skills: ["JavaScript"], active: true, postedBy: ids.E1, createdAt: new Date() },
  { _id: ids.J2, title: "Backend Developer", description: "Node.js and MongoDB APIs. Requirements: Node.js, Express, MongoDB, Docker.", requirements: [], skills: [], active: true, postedBy: ids.E2, createdAt: new Date() },
]);
const appl = (id, uid, job) => ({ _id: id, jobId: job, userId: uid, fullName: "x", email: "x@test.local", phone: "0300", coverLetter: "hi", status: "pending", appliedAt: new Date() });
fake.seed(coll("JobApplication"), [appl(ids.A1, ids.S1, ids.J1), appl(ids.A2, ids.S1, ids.J2), appl(ids.A3, ids.S2, ids.J1)]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok, raw = false } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
        const buf = Buffer.concat(chunks); const t = buf.toString(); let j = null; try { j = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, json: j, text: t, buf, type: res.headers["content-type"] || "" });
      });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let keyN = 0;
const key = () => `test-key-${++keyN}-${Date.now()}`;
const B = "/api/career/resume";
async function waitJob(tok, id) {
  for (let i = 0; i < 300; i++) {
    const r = await call("GET", `${B}/tailor-jobs/${id}`, { tok });
    if (!["queued", "running"].includes(r.json?.data?.status)) return r;
    await pause(5);
  }
  return { json: { data: { status: "timeout" } } };
}
let PDFExtract;
const pdfText = async (buf) => (await new PDFExtract().extractBuffer(buf, {})).pages.map((p) => p.content.map((c) => c.str).join("")).join("\n");


// a full resume: every section with several entries (React.js and Docker shown only in projects / experience)
const RF = oid(), JT = oid();
fake.seed(coll("Resume"), [{
  _id: RF, user: ids.S3, title: "Full resume", createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-10-01"),
  personalInfo: { firstName: "Sara", lastName: "Ali", email: "sara@example.com", phone: "+92 300 1111111", location: "Lahore" },
  professionalSummary: { summary: "Software engineering student who enjoys building web apps." },
  workExperience: [
    { company: "Bright Labs", position: "Frontend Intern", location: "Lahore", startDate: new Date("2025-06-01"), endDate: new Date("2025-08-31"), description: "Built dashboard screens in React.js for the support team.", achievements: ["Shipped an order-tracking page", "Fixed 12 layout bugs"] },
    { company: "Code Club", position: "Volunteer Tutor", location: "Lahore", startDate: new Date("2024-01-01"), endDate: new Date("2024-12-31"), description: "Taught JavaScript basics to school students.", achievements: ["Ran 20 weekly sessions"] },
  ],
  education: [
    { institution: "FAST NUCES", degree: "BS", fieldOfStudy: "Software Engineering", startDate: new Date("2022-09-01"), endDate: new Date("2026-06-30"), description: "Coursework: data structures, databases." },
    { institution: "Lahore College", degree: "Intermediate", fieldOfStudy: "Pre-Engineering", startDate: new Date("2020-09-01"), endDate: new Date("2022-06-30") },
  ],
  projects: [
    { name: "Campus Market", description: "A marketplace web app with a React.js front end, deployed with Docker containers.", technologies: ["React.js", "Docker"] },
    { name: "Notes CLI", description: "A command line notes tool.", technologies: ["Python"] },
  ],
  skills: [{ name: "JavaScript" }, { name: "Python" }],
  certifications: [{ name: "Google UX Design", organization: "Coursera", issueDate: new Date("2025-03-01") }, { name: "Intro to Git", organization: "Udemy" }],
  languages: [{ name: "English", proficiency: "Fluent" }],
}]);
fake.seed(coll("Job"), [{ _id: JT, title: "Frontend Developer", description: "Build web apps. Requirements: React, Docker, TypeScript, JavaScript.", requirements: ["React", "Docker", "TypeScript", "JavaScript"], skills: ["React", "Docker", "TypeScript", "JavaScript"], active: true, postedBy: ids.E1, createdAt: new Date() }]);
const S3 = () => token("S3", "student");
const tailor = async (tok) => {
  const r = await call("POST", `${B}/tailor-jobs`, { tok, body: { resumeId: String(RF), jobId: String(JT), idempotencyKey: key() } });
  return waitJob(tok, r.json?.data?.id);
};
const draftOf = async (tok, j) => (await call("GET", `${B}/drafts/${j.json.data.draftId}`, { tok })).json?.data;
const count = (c) => ({ workExperience: c.workExperience.length, achievements: c.workExperience.map((w) => w.achievements.length).join("+"), education: c.education.length, projects: c.projects.length, certifications: c.certifications.length, languages: c.languages.length });

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  await reqS("./services/featureAccess").load(); // Resume Studio is on by default for students
  const ai = reqS("./services/resumeStudio/ai");
  const tok = S3();
  const SUMMARY = "Software engineering student who enjoys building web apps.";

  console.log("── 1. tailoring a full resume keeps every section and every item");
  ai.setCaller(async () => JSON.stringify({ suggestions: [
    { fieldPath: "professionalSummary.summary", original: SUMMARY, proposed: "Software engineering student who builds web apps.", reason: "clearer for a frontend role", sourceFactIds: ["fact_1"] },
    { fieldPath: "order.projects", original: "", proposed: "[0,1]", reason: "the web project first", sourceFactIds: [] },
  ] }));
  let j = await tailor(tok);
  check("tailoring succeeded with a draft", j.json?.data?.status === "succeeded" && !!j.json.data.draftId, JSON.stringify(j.json?.data));
  let d = await draftOf(tok, j);
  const src = { workExperience: 2, achievements: "2+1", education: 2, projects: 2, certifications: 2, languages: 1 };
  check("the tailored content has every section and item of the resume (2 jobs with 2+1 bullets, 2 schools, 2 projects, 2 certifications, 1 language)", JSON.stringify(count(d.content)) === JSON.stringify(src), JSON.stringify(count(d.content)));
  check("…names, companies, dates and contact details unchanged", d.content.workExperience[0].company === "Bright Labs" && d.content.workExperience[0].startDate === "2025-06" && d.content.personalInfo.email === "sara@example.com" && d.content.education[0].institution === "FAST NUCES");
  check("…the draft says how many entries each section has (nothing is shown as empty)", d.sections.workExperience === 2 && d.sections.projects === 2 && d.sections.certifications === 2);
  // the guard: content that lost entries is put back from the source
  const drafts = reqS("./services/resumeStudio/drafts");
  const source = { personalInfo: {}, professionalSummary: { summary: "x" }, workExperience: [{ company: "A" }, { company: "B" }], education: [{}], projects: [{}, {}], skills: [{ name: "Go" }], certifications: [{ name: "C" }], languages: [] };
  const warned = []; const warn = console.warn; console.warn = (m) => warned.push(String(m));
  const kept = drafts.keepComplete(source, { personalInfo: {}, professionalSummary: { summary: "" }, workExperience: [{ company: "A" }], projects: [], skills: [] });
  console.warn = warn;
  check("a section that shrank or disappeared is put back from the base resume, and logged", kept.workExperience.length === 2 && kept.projects.length === 2 && kept.education.length === 1 && kept.skills.length === 1 && kept.certifications.length === 1 && kept.professionalSummary.summary === "x" && warned.length >= 4, JSON.stringify(warned));

  console.log("── 2. a bad, cut-off or timed-out AI answer saves nothing");
  const draftsBefore = rows("CareerResumeDraft").length;
  ai.setCaller(async () => '{"suggestions": [ { "fieldPath": "professionalSummary.summary", "original": "Software eng'); // cut off mid-answer
  j = await tailor(tok);
  check("a cut-off (truncated) answer: the job fails, no draft is saved", j.json?.data?.status === "failed" && j.json.data.errorCode === "AI_FAILED" && rows("CareerResumeDraft").length === draftsBefore, JSON.stringify(j.json?.data));
  check("…the student is told 'Nothing was saved. Please try again.' and can retry", /Nothing was saved\. Please try again\./.test(j.json.data.errorMessage || "") && j.json.data.retryable === true);
  ai.setCaller(async () => "not json at all");
  j = await tailor(tok);
  check("bad JSON twice: fails, nothing saved", j.json?.data?.status === "failed" && rows("CareerResumeDraft").length === draftsBefore);
  ai.setCaller(async () => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); });
  j = await tailor(tok);
  check("an AI timeout: 'Tailoring took too long. Nothing was saved. Please try again.', no draft", j.json?.data?.status === "failed" && j.json.data.errorCode === "AI_TIMEOUT" && /took too long\. Nothing was saved\. Please try again\./.test(j.json.data.errorMessage) && rows("CareerResumeDraft").length === draftsBefore, JSON.stringify(j.json?.data));
  ai.setCaller(async () => { throw Object.assign(new Error("the model's answer was cut off"), { code: "truncated" }); });
  const r2 = await ai.completeJson([], () => ({ ok: true, value: {} }));
  check("a reply cut off by the length limit (finish_reason length) counts as a failure", r2.ok === false && r2.error === "model_truncated");
  check("at most 90 s of AI time: 2 attempts × 45 s, no hidden SDK retries", ai.ATTEMPT_MS === 45000 && /maxRetries: 0/.test(fs.readFileSync(path.join(SERVER, "services/resumeStudio/ai.js"), "utf8")));

  console.log("── 3. skills the resume shows in projects / experience go into the skills section");
  ai.setCaller(async () => JSON.stringify({ suggestions: [] }));
  j = await tailor(tok);
  d = await draftOf(tok, j);
  const names = d.content.skills.map((s) => s.name);
  check("React (shown as React.js in a job and a project) and Docker (a project) are added to skills, in the job's wording, with where they're shown", names.includes("React") && names.includes("Docker") && d.surfacedSkills.some((s) => s.skill === "React" && s.evidence.length) && d.surfacedSkills.some((s) => s.skill === "Docker"), JSON.stringify({ names, surfaced: d.surfacedSkills }));
  check("…the resume's own skills stay (JavaScript, Python)", names.includes("JavaScript") && names.includes("Python"));
  check("…TypeScript (nowhere in the resume) is NOT added", !names.includes("TypeScript") && d.missingSkills.includes("TypeScript"), JSON.stringify(d.missingSkills));
  check("the % is computed on the tailored version: before 75% → after 75% (React and Docker were already counted from the projects, so moving them doesn't change it)", d.scores.before === 75 && d.scores.after === 75, JSON.stringify(d.scores));
  check("…'what changed' shows the skills before and after, side by side", d.changes.some((c) => c.section === "skills" && !/React/.test(c.before) && /React/.test(c.after)), JSON.stringify(d.changes));

  console.log("── 4. a skill the resume doesn't show: only after the student confirms it with a proof line");
  const evil = JSON.stringify({ suggestions: [{ fieldPath: "professionalSummary.summary", original: SUMMARY, proposed: "Software engineering student skilled in TypeScript and Kubernetes.", reason: "job", sourceFactIds: ["fact_1"] }] });
  ai.setCaller(async () => evil);
  j = await tailor(tok);
  d = await draftOf(tok, j);
  const s = d.suggestions.find((x) => x.fieldPath === "professionalSummary.summary");
  check("the AI adding TypeScript to the summary: flagged, not applied unless the student says it's true; not in skills", s && s.status !== "ok" && !d.content.skills.some((x) => x.name === "TypeScript") && !/TypeScript/.test(d.content.professionalSummary.summary), JSON.stringify(s));
  let r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "TypeScript", proof: "", confirmTrue: true } });
  check("'I have this' without a proof line: refused", r.status === 400 && r.json.error.code === "PROOF_REQUIRED", r.text.slice(0, 160));
  r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "TypeScript", proof: "Campus Market's admin panel is written in TypeScript" } });
  check("…without ticking 'I have this': refused", r.status === 422 && r.json.error.code === "CONFIRMATION_REQUIRED", r.text.slice(0, 160));
  r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "Kubernetes", proof: "used it once", confirmTrue: true } });
  check("…a skill the job doesn't ask for: refused", r.status === 400 && r.json.error.code === "UNKNOWN_SKILL");
  r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "TypeScript", proof: "see https://example.com", confirmTrue: true } });
  check("…a link in the proof: refused", r.status === 400 && r.json.error.code === "PROOF_INVALID");
  r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "TypeScript", proof: "Campus Market's admin panel is written in TypeScript", confirmTrue: true } });
  const d2 = r.json?.data;
  check("ticked + a proof line: TypeScript added to skills, the % recalculates 75% → 100%", r.status === 200 && d2.content.skills.some((x) => x.name === "TypeScript") && d2.scores.before === 75 && d2.scores.after === 100 && !d2.missingSkills.includes("TypeScript") && d2.confirmedSkills[0].proof.includes("Campus Market"), JSON.stringify(d2 && { scores: d2.scores, missing: d2.missingSkills }));
  r = await call("POST", `${B}/drafts/${d.id}/skills`, { tok, body: { revision: d.revision, skill: "TypeScript", proof: "x".repeat(20), confirmTrue: true } });
  check("…sent with an old revision: 409 (two devices can't overwrite each other)", r.status === 409);

  console.log("── 5. approving: the version keeps everything, and its % is what JobDetails shows after");
  const dec = d2.suggestions.map((x) => ({ suggestionId: x.suggestionId, decision: "rejected" }));
  r = await call("PATCH", `${B}/drafts/${d.id}/decisions`, { tok, body: { revision: d2.revision, decisions: dec } });
  r = await call("POST", `${B}/drafts/${d.id}/approve`, { tok, body: { revision: r.json.data.revision, confirmAccurate: true, confirmReviewed: true } });
  check("approved: the version has every section and the added skills (React, Docker, TypeScript)", r.status === 200 || r.status === 201, r.text.slice(0, 200));
  const v = rows("CareerResumeApprovedVersion", (x) => same(x.draftId, d.id))[0];
  check("…the saved snapshot: every entry kept, skills = own + surfaced + confirmed", v && JSON.stringify(count(v.contentSnapshot)) === JSON.stringify(src) && ["JavaScript", "Python", "React", "Docker", "TypeScript"].every((n) => v.contentSnapshot.skills.some((x) => x.name === n)), JSON.stringify(v && v.contentSnapshot.skills));
  const recs = reqS("./services/career/recommendations");
  const job = rows("Job", (x) => same(x._id, JT))[0];
  const m = await recs.matchJobFor(ids.S3, job);
  check("JobDetails' 'your match': before 75% (the resume that was tailored) → after 100% (the tailored version for this job)", m.tailored && m.tailored.before === 75 && m.tailored.score === 100 && m.tailored.versionId === String(v._id), JSON.stringify({ tailored: m.tailored }));
  check("…even though the student's other, newer resume scores 50% (what 'your match' used to show alone)", m.match.score === 50, String(m.match.score));
  const check2 = reqS("./services/resumeStudio/validator").checkVersion(d2.content && v.contentSnapshot, { ...v.contentSnapshot, skills: [...v.contentSnapshot.skills, { name: "Kubernetes" }] }, "", [], ["React", "Docker", "TypeScript"]);
  check("approval still refuses a skill nobody surfaced or confirmed", check2.ok === false && check2.errors.some((e) => e.fieldPath === "skills"));

  ai.setCaller(null);
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
