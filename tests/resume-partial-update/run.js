// PUT /api/resume/:id merges partial saves (fix/resume-builder): only the sent sections / keys change,
// colours (customStyles) are saved and merged, owner and id can't be changed, two saves at the same
// moment both keep their section.
//   node tests/resume-partial-update/run.js [serverDir]
// Real routes and models; fake MongoDB with unique indexes and interleaving; OpenAI stubbed (no network).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "OPENAI_API_KEY"]) delete process.env[k];
let r;

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
  if (request === "openai") return class OpenAI { constructor() { const no = async () => { throw new Error("AI off in tests"); }; this.chat = { completions: { create: no } }; this.embeddings = { create: no }; } };
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
for (const m of ["User", "Resume", "ResumeCreationLock", "Notification", "DomainEvent", "EngagementProfile", "PointsLedger", "EngagementEvent"]) { try { reqS(`./models/${m}`); } catch {} }

const app = express();
app.use(express.json());
app.use("/api/resume", reqS("./routes/resume.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = { S1: oid(), S2: oid(), S3: oid() };
const user = (id, name) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role: "student", status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.S1, "sana"), user(ids.S2, "taha"), user(ids.S3, "umar")]);
const resumeDoc = (id, who, extra = {}) => ({
  _id: id, user: ids[who], title: "My resume", createdAt: new Date(), updatedAt: new Date(),
  personalInfo: { firstName: "Sana", lastName: "Khan", title: "Frontend Developer", email: "sana@example.test", phone: "+92 300 0000000", location: "Karachi, Pakistan", linkedin: "https://linkedin.com/in/sana", github: "github.com/sana" },
  professionalSummary: { summary: "Final-year CS student." },
  education: [{ institution: "SZABIST", degree: "BS", fieldOfStudy: "Computer Science", startDate: new Date("2022-09-01"), endDate: new Date("2026-06-30") }],
  workExperience: [{ position: "Intern Developer", company: "Hire Co", location: "Karachi", startDate: new Date("2025-06-01"), endDate: new Date("2025-08-31"), achievements: ["Cut page load from 4s to 2s"] }],
  skills: [{ name: "JavaScript", category: "Languages" }, { name: "", category: "Languages" }, { name: "React", category: "Frameworks" }],
  certifications: [{ name: "AWS Cloud Practitioner", organization: "AWS", issueDate: new Date("2025-03-01") }],
  ...extra,
});
const R1 = oid();
fake.seed(coll("Resume"), [resumeDoc(R1, "S1")]); // S1 has 1 of 2
const token = (who) => jwt.sign({ id: String(ids[who]), role: "student" }, "test-only", { expiresIn: "1h" });
let PORT;
function call(method, url, { body, tok, raw = false } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch {} resolve({ status: res.statusCode, json: j, buf, headers: res.headers }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, buf: Buffer.from(String(e)), headers: {} }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const statuses = (rs) => rs.map((r) => r.status).sort().join(",");
const resumesOf = (who) => rows("Resume", (r) => same(r.user, ids[who])).length;
const newResume = (n) => ({ title: `Resume ${n}`, personalInfo: { firstName: "Sana", lastName: "Khan", email: "sana@example.test" } });


(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { S1: token("S1"), S2: token("S2") };
  const RID = oid();
  fake.seed(coll("Resume"), [resumeDoc(RID, "S2", {
    professionalSummary: { title: "Frontend Developer", summary: "Final-year CS student." },
    targetJob: { jobTitle: "Frontend Developer", location: "Karachi" },
    targetJobs: [{ jobTitle: "Frontend Developer", industry: "Technology", jobType: "Full-time" }],
    projects: [{ name: "tdc app", description: "student app" }],
    customStyles: { font: "Inter", accentColor: "#1E3A8A", headingColor: "#0F172A", textColor: "#334155", bgColor: "#FFFFFF" },
  })]);
  const doc = () => JSON.parse(JSON.stringify(rows("Resume", (x) => same(x._id, RID))[0]));
  const put = (body, tok = T.S2, id = RID) => call("PUT", `/api/resume/${id}`, { tok, body });
  const before = doc();
  const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // every value the section had is still there (schema defaults filled in on save don't count as a change)
  const keeps = (was, is) => (was && typeof was === "object" && !Array.isArray(was) ? Object.keys(was).every((k) => keeps(was[k], is?.[k])) : sameAs(was, is));
  const untouched = (now, keys) => keys.filter((k) => !keeps(before[k], now[k]));

  console.log("── partial saves change only what was sent");
  let r = await put({ skills: [{ name: "React" }, { name: "Node" }] });
  let now = doc();
  check("only skills sent: skills replaced", r.status === 200 && now.skills.map((s) => s.name).join() === "React,Node", r.status);
  check("…personal info, education, work, projects, certifications, summary, target, styles unchanged", untouched(now, ["personalInfo", "education", "workExperience", "projects", "certifications", "professionalSummary", "targetJob", "targetJobs", "customStyles"]).length === 0, untouched(now, ["personalInfo", "education", "workExperience", "projects", "certifications", "professionalSummary", "targetJob", "targetJobs", "customStyles"]).join());

  r = await put({ personalInfo: { phone: "+92 311 1111111" } });
  now = doc();
  check("only the phone sent: phone changed, name / email / links kept", r.status === 200 && now.personalInfo.phone === "+92 311 1111111" && now.personalInfo.firstName === "Sana" && now.personalInfo.email === before.personalInfo.email && now.personalInfo.linkedin === before.personalInfo.linkedin, JSON.stringify(now.personalInfo));
  check("…summary and every section kept", now.professionalSummary.summary === "Final-year CS student." && untouched(now, ["education", "workExperience", "projects", "certifications", "customStyles"]).length === 0);

  r = await put({ professionalSummary: { summary: "New summary." } });
  now = doc();
  check("only the summary sent: summary changed, title kept", now.professionalSummary.summary === "New summary." && now.professionalSummary.title === "Frontend Developer", JSON.stringify(now.professionalSummary));

  r = await put({ customStyles: { accentColor: "#0F766E" } });
  now = doc();
  check("colours: only the accent sent → accent saved, font and other colours kept (styles were never saved before)", r.status === 200 && now.customStyles.accentColor === "#0F766E" && now.customStyles.font === "Inter" && now.customStyles.textColor === "#334155", JSON.stringify(now.customStyles));
  r = await put({ customStyles: { textColor: "#111827", evil: "x", font: "y".repeat(500) } });
  now = doc();
  check("…a second colour change keeps the first; unknown keys and oversized values are ignored", now.customStyles.accentColor === "#0F766E" && now.customStyles.textColor === "#111827" && !("evil" in now.customStyles) && now.customStyles.font === "Inter", JSON.stringify(now.customStyles));

  r = await put({ targetJobs: [{ jobTitle: "UX Designer", industry: "Design", jobType: "Full-time" }] });
  now = doc();
  check("only target roles sent: roles replaced, summary and sections kept", now.targetJobs.length === 1 && now.targetJobs[0].jobTitle === "UX Designer" && now.professionalSummary.summary === "New summary." && now.skills.length === 2);

  r = await put({});
  check("an empty save changes nothing", r.status === 200 && sameAs(doc().skills, now.skills) && sameAs(doc().personalInfo, now.personalInfo));

  console.log("── what a save can't change");
  const other = oid();
  r = await put({ user: String(other), _id: String(oid()), careerProfile: { skills: ["hacked"] }, title: "x" });
  now = doc();
  check("owner and id can't be changed by a save", same(now.user, ids.S2) && same(now._id, RID), JSON.stringify({ user: now.user }));
  r = await put({ skills: [] }, T.S1);
  check("someone else's resume: 404, nothing changed", r.status === 404 && doc().skills.length === 2, r.status);

  console.log("── two saves at the same moment");
  const [a, b] = await Promise.all([
    put({ education: [...before.education, { institution: "MIT", degree: "MS", fieldOfStudy: "CS" }] }),
    put({ skills: [{ name: "React" }, { name: "Node" }, { name: "SQL" }] }),
  ]);
  now = doc();
  check("education and skills saved together: both kept (each save writes only its own section)", a.status === 200 && b.status === 200 && now.education.length === 2 && now.skills.length === 3, `${now.education.length} ${now.skills.length}`);
  check("…and nothing else lost", now.professionalSummary.summary === "New summary." && now.customStyles.accentColor === "#0F766E" && now.projects.length === 1 && now.personalInfo.phone === "+92 311 1111111");

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
