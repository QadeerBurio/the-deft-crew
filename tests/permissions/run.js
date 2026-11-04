// Permission matrix (Sprint 7): every route added in Sprints 2-6 (loyalty, career timeline, Resume Studio,
// Surprise Box, First Hire Free, analytics) x every role: guest, student (owner), other student, brand (owner),
// other brand, employer (owner), other employer, admin. Fixtures are made through the real routes by their
// owners; denied roles are tried first. Allowed = 2xx or a business answer (400/409/422/429/503);
// denied = 401/403/404. All flags on for every test account (this checks permissions, not flags).
//   node tests/permissions/run.js [serverDir]        PM_TABLE=<file> writes the markdown table
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];
// models added by later commits of this sprint (loaded when present)
const OPTIONAL_MODELS = ["CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox"];

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
// ---------- aggregate interpreter (copied from tests/perf-server) ----------
// ---------- aggregate interpreter: $match, $unwind, $group ($push, $sum incl. $cond) ----------
const isOid = (v) => v != null && typeof v === "object" && v._bsontype === "ObjectId";
const norm = (v) => (isOid(v) ? String(v) : v instanceof Date ? v.getTime() : v);
const at = (doc, p) => p.split(".").reduce((o, k) => (o == null ? undefined : Array.isArray(o) ? o.map((x) => x?.[k]) : o[k]), doc);
const condOk = (val, cond) => {
  const vals = (Array.isArray(val) ? val.flat() : [val]).map(norm);
  if (cond && typeof cond === "object" && !isOid(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$gt") return vals.some((v) => v > norm(arg));
      if (op === "$ne") return !vals.includes(norm(arg));
      if (op === "$regex") return vals.some((v) => new RegExp(arg).test(v));
      throw new Error(`aggregate test: unsupported ${op}`);
    });
  }
  return vals.includes(norm(cond));
};
const evalExpr = (e, doc) => {
  if (typeof e === "string" && e.startsWith("$")) return at(doc, e.slice(1));
  if (e == null || typeof e !== "object" || isOid(e)) return e;
  if ("$cond" in e) return evalExpr(e.$cond[0], doc) ? evalExpr(e.$cond[1], doc) : evalExpr(e.$cond[2], doc);
  if ("$eq" in e) return norm(evalExpr(e.$eq[0], doc)) === norm(evalExpr(e.$eq[1], doc));
  if ("$ifNull" in e) { const v = evalExpr(e.$ifNull[0], doc); return v == null ? evalExpr(e.$ifNull[1], doc) : v; }
  if ("$substrCP" in e) { const [s, i, n] = e.$substrCP.map((x) => evalExpr(x, doc)); return String(s ?? "").substr(i, n); }
  const out = {}; for (const [k, v] of Object.entries(e)) out[k] = evalExpr(v, doc); return out;
};
const P = Object.getPrototypeOf(mongoose.connection.collection("__agg_probe"));
const aggCalls = [];
P.aggregate = function (pipeline) {
  aggCalls.push({ coll: this.collectionName || this.name, pipeline });
  let docs = (fake.STORE.get(this.collectionName || this.name) || []).map((d) => d);
  for (const stage of pipeline) {
    const [[op, arg]] = Object.entries(stage);
    if (op === "$match") docs = docs.filter((d) => Object.entries(arg).every(([k, c]) => condOk(at(d, k), c)));
    else if (op === "$unwind") { const f = arg.slice(1); docs = docs.flatMap((d) => (d[f] || []).map((x) => ({ ...d, [f]: x }))); }
    else if (op === "$group") {
      const groups = new Map();
      for (const d of docs) {
        const key = arg._id == null ? null : evalExpr(arg._id, d);
        const k = String(norm(key));
        if (!groups.has(k)) groups.set(k, { _id: key, _docs: [] });
        groups.get(k)._docs.push(d);
      }
      docs = [...groups.values()].map(({ _id, _docs }) => {
        const g = { _id };
        for (const [field, acc] of Object.entries(arg)) {
          if (field === "_id") continue;
          if (acc.$push) g[field] = _docs.map((d) => evalExpr(acc.$push, d));
          else if ("$sum" in acc) g[field] = _docs.reduce((s, d) => s + (Number(evalExpr(acc.$sum, d)) || 0), 0);
          else throw new Error("aggregate test: unsupported accumulator");
        }
        return g;
      });
    } else throw new Error(`aggregate test: unsupported stage ${op}`);
  }
  const c = { toArray: async () => docs, async *[Symbol.asyncIterator]() { for (const d of docs) yield d; }, close: async () => {} };
  for (const m of ["sort", "limit", "skip", "project", "batchSize", "maxTimeMS", "collation", "hint", "comment", "allowDiskUse"]) c[m] = () => c;
  return c;
};

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "JobInteraction", "Notification", "DomainEvent", "EngagementProfile", "PointsLedger", "RedemptionGuard", "PushLog", "Offer", "Branch", "PromoCode",
  "LoyaltyProgram", "LoyaltyLedger", "CareerApplicationEvent", "CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox", "Resume",
  "CareerResumeTailorJob", "CareerResumeDraft", "CareerResumeApprovedVersion", "CareerApplicationResumeAttachment", "CareerResumeSourceConfirmation",
  "SurplusListing", "SurplusInventoryHold", "SurplusOrder", "SurplusSupportCase", "SurplusNotificationOutbox", "SurplusBrandBlock",
  "EmployerCompanyVerification", "EmployerHiringTrial", "EmployerHiringBillingEvent", "CareerAdminAudit"]) reqS(`./models/${m}`);
reqS("./services/resumeStudio/ai").setCaller(async () => JSON.stringify({ suggestions: [] }));
reqS("./services/surplus/notifications").providers.push = async () => ({ status: "sent" });
process.env.SURPLUS_CODE_SECRET = "test-only-surplus-code-secret-0123456789abcdef";

const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/jobs", reqS("./routes/jobs.routes"));
app.use("/api/loyalty", reqS("./routes/loyalty.routes"));
app.use("/api/career/resume", reqS("./routes/careerResume.routes"));
app.use("/api/career", reqS("./routes/careerTrial.routes"));
app.use("/api/career", reqS("./routes/career.routes"));
app.use("/api/surplus", reqS("./routes/surplus.routes"));
app.use("/api/analytics", reqS("./routes/analytics.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["S", "S2", "B", "B2", "E", "E2", "A", "BR", "BR2", "J1", "J2", "J3", "J4", "R1", "R2"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.S, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.B, "brand", "alpha", { brandName: "Alpha" }), user(ids.B2, "brand", "beta", { brandName: "Beta" }),
  user(ids.E, "employee", "hireco", { email: "hr@hireco.pk" }), user(ids.E2, "employee", "otherco", { email: "hr@otherco.pk" }), user(ids.A, "admin", "admin"),
]);
fake.seed(coll("Branch"), [
  { _id: ids.BR, brand: ids.B, name: "Alpha Clifton", location: "Clifton", city: "Karachi", isActive: true, createdAt: new Date() },
  { _id: ids.BR2, brand: ids.B2, name: "Beta Gulshan", location: "Gulshan", city: "Karachi", isActive: true, createdAt: new Date() },
]);
const job = (id, by, title) => ({ _id: id, title, department: "Engineering", location: "Karachi", type: "Full-time", salaryRange: "100k", contactEmail: "jobs@test.local", description: "Build web apps with React and Node.js. Requirements: JavaScript, React.", requirements: ["React"], skills: ["JavaScript"], companyName: "Hire Co", postedBy: by, isExternal: false, active: true, archivedAt: null, createdAt: new Date() });
fake.seed(coll("Job"), [job(ids.J1, ids.E, "Frontend dev"), job(ids.J2, ids.E2, "Designer"), job(ids.J3, ids.E, "Backend dev"), job(ids.J4, ids.E, "QA engineer")]);
const resume = (id, owner) => ({ _id: id, user: owner, title: "My resume", createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-10-01"), personalInfo: { firstName: "Sana", lastName: "Khan" }, professionalSummary: { summary: "Student who builds web apps with React." }, workExperience: [], education: [{ institution: "NED", degree: "BS", fieldOfStudy: "CS", startDate: new Date("2022-09-01"), endDate: new Date("2026-06-30") }], projects: [{ name: "Campus Eats", description: "A React web app.", technologies: ["React"] }], skills: [{ name: "JavaScript" }, { name: "React" }], certifications: [], languages: [] });
fake.seed(coll("Resume"), [resume(ids.R1, ids.S), resume(ids.R2, ids.S2)]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
const T = { G: null, S: token(ids.S, "student"), S2: token(ids.S2, "student"), B: token(ids.B, "brand"), B2: token(ids.B2, "brand"), E: token(ids.E, "employee"), E2: token(ids.E2, "employee"), A: token(ids.A, "admin") };
const ROLES = ["G", "S", "S2", "B", "B2", "E", "E2", "A"];
const ROLE_NAME = { G: "guest", S: "student (owner)", S2: "other student", B: "brand (owner)", B2: "other brand", E: "employer (owner)", E2: "other employer", A: "admin" };

let PORT;
function call(method, url, { body, tok } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
let kn = 0;
const key = () => `pm-${++kn}-${Date.now()}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); if (!ok || process.env.PM_VERBOSE) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const all = Object.values(ids).map(String).join(",");
  for (const f of ["LOYALTY_V2", "CAREER_TIMELINE", "RESUME_STUDIO_V2", "SURPLUS_BOXES", "EMPLOYER_FIRST_HIRE_FREE"]) process.env[`FLAG_${f}`] = `ids:${all}`;
  const fx = {};
  const must = (label, r, ok = [200, 201, 202]) => { if (!ok.includes(r.status)) { console.log(`SETUP FAILED: ${label} -> ${r.status} ${r.text.slice(0, 200)}`); process.exit(2); } return r.json?.data ?? r.json; };
  const ver = async (appId, tok) => (await call("GET", `/api/career/applications/${appId}/timeline`, { tok })).json.data.version;

  // ---------- fixtures, made through the real routes by their owners ----------
  let r = must("loyalty program", await call("POST", "/api/loyalty/programs", { tok: T.B, body: {} }), [200, 201]);
  fx.P = r.id || r.program?.id;
  must("program active", await call("PATCH", `/api/loyalty/programs/${fx.P}`, { tok: T.B, body: { status: "active" } }));
  const apply = async (jobId, who) => { await call("POST", `/api/jobs/apply/${jobId}`, { tok: T[who], body: { fullName: "Full Name", email: "x@test.local", phone: "03001234567", coverLetter: "hello" } }); return rows("JobApplication", (a) => same(a.jobId, jobId) && same(a.userId, ids[who]))[0]._id; };
  fx.A1 = await apply(ids.J1, "S"); fx.A3 = await apply(ids.J3, "S"); fx.A4 = await apply(ids.J4, "S"); fx.A2 = await apply(ids.J2, "S2");
  for (const a of [fx.A1, fx.A3, fx.A4]) must("shortlist", await call("POST", `/api/career/applications/${a}/events`, { tok: T.E, body: { type: "SHORTLISTED", version: await ver(a, T.E) } }), [201]);
  must("interview", await call("POST", "/api/career/interviews", { tok: T.E, body: { applicationId: String(fx.A1), version: await ver(fx.A1, T.E), startsAt: inHours(48), durationMinutes: 45, timezone: "Asia/Karachi", mode: "online", meetingLink: "https://meet.example.test/x" } }), [201]);
  fx.I1 = rows("CareerInterview", (i) => same(i.application, fx.A1))[0]._id;
  must("offer", await call("POST", "/api/career/offers", { tok: T.E, body: { applicationId: String(fx.A3), version: await ver(fx.A3, T.E), title: "Backend dev", terms: "full time", expiresAt: inHours(24 * 7) } }), [201]);
  fx.O1 = rows("CareerOffer", (o) => same(o.application, fx.A3))[0]._id;
  must("offer 4", await call("POST", "/api/career/offers", { tok: T.E, body: { applicationId: String(fx.A4), version: await ver(fx.A4, T.E), title: "QA", terms: "full time", expiresAt: inHours(24 * 7) } }), [201]);
  const o4 = rows("CareerOffer", (o) => same(o.application, fx.A4))[0]._id;
  must("accept 4", await call("POST", `/api/career/offers/${o4}/respond`, { tok: T.S, body: { version: await ver(fx.A4, T.S), response: "accept" } }), [201]);
  must("hire 4", await call("POST", `/api/career/offers/${o4}/confirm-hire`, { tok: T.E, body: { version: await ver(fx.A4, T.E) } }), [201]);
  fx.OC = rows("CareerOutcome", (o) => same(o.application, fx.A4) && o.outcomeType === "hired")[0]._id;
  // resume studio
  const tj = must("tailor", await call("POST", "/api/career/resume/tailor-jobs", { tok: T.S, body: { resumeId: String(ids.R1), jobId: String(ids.J1), idempotencyKey: key() } }), [202]);
  fx.TJ = tj.id;
  for (let i = 0; i < 100 && rows("CareerResumeTailorJob", (j) => same(j._id, fx.TJ))[0].status !== "succeeded"; i++) await tick(10);
  fx.D1 = String(rows("CareerResumeTailorJob", (j) => same(j._id, fx.TJ))[0].draftId);
  const d1 = must("draft", await call("GET", `/api/career/resume/drafts/${fx.D1}`, { tok: T.S }));
  fx.V1 = must("approve", await call("POST", `/api/career/resume/drafts/${fx.D1}/approve`, { tok: T.S, body: { revision: d1.revision, confirmAccurate: true, confirmReviewed: true } }), [201]).version.id;
  must("attach", await call("POST", `/api/career/resume/applications/${fx.A1}/attach-version`, { tok: T.S, body: { versionId: fx.V1 } }), [201]);
  const tj2 = must("tailor 2", await call("POST", "/api/career/resume/tailor-jobs", { tok: T.S, body: { resumeId: String(ids.R1), jobId: String(ids.J3), idempotencyKey: key() } }), [202]);
  for (let i = 0; i < 100 && rows("CareerResumeTailorJob", (j) => same(j._id, tj2.id))[0].status !== "succeeded"; i++) await tick(10);
  fx.D2 = String(rows("CareerResumeTailorJob", (j) => same(j._id, tj2.id))[0].draftId);
  const d2 = must("draft 2", await call("GET", `/api/career/resume/drafts/${fx.D2}`, { tok: T.S }));
  fx.V2 = must("approve 2", await call("POST", `/api/career/resume/drafts/${fx.D2}/approve`, { tok: T.S, body: { revision: d2.revision, confirmAccurate: true, confirmReviewed: true } }), [201]).version.id;
  const tj3 = must("tailor 3", await call("POST", "/api/career/resume/tailor-jobs", { tok: T.S, body: { resumeId: String(ids.R1), jobId: String(ids.J4), idempotencyKey: key() } }), [202]);
  for (let i = 0; i < 100 && rows("CareerResumeTailorJob", (j) => same(j._id, tj3.id))[0].status !== "succeeded"; i++) await tick(10);
  fx.D3 = String(rows("CareerResumeTailorJob", (j) => same(j._id, tj3.id))[0].draftId);
  // surplus
  const lb = (extra = {}) => ({ branchId: String(ids.BR), title: "Bakery box", allergenNotes: "contains gluten", quantityTotal: 10, listPrice: 1000, price: 400, pickupStart: inHours(3), pickupEnd: inHours(4), status: "published", ...extra });
  fx.L1 = must("listing", await call("POST", "/api/surplus/merchant/listings", { tok: T.B, body: lb() }), [201]).id;
  fx.L2 = must("listing 2", await call("POST", "/api/surplus/merchant/listings", { tok: T.B, body: lb({ title: "Lunch box" }) }), [201]).id;
  const h1 = must("hold", await call("POST", "/api/surplus/holds", { tok: T.S, body: { listingId: fx.L1, qty: 1, idempotencyKey: key() } }), [201]).hold;
  const o1 = must("order", await call("POST", "/api/surplus/orders", { tok: T.S, body: { holdId: h1.id, idempotencyKey: key(), acceptedTerms: true } }), [201]);
  fx.SO1 = o1.id; fx.CODE = o1.pickup.code;
  fx.H2 = must("hold 2 (S2)", await call("POST", "/api/surplus/holds", { tok: T.S2, body: { listingId: fx.L2, qty: 1, idempotencyKey: key() } }), [201]).hold.id;
  const h3 = must("hold 3 (S2)", await call("POST", "/api/surplus/holds", { tok: T.S2, body: { listingId: fx.L1, qty: 1, idempotencyKey: key() } }), [201]).hold;
  await call("DELETE", `/api/surplus/holds/${fx.H2}`, { tok: T.S2 });
  const o3 = must("order 3 (S2)", await call("POST", "/api/surplus/orders", { tok: T.S2, body: { holdId: h3.id, idempotencyKey: key(), acceptedTerms: true } }), [201]);
  rows("SurplusOrder", (o) => same(o._id, o3.id))[0].pickupStart = new Date(Date.now() - 10 * 60e3);
  must("verify 3", await call("POST", "/api/surplus/merchant/verify-pickup", { tok: T.B, body: { code: o3.pickup.code, branchId: String(ids.BR), markPaid: true } }));
  fx.C1 = must("case", await call("POST", "/api/surplus/support-cases", { tok: T.S2, body: { orderId: o3.id, reason: "other", description: "x" } }), [201]).id;
  fx.L3 = must("listing 3 (B2)", await call("POST", "/api/surplus/merchant/listings", { tok: T.B2, body: lb({ branchId: String(ids.BR2), title: "Beta box" }) }), [201]).id;
  fx.H4 = must("hold 4 (S, other brand)", await call("POST", "/api/surplus/holds", { tok: T.S, body: { listingId: fx.L3, qty: 1, idempotencyKey: key() } }), [201]).hold.id;
  // first hire free
  must("verification", await call("POST", "/api/career/employers/me/verification", { tok: T.E, body: { companyName: "Hire Co", registrationType: "ntn", ntnOrSecp: "1234567-8", businessEmailDomain: "hireco.pk", website: "hireco.pk" } }), [201]);
  fx.CV = String(rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E))[0]._id);
  must("approve company", await call("POST", `/api/career/admin/verifications/${fx.CV}/review`, { tok: T.A, body: { action: "approve", reason: "NTN checked" } }));
  must("activate", await call("POST", "/api/career/employers/me/trial/activate", { tok: T.E }), [201]);
  fx.TR = String(rows("EmployerHiringTrial")[0]._id);
  fx.redemption = String(oid());

  // ---------- the matrix: [method, path, body, allowed roles, note] ----------
  const V = (app) => async () => ver(app, T.E); // the current version (the same for every viewer)
  const ANY_STUDENT = ["S", "S2"], ANY_BRAND = ["B", "B2"], ANY_EMPLOYER = ["E", "E2"];
  const L = "/api/loyalty", C = "/api/career", RS = "/api/career/resume", SP = "/api/surplus", AN = "/api/analytics";
  const M = [
    // loyalty
    ["GET", `${L}/brands/me/analytics`, null, ANY_BRAND, "own figures"],
    ["GET", `${L}/brands/${ids.B}/program`, null, [...ROLES], "public program view (read-only)"],
    ["GET", `${L}/brands/${ids.B}/me`, null, ANY_STUDENT, "own progress"],
    ["GET", `${L}/me/credits`, null, ANY_STUDENT, "own ledger"],
    ["GET", `${L}/programs/mine`, null, ANY_BRAND, "own program"],
    ["POST", `${L}/programs`, {}, ANY_BRAND, "own program only"],
    ["PATCH", `${L}/programs/${fx.P}`, { maxVisitsPerDay: 1 }, ["B", "A"], "owner or admin"],
    ["POST", `${L}/quotes`, { studentId: String(ids.S), offerId: String(oid()) }, ANY_BRAND, "own offers only (unknown offer -> 404)", { allow404: true }],
    ["GET", `${L}/admin/ledger`, null, ["A"]],
    ["POST", `${L}/admin/reverse`, { redemptionId: fx.redemption, reason: "test" }, ["A"], "", { allow404: true }],
    // career timeline
    ["GET", `${C}/applications/me`, null, ANY_STUDENT, "own applications"],
    ["GET", `${C}/applications/${fx.A1}/timeline`, null, ["S", "E", "A"], "candidate, job's employer, admin"],
    ["POST", `${C}/applications/${fx.A1}/events`, async () => ({ type: "REVIEWED", version: await V(fx.A1)() }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["GET", `${C}/employers/me/applications`, null, [...ANY_EMPLOYER, "A"], "own jobs' applicants"],
    ["POST", `${C}/interviews`, async () => ({ applicationId: String(fx.A3), version: await V(fx.A3)(), startsAt: inHours(72), durationMinutes: 30, timezone: "Asia/Karachi", mode: "phone" }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["GET", `${C}/interviews/${fx.I1}`, null, ["S", "E", "A"]],
    ["GET", `${C}/interviews/${fx.I1}/ics`, null, ["S", "E", "A"]],
    ["POST", `${C}/interviews/${fx.I1}/respond`, async () => ({ version: await V(fx.A1)(), response: "accept" }), ["S"], "candidate"],
    ["POST", `${C}/interviews/${fx.I1}/reschedule`, async () => ({ version: await V(fx.A1)(), startsAt: inHours(96), durationMinutes: 30, timezone: "Asia/Karachi", mode: "phone" }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["POST", `${C}/interviews/${fx.I1}/complete`, async () => ({ version: await V(fx.A1)() }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["POST", `${C}/interviews/${fx.I1}/cancel`, async () => ({ version: await V(fx.A1)() }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["POST", `${C}/offers`, async () => ({ applicationId: String(fx.A1), version: await V(fx.A1)(), title: "x", terms: "y", expiresAt: inHours(48) }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["GET", `${C}/offers/${fx.O1}`, null, ["S", "E", "A"]],
    ["POST", `${C}/offers/${fx.O1}/respond`, async () => ({ version: await V(fx.A3)(), response: "accept" }), ["S"]],
    ["POST", `${C}/offers/${fx.O1}/withdraw`, async () => ({ version: await V(fx.A3)() }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["POST", `${C}/offers/${fx.O1}/confirm-hire`, async () => ({ version: await V(fx.A3)() }), ["E", "A"], "job's employer, or an admin acting for them (audited)"],
    ["GET", `${C}/outcomes/me`, null, ANY_STUDENT],
    ["PATCH", `${C}/outcomes/${fx.OC}`, { visibility: "private" }, ["S"], "own outcome"],
    ["GET", `${C}/employers/me/analytics`, null, [...ANY_EMPLOYER, "A"]],
    ["GET", `${C}/admin/analytics`, null, ["A"]],
    ["POST", `${C}/admin/outbox/drain`, {}, ["A"]],
    // resume studio
    ["GET", `${RS}/sources/${ids.R1}`, null, ["S"], "own resume"],
    ["POST", `${RS}/sources/${ids.R1}/confirm`, { revisionHash: "x" }, ["S"]],
    ["POST", `${RS}/tailor-jobs`, { resumeId: String(ids.R1), jobId: String(ids.J1), idempotencyKey: "pm-matrix-tailor-key" }, ["S"], "own resume"],
    ["GET", `${RS}/tailor-jobs/${fx.TJ}`, null, ["S"]],
    ["GET", `${RS}/drafts/${fx.D3}`, null, ["S"]],
    ["PATCH", `${RS}/drafts/${fx.D3}/decisions`, { revision: 999, decisions: [{ suggestionId: "s1", decision: "accepted" }] }, ["S"]],
    ["GET", `${RS}/drafts/${fx.D3}/preview.pdf`, null, ["S"]],
    ["POST", `${RS}/drafts/${fx.D3}/approve`, { revision: 999 }, ["S"]],
    ["GET", `${RS}/versions`, null, ANY_STUDENT, "own versions"],
    ["GET", `${RS}/versions/${fx.V1}`, null, ["S"]],
    ["GET", `${RS}/versions/${fx.V1}/export.pdf`, null, ["S"]],
    ["POST", `${RS}/applications/${fx.A1}/attach-version`, { versionId: fx.V1 }, ["S"], "own application + own version"],
    ["GET", `${RS}/applications/${fx.A1}/resume`, null, ["S", "E"], "candidate + job's employer only (not admin)"],
    ["GET", `${RS}/applications/${fx.A1}/resume.pdf`, null, ["S", "E"]],
    ["DELETE", `${RS}/versions/${fx.V2}`, null, ["S"], "own unused version"],
    ["DELETE", `${RS}/drafts/${fx.D3}`, null, ["S"]],
    // surplus
    ["GET", `${SP}/listings`, null, ANY_STUDENT],
    ["GET", `${SP}/listings/${fx.L1}`, null, ANY_STUDENT],
    ["POST", `${SP}/holds`, { listingId: fx.L2, qty: 1, idempotencyKey: "pm-matrix-hold-key" }, ANY_STUDENT, "a student holds for themself"],
    ["POST", `${SP}/orders`, { holdId: fx.H4, idempotencyKey: "pm-matrix-order-key", acceptedTerms: true }, ["S"], "own hold"],
    ["GET", `${SP}/orders/me`, null, ANY_STUDENT],
    ["GET", `${SP}/orders/${fx.SO1}`, null, ["S"], "own order"],
    ["POST", `${SP}/support-cases`, { orderId: fx.SO1, reason: "other" }, ["S"], "own order"],
    ["GET", `${SP}/support-cases/me`, null, ANY_STUDENT],
    ["GET", `${SP}/merchant/listings`, null, ANY_BRAND, "own listings"],
    ["POST", `${SP}/merchant/listings`, { branchId: String(ids.BR), title: "x", allergenNotes: "none known", quantityTotal: 1, listPrice: 10, price: 5, pickupStart: inHours(5), pickupEnd: inHours(6) }, ["B"], "own branch"],
    ["PATCH", `${SP}/merchant/listings/${fx.L2}`, { version: 999 }, ["B"], "own listing"],
    ["GET", `${SP}/merchant/orders`, null, ANY_BRAND, "own orders"],
    ["POST", `${SP}/merchant/orders/${fx.SO1}/transition`, { to: "CONFIRMED", version: 999 }, ["B"], "own order"],
    ["POST", `${SP}/merchant/orders/${fx.SO1}/verify-pickup`, { code: "AAAAAA", branchId: String(ids.BR) }, ["B"], "own order, own branch", { allow404: true }],
    ["POST", `${SP}/merchant/verify-pickup`, { code: fx.CODE, branchId: String(ids.BR), markPaid: false }, ["B"], "only the listing's brand at its branch"],
    ["GET", `${SP}/merchant/summary`, null, ANY_BRAND],
    ["GET", `${SP}/admin/orders`, null, ["A"]],
    ["GET", `${SP}/admin/no-shows`, null, ["A"]],
    ["GET", `${SP}/admin/cases`, null, ["A"]],
    ["POST", `${SP}/admin/cases/${fx.C1}/decide`, { decision: "no_action", note: "matrix" }, ["A"]],
    ["GET", `${SP}/admin/brands`, null, ["A"]],
    ["POST", `${SP}/admin/brands/${ids.B2}/block`, { blocked: false }, ["A"]],
    ["POST", `${SP}/orders/${fx.SO1}/cancel`, {}, ["S"], "own order"],
    ["DELETE", `${SP}/holds/${fx.H4}`, null, ["S"], "own hold"],
    // first hire free
    ["GET", `${C}/employers/me/trial`, null, ANY_EMPLOYER, "own company"],
    ["POST", `${C}/employers/me/verification`, { companyName: "x" }, ANY_EMPLOYER, "own company (invalid -> 400)"],
    ["POST", `${C}/employers/me/trial/activate`, {}, ANY_EMPLOYER, "own company's trial"],
    ["GET", `${C}/employers/me/trial/summary`, null, ANY_EMPLOYER],
    ["GET", `${C}/admin/verifications`, null, ["A"]],
    ["POST", `${C}/admin/verifications/${fx.CV}/review`, { action: "approve" }, ["A"], "reason required -> 400"],
    ["GET", `${C}/admin/trials`, null, ["A"]],
    ["POST", `${C}/admin/trials/${fx.TR}/review`, { action: "keep" }, ["A"], "reason required -> 400"],
    ["GET", `${C}/admin/billing-events`, null, ["A"]],
    ["GET", `${C}/admin/audit`, null, ["A"]],
    ["GET", `${C}/admin/employers/company-status`, null, ["A"]],
    // analytics
    ["GET", `${AN}/admin/overview`, null, ["A"]],
    ["GET", `${AN}/brands/me`, null, ANY_BRAND, "own figures"],
    ["GET", `${AN}/employers/me`, null, ANY_EMPLOYER, "own figures"],
  ];

  const ALLOWED_OK = (s) => (s >= 200 && s < 300) || [400, 409, 422, 429, 503].includes(s);
  const DENIED = [401, 403, 404];
  const table = [];
  for (const [method, path, body, allowed, note = "", opts = {}] of M) {
    const line = { method, path: path.replace(/[0-9a-f]{24}/g, ":id"), allowed, note, statuses: {} };
    const order = [...ROLES.filter((x) => !allowed.includes(x)), ...ROLES.filter((x) => allowed.includes(x))]; // denied roles first: an owner's write can't hide a leak
    for (const role of order) {
      const res = await call(method, path, { body: typeof body === "function" ? await body(role) : body, tok: T[role] });
      line.statuses[role] = res.status;
      const okAllowed = ALLOWED_OK(res.status) || (opts.allow404 && res.status === 404);
      if (allowed.includes(role)) check(`${method} ${line.path} as ${ROLE_NAME[role]}: allowed`, okAllowed, `${res.status} ${res.text.slice(0, 140)}`);
      else check(`${method} ${line.path} as ${ROLE_NAME[role]}: denied`, DENIED.includes(res.status), `${res.status} ${res.text.slice(0, 140)}`);
      if (res.status >= 500) check(`${method} ${line.path} as ${ROLE_NAME[role]}: no 500`, false, res.text.slice(0, 140));
    }
    table.push(line);
  }

  if (process.env.PM_TABLE) {
    const head = `| route | ${ROLES.map((r) => ROLE_NAME[r]).join(" | ")} |\n|---|${ROLES.map(() => "---").join("|")}|`;
    const cell = (l, r) => `${l.allowed.includes(r) ? "allow" : "deny"} ${l.statuses[r]}`;
    require("fs").writeFileSync(process.env.PM_TABLE, `${head}\n${table.map((l) => `| \`${l.method} ${l.path}\`${l.note ? ` (${l.note})` : ""} | ${ROLES.map((r) => cell(l, r)).join(" | ")} |`).join("\n")}\n`);
  }
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${M.length} routes x ${ROLES.length} roles: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
