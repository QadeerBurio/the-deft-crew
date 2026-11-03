// The existing resume routes (fix/resume-pdf-basics): the 2-resume limit under simultaneous requests
// (per-user lock), and the existing PDF export: bullets that render, dates in reading order, skills that
// don't overlap, full clickable LinkedIn / GitHub links.
//   node tests/resume-basics/run.js [serverDir]
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
  const T = { S1: token("S1"), S2: token("S2"), S3: token("S3") };

  console.log("── 1. the 2-resume limit under simultaneous requests");
  let rs = await Promise.all([1, 2, 3, 4, 5].map((n) => call("POST", "/api/resume", { tok: T.S1, body: newResume(n) })));
  check("S1 has 1 resume; 5 simultaneous creates → exactly 1 more, the rest refused (403)", resumesOf("S1") === 2 && rs.filter((x) => x.status === 201 || x.status === 200).length === 1 && rs.filter((x) => x.status === 403 && x.json?.code === "RESUME_CREATION_LIMIT_REACHED").length === 4, `${statuses(rs)} → ${resumesOf("S1")} resumes`);
  await new Promise((r) => setTimeout(r, 100)); // the release runs right after each response is sent
  check("…the lock is released after the requests (no row left)", rows("ResumeCreationLock").length === 0, rows("ResumeCreationLock").length);
  fake.seed(coll("Resume"), [resumeDoc(oid(), "S2")]);
  const S2first = rows("Resume", (r) => same(r.user, ids.S2))[0]._id;
  rs = await Promise.all([1, 2, 3].map(() => call("POST", `/api/resume/${S2first}/duplicate`, { tok: T.S2 })));
  check("S2 has 1; 3 simultaneous duplicates → 1 more, ends at 2", resumesOf("S2") === 2 && rs.filter((x) => x.status === 201 || x.status === 200).length === 1, `${statuses(rs)} → ${resumesOf("S2")}`);
  rs = await Promise.all([
    call("POST", "/api/resume", { tok: T.S3, body: newResume("a") }),
    call("POST", "/api/resume", { tok: T.S3, body: newResume("b") }),
    call("POST", "/api/resume", { tok: T.S3, body: newResume("c") }),
  ]);
  check("S3 has 0; 3 simultaneous creates → 2 created, 1 refused (never 3)", resumesOf("S3") === 2 && rs.filter((x) => x.status === 403).length === 1, `${statuses(rs)} → ${resumesOf("S3")}`);
  r = await call("DELETE", `/api/resume/${R1}`, { tok: T.S1 });
  const after = await call("POST", "/api/resume", { tok: T.S1, body: newResume("after delete") });
  check("delete one, then create → allowed again (the lock didn't stick)", (r.status === 200) && (after.status === 201 || after.status === 200) && resumesOf("S1") === 2, `${r.status} ${after.status}`);
  // a holder that crashed: its expired lock is taken over
  fake.seed(coll("ResumeCreationLock"), [{ _id: oid(), key: `resume-create:${ids.S2}`, token: "dead-server", expiresAt: new Date(Date.now() - 1000) }]);
  const S2ids = rows("Resume", (r) => same(r.user, ids.S2)).map((x) => x._id);
  await call("DELETE", `/api/resume/${S2ids[1]}`, { tok: T.S2 });
  r = await call("POST", "/api/resume", { tok: T.S2, body: newResume("after crash") });
  check("an expired lock left by a crashed request is taken over (create succeeds)", (r.status === 201 || r.status === 200) && resumesOf("S2") === 2, r.status);
  await new Promise((r) => setTimeout(r, 100));
  check("…and nothing is left locked", rows("ResumeCreationLock").length === 0);

  console.log("── 2. the existing PDF export, fixed");
  const R2 = oid();
  fake.seed(coll("Resume"), [resumeDoc(R2, "S3", { user: oid() })]); // someone else's
  r = await call("GET", `/api/resume/${R2}/pdf`, { tok: T.S3 });
  check("someone else's resume PDF: still refused", r.status === 404 || r.status === 403, r.status);
  const R3 = rows("Resume", (x) => same(x.user, ids.S3))[0]._id;
  Object.assign(rows("Resume", (x) => same(x._id, R3))[0], resumeDoc(R3, "S3"));
  r = await call("GET", `/api/resume/${R3}/pdf`, { tok: T.S3 });
  check("own PDF: 200 application/pdf (route unchanged)", r.status === 200 && /application\/pdf/.test(r.headers["content-type"] || "") && r.buf.slice(0, 4).toString() === "%PDF", `${r.status} ${r.headers["content-type"]}`);
  const PDFExtract = await reqS("pdf.js-extract"); // its CommonJS entry resolves to the class
  const data = await new PDFExtract().extractBuffer(r.buf, {});
  const boxes = data.pages.flatMap((p) => p.content).filter((c) => c.str.trim());
  const items = boxes.map((c) => c.str);
  // a date drawn at the right edge is a separate column: text extraction (pdftotext) and ATS parsers read
  // it after the whole section; in reading order it starts at the left margin, under its heading
  const leftAligned = (t) => { const b = boxes.find((c) => c.str.includes(t)); return !!b && b.x < 100; };
  const text = items.join(" ");
  const idx = (t) => items.findIndex((x) => x.includes(t));
  check("no unknown glyph (no '•' / '\\ufffd' in the text): bullets are drawn", !/[•�]/.test(text) && text.includes("Cut page load from 4s to 2s"), text.slice(0, 160));
  check("dates in reading order: the job's dates right after its heading, before its bullets, at the left (no right-hand column)", idx("Intern Developer") >= 0 && idx("Jun 2025 - Aug 2025") > idx("Intern Developer") && idx("Jun 2025 - Aug 2025") < idx("Cut page load") && leftAligned("Jun 2025 - Aug 2025") && leftAligned("Sep 2022 - Jun 2026"), JSON.stringify(boxes.filter((c) => /20\d\d/.test(c.str)).map((c) => [c.str, Math.round(c.x)])));
  check("…the school's dates right after the school, the certificate's date on its line", idx("Sep 2022 - Jun 2026") === idx("SZABIST") + 1 || idx("Sep 2022 - Jun 2026") === idx("SZABIST") + 2, `${idx("SZABIST")} ${idx("Sep 2022 - Jun 2026")}`);
  check("skills: one line per category, no empty item, nothing drawn on top", text.includes("Languages: ") && text.includes("JavaScript") && text.includes("Frameworks: ") && !/,\s*,/.test(text) && !/JavaScript,\s*$/.test(items[idx("JavaScript")] || ""), text.slice(text.indexOf("SKILLS"), text.indexOf("SKILLS") + 80));
  const raw = r.buf.toString("latin1");
  check("LinkedIn and GitHub: full addresses, clickable links in the PDF", text.includes("linkedin.com/in/sana") && text.includes("github.com/sana") && raw.includes("(https://linkedin.com/in/sana)") && raw.includes("(https://github.com/sana)") && !text.includes("li/sana"), (raw.match(/\/URI \([^)]*\)/g) || []).join(" "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
