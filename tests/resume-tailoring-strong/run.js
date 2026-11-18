// Resume Studio strong tailoring (feat/strong-tailoring): three student / job pairs (HR student -> HR Intern, CS student ->
// Full Stack Developer, business graduate -> Marketing Executive) with recorded AI answers. The tailored version
// visibly changes toward the job (headline, summary, bullets, order, one-line entries), facts never change, the
// invented claim in each answer never reaches the version, every entry is kept, keyword coverage and the match rise,
// undo per section and hand edits work, a bad or slow AI answer saves nothing.
//   node tests/resume-tailoring-strong/run.js [serverDir]
// Real routes, services and models; fake MongoDB; no network.
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

// ---------- the 3 pairs ----------
const d = (s) => new Date(s);
const S = { HR: oid(), DEV: oid(), MKT: oid() };
const R = { HR: oid(), DEV: oid(), MKT: oid() };
const J = { HR: oid(), DEV: oid(), MKT: oid() };
const A = { HR: oid() };
const stu = (id, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role: "student", status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("User"), [stu(S.HR, "ayesha"), stu(S.DEV, "bilal"), stu(S.MKT, "sara")]);
const base = { createdAt: d("2026-09-01"), updatedAt: d("2026-10-01"), certifications: [], languages: [] };
fake.seed(coll("Resume"), [
  { ...base, _id: R.HR, user: S.HR,
    personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "BBA Student", email: "ayesha@example.com", location: "Karachi" },
    professionalSummary: { summary: "BBA student at IBA with interest in business and people. Hardworking and eager to learn." },
    workExperience: [
      { company: "Acme Textiles", position: "Summer Intern", location: "Karachi", startDate: d("2025-06-01"), endDate: d("2025-08-01"), description: "Worked in the admin and HR department.", achievements: ["Helped with screening 120 CVs for three roles", "Scheduled interviews with managers", "Updated employee records in Excel"] },
      { company: "Edhi Foundation", position: "Volunteer", startDate: d("2024-01-01"), current: true, description: "", achievements: ["Organised donation drives with 15 volunteers", "Kept attendance and donor lists"] },
      { company: "Cafe Aylanto", position: "Part-time Cashier", startDate: d("2023-06-01"), endDate: d("2023-12-01"), description: "", achievements: ["Handled cash and card payments", "Trained 2 new cashiers on the till"] },
    ],
    education: [{ institution: "Institute of Business Administration", degree: "BBA", fieldOfStudy: "Human Resource Management", startDate: d("2022-09-01"), endDate: d("2026-06-01"), description: "Courses: Organisational Behaviour, HRM, Labour Law" }],
    projects: [{ name: "Campus Job Fair", description: "Organised a job fair with 25 employers for 300 students.", technologies: [] }],
    skills: [{ name: "MS Excel" }, { name: "Communication" }, { name: "Teamwork" }],
    languages: [{ name: "English", proficiency: "Fluent" }, { name: "Urdu", proficiency: "Native" }] },
  { ...base, _id: R.DEV, user: S.DEV,
    personalInfo: { firstName: "Bilal", lastName: "Ahmed", title: "Computer Science Student", email: "bilal@example.com", location: "Lahore", github: "github.com/bilal" },
    professionalSummary: { summary: "Final year CS student who likes programming and learning new technologies." },
    workExperience: [
      { company: "Tech Society, FAST", position: "General Secretary", startDate: d("2024-09-01"), endDate: d("2025-06-01"), description: "Organised coding events.", achievements: ["Ran a 2-day hackathon for 180 students", "Managed the society's social media"] },
      { company: "Softlogic Pvt Ltd", position: "Software Intern", startDate: d("2025-06-01"), endDate: d("2025-08-01"), description: "", achievements: ["Worked on the company's internal dashboard", "Fixed bugs in the React frontend", "Wrote REST API endpoints in Node.js and Express", "Wrote unit tests with Jest"] },
    ],
    education: [{ institution: "FAST NUCES", degree: "BS", fieldOfStudy: "Computer Science", startDate: d("2022-09-01"), endDate: d("2026-06-01"), gpa: 3.4 }],
    projects: [
      { name: "Library Management System", description: "A Java desktop app for issuing and returning books, made for the OOP course.", technologies: ["Java"] },
      { name: "ShopEase", description: "An e-commerce web app with cart, checkout and admin panel. Used MongoDB for the database and deployed on Vercel. About 50 classmates used it for a semester project fair.", technologies: ["React", "Node.js", "Express", "MongoDB"] },
      { name: "Weather CLI", description: "A Python script that shows the weather for a city using an API.", technologies: ["Python"] },
    ],
    skills: [{ name: "Java" }, { name: "Python" }, { name: "C++" }, { name: "HTML" }, { name: "CSS" }, { name: "Git" }] },
  { ...base, _id: R.MKT, user: S.MKT,
    personalInfo: { firstName: "Sara", lastName: "Malik", title: "Business Graduate", email: "sara@example.com", location: "Islamabad" },
    professionalSummary: { summary: "Business graduate with a creative mind. Looking for opportunities to grow." },
    workExperience: [
      { company: "Daraz", position: "Customer Support Associate", startDate: d("2025-01-01"), current: true, description: "Answered customer queries over chat and phone.", achievements: ["Resolved about 60 tickets a day", "Wrote FAQ answers used by the support team"] },
      { company: "Kapra Studio", position: "Social Media Intern", startDate: d("2024-06-01"), endDate: d("2024-09-01"), description: "", achievements: ["Posted on Instagram and Facebook for the brand", "Made posts in Canva", "Grew the Instagram page from 2,000 to 3,500 followers in 3 months", "Tracked post likes and reach in a weekly sheet"] },
    ],
    education: [{ institution: "NUST Business School", degree: "BBA", fieldOfStudy: "Marketing", startDate: d("2020-09-01"), endDate: d("2024-06-01"), description: "Final year project: brand audit of a local clothing brand" }],
    projects: [{ name: "Brand audit – local clothing brand", description: "Surveyed 80 customers and suggested changes to the brand's pricing and social media.", technologies: [] }],
    skills: [{ name: "Canva" }, { name: "MS Office" }, { name: "Customer Service" }],
    certifications: [{ name: "Fundamentals of Digital Marketing", organization: "Google Digital Garage", issueDate: d("2024-03-01") }] },
]);
const JOBS = {
  HR: { title: "HR Intern", companyName: "Engro Corporation", description: "We are looking for an HR Intern to support our Talent Acquisition and HR Operations team.\nResponsibilities:\n- Screen CVs and shortlist candidates for open roles\n- Schedule and coordinate interviews with hiring managers\n- Maintain employee records and HR databases (MS Excel)\n- Support onboarding of new joiners\n- Help organise employer branding and campus recruitment events\nRequirements:\n- Final-year BBA / MBA student, HRM major preferred\n- Strong communication and organisational skills\n- Good command of MS Excel\n- Attention to detail and confidentiality" },
  DEV: { title: "Full Stack Developer", companyName: "Arbisoft", description: "Build and maintain web applications across the stack.\nYou will:\n- Build responsive front-end features in React\n- Design and build REST APIs with Node.js and Express\n- Work with MongoDB and SQL databases\n- Write unit and integration tests (Jest)\n- Use Git and take part in code reviews in an Agile team\nRequirements:\n- BS in Computer Science or related field\n- Projects or internship experience with JavaScript, React and Node.js\n- Understanding of REST, databases and version control\n- Nice to have: TypeScript, Docker, AWS" },
  MKT: { title: "Marketing Executive", companyName: "Unilever Pakistan", description: "Plan and run digital and social media campaigns for our brands.\nResponsibilities:\n- Create and schedule social media content (Instagram, Facebook, TikTok)\n- Track campaign performance and report insights (reach, engagement)\n- Support brand activations and market research\n- Work with agencies and internal teams\nRequirements:\n- Bachelor's in Marketing or Business\n- 1 year of digital marketing or social media experience\n- Content creation (Canva or Adobe), basic analytics (Google Analytics, Meta Business Suite)\n- Strong written communication" },
};
fake.seed(coll("Job"), Object.entries(JOBS).map(([k, j]) => ({ _id: J[k], ...j, requirements: [], skills: [], active: true, postedBy: ids.E1, createdAt: new Date() })));
fake.seed(coll("JobApplication"), [{ _id: A.HR, jobId: J.HR, userId: S.HR, fullName: "Ayesha Khan", email: "ayesha@test.local", phone: "0300", coverLetter: "hi", status: "pending", appliedAt: new Date() }]);

// ---------- recorded AI answers: strong tailoring, plus one invented claim each (must never reach the version) ----------
const ANSWERS = {
  HR: [
    ["personalInfo.title", "BBA Student", "BBA (HRM) student | aspiring HR Intern", ["headline"]],
    ["professionalSummary.summary", null, "BBA student in Human Resource Management at the Institute of Business Administration. As a Summer Intern at Acme Textiles, screened 120 CVs for three roles, scheduled interviews with managers and maintained employee records in MS Excel. Organised a campus job fair with 25 employers for 300 students.", ["summary"]],
    ["workExperience[0].description", null, "Supported the HR department with CV screening, interview scheduling and employee records.", ["experience"]],
    ["workExperience[0].achievements[0]", null, "Screened 120 CVs for three open roles", ["achievement"]],
    ["workExperience[0].achievements[1]", null, "Scheduled and coordinated interviews with hiring managers", ["achievement"]],
    ["workExperience[0].achievements[2]", null, "Maintained employee records in MS Excel, cutting hiring time by 30%", ["achievement"]], // invented result
    ["workExperience[1].achievements[0]", null, "Coordinated 15 volunteers to run donation drives", ["achievement"]],
    ["condense.workExperience[2]", "", "Handled cash and card payments; trained 2 new cashiers.", ["role"]],
    ["projects[0].description", null, "Organised a campus recruitment event: a job fair with 25 employers for 300 students.", ["project_detail"]],
    ["education[0].description", null, "Relevant courses: Human Resource Management, Organisational Behaviour, Labour Law", ["education_detail"]],
    ["order.sections", "", JSON.stringify(["experience", "projects", "education", "skills", "languages"]), []],
  ],
  DEV: [
    ["personalInfo.title", "Computer Science Student", "BS Computer Science student | aspiring Full Stack Developer (React, Node.js)", ["headline"]],
    ["professionalSummary.summary", null, "BS Computer Science student at FAST NUCES who builds web apps with React, Node.js, Express and MongoDB. As a Software Intern at Softlogic, wrote REST API endpoints in Node.js and Express, fixed bugs in the React front end and wrote unit tests with Jest. Built ShopEase, an e-commerce app used by about 50 classmates.", ["summary"]],
    ["workExperience[1].achievements[0]", null, "Developed features for the company's internal dashboard", ["achievement"]],
    ["workExperience[1].achievements[1]", null, "Fixed bugs in the React front end of the internal dashboard", ["achievement"]],
    ["workExperience[1].achievements[2]", null, "Built REST API endpoints with Node.js and Express", ["achievement"]],
    ["workExperience[1].achievements[3]", null, "Wrote unit tests in Jest for the API endpoints", ["achievement"]],
    ["order.workExperience", "", "[1,0]", []],
    ["order.workExperience[1].achievements", "", "[2,1,3,0]", []],
    ["condense.workExperience[0]", "", "Ran a 2-day hackathon for 180 students and the society's social media.", ["role"]],
    ["projects[1].description", null, "Full stack e-commerce web app with React, Node.js, Express and MongoDB: cart, checkout and admin panel; deployed on Vercel and used by about 50 classmates.", ["project_detail"]],
    ["projects[0].description", null, "A Java and Spring Boot desktop app with Docker for issuing and returning books.", ["project_detail"]], // invented tools
    ["condense.projects[2]", "", "Python CLI that shows a city's weather from an API.", ["project"]],
    ["order.projects", "", "[1,0,2]", []],
    ["order.sections", "", JSON.stringify(["experience", "projects", "skills", "education"]), []],
  ],
  MKT: [
    ["personalInfo.title", "Business Graduate", "Marketing Executive", ["headline"]], // states the job as held: needs the student's confirmation
    ["professionalSummary.summary", null, "BBA Marketing graduate from NUST Business School with social media experience: posted Instagram and Facebook content for a brand, made posts in Canva and grew its Instagram page from 2,000 to 3,500 followers in 3 months. Completed Fundamentals of Digital Marketing (Google Digital Garage).", ["summary"]],
    ["workExperience[1].achievements[0]", null, "Created and posted Instagram and Facebook content for the brand", ["achievement"]],
    ["workExperience[1].achievements[1]", null, "Designed social media posts in Canva", ["achievement"]],
    ["workExperience[1].achievements[2]", null, "Grew the brand's Instagram page from 2,000 to 3,500 followers in 3 months", ["achievement"]],
    ["workExperience[1].achievements[3]", null, "Tracked reach and likes of every post in a weekly report", ["achievement"]],
    ["order.workExperience", "", "[1,0]", []],
    ["condense.workExperience[0]", "", "Resolved about 60 customer tickets a day over chat and phone; wrote FAQ answers.", ["role"]],
    ["projects[0].description", null, "Market research: surveyed 80 customers and suggested changes to the brand's pricing and social media.", ["project_detail"]],
    ["order.sections", "", JSON.stringify(["experience", "projects", "certifications", "skills", "education"]), []],
  ],
};
// the answer for a request: fact ids looked up from what the request sent (as the model would cite them)
const answerFor = (key) => (messages) => {
  const u = messages[1].content;
  const data = JSON.parse(u.slice(u.indexOf("{"), u.lastIndexOf("}") + 1));
  const factFor = (types, path) => data.VerifiedResumeFacts.filter((f) => types.includes(f.type) || f.sourcePath === path).map((f) => f.factId).slice(0, 3);
  const editable = new Map(data.EditableFields.map((e) => [e.fieldPath, e.text]));
  sent[key] = data;
  return JSON.stringify({
    suggestions: ANSWERS[key].map(([fieldPath, original, proposed, types]) => ({ fieldPath, original: original == null ? editable.get(fieldPath) || "" : original, proposed, reason: "fits the job", sourceFactIds: factFor(types, fieldPath) })),
    matchedRequirements: [], missingRequirements: [], warnings: [],
  });
};
const sent = {};
const tokOf = (k) => jwt.sign({ id: String(S[k]), role: "student" }, "test-only", { expiresIn: "1h" });
const startFor = async (k) => {
  const r = await call("POST", `${B}/tailor-jobs`, { tok: tokOf(k), body: { resumeId: String(R[k]), jobId: String(J[k]), idempotencyKey: key() } });
  return waitJob(tokOf(k), r.json?.data?.id);
};
const getDraft = async (k, id) => (await call("GET", `${B}/drafts/${id}`, { tok: tokOf(k) })).json?.data;
const patch = async (k, dr, body) => call("PATCH", `${B}/drafts/${dr.id}/decisions`, { tok: tokOf(k), body: { revision: dr.revision, ...body } });
const numbersOf = (c) => new Set((JSON.stringify([c.professionalSummary, c.workExperience, c.projects, c.education]).match(/\d+(?:,\d{3})*/g) || []).map((n) => n.replace(/,/g, "")));
const identity = (c) => JSON.stringify({
  work: c.workExperience.map((w) => [w.company, w.position, w.startDate, w.endDate, w.current]).sort(),
  edu: c.education.map((e) => [e.institution, e.degree, e.fieldOfStudy, e.startDate, e.endDate]).sort(),
  proj: c.projects.map((p) => [p.name, p.technologies]).sort(),
  certs: c.certifications, langs: c.languages,
  contact: { ...c.personalInfo, title: undefined },
});
const counts = (c) => [c.workExperience.length, c.education.length, c.projects.length, c.certifications.length, c.languages.length].join("/");

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  await reqS("./services/featureAccess").load();
  const ai = reqS("./services/resumeStudio/ai");
  const before = {};
  const versions = {};

  console.log("── job keywords, for every kind of job");
  const { requirementsFor } = reqS("./services/resumeStudio/jobRequirements");
  const jr = await requirementsFor({ title: JOBS.HR.title, description: JOBS.HR.description, company: JOBS.HR.companyName });
  const terms = jr.keywords.map((k) => k.term.toLowerCase());
  check("HR job: duties become keywords (screen CVs, interviews, onboarding, employee records, talent acquisition)", ["screen cvs", "onboarding", "employee records", "talent acquisition"].every((t) => terms.includes(t)) && terms.some((t) => /interview/.test(t)), terms.join(", "));
  check("'MS Excel' is not read as a master's degree; the BBA line is", jr.requirements.filter((r) => r.kind === "education").every((r) => /BBA/.test(r.requirement)), JSON.stringify(jr.requirements.filter((r) => r.kind !== "skill")));
  const jm = await requirementsFor({ title: JOBS.MKT.title, description: JOBS.MKT.description });
  check("marketing job: social media, content creation, engagement, Google Analytics are keywords", ["social media", "content creation", "engagement", "google analytics"].every((t) => jm.keywords.some((k) => k.term.toLowerCase() === t)), jm.keywords.map((k) => k.term).join(", "));

  for (const k of ["HR", "DEV", "MKT"]) {
    console.log(`── ${k}: tailoring for ${JOBS[k].title} (${JOBS[k].companyName})`);
    ai.setCaller(answerFor(k));
    const j = await startFor(k);
    check(`${k}: tailoring succeeded`, j.json?.data?.status === "succeeded", JSON.stringify(j.json?.data));
    let dr = await getDraft(k, j.json.data.draftId);
    before[k] = dr;
    const data = sent[k];
    check(`${k}: the AI got the job's keywords, company, page budget, sections and entries`, data.TargetJob.keywords.length >= 8 && data.TargetJob.company === JOBS[k].companyName && [1, 2].includes(data.PageBudget) && data.Sections.length >= 3 && data.Entries.workExperience.length === dr.content.workExperience.length);
    const flagged = dr.suggestions.filter((s) => s.status !== "ok");
    const invented = { HR: "30%", DEV: "Spring Boot", MKT: "Marketing Executive" }[k];
    check(`${k}: the invented claim is held back (${invented})`, flagged.some((s) => (s.proposed || "").includes(invented)) && dr.suggestions.filter((s) => (s.proposed || "").includes(invented)).every((s) => s.status !== "ok"), JSON.stringify(flagged.map((s) => [s.fieldPath, s.status, s.riskFlags])));
    check(`${k}: the honest rewrites pass the checks (headline, summary, bullets, one-line entries, orders)`, dr.suggestions.filter((s) => !(s.proposed || "").includes(invented)).every((s) => s.status === "ok"), JSON.stringify(dr.suggestions.filter((s) => s.status !== "ok" && !(s.proposed || "").includes(invented)).map((s) => [s.fieldPath, s.riskFlags])));
    check(`${k}: every suggestion says which section it belongs to`, dr.suggestions.every((s) => ["headline", "summary", "experience", "projects", "education", "skills", "layout"].includes(s.section)));

    // accept all (the checked ones), then keep the original for what was held back
    let r = await patch(k, dr, { bulk: { decision: "accepted" } });
    check(`${k}: 'accept all' takes every checked change, leaves the held-back one for the student`, r.status === 200 && r.json.data.unresolved === flagged.length, r.text.slice(0, 200));
    dr = r.json.data;
    r = await patch(k, dr, { decisions: dr.suggestions.filter((s) => s.decision === "pending").map((s) => ({ suggestionId: s.suggestionId, decision: "rejected" })) });
    dr = r.json.data;
    const src = before[k].content && (await getDraft(k, dr.id)) && rows("CareerResumeDraft", (x) => same(x._id, dr.id))[0].sourceContent;
    const c = dr.content;

    console.log(`   ${k} before → after`);
    check(`${k}: headline aimed at the job, truthfully`, c.personalInfo.title !== src.personalInfo.title === (k !== "MKT") && (k === "MKT" ? c.personalInfo.title === "Business Graduate" : /aspiring/i.test(c.personalInfo.title)), c.personalInfo.title);
    check(`${k}: summary rewritten for the job`, c.professionalSummary.summary !== src.professionalSummary.summary && c.professionalSummary.summary.length > 150 && !/\b(I|my)\b/.test(c.professionalSummary.summary), c.professionalSummary.summary);
    const changedBullets = c.workExperience.flatMap((w) => w.achievements).filter((a) => !src.workExperience.flatMap((w) => w.achievements).includes(a)).length;
    check(`${k}: bullets rewritten toward the job (${changedBullets})`, changedBullets >= 2);
    check(`${k}: a less relevant entry kept as one line`, c.workExperience.some((w) => !w.achievements.length && w.description && src.workExperience.find((s) => s.company === w.company)?.achievements.length));
    const orderChanged = JSON.stringify(c.workExperience.map((w) => w.company)) !== JSON.stringify(src.workExperience.map((w) => w.company)) || JSON.stringify(c.projects.map((p) => p.name)) !== JSON.stringify(src.projects.map((p) => p.name)) || !!c.sectionOrder;
    check(`${k}: order changed toward the job (entries / sections)`, orderChanged && Array.isArray(c.sectionOrder));
    if (k === "DEV") check("DEV: Softlogic (the developer internship) first, its API bullet first, ShopEase first, projects above education", c.workExperience[0].company === "Softlogic Pvt Ltd" && /REST API/.test(c.workExperience[0].achievements[0]) && c.projects[0].name === "ShopEase" && c.sectionOrder.indexOf("projects") < c.sectionOrder.indexOf("education"), JSON.stringify([c.workExperience.map((w) => w.company), c.workExperience[0].achievements[0], c.projects.map((p) => p.name), c.sectionOrder]));
    if (k === "MKT") check("MKT: the social media internship first", c.workExperience[0].company === "Kapra Studio");
    check(`${k}: facts unchanged: companies, roles, dates, schools, projects, contact details`, identity(c) === identity(src));
    check(`${k}: no new numbers`, [...numbersOf(c)].every((n) => numbersOf(src).has(n)), [...numbersOf(c)].filter((n) => !numbersOf(src).has(n)).join(","));
    check(`${k}: nothing invented in the version (${invented})`, !JSON.stringify(c).includes(invented) || (k === "MKT" && !c.personalInfo.title.includes(invented) && !JSON.stringify(c.professionalSummary).includes("Marketing Executive")));
    check(`${k}: every section and entry kept (${counts(c)})`, counts(c) === counts(src));
    const sk = c.skills.map((s) => s.name);
    check(`${k}: skills only gain what the resume shows elsewhere`, src.skills.every((s) => sk.includes(s.name)) && sk.filter((n) => !src.skills.some((s) => s.name === n)).every((n) => dr.surfacedSkills.some((x) => x.skill === n)), sk.join(", "));
    check(`${k}: keywords covered rise: ${dr.keywords.before.covered.length} → ${dr.keywords.after.covered.length} of ${dr.keywords.after.total}`, dr.keywords.after.covered.length > dr.keywords.before.covered.length && dr.keywords.after.total === dr.keywords.before.total, JSON.stringify(dr.keywords));
    check(`${k}: match rises: ${dr.scores.before}% → ${dr.scores.after}%`, dr.scores.after > dr.scores.before);
    check(`${k}: about ${dr.pages.after} page(s), within ${dr.pages.budget}`, dr.pages.after <= dr.pages.budget && dr.pages.after <= dr.pages.before + 0.01, JSON.stringify(dr.pages));
    check(`${k}: the default name is '<Name> – <Job title> (<Company>)'`, dr.defaultLabel === `${c.personalInfo.firstName} ${c.personalInfo.lastName} – ${JOBS[k].title} (${JOBS[k].companyName})`, dr.defaultLabel);
    before[k] = { src, dr };
  }

  console.log("── undo per section, manual edits");
  {
    const k = "HR";
    let dr = before[k].dr;
    const tailoredExp = JSON.stringify(dr.content.workExperience);
    let r = await patch(k, dr, { bulk: { section: "experience", decision: "rejected" } });
    dr = r.json.data;
    check("undo 'experience': experience back to the student's own words and order", r.status === 200 && JSON.stringify(dr.content.workExperience.map((w) => [w.description, w.achievements])) === JSON.stringify(before[k].src.workExperience.map((w) => [w.description, w.achievements])), r.text.slice(0, 200));
    check("…the other sections stay tailored (summary, headline)", dr.content.professionalSummary.summary !== before[k].src.professionalSummary.summary && /aspiring/.test(dr.content.personalInfo.title));
    r = await patch(k, dr, { bulk: { section: "experience", decision: "accepted" } });
    dr = r.json.data;
    check("accept 'experience' again: the tailored experience is back (the held-back bullet stays out)", JSON.stringify(dr.content.workExperience) !== JSON.stringify(before[k].src.workExperience) && !JSON.stringify(dr.content.workExperience).includes("30%") && dr.content.workExperience.length === 3);
    void tailoredExp;
    const sum = dr.suggestions.find((s) => s.fieldPath === "professionalSummary.summary");
    const mine = "BBA student in Human Resource Management at IBA. Screened 120 CVs and scheduled interviews as a Summer Intern at Acme Textiles.";
    r = await patch(k, dr, { decisions: [{ suggestionId: sum.suggestionId, decision: "edited", editedText: mine }] });
    check("a hand edit of the summary is saved", r.status === 200 && r.json.data.content.professionalSummary.summary === mine, r.text.slice(0, 200));
    dr = await getDraft(k, dr.id);
    check("…and still there when the draft is opened again", dr.content.professionalSummary.summary === mine);
    const head = dr.suggestions.find((s) => s.fieldPath === "personalInfo.title");
    r = await patch(k, dr, { decisions: [{ suggestionId: head.suggestionId, decision: "edited", editedText: "HR Intern at Engro Corporation" }] });
    check("a hand edit that claims the job as held needs 'this is true'", r.status === 422 && r.json.error.code === "CONFIRMATION_REQUIRED", r.text.slice(0, 200));
    dr = await getDraft(k, dr.id);
    if (dr.unresolved) { r = await patch(k, dr, { decisions: dr.suggestions.filter((s) => s.decision === "pending").map((s) => ({ suggestionId: s.suggestionId, decision: "rejected" })) }); dr = r.json.data; }
    r = await call("POST", `${B}/drafts/${dr.id}/approve`, { tok: tokOf(k), body: { revision: dr.revision, confirmAccurate: true, confirmReviewed: true, templateId: "stanford" } });
    check("approve: saved as 'Ayesha Khan – HR Intern (Engro Corporation)' in the chosen template", r.status === 201 && r.json.data.version.label === "Ayesha Khan – HR Intern (Engro Corporation)" && r.json.data.version.templateId === "stanford" && r.json.data.version.target.company === "Engro Corporation", r.text.slice(0, 300));
    versions.HR = r.json?.data?.version;
    const v = rows("CareerResumeApprovedVersion", (x) => same(x._id, versions.HR?.id))[0];
    check("the approved version has the tailored content (summary edit, section order)", v?.contentSnapshot.professionalSummary.summary === mine && Array.isArray(v?.contentSnapshot.sectionOrder));
    r = await call("POST", `${B}/applications/${A.HR}/attach-version`, { tok: tokOf(k), body: { versionId: versions.HR.id } });
    check("attach it to the application for that job", r.status === 201 && r.json.data.versionId === versions.HR.id, r.text.slice(0, 200));
    const pdf = await call("GET", `${B}/versions/${versions.HR.id}/export.pdf`, { tok: tokOf(k) });
    const text = (await reqS("pdf-parse/lib/pdf-parse.js")(Uint8Array.from(pdf.buf))).text;
    check("the PDF follows the tailored section order (projects before education before skills)", pdf.status === 200 && text.indexOf("PROJECTS") > text.indexOf("EXPERIENCE") && text.indexOf("EDUCATION") > text.indexOf("PROJECTS") && text.indexOf("SKILLS") > text.indexOf("EDUCATION"), [text.indexOf("EXPERIENCE"), text.indexOf("PROJECTS"), text.indexOf("EDUCATION"), text.indexOf("SKILLS")].join(","));
  }

  console.log("── a bad or slow AI answer saves nothing");
  {
    const draftsBefore = rows("CareerResumeDraft").length;
    ai.setCaller(async () => "{ not json");
    let j = await startFor("DEV");
    check("invalid JSON (twice): failed, 'try again', no draft", j.json?.data?.status === "failed" && j.json.data.errorCode === "AI_FAILED" && j.json.data.retryable === true && rows("CareerResumeDraft").length === draftsBefore, JSON.stringify(j.json?.data));
    ai.setCaller(async () => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); });
    j = await startFor("DEV");
    check("timeout: failed AI_TIMEOUT, no draft", j.json?.data?.status === "failed" && j.json.data.errorCode === "AI_TIMEOUT" && rows("CareerResumeDraft").length === draftsBefore);
    ai.setCaller(async () => JSON.stringify({ suggestions: [{ fieldPath: "workExperience[9].description", original: "x", proposed: "y" }, { fieldPath: "personalInfo.email", original: "", proposed: "x@y.z" }] }));
    j = await startFor("DEV");
    const dr = await getDraft("DEV", j.json?.data?.draftId);
    check("an answer touching fields that can't be tailored: those changes are dropped, the resume stays as it was", dr && dr.suggestions.length === 0 && JSON.stringify(dr.content.workExperience) === JSON.stringify(rows("CareerResumeDraft", (x) => same(x._id, dr.id))[0].sourceContent.workExperience));
  }

  console.log("── prompt and settings");
  const src = (f) => fs.readFileSync(path.join(SERVER, f), "utf8");
  check("the prompt asks for real tailoring: headline as a goal, 2-4 line summary, action + skill + result, order, one-line entries, page budget", /aspiring/.test(src("services/resumeStudio/contract.js")) && /2-4 short lines/.test(src("services/resumeStudio/contract.js")) && /action verb \+ tool or skill \+ result/.test(src("services/resumeStudio/contract.js")) && /condense\.workExperience/.test(src("services/resumeStudio/contract.js")) && /PageBudget/.test(src("services/resumeStudio/contract.js")));
  check("…and keeps the no-invention contract word for word", /Never add employers, roles, dates, education, certificates, technologies, skills, proficiency levels, projects, achievements or numbers not supported by candidate facts\./.test(src("services/resumeStudio/contract.js")));
  check("temperature 0.4, no hidden retries", /temperature: 0\.4/.test(src("services/resumeStudio/ai.js")) && /maxRetries: 0/.test(src("services/resumeStudio/ai.js")));

  ai.setCaller(null);
  server.close();
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, no hidden fields or hiring verdicts`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks}`).join(" | "));
  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url).join(" | "));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
