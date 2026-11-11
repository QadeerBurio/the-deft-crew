// Employer candidate matching (FLAG_CAREER_MATCHING): the matcher (mandatory criteria, skill evidence, the
// estimate and its formula), the fairness set (name, gender, city, university, age and photo never change a
// result; freshers vs experienced and sparse vs full profiles with the same skills score the same; a seeded cohort
// of 60 skill sets written 16 ways), and the routes (flag, ownership, admin audit, snapshots, recomputation when
// the resume or the job changes, newest / relevance order, nothing hidden or rejected, account deletion).
//   node tests/career-matching/run.js [serverDir]        FAIRNESS_REPORT=<file> also writes the fairness figures
// No database, no network, no .env (the fake in-memory database from tests/hide-user-secrets).
const path = require("path");
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
for (const m of ["User", "Job", "JobApplication", "Resume", "CareerMatchSnapshot", "CareerApplicationResumeAttachment", "CareerResumeApprovedVersion", "DomainEvent"]) reqS(`./models/${m}`);
const matching = reqS("./services/career/matchingService");

const responses = [];
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const rows = (m, f = () => true) => (fake.STORE.get(coll(m)) || []).filter(f);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
let PORT;
function call(method, url, { tok } = {}) {
  return new Promise((resolve) => {
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: tok ? { authorization: `Bearer ${tok}` } : {} }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    q.end();
  });
}

// ---------- synthetic profiles (contentOf shape) ----------
const JOB = { title: "Junior web developer", skills: ["JavaScript", "React", "Node.js", "MongoDB", "TypeScript", "Git"], requirements: ["Must know React", "Good communication"], minExperience: 0, education: "Bachelor's Degree" };
const blank = () => ({ personalInfo: {}, professionalSummary: {}, workExperience: [], education: [], projects: [], skills: [], certifications: [], languages: [] });
// the same skills, written as a fresher (projects) or as someone experienced (work history)
function person({ skills, name = "Ayesha Khan", city = "Karachi", university = "NED University", style = "fresher", detail = "full", gradYear = 2024, photo = "" }) {
  const c = blank();
  c.personalInfo = { firstName: name.split(" ")[0], lastName: name.split(" ")[1] || "", title: "Software developer", email: `${name.split(" ")[0].toLowerCase()}@example.com`, phone: "+92 300 0000000", location: city, photo };
  c.education = [{ institution: university, degree: "BS", fieldOfStudy: "Computer Science", startDate: `${gradYear - 4}-09`, endDate: `${gradYear}-06`, current: false, description: `Studied at ${university}, ${city}` }];
  c.skills = skills.map((s) => ({ name: s, category: "" }));
  if (detail === "full") {
    c.professionalSummary = { summary: "I like building useful things and learning from the people around me." };
    c.languages = [{ name: "English", proficiency: "Fluent" }, { name: "Urdu", proficiency: "Native" }];
    if (style === "fresher") c.projects = [{ name: "Final year project", description: `A web app built with ${skills.join(", ") || "care"}, used by our department.`, technologies: skills }];
    else c.workExperience = [{ company: `${city} Tech`, position: "Developer", location: city, startDate: "2019-01", endDate: "2024-01", current: false, description: `Worked with ${skills.join(", ") || "the team"} on customer projects.`, achievements: ["Mentored two interns", "Shipped releases every two weeks"] }];
  }
  return c;
}
const score = (c) => matching.match(JOB, matching.profileOf({ content: c }));
const evidenceKey = (m) => JSON.stringify(m.skills.matched.map((s) => s.skill)) + JSON.stringify(m.skills.missing.map((s) => s.skill)) + JSON.stringify(m.skills.unknown.map((s) => s.skill));
// a seeded random generator, so the cohort is the same every run
let seed = 20261105;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const report = [];

  console.log("-- the matcher");
  let m = score(person({ skills: ["JavaScript", "React", "Git"] }));
  check("evidence lists: matched with the resume text, missing for the rest, and an estimate with its formula", m.skills.matched.map((s) => s.skill).join() === "JavaScript,React,Git" && m.skills.matched.every((s) => s.evidence.length && s.evidence[0].text) && m.skills.missing.map((s) => s.skill).join() === "Node.js,MongoDB,TypeScript" && m.relevance.score === 50 && /estimate/.test(m.relevance.label) && /experience and education are mandatory criteria/.test(m.relevance.formula), JSON.stringify(m.relevance));
  check("mandatory criteria shown separately: education met (BS), 'Must know React' met with its evidence; the non-mandatory line isn't a criterion", m.mandatory.length === 2 && m.mandatory[0].status === "met" && m.mandatory[1].criterion === "Must know React" && m.mandatory[1].status === "met" && /React/.test(m.mandatory[1].evidence), JSON.stringify(m.mandatory));
  m = score(blank());
  check("an empty resume: every skill unknown, no number ('insufficient information'), never 0%", m.relevance.score === null && /insufficient information/.test(m.relevance.label) && m.skills.unknown.length === 6 && m.skills.missing.length === 0);
  m = matching.match({ ...JOB, skills: [] }, matching.profileOf({ content: person({ skills: ["React"] }) }));
  check("a job with no listed skills: insufficient information, no number", m.relevance.score === null && /job lists no skills/.test(m.relevance.label));
  const exp = (periods) => matching.experienceMonths(periods, new Date("2026-11-01T00:00:00Z"));
  check("experience: overlapping jobs counted once; a missing date → unknown", exp([{ start: "2020-01", end: "2022-01" }, { start: "2021-01", end: "2023-01" }]) === 36 && exp([{ start: "2020-01", end: "" }]) === null);
  m = matching.match({ ...JOB, minExperience: 2 }, matching.profileOf({ content: person({ skills: ["React"], style: "fresher" }) }));
  check("a fresher on a 2-year job: experience 'not met' as a criterion, and the estimate is unchanged by it", m.mandatory.find((x) => /2 years/.test(x.criterion)).status === "not_met" && m.relevance.score === score(person({ skills: ["React"] })).relevance.score);
  m = matching.match({ ...JOB, minExperience: 2 }, matching.profileOf({ content: blank() }), { statedYears: 3 });
  check("no work history in the resume but 3 years stated in the application: met, and it says where it came from", /stated in the application/.test(m.mandatory[0].evidence) && m.mandatory[0].status === "met");
  check("degree levels: BS → bachelor's, MBA → master's, FSc → high school, an unclear one → unknown", matching.degreeLevel({ degree: "BS", field: "CS" }) === 3 && matching.degreeLevel({ degree: "MBA", field: "" }) === 4 && matching.degreeLevel({ degree: "FSc", field: "Pre-Engineering" }) === 1 && matching.degreeLevel({ degree: "Certificate", field: "Cooking" }) === null);
  const inProgress = person({ skills: ["React"] });
  inProgress.education[0].current = true;
  check("a bachelor's still in progress: 'unknown', not 'not met'", score(inProgress).mandatory[0].status === "unknown");

  console.log("-- fairness: identical skills give identical results");
  const base = { skills: ["JavaScript", "React", "MongoDB"] };
  const variants = [
    ["name (and so gender)", { name: "Ahmed Raza" }], ["name", { name: "Zainab Bibi" }],
    ["city", { city: "Quetta" }], ["city", { city: "Gilgit" }],
    ["university", { university: "Virtual University" }], ["university", { university: "LUMS" }],
    ["age (graduated 2010)", { gradYear: 2010 }], ["photo", { photo: "https://example.com/p.jpg" }],
    ["a university named after a skill", { university: "Git React Institute of TypeScript" }], ["a city named like a skill", { city: "Java" }],
  ];
  const ref = score(person(base));
  let identityOk = true;
  for (const [what, v] of variants) {
    const x = score(person({ ...base, ...v }));
    const sameOut = x.relevance.score === ref.relevance.score && evidenceKey(x) === evidenceKey(ref) && JSON.stringify(x.mandatory.map((c) => c.status)) === JSON.stringify(ref.mandatory.map((c) => c.status));
    identityOk = identityOk && sameOut;
    report.push({ group: `different ${what}`, score: x.relevance.score, reference: ref.relevance.score, same: sameOut });
  }
  check("name, gender, city, university, age and photo never change the estimate, the evidence or the criteria (10 variants)", identityOk, JSON.stringify(report.filter((r) => !r.same)));
  const pIds = matching.profileOf({ content: person({ ...base, name: "Ahmed Raza", city: "Quetta", university: "LUMS" }) });
  check("…they aren't even in what the matcher reads (no name, city, university, e-mail or phone in its input)", !/Ahmed|Raza|Quetta|LUMS|example\.com|\+92/.test(JSON.stringify(pIds)));
  const fresher = score(person({ ...base, style: "fresher" })), experienced = score(person({ ...base, style: "experienced" }));
  const fe = fresher.relevance.score === experienced.relevance.score && evidenceKey(fresher) === evidenceKey(experienced);
  report.push({ group: "fresher (projects) vs experienced (5 years' work), same skills", score: fresher.relevance.score, reference: experienced.relevance.score, same: fe });
  check("fresher vs experienced with the same skills: the same estimate and evidence", fe, `${fresher.relevance.score} vs ${experienced.relevance.score}`);
  const sp = score(person({ ...base, detail: "sparse" })), full = score(person({ ...base, detail: "full" }));
  const sf = sp.relevance.score === full.relevance.score && evidenceKey(sp) === evidenceKey(full);
  report.push({ group: "sparse (skills list only) vs full profile, same skills", score: sp.relevance.score, reference: full.relevance.score, same: sf });
  check("a sparse profile vs a full one with the same skills: the same estimate", sf, `${sp.relevance.score} vs ${full.relevance.score}`);

  // the cohort: 60 random skill sets, each written 16 ways (fresher/experienced x sparse/full x 4 cities and universities)
  const CITIES = [["Karachi", "NED University"], ["Lahore", "UET Lahore"], ["Quetta", "BUITEMS"], ["Gilgit", "Karakoram International University"]];
  const groups = {};
  let pairsOk = true, pairs = 0;
  for (let i = 0; i < 60; i++) {
    const pool = ["JavaScript", "React", "Node.js", "MongoDB", "TypeScript", "Git", "Python", "Excel", "Figma"];
    const skills = pool.filter(() => rand() < 0.45);
    const outs = [];
    for (const style of ["fresher", "experienced"]) for (const detail of ["sparse", "full"]) for (const [city, university] of CITIES) {
      const s = score(person({ skills, style, detail, city, university, name: i % 2 ? "Bilal Ahmed" : "Sana Iqbal" })).relevance.score;
      outs.push(s);
      for (const g of [style, detail, city]) (groups[g] = groups[g] || []).push(s);
    }
    pairs += 1;
    if (new Set(outs.map(String)).size !== 1) pairsOk = false;
  }
  const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const means = Object.fromEntries(Object.entries(groups).map(([g, xs]) => [g, mean(xs)]));
  check(`cohort: ${pairs} skill sets x 16 ways each (fresher/experienced, sparse/full, 4 cities and universities): every way scores the same`, pairsOk);
  check("…so freshers aren't pushed down: the mean estimate is the same for freshers and experienced, sparse and full, and every city", means.fresher === means.experienced && means.sparse === means.full && new Set(CITIES.map(([c]) => means[c])).size === 1, JSON.stringify(means));

  console.log("-- routes, snapshots and recomputation");
  const ids = { E: oid(), E2: oid(), A: oid(), S1: oid(), S2: oid(), S3: oid() };
  const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, role, status: "active", createdAt: new Date() });
  fake.seed(coll("User"), [user(ids.E, "employee", "hireco"), user(ids.E2, "employee", "otherco"), user(ids.A, "admin", "admin"), user(ids.S1, "student", "s1"), user(ids.S2, "student", "s2"), user(ids.S3, "student", "s3")]);
  const J = oid();
  fake.seed(coll("Job"), [{ _id: J, ...JOB, department: "Eng", location: "Karachi", type: "Full-time", salary: "x", email: "j@test.local", description: "d", postedBy: ids.E, isExternal: false, active: true }]);
  const A1 = oid(), A2 = oid(), A3 = oid();
  const t = (h) => new Date(Date.now() - h * 3600e3);
  fake.seed(coll("JobApplication"), [
    { _id: A1, jobId: J, userId: ids.S1, fullName: "s1", email: "s1@test.local", phone: "0300", status: "pending", appliedAt: t(30) },
    { _id: A2, jobId: J, userId: ids.S2, fullName: "s2", email: "s2@test.local", phone: "0300", status: "pending", appliedAt: t(20) },
    { _id: A3, jobId: J, userId: ids.S3, fullName: "s3", email: "s3@test.local", phone: "0300", status: "pending", appliedAt: t(10) },
  ]);
  const R1 = oid(), R2 = oid();
  fake.seed(coll("Resume"), [{ _id: R1, user: ids.S1, ...person({ skills: ["JavaScript", "React", "Node.js", "MongoDB"] }), updatedAt: t(40) }, { _id: R2, user: ids.S2, ...person({ skills: ["Git"] }), updatedAt: t(40) }]);
  const T = { E: token(ids.E, "employee"), E2: token(ids.E2, "employee"), A: token(ids.A, "admin"), S1: token(ids.S1, "student") };
  let r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  check("flag off: 404 MATCHING_OFF (nothing computed, nothing stored)", r.status === 404 && r.json?.error?.code === "MATCHING_OFF" && rows("CareerMatchSnapshot").length === 0, r.text);
  process.env.FLAG_CAREER_MATCHING = `ids:${ids.E},${ids.S1},${ids.S2}`;
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  const d = r.json?.data;
  check("the job's employer: mandatory criteria + matched / missing / unknown with resume text, model version, time, and a decision-support note", r.status === 200 && d.mandatory.length >= 1 && d.skills.matched.length === 4 && d.skills.missing.map((s) => s.skill).join() === "TypeScript,Git" && d.relevance.score === 67 && d.modelVersion === "skill-evidence-1" && d.computedAt && /not a hiring prediction/.test(d.note) && d.source === "resume", r.text.slice(0, 300));
  const snap = rows("CareerMatchSnapshot", (s) => same(s.application, A1));
  check("…logged as a snapshot: model version, both fingerprints, evidence summary, timestamp", snap.length === 1 && snap[0].modelVersion && snap[0].jobFingerprint && snap[0].profileFingerprint && /4 matched, 2 missing/.test(snap[0].evidenceSummary) && snap[0].computedAt);
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  check("reading it again reuses the snapshot (nothing changed: no new computation)", r.status === 200 && rows("CareerMatchSnapshot", (s) => same(s.application, A1)).length === 1);
  const res1 = rows("Resume", (x) => same(x._id, R1))[0];
  res1.skills.push({ name: "TypeScript", category: "" });
  res1.updatedAt = new Date();
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  check("the candidate adds TypeScript to their skills → recomputed: TypeScript now matched, a second snapshot (the first kept)", r.json.data.skills.matched.some((s) => s.skill === "TypeScript") && r.json.data.relevance.score === 83 && rows("CareerMatchSnapshot", (s) => same(s.application, A1)).length === 2);
  res1.personalInfo.firstName = "Renamed";
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  check("…changing only their name doesn't recompute (it isn't an input)", rows("CareerMatchSnapshot", (s) => same(s.application, A1)).length === 2);
  rows("Job", (j) => same(j._id, J))[0].skills.push("Docker");
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E });
  check("the employer edits the job (adds Docker) → recomputed with Docker missing", r.json.data.skills.missing.some((s) => s.skill === "Docker") && rows("CareerMatchSnapshot", (s) => same(s.application, A1)).length === 3);
  const V = oid();
  fake.seed(coll("CareerResumeApprovedVersion"), [{ _id: V, userId: ids.S2, sourceResumeId: R2, draftId: oid(), contentSnapshot: person({ skills: ["Git", "React", "Docker"] }), contentHash: "hv", rendererVersion: "1" }]);
  fake.seed(coll("CareerApplicationResumeAttachment"), [{ _id: oid(), applicationId: A2, jobId: J, userId: ids.S2, versionId: V, contentHash: "hv", retainUntil: new Date(Date.now() + 1e10) }]);
  r = await call("GET", `/api/career/matching/applications/${A2}`, { tok: T.E });
  check("an application sent with an approved tailored resume is matched against that version", r.json.data.source === "tailored_version" && r.json.data.skills.matched.map((s) => s.skill).sort().join() === "Docker,Git,React");

  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.E2 });
  const rs = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.S1 });
  check("another employer → 404; the student → 404 (employer-side only)", r.status === 404 && rs.status === 404, `${r.status} ${rs.status}`);
  const audits = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("GET", `/api/career/matching/applications/${A1}`, { tok: T.A });
  check("an admin can read it; the read is audited", r.status === 200 && rows("DomainEvent", (e) => e.type === "career.admin.access").length === audits + 1);
  r = await call("GET", `/api/career/matching/applications/${A3}`, { tok: T.E });
  check("a candidate outside the pilot: 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");

  const statusesBefore = rows("JobApplication").map((a) => a.status).join();
  r = await call("GET", `/api/career/matching/jobs/${J}`, { tok: T.E });
  check("the job list, default order: newest first, every application listed (outside the pilot with match: null)", r.status === 200 && r.json.data.sort === "newest" && r.json.data.applications.map((a) => a.applicationId).join() === [A3, A2, A1].map(String).join() && r.json.data.applications[0].match === null, r.text.slice(0, 300));
  r = await call("GET", `/api/career/matching/jobs/${J}?sort=relevance`, { tok: T.E });
  const order = r.json.data.applications.map((a) => a.applicationId);
  check("?sort=relevance: highest estimate first, no-match last, still all three (none hidden)", order.length === 3 && order[0] === String(A1) && order[2] === String(A3), JSON.stringify(r.json.data.applications.map((a) => a.match?.score)));
  // match quality per job: bands from the estimate, counted in a summary
  const qm = reqS("./services/career/matchingService");
  check("quality bands: 70+ strong, 40-69 medium, under 40 weak, no estimate insufficient", qm.qualityOf(100) === "strong" && qm.qualityOf(70) === "strong" && qm.qualityOf(69) === "medium" && qm.qualityOf(40) === "medium" && qm.qualityOf(39) === "weak" && qm.qualityOf(0) === "weak" && qm.qualityOf(null) === "insufficient");
  const sum = r.json.data.summary;
  const apps = r.json.data.applications;
  const counted = (band) => apps.filter((a) => a.match && a.match.quality === band).length;
  check("the reply's summary counts each band from the rows, applicants outside the pilot apart, total = all applications", sum && sum.total === apps.length && sum.outsidePilot === apps.filter((a) => !a.match).length && ["strong", "medium", "weak", "insufficient"].every((b) => sum[b] === counted(b)) && sum.strong + sum.medium + sum.weak + sum.insufficient + sum.outsidePilot === sum.total && sum.thresholds.strong === 70 && sum.thresholds.medium === 40, JSON.stringify(sum));
  check("each match row carries its band, the same as its score's", apps.filter((a) => a.match).every((a) => a.match.quality === qm.qualityOf(a.match.score)));
  check("the summary says it's an estimate, not a judgment", /estimate/i.test(sum?.note || "") && /not a judgment/i.test(sum?.note || ""));
  check("matching never changes an application (no status written, nothing rejected)", rows("JobApplication").map((a) => a.status).join() === statusesBefore);
  r = await call("GET", `/api/career/matching/jobs/${J}`, { tok: T.E2 });
  check("another employer can't list this job (404)", r.status === 404);
  check("no 'probability', 'chance' or 'likely to be hired' anywhere in the replies", !/probab|chance|likely to be hired|hire rate/i.test(responses.map((x) => x.text).join(" ")));
  check("no e-mail or phone of a candidate in any reply", !/@test\.local|@example\.com|\+92 300/.test(responses.map((x) => x.text).join(" ")));
  check("no 500s", !responses.some((x) => x.status >= 500));

  // deleting a student's account removes their match evidence
  const retention = reqS("./services/career/retentionService");
  const del = async (M, f) => (await M.deleteMany(f)).deletedCount;
  const upd = async (M, f, u) => (await M.updateMany(f, u)).modifiedCount;
  await retention.forDeletedStudent({ id: ids.S1, ghost: oid(), upd, del });
  check("account deletion: the student's match snapshots are deleted", rows("CareerMatchSnapshot", (s) => same(s.candidate, ids.S1)).length === 0 && rows("CareerMatchSnapshot", (s) => same(s.candidate, ids.S2)).length === 1);

  if (process.env.FAIRNESS_REPORT) {
    const lines = report.map((x) => `| ${x.group} | ${x.score} | ${x.reference} | ${x.same ? "yes" : "**NO**"} |`);
    const g = (k) => `${means[k]}`;
    require("fs").writeFileSync(process.env.FAIRNESS_REPORT, JSON.stringify({ lines, means, pairs, pairsOk, cities: CITIES.map(([c]) => [c, g(c)]) }, null, 1));
  }
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
