// A job's skills (fix/job-skills-input): paste splitting, the rules (15 skills, 40 characters each), job create /
// update validation, matching on clean skills, the read-only skills report, and the CSV import reporting bad rows.
//   node tests/job-skills/run.js [serverDir]
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
  if (resolved.endsWith("jobEmbeddingService.js")) return { generateJobEmbedding: async () => {}, batchEmbedAllJobs: async () => {}, buildJobText: () => "" };
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

const sk = reqS("./services/jobs/skills");
const { importJobsFromFile } = reqS("./services/jobs/csvJobImporter");
const matching = reqS("./services/career/matchingService");
const XLSX = reqS("xlsx");
const oid = () => new mongoose.Types.ObjectId();
const ids = { A: oid(), E: oid(), S: oid(), J1: oid(), J2: oid(), J3: oid(), J4: oid() };
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date() });
fake.seed(coll("User"), [user(ids.A, "admin", "admin"), user(ids.E, "employee", "hireco"), user(ids.S, "student", "sana")]);
const job = (id, extra) => ({ _id: id, title: "Job", department: "Eng", location: "Karachi", type: "Internship", salary: "x", email: "hr@hireco.test", description: "d", postedBy: ids.E, isExternal: false, active: true, requirements: [], createdAt: new Date(), ...extra });
const LONG = "We are looking for someone who knows React and Node.js very well";
fake.seed(coll("Job"), [
  job(ids.J1, { title: "Clean job", skills: ["React", "Node.js"] }),
  job(ids.J2, { title: "Pasted paragraph", skills: [LONG, "SQL"] }),
  job(ids.J3, { title: "Broken brackets", skills: ["Python (pandas", "Git"] }),
  job(ids.J4, { title: "Too many", skills: Array.from({ length: 16 }, (_, i) => `Skill ${i + 1}`) }),
]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, tok, body, raw) {
  return new Promise((resolve) => {
    const headers = tok ? { authorization: `Bearer ${tok}` } : {};
    let payload = null;
    if (raw) { payload = raw.body; headers["content-type"] = raw.type; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (payload) q.write(payload);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = (m) => fake.STORE.get(coll(m)) || [];
const jobOf = (id) => rows("Job").find((j) => String(j._id) === String(id));

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { A: token(ids.A, "admin"), E: token(ids.E, "employee"), S: token(ids.S, "student") };

  console.log("── 1. paste splitting (services/jobs/skills.splitSkillText)");
  const split = sk.splitSkillText;
  check("commas and semicolons", eq(split("React, Node.js; SQL"), ["React", "Node.js", "SQL"]));
  check("new lines", eq(split("React\nNode.js\r\nSQL"), ["React", "Node.js", "SQL"]));
  check('" - " between items', eq(split("React - Node.js - SQL"), ["React", "Node.js", "SQL"]));
  check("bullets at line starts (•, -, *, 1.)", eq(split("• React\n- Node.js\n* SQL\n1. Git\n2) Docker"), ["React", "Node.js", "SQL", "Git", "Docker"]));
  check("bullets inside a line", eq(split("React • Node.js · SQL"), ["React", "Node.js", "SQL"]));
  check("never inside brackets", eq(split("Python (pandas, numpy), SQL [MySQL, Postgres] - Git"), ["Python (pandas, numpy)", "SQL [MySQL, Postgres]", "Git"]));
  check("nested brackets and a new line inside one", eq(split("Cloud (AWS [EC2, S3],\nGCP), Linux"), ["Cloud (AWS [EC2, S3], GCP)", "Linux"]));
  check("hyphenated words, C++, C#, Node.js stay whole", eq(split("front-end, C++, C#, Node.js, e-commerce"), ["front-end", "C++", "C#", "Node.js", "e-commerce"]));
  check("empty pieces dropped, spaces tidied", eq(split(" ,, React   Native ,\n\n"), ["React Native"]));

  console.log("── 2. rules (cleanSkills, skillProblems)");
  let c = sk.cleanSkills(["  React ", "react", "", "Node.js", null, "  "]);
  check("trimmed, empty dropped, repeats (any case) dropped", eq(c.skills, ["React", "Node.js"]) && c.errors.length === 0, JSON.stringify(c));
  c = sk.cleanSkills(Array.from({ length: 16 }, (_, i) => `S${i}`));
  check("16 skills → TOO_MANY", c.errors.some((e) => e.code === "TOO_MANY" && e.count === 16));
  check("15 skills are fine", sk.cleanSkills(Array.from({ length: 15 }, (_, i) => `S${i}`)).errors.length === 0);
  c = sk.cleanSkills(["x".repeat(41), "React"]);
  check("41 characters → TOO_LONG; 40 are fine", c.errors.some((e) => e.code === "TOO_LONG") && sk.cleanSkills(["x".repeat(40)]).errors.length === 0);
  check("legacy comma text is split like a paste", eq(sk.cleanSkills("React, Node.js").skills, ["React", "Node.js"]));
  check("an object is refused", sk.cleanSkills([{ a: 1 }]).errors[0].code === "NOT_A_LIST" && sk.cleanSkills({ a: 1 }).errors[0].code === "NOT_A_LIST");
  check("message is clear", /at most 15 skills \(this one has 16\)/.test(sk.skillsMessage([{ code: "TOO_MANY", count: 16 }])) && /at most 40 characters/.test(sk.skillsMessage([{ code: "TOO_LONG", skills: ["x".repeat(41)] }])));
  check("problems: too long, unbalanced brackets; clean ones none", sk.skillProblems(LONG).some((r) => /over 40/.test(r)) && eq(sk.skillProblems("Python (pandas"), ["unbalanced brackets"]) && eq(sk.skillProblems(")("), ["unbalanced brackets"]) && sk.skillProblems("Python (pandas)").length === 0);

  console.log("── 3. job create / update");
  const base = { title: "Backend intern", department: "Eng", location: "Karachi", type: "Internship", salary: "PKR 40,000", email: "hr@hireco.test", description: "Build APIs" };
  let r = await call("POST", "/api/jobs/add", T.E, { ...base, skills: ["  React ", "Node.js", "react", ""] });
  const created = r.json?.data;
  check("create: skills trimmed, empty and repeated dropped", r.status === 201 && eq(created?.skills, ["React", "Node.js"]), r.text.slice(0, 200));
  const before = rows("Job").length;
  r = await call("POST", "/api/jobs/add", T.E, { ...base, skills: Array.from({ length: 16 }, (_, i) => `S${i}`) });
  check("create with 16 skills: 400 INVALID_SKILLS with a clear message, nothing saved", r.status === 400 && r.json?.code === "INVALID_SKILLS" && /at most 15 skills/.test(r.json.error) && r.json.limits?.maxSkills === 15 && rows("Job").length === before, r.text);
  r = await call("POST", "/api/jobs/add", T.E, { ...base, skills: ["React", LONG] });
  check("create with a 64-character skill: 400, names the skill, nothing saved", r.status === 400 && r.json?.code === "INVALID_SKILLS" && /at most 40 characters/.test(r.json.error) && r.json.error.includes("We are looking for") && rows("Job").length === before, r.text);
  const id = created._id;
  r = await call("PUT", `/api/jobs/update/${id}`, T.E, { skills: ["x".repeat(41)] });
  check("update with a bad skill: 400, the job keeps its skills", r.status === 400 && r.json?.code === "INVALID_SKILLS" && eq(jobOf(id).skills, ["React", "Node.js"]), r.text);
  r = await call("PUT", `/api/jobs/update/${id}`, T.E, { skills: [" Express ", "Node.js", ""] });
  check("update with good skills: cleaned and saved", r.status === 200 && eq(jobOf(id).skills, ["Express", "Node.js"]), r.text.slice(0, 200));
  r = await call("PUT", `/api/jobs/update/${id}`, T.E, { title: "Backend intern (renamed)" });
  check("update without skills: skills unchanged", r.status === 200 && eq(jobOf(id).skills, ["Express", "Node.js"]) && jobOf(id).title === "Backend intern (renamed)");

  console.log("── 4. matching on clean skills");
  const blank = { personalInfo: {}, professionalSummary: { summary: "" }, workExperience: [], education: [], projects: [], skills: [{ name: "Express" }, { name: "Node.js" }], certifications: [], languages: [] };
  const profile = matching.profileOf({ content: blank });
  let m = matching.match(jobOf(id), profile);
  check("a job saved through the form matches skill by skill (2 of 2, 100%)", m.relevance.score === 100 && m.skills.matched.length === 2, JSON.stringify(m.relevance));
  m = matching.match({ title: "x", skills: [LONG] }, matching.profileOf({ content: { ...blank, skills: [{ name: "React" }, { name: "Node.js" }] } }));
  const m2 = matching.match({ title: "x", skills: sk.cleanSkills(sk.splitSkillText("React - Node.js")).skills }, matching.profileOf({ content: { ...blank, skills: [{ name: "React" }, { name: "Node.js" }] } }));
  check("pasted text as one long skill can't be matched; split into tags it matches", m.relevance.score === 0 && m2.relevance.score === 100, `${m.relevance.score} / ${m2.relevance.score}`);

  console.log("── 5. the read-only skills report");
  const snapshot = () => JSON.stringify([...fake.STORE.entries()]);
  const store0 = snapshot();
  r = await call("GET", "/api/jobs/admin/skills-report", T.A);
  const rep = r.json || {};
  const titles = (rep.jobs || []).map((j) => j.title).sort();
  check("admin: lists the broken jobs (long skill, unbalanced bracket, 16 skills), not the clean ones", r.status === 200 && eq(titles, ["Broken brackets", "Pasted paragraph", "Too many"]) && rep.checked >= 5, r.text.slice(0, 300));
  const pasted = rep.jobs.find((j) => j.title === "Pasted paragraph");
  check("…each with the skill and why", pasted.problems.length === 1 && pasted.problems[0].skill === LONG && /over 40 characters \(64\)/.test(pasted.problems[0].reasons[0]) && rep.jobs.find((j) => j.title === "Broken brackets").problems[0].reasons[0] === "unbalanced brackets" && /16 skills \(max 15\)/.test(rep.jobs.find((j) => j.title === "Too many").problems[0].reasons[0]));
  check("reading the report writes nothing", snapshot() === store0);
  r = await call("GET", "/api/jobs/admin/skills-report", T.E);
  check("an employer: 403", r.status === 403);
  r = await call("GET", "/api/jobs/admin/skills-report", T.S);
  check("a student: 403", r.status === 403);

  console.log("── 6. CSV import: rows with bad skills are reported, not saved");
  const sheet = (rows2) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows2), "Jobs"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };
  const csvRows = [
    { Company: "Acme", "Job Title": "Data intern", Location: "Lahore", Skills: "Python (pandas, numpy), SQL\n• Excel" },
    { Company: "Acme", "Job Title": "Writer", Location: "Lahore", Skills: "Writing, " + "x".repeat(45) },
    { Company: "Acme", "Job Title": "Generalist", Location: "Lahore", Skills: Array.from({ length: 16 }, (_, i) => `S${i}`).join(", ") },
    { Company: "Acme", "Job Title": "Python developer", Location: "Lahore", Department: "A department name that is much longer than forty characters" },
  ];
  const jobsBefore = rows("Job").length;
  const res1 = await importJobsFromFile(sheet(csvRows), "jobs.xlsx");
  const saved = (t) => rows("Job").find((j) => j.title === t);
  check("good rows saved: 2 created", res1.created === 2 && rows("Job").length === jobsBefore + 2, JSON.stringify(res1));
  check("a skills column is split like a paste (brackets kept, bullets removed)", eq(saved("Data intern")?.skills, ["Python (pandas, numpy)", "SQL", "Excel"]), JSON.stringify(saved("Data intern")?.skills));
  check("bad rows are reported with their row number and reason, and not saved", res1.rejected.length === 2 && res1.rejected[0].row === 3 && res1.rejected[0].title === "Writer" && /at most 40 characters/.test(res1.rejected[0].reason) && res1.rejected[1].row === 4 && /at most 15 skills/.test(res1.rejected[1].reason) && !saved("Writer") && !saved("Generalist"), JSON.stringify(res1.rejected));
  check("no skills column: found tags kept, an over-long department name left out (row still saved)", eq(saved("Python developer")?.skills, ["Python"]), JSON.stringify(saved("Python developer")?.skills));
  const boundary = "----skills" + Date.now();
  const file = sheet([{ Company: "Beta", "Job Title": "Ops intern", Location: "Karachi", Skills: "Ops, " + "y".repeat(41) }, { Company: "Beta", "Job Title": "QA intern", Location: "Karachi", Skills: "Testing; Jira" }]);
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="jobs.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  r = await call("POST", "/api/jobs/admin/import-csv", T.A, undefined, { body, type: `multipart/form-data; boundary=${boundary}` });
  check("POST /admin/import-csv replies with created and the rejected rows", r.status === 200 && r.json?.success === true && r.json.created === 1 && r.json.rejected?.length === 1 && r.json.rejected[0].row === 2 && r.json.rejected[0].title === "Ops intern", r.text.slice(0, 300));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
