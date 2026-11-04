// Hiring timeline (Sprint 3, FLAG_CAREER_TIMELINE): applications, events, roles, versions, retries, the
// legacy adapter, interviews (.ics), offers, verified hires, disputes, the notification outbox, analytics.
//   node tests/career/run.js [serverDir]
// Same harness as tests/loyalty: real routes, models and services; fake MongoDB with unique indexes and
// interleaving (simultaneous requests really interleave); no database, no network, no .env.
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
for (const m of ["User", "Job", "JobApplication", "JobInteraction", "Notification", "DomainEvent", "EngagementProfile", "PointsLedger", "RedemptionGuard", "PushLog", "CareerApplicationEvent", ...OPTIONAL_MODELS]) {
  try { reqS(`./models/${m}`); } catch (e) { if (!OPTIONAL_MODELS.includes(m)) throw e; }
}
const timeline = reqS("./services/career/careerTimelineService");

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const CAREER_HIDDEN = [...HIDDEN, "email", "phone", "address", "resumeUrl", "resumePublicId"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const text = Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body);
    let keys = new Set();
    try { keys = keysIn(JSON.parse(text)); } catch {}
    // /api/career replies carry no contact details, resume files or secrets
    const hidden = req.originalUrl.startsWith("/api/career") ? CAREER_HIDDEN : HIDDEN;
    const leaks = hidden.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks });
    return send(body);
  };
  next();
});
app.use("/api/jobs", reqS("./routes/jobs.routes"));
app.use("/api/career", reqS("./routes/career.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["E1", "E2", "S1", "S2", "S3", "admin", "J1", "J2", "J3", "J4", "JX", "Aold", "Aext", "As3", "Aarch", "Ae2"]) ids[k] = oid();
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("User"), [user(ids.E1, "employee", "hireco"), user(ids.E2, "employee", "otherco"), user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "umar"), user(ids.admin, "admin", "admin")]);
const job = (id, by, title, extra = {}) => ({ _id: id, title, department: "Engineering", location: "Karachi", type: "Full-time", salaryRange: "100k", contactEmail: "jobs@hireco.test", description: "build things", companyName: "Hire Co", postedBy: by, isExternal: false, active: true, archivedAt: null, createdAt: new Date(), ...extra });
fake.seed(coll("Job"), [
  job(ids.J1, ids.E1, "Backend dev"), job(ids.J2, ids.E2, "Designer", { companyName: "Other Co" }), job(ids.J3, ids.E1, "Frontend dev"),
  job(ids.J4, ids.E1, "Old role"), job(ids.JX, null, "Imported role", { isExternal: true, source: "adzuna", companyName: "Imported Ltd" }),
]);
const application = (id, jobId, who, status = "pending", days = 5) => ({ _id: id, jobId, userId: ids[who], fullName: `${who} full name`, email: `${who}@test.local`, phone: "03001234567", coverLetter: "hello", status, appliedAt: new Date(Date.now() - days * 864e5) });
fake.seed(coll("JobApplication"), [
  application(ids.Aold, ids.J1, "S2", "shortlisted", 10), // before the pilot: no events
  application(ids.Aext, ids.JX, "S1"), application(ids.As3, ids.J1, "S3"), application(ids.Aarch, ids.J4, "S2", "reviewed"), application(ids.Ae2, ids.J2, "S1"),
]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e), headers: {} }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const statuses = (rs) => rs.map((r) => r.status).sort().join(",");
const events = (appId) => rows("CareerApplicationEvent", (e) => same(e.application, appId)).sort((a, b) => a.seq - b.seq);
const appDoc = (id) => rows("JobApplication", (a) => same(a._id, id))[0];
const applyBody = (who) => ({ fullName: `${who} full name`, email: `${who}@test.local`, phone: "03001234567", coverLetter: "I'd like this job" });

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { E1: token("E1", "employee"), E2: token("E2", "employee"), S1: token("S1", "student"), S2: token("S2", "student"), S3: token("S3", "student"), admin: token("admin", "admin") };
  const ctx = {};

  console.log("── 1. flag off: today's behaviour");
  let r = await call("GET", "/api/career/applications/me", { tok: T.S1 });
  check("flag off: applications/me says not enabled", r.status === 200 && r.json.data.enabled === false, r.text);
  r = await call("GET", `/api/career/applications/${ids.As3}/timeline`, { tok: T.E1 });
  check("flag off: a timeline is not available (404 CAREER_OFF)", r.status === 404 && r.json?.error?.code === "CAREER_OFF", r.text);
  r = await call("POST", `/api/jobs/apply/${ids.J3}`, { tok: T.S3, body: applyBody("S3") });
  check("flag off: apply works as before, no timeline event", r.status === 201 && rows("CareerApplicationEvent").length === 0, r.status);
  const s3j3 = rows("JobApplication", (a) => same(a.userId, ids.S3) && same(a.jobId, ids.J3))[0];
  r = await call("PATCH", `/api/jobs/application/${s3j3._id}/status`, { tok: T.E1, body: { status: "hired" } });
  check("flag off: the old status route still sets any status, even hired", r.status === 200 && appDoc(s3j3._id).status === "hired", r.status);

  process.env.FLAG_CAREER_TIMELINE = `ids:${ids.E1},${ids.E2},${ids.S1},${ids.S2}`; // S3 is not in the pilot
  console.log("── 2. one application per student and job");
  let rs = await Promise.all([1, 2, 3].map(() => call("POST", `/api/jobs/apply/${ids.J1}`, { tok: T.S1, body: applyBody("S1") })));
  const mine = rows("JobApplication", (a) => same(a.userId, ids.S1) && same(a.jobId, ids.J1));
  check("3 simultaneous applies → one application", mine.length === 1 && rs.filter((x) => x.status === 201).length === 1, statuses(rs));
  ctx.A1 = mine[0]._id;
  check("…and one APPLIED event (seq 1)", events(ctx.A1).length === 1 && events(ctx.A1)[0].type === "APPLIED" && events(ctx.A1)[0].seq === 1);
  r = await call("POST", `/api/jobs/apply/${ids.J1}`, { tok: T.S1, body: applyBody("S1") });
  check("applying again later → refused as before, still one event", r.status === 400 && events(ctx.A1).length === 1, r.status);

  console.log("── 3. who sees a timeline");
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.S1 });
  check("the candidate: own timeline, stage applied, version 1", r.status === 200 && r.json.data.stage === "applied" && r.json.data.version === 1 && r.json.data.nextAllowedActions.includes("WITHDRAWN"), r.text.slice(0, 160));
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.S2 });
  check("another student → 404 (doesn't exist for them)", r.status === 404, r.status);
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.E2 });
  check("employer B → 404 for employer A's applicant", r.status === 404, r.status);
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.E1 });
  check("employer A (own job) → 200, can review / shortlist / reject", r.status === 200 && ["REVIEWED", "SHORTLISTED", "REJECTED"].every((t) => r.json.data.nextAllowedActions.includes(t)), JSON.stringify(r.json?.data?.nextAllowedActions));
  const auditBefore = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.admin });
  check("admin → 200, and the access is audited", r.status === 200 && rows("DomainEvent", (e) => e.type === "career.admin.access").length === auditBefore + 1, r.status);

  console.log("── 4. employer actions: roles, versions, retries");
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.S1, body: { type: "REVIEWED", version: 1 } });
  check("a candidate can't mark themselves reviewed (403)", r.status === 403 && r.json?.error?.code === "NOT_YOUR_ACTION", r.text);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E2, body: { type: "REVIEWED", version: 1 } });
  check("employer B can't act on employer A's applicant (404)", r.status === 404, r.status);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "REVIEWED" } });
  check("no version → 400 VERSION_REQUIRED", r.status === 400 && r.json?.error?.code === "VERSION_REQUIRED", r.text);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "REVIEWED", version: 1, internalNote: "solid cv" }, headers: { "idempotency-key": "rev-1" } });
  check("employer A reviews → 201, version 2, old status 'reviewed'", r.status === 201 && r.json.data.version === 2 && appDoc(ctx.A1).status === "reviewed", r.text.slice(0, 160));
  const again = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "REVIEWED", version: 1 }, headers: { "idempotency-key": "rev-1" } });
  check("the same request retried (same Idempotency-Key) → 200 duplicate, still one REVIEWED", again.status === 200 && again.json.data.duplicate === true && events(ctx.A1).filter((e) => e.type === "REVIEWED").length === 1, again.text.slice(0, 160));
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 2 } })));
  check("two employer users shortlisting at once from version 2 → one 201, one 409 VERSION_CONFLICT", rs.filter((x) => x.status === 201).length === 1 && rs.filter((x) => x.status === 409 && x.json?.error?.code === "VERSION_CONFLICT").length === 1, statuses(rs));
  check("…one SHORTLISTED event, seq 3", events(ctx.A1).filter((e) => e.type === "SHORTLISTED").length === 1 && events(ctx.A1).slice(-1)[0].seq === 3);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "REVIEWED", version: 3 } });
  check("reviewing a shortlisted candidate → 409 INVALID_TRANSITION with the allowed actions", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION" && Array.isArray(r.json.error.nextAllowedActions), r.text);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.E1, body: { type: "HIRE_CONFIRMED", version: 3 } });
  check("the generic route refuses interview / offer / hire events (400)", r.status === 400 && r.json?.error?.code === "NOT_A_GENERIC_EVENT", r.text);
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.S1 });
  check("the candidate's timeline hides the employer's internal note", r.status === 200 && !r.text.includes("solid cv") && r.json.data.events.length === 3, r.text.slice(0, 200));
  r = await call("GET", `/api/career/applications/${ctx.A1}/timeline`, { tok: T.E1 });
  check("…the employer sees it", r.text.includes("solid cv"));

  console.log("── 5. the old screens, for pilot applications");
  r = await call("PATCH", `/api/jobs/application/${ctx.A1}/status`, { tok: T.E1, body: { status: "hired" } });
  check("old status route: 'hired' refused for a pilot application (409 USE_CAREER_TIMELINE), status unchanged", r.status === 409 && r.json?.code === "USE_CAREER_TIMELINE" && appDoc(ctx.A1).status === "shortlisted", r.text);
  r = await call("POST", "/api/jobs/interviews/schedule", { tok: T.E1, body: { applicationId: String(ctx.A1), interviewDate: new Date(Date.now() + 864e5).toISOString() } });
  check("old interview scheduler: refused for a pilot application (409)", r.status === 409 && r.json?.code === "USE_CAREER_TIMELINE" && appDoc(ctx.A1).status === "shortlisted", r.text);
  r = await call("PATCH", "/api/jobs/candidates/bulk-status", { tok: T.E1, body: { candidateIds: [String(ctx.A1), String(ids.As3)], status: "rejected", notes: "position filled" } });
  check("old bulk reject: the pilot one through its timeline (REJECTED event), the other as before", r.status === 200 && events(ctx.A1).slice(-1)[0].type === "REJECTED" && appDoc(ctx.A1).status === "rejected" && appDoc(ids.As3).status === "rejected" && events(ids.As3).length === 0, r.text);
  check("…the timeline's REJECTED event records the employer and source", events(ctx.A1).slice(-1)[0].actorRole === "employer" && events(ctx.A1).slice(-1)[0].source === "portal-legacy" && same(events(ctx.A1).slice(-1)[0].actor, ids.E1));
  r = await call("PATCH", `/api/jobs/application/${ids.As3}/status`, { tok: T.E1, body: { status: "hired" } });
  check("a candidate outside the pilot: the old route unchanged (hired allowed)", r.status === 200 && appDoc(ids.As3).status === "hired" && events(ids.As3).length === 0, r.status);

  console.log("── 6. applications from before the pilot");
  r = await call("GET", `/api/career/applications/${ids.Aold}/timeline`, { tok: T.E1 });
  check("an older application without events: stage from its status (shortlisted), version 0", r.status === 200 && r.json.data.stage === "shortlisted" && r.json.data.version === 0 && r.json.data.events.length === 0, r.text.slice(0, 160));
  check("…reading it writes nothing", events(ids.Aold).length === 0);
  r = await call("POST", `/api/career/applications/${ids.Aold}/events`, { tok: T.E1, body: { type: "REJECTED", version: 0 } });
  check("the first action (from version 0): its start is written, then the action (applied, legacy status, rejected)", r.status === 201 && events(ids.Aold).map((e) => e.type).join() === "APPLIED,LEGACY_STATUS,REJECTED" && events(ids.Aold)[0].source === "legacy", events(ids.Aold).map((e) => e.type).join());

  console.log("── 7. external and deleted jobs");
  r = await call("GET", `/api/career/applications/${ids.Aext}/timeline`, { tok: T.S1 });
  check("imported job: 'External application, outcome unverified'; the candidate can only withdraw", r.status === 200 && r.json.data.external === true && r.json.data.externalLabel === "External application, outcome unverified" && r.json.data.nextAllowedActions.join() === "WITHDRAWN", r.text.slice(0, 200));
  r = await call("DELETE", `/api/jobs/delete/${ids.J4}`, { tok: T.E1 });
  check("employer deletes a job (archived)", r.status === 200 && rows("Job", (j) => same(j._id, ids.J4))[0].archivedAt);
  r = await call("GET", `/api/career/applications/${ids.Aarch}/timeline`, { tok: T.S2 });
  check("its application's timeline is still there", r.status === 200 && r.json.data.job.archived === true, r.text.slice(0, 120));
  r = await call("POST", `/api/career/applications/${ids.Aarch}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 0 } });
  check("…nothing new starts on it (410 JOB_ARCHIVED)", r.status === 410 && r.json?.error?.code === "JOB_ARCHIVED", r.text);
  r = await call("POST", `/api/career/applications/${ids.Aarch}/events`, { tok: T.E1, body: { type: "REJECTED", version: 0 } });
  check("…but it can be closed (rejected)", r.status === 201, r.text);

  console.log("── 8. lists");
  r = await call("GET", "/api/career/applications/me", { tok: T.S1 });
  const myIds = (r.json?.data?.applications || []).map((a) => a.applicationId);
  check("candidate: my pilot applications, with stage, version and next actions", r.status === 200 && myIds.includes(String(ctx.A1)) && myIds.includes(String(ids.Aext)) && myIds.includes(String(ids.Ae2)) && r.json.data.applications.every((a) => typeof a.version === "number" && Array.isArray(a.nextAllowedActions)), myIds.join());
  r = await call("GET", "/api/career/applications/me", { tok: T.S3 });
  check("a student outside the pilot: not enabled", r.json?.data?.enabled === false);
  r = await call("GET", "/api/career/employers/me/applications", { tok: T.E1 });
  const e1apps = (r.json?.data?.applications || []).map((a) => a.applicationId);
  check("employer A's pipeline: only applicants of A's jobs", r.status === 200 && e1apps.includes(String(ctx.A1)) && !e1apps.includes(String(ids.Ae2)), e1apps.join());
  check("…a candidate outside the pilot is marked (no timeline actions)", r.json.data.applications.find((a) => a.applicationId === String(ids.As3))?.careerEnabled === false);
  r = await call("GET", "/api/career/employers/me/applications", { tok: T.S1 });
  check("a student can't read an employer pipeline (403)", r.status === 403, r.status);
  r = await call("POST", `/api/career/applications/${ctx.A1}/events`, { tok: T.S1, body: { type: "WITHDRAWN", version: 4 } });
  check("a rejected application can't be withdrawn (closed): 409", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION", r.text);

  console.log("── 9. interviews: scheduled is not completed");
  await call("POST", `/api/jobs/apply/${ids.J3}`, { tok: T.S2, body: applyBody("S2") });
  await call("POST", `/api/jobs/apply/${ids.J3}`, { tok: T.S1, body: applyBody("S1") });
  ctx.A2 = rows("JobApplication", (a) => same(a.userId, ids.S2) && same(a.jobId, ids.J3))[0]._id;
  ctx.A3 = rows("JobApplication", (a) => same(a.userId, ids.S1) && same(a.jobId, ids.J3))[0]._id;
  const ver = async (id, tok = T.E1) => (await call("GET", `/api/career/applications/${id}/timeline`, { tok })).json.data.version;
  r = await call("POST", `/api/career/applications/${ctx.A2}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  check("A2 shortlisted", r.status === 201, r.text.slice(0, 120));
  const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const slot = { startsAt: inHours(48), durationMinutes: 45, timezone: "Asia/Karachi", mode: "online", meetingLink: "https://meet.example.test/abc", note: "bring your portfolio" };
  r = await call("POST", "/api/career/interviews", { tok: T.S2, body: { applicationId: String(ctx.A2), version: 2, ...slot } });
  check("a candidate can't schedule (403)", r.status === 403, r.status);
  r = await call("POST", "/api/career/interviews", { tok: T.E2, body: { applicationId: String(ctx.A2), version: 2, ...slot } });
  check("employer B can't schedule for employer A's applicant (404)", r.status === 404, r.status);
  r = await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A2), version: 2, ...slot, startsAt: inHours(-1) } });
  check("a time in the past → 400", r.status === 400 && r.json?.error?.code === "INVALID_TIME", r.text);
  r = await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A2), version: 2, ...slot, meetingLink: "" } });
  check("online without a meeting link → 400", r.status === 400 && r.json?.error?.code === "LINK_REQUIRED", r.text);
  rs = await Promise.all([1, 2].map(() => call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A2), version: 2, ...slot }, headers: { "idempotency-key": "iv-a2-1" } })));
  const ivs = () => rows("CareerInterview", (i) => same(i.application, ctx.A2));
  check("schedule sent twice with the same key → one interview, one INTERVIEW_INVITED", ivs().length === 1 && events(ctx.A2).filter((e) => e.type === "INTERVIEW_INVITED").length === 1 && rs.every((x) => x.status === 201 || x.status === 200), statuses(rs));
  const iv = ivs()[0];
  check("…the meeting link is saved (it was dropped before), old status 'interview', old interviewDate set", iv.meetingLink === slot.meetingLink && appDoc(ctx.A2).status === "interview" && new Date(appDoc(ctx.A2).interviewDate).toISOString() === new Date(slot.startsAt).toISOString());
  r = await call("GET", `/api/career/interviews/${iv._id}/ics`, { tok: T.S2 });
  check(".ics: text/calendar, stable UID, SEQUENCE:0, REQUEST, UTC times, link", r.status === 200 && /text\/calendar/.test(r.headers["content-type"]) && r.text.includes(`UID:career-interview-${iv._id}@thedeftcrew.com`) && r.text.includes("SEQUENCE:0") && r.text.includes("METHOD:REQUEST") && /DTSTART:\d{8}T\d{6}Z/.test(r.text) && r.text.includes("https://meet.example.test/abc") && r.text.includes("\r\n"), r.text.slice(0, 200));
  r = await call("GET", `/api/career/interviews/${iv._id}/ics`, { tok: T.E2 });
  check(".ics for someone else's interview → 404", r.status === 404, r.status);
  r = await call("POST", `/api/career/applications/${ctx.A3}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  r = await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A3), version: 2, ...slot, startsAt: new Date(new Date(slot.startsAt).getTime() + 15 * 60e3).toISOString() } });
  check("another interview overlapping the same employer's slot → 409 SLOT_CONFLICT", r.status === 409 && r.json?.error?.code === "SLOT_CONFLICT", r.text);
  r = await call("POST", `/api/career/interviews/${iv._id}/reschedule`, { tok: T.E1, body: { version: await ver(ctx.A2), ...slot, startsAt: inHours(72) } });
  check("reschedule → 201; history kept; sequence 1", r.status === 201 && ivs()[0].calendarSequence === 1 && ivs()[0].history.length === 1, r.text.slice(0, 160));
  r = await call("GET", `/api/career/interviews/${iv._id}/ics`, { tok: T.S2 });
  check("…the new .ics: same UID, SEQUENCE:1 (replaces the old slot)", r.text.includes(`UID:career-interview-${iv._id}@thedeftcrew.com`) && r.text.includes("SEQUENCE:1"), r.text.slice(0, 120));
  r = await call("POST", `/api/career/interviews/${iv._id}/respond`, { tok: T.E1, body: { version: await ver(ctx.A2), response: "accept" } });
  check("the employer can't answer for the candidate (403)", r.status === 403, r.status);
  r = await call("POST", `/api/career/interviews/${iv._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A2, T.S2), response: "accept" } });
  check("the candidate accepts → 201, interview accepted, .ics CONFIRMED", r.status === 201 && ivs()[0].status === "accepted" && (await call("GET", `/api/career/interviews/${iv._id}/ics`, { tok: T.S2 })).text.includes("STATUS:CONFIRMED"), r.text.slice(0, 160));
  r = await call("POST", `/api/career/interviews/${iv._id}/complete`, { tok: T.E1, body: { version: await ver(ctx.A2) } });
  check("recording 'completed' before the interview starts → 409 (scheduled ≠ completed)", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION" && !events(ctx.A2).some((e) => e.type === "INTERVIEW_COMPLETED"), r.text);
  // the interview time comes: move the slot into the past
  const past = new Date(Date.now() - 2 * 3600e3);
  for (const e of events(ctx.A2)) if (e.metadata?.startsAt) e.metadata.startsAt = past;
  ivs()[0].startsAt = past; ivs()[0].endsAt = new Date(past.getTime() + 45 * 60e3);
  r = await call("POST", `/api/career/interviews/${iv._id}/complete`, { tok: T.S2, body: { version: await ver(ctx.A2, T.S2) } });
  check("the candidate can't record it completed (403)", r.status === 403, r.status);
  r = await call("POST", `/api/career/interviews/${iv._id}/complete`, { tok: T.E1, body: { version: await ver(ctx.A2), note: "thanks for coming", internalNote: "strong" } });
  check("after it started, the employer records it → completed, stage still interview", r.status === 201 && ivs()[0].status === "completed" && r.json.data.state === "interview", r.text.slice(0, 160));
  r = await call("POST", `/api/career/interviews/${iv._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A2, T.S2), response: "dispute" } });
  check("a dispute without a reason → 400", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  r = await call("POST", `/api/career/interviews/${iv._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A2, T.S2), response: "dispute", message: "the interviewer never joined" } });
  check("the candidate disputes the recorded completion → 201, interview disputed", r.status === 201 && ivs()[0].status === "disputed" && events(ctx.A2).slice(-1)[0].type === "INTERVIEW_DISPUTED", r.text.slice(0, 160));
  r = await call("GET", `/api/career/applications/${ctx.A2}/timeline`, { tok: T.S2 });
  check("timeline: interview details (link, time zone), no internal note for the candidate", r.json.data.interviewDetails?.meetingLink === slot.meetingLink && r.json.data.interviewDetails.timezone === "Asia/Karachi" && !r.text.includes("strong"), r.text.slice(0, 200));
  r = await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A3), version: await ver(ctx.A3), ...slot, startsAt: inHours(120) } });
  const iv3 = rows("CareerInterview", (i) => same(i.application, ctx.A3))[0];
  check("A3: interview scheduled", r.status === 201 && iv3?.status === "invited", r.text.slice(0, 120));
  r = await call("POST", `/api/career/applications/${ctx.A3}/events`, { tok: T.S1, body: { type: "WITHDRAWN", version: await ver(ctx.A3, T.S1) } });
  const iv3b = rows("CareerInterview", (i) => same(i.application, ctx.A3))[0];
  check("the candidate withdraws → the pending interview is cancelled; its .ics becomes CANCEL", r.status === 201 && iv3b.status === "cancelled" && iv3b.active === false && (await call("GET", `/api/career/interviews/${iv3._id}/ics`, { tok: T.S1 })).text.includes("METHOD:CANCEL"), r.text.slice(0, 120));
  check("…and the old status shows it closed (rejected; the old enum has no 'withdrawn')", appDoc(ctx.A3).status === "rejected");

  console.log("── 10. offers and verified hires");
  ids.J5 = oid();
  fake.seed(coll("Job"), [job(ids.J5, ids.E1, "Data analyst")]);
  await call("POST", `/api/jobs/apply/${ids.J5}`, { tok: T.S1, body: applyBody("S1") });
  await call("POST", `/api/jobs/apply/${ids.J5}`, { tok: T.S2, body: applyBody("S2") });
  ctx.A4 = rows("JobApplication", (a) => same(a.userId, ids.S1) && same(a.jobId, ids.J5))[0]._id;
  ctx.A5 = rows("JobApplication", (a) => same(a.userId, ids.S2) && same(a.jobId, ids.J5))[0]._id;
  // A4: shortlist → interview → accepted → (time passes) → completed
  await call("POST", `/api/career/applications/${ctx.A4}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  r = await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(ctx.A4), version: 2, ...slot, startsAt: inHours(200) } });
  const iv4 = rows("CareerInterview", (i) => same(i.application, ctx.A4))[0];
  await call("POST", `/api/career/interviews/${iv4._id}/respond`, { tok: T.S1, body: { version: await ver(ctx.A4, T.S1), response: "accept" } });
  for (const e of events(ctx.A4)) if (e.metadata?.startsAt) e.metadata.startsAt = past;
  iv4.startsAt = past; iv4.endsAt = new Date(past.getTime() + 45 * 60e3);
  r = await call("POST", `/api/career/interviews/${iv4._id}/complete`, { tok: T.E1, body: { version: await ver(ctx.A4) } });
  const outcome = (appId, type) => rows("CareerOutcome", (o) => same(o.application, appId) && o.outcomeType === type)[0];
  check("interview completed → a private 'Interviewed via TDC' outcome (employer-recorded)", r.status === 201 && outcome(ctx.A4, "interviewed")?.verificationLevel === "employer-recorded" && outcome(ctx.A4, "interviewed").visibility === "private", r.text.slice(0, 120));
  const offerBody = (version, extra = {}) => ({ applicationId: String(ctx.A4), version, title: "Junior data analyst", terms: "Full time, starts 1 December", expiresAt: inHours(24 * 7), ...extra });
  r = await call("POST", "/api/career/offers", { tok: T.S1, body: offerBody(await ver(ctx.A4)) });
  check("a candidate can't send an offer (403)", r.status === 403, r.status);
  r = await call("POST", "/api/career/offers", { tok: T.E2, body: offerBody(await ver(ctx.A4)) });
  check("employer B can't send an offer to employer A's applicant (404)", r.status === 404, r.status);
  r = await call("POST", "/api/career/offers", { tok: T.E1, body: offerBody(await ver(ctx.A4), { expiresAt: inHours(-2) }) });
  check("a deadline in the past → 400", r.status === 400 && r.json?.error?.code === "INVALID_DATE", r.text);
  r = await call("POST", "/api/career/offers", { tok: T.E1, body: offerBody(await ver(ctx.A4)) });
  const off4 = rows("CareerOffer", (o) => same(o.application, ctx.A4))[0];
  check("employer A sends an offer → stage offer; the old status stays 'interview' (no offer in the old enum)", r.status === 201 && r.json.data.state === "offer" && appDoc(ctx.A4).status === "interview" && off4?.status === "sent", r.text.slice(0, 160));
  r = await call("POST", `/api/career/offers/${off4._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(ctx.A4) } });
  check("confirming a hire before the candidate accepts → 409", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION" && !outcome(ctx.A4, "hired"), r.text);
  r = await call("POST", `/api/career/offers/${off4._id}/respond`, { tok: T.S2, body: { version: 1, response: "accept" } });
  check("another student can't answer the offer (404)", r.status === 404, r.status);
  r = await call("POST", `/api/career/offers/${off4._id}/respond`, { tok: T.S1, body: { version: await ver(ctx.A4, T.S1), response: "accept", message: "happy to join" } });
  check("the candidate accepts → offer accepted, NOT hired: stage offer, old status 'interview', no hire outcome", r.status === 201 && r.json.data.state === "offer" && appDoc(ctx.A4).status === "interview" && !outcome(ctx.A4, "hired") && rows("CareerOffer", (o) => same(o._id, off4._id))[0].status === "accepted", r.text.slice(0, 160));
  r = await call("GET", `/api/career/applications/${ctx.A4}/timeline`, { tok: T.E1 });
  check("the employer's next action is confirm hire", r.json.data.nextAllowedActions.includes("HIRE_CONFIRMED") && r.json.data.offerDetails?.status === "accepted", JSON.stringify(r.json?.data?.nextAllowedActions));
  const v4 = await ver(ctx.A4);
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/career/offers/${off4._id}/confirm-hire`, { tok: T.E1, body: { version: v4 } })));
  check("two simultaneous confirms → one 201, one 409; one HIRE_CONFIRMED", rs.filter((x) => x.status === 201).length === 1 && rs.filter((x) => x.status === 409).length === 1 && events(ctx.A4).filter((e) => e.type === "HIRE_CONFIRMED").length === 1, statuses(rs));
  const hired = outcome(ctx.A4, "hired");
  check("verified hire: old status 'hired', outcome verified, private, 7-day dispute window", appDoc(ctx.A4).status === "hired" && hired?.verificationLevel === "verified" && hired.visibility === "private" && Math.round((new Date(hired.disputeWindowEndsAt) - Date.now()) / 864e5) === 7, JSON.stringify(hired && { v: hired.verificationLevel, vis: hired.visibility }));
  r = await call("GET", "/api/career/outcomes/me", { tok: T.S1 });
  check("the student's outcomes: Hired via TDC (verified, private, can dispute) and Interviewed via TDC", r.status === 200 && r.json.data.outcomes.some((o) => o.label === "Hired via TDC" && o.visibility === "private" && o.canDispute) && r.json.data.outcomes.some((o) => o.label === "Interviewed via TDC"), r.text.slice(0, 200));
  r = await call("PATCH", `/api/career/outcomes/${hired._id}`, { tok: T.S2, body: { visibility: "public" } });
  check("another student can't change it (404)", r.status === 404, r.status);
  r = await call("PATCH", `/api/career/outcomes/${hired._id}`, { tok: T.S1, body: { visibility: "public" } });
  check("the student makes it public (their choice)", r.status === 200 && r.json.data.visibility === "public", r.text);
  r = await call("POST", `/api/career/applications/${ctx.A4}/events`, { tok: T.S1, body: { type: "HIRE_DISPUTED", version: await ver(ctx.A4, T.S1) } });
  check("a hire dispute without a reason → 400", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  r = await call("POST", `/api/career/applications/${ctx.A4}/events`, { tok: T.S1, body: { type: "HIRE_DISPUTED", version: await ver(ctx.A4, T.S1), note: "the employer withdrew the job after I accepted" } });
  check("the student disputes within 7 days → revoked, private again; old status back to 'interview'", r.status === 201 && outcome(ctx.A4, "hired").verificationLevel === "revoked" && outcome(ctx.A4, "hired").visibility === "private" && appDoc(ctx.A4).status === "interview", r.text.slice(0, 160));
  r = await call("PATCH", `/api/career/outcomes/${hired._id}`, { tok: T.S1, body: { visibility: "public" } });
  check("a revoked outcome can't be made public (409)", r.status === 409 && r.json?.error?.code === "REVOKED", r.text);

  console.log("── 11. the dispute window and admin corrections");
  await call("POST", `/api/career/applications/${ctx.A5}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  await call("POST", "/api/career/offers", { tok: T.E1, body: { ...offerBody(2), applicationId: String(ctx.A5) } });
  const off5 = rows("CareerOffer", (o) => same(o.application, ctx.A5))[0];
  await call("POST", `/api/career/offers/${off5._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A5, T.S2), response: "accept" } });
  r = await call("POST", `/api/career/offers/${off5._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(ctx.A5) } });
  check("A5 hired (offer from shortlist, accepted, confirmed)", r.status === 201 && appDoc(ctx.A5).status === "hired", r.text.slice(0, 120));
  events(ctx.A5).find((e) => e.type === "HIRE_CONFIRMED").occurredAt = new Date(Date.now() - 8 * 864e5); // 8 days ago
  r = await call("POST", `/api/career/applications/${ctx.A5}/events`, { tok: T.S2, body: { type: "HIRE_DISPUTED", version: await ver(ctx.A5, T.S2), note: "not hired actually" } });
  check("a dispute after 7 days → 409 (window closed)", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION", r.text);
  r = await call("POST", `/api/career/applications/${ctx.A5}/events`, { tok: T.E1, body: { type: "HIRE_REVOKED", version: await ver(ctx.A5), note: "entered by mistake" } });
  check("the employer can't revoke a verified hire itself (403)", r.status === 403, r.text);
  const audits = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("POST", `/api/career/applications/${ctx.A5}/events`, { tok: T.admin, body: { type: "HIRE_REVOKED", version: await ver(ctx.A5, T.admin), note: "duplicate hire record (support ticket 42)" } });
  check("admin revokes with a reason → revoked; audited; the event records the admin", r.status === 201 && outcome(ctx.A5, "hired").verificationLevel === "revoked" && rows("DomainEvent", (e) => e.type === "career.admin.access").length > audits && events(ctx.A5).slice(-1)[0].actorRole === "admin", r.text.slice(0, 160));

  console.log("── 11b. only the job's employer confirms a hire; an admin resolves disputes");
  // an application with an accepted offer: shortlisted, offered, accepted
  const acceptedApp = async (title, studentTok, studentKey) => {
    const jobId = oid();
    fake.seed(coll("Job"), [job(jobId, ids.E1, title)]);
    await call("POST", `/api/jobs/apply/${jobId}`, { tok: studentTok, body: applyBody(studentKey) });
    const appId = rows("JobApplication", (a) => same(a.jobId, jobId))[0]._id;
    await call("POST", `/api/career/applications/${appId}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
    await call("POST", "/api/career/offers", { tok: T.E1, body: { applicationId: String(appId), version: 2, title, expiresAt: inHours(72) } });
    const off = rows("CareerOffer", (o) => same(o.application, appId))[0];
    await call("POST", `/api/career/offers/${off._id}/respond`, { tok: studentTok, body: { version: await ver(appId, studentTok), response: "accept" } });
    return { appId, off };
  };
  const h1 = await acceptedApp("Data intern", T.S1, "S1");
  r = await call("GET", `/api/career/applications/${h1.appId}/timeline`, { tok: T.admin });
  check("an admin's next actions don't include confirming the hire; the employer's do", r.status === 200 && !r.json.data.nextAllowedActions.includes("HIRE_CONFIRMED") && (await call("GET", `/api/career/applications/${h1.appId}/timeline`, { tok: T.E1 })).json.data.nextAllowedActions.includes("HIRE_CONFIRMED"), JSON.stringify(r.json?.data?.nextAllowedActions));
  r = await call("POST", `/api/career/offers/${h1.off._id}/confirm-hire`, { tok: T.admin, body: { version: await ver(h1.appId, T.admin), note: "employer asked by phone" } });
  check("an admin can't confirm a hire: 403 EMPLOYER_ONLY, no HIRE_CONFIRMED, no hire outcome, old status unchanged", r.status === 403 && r.json?.error?.code === "EMPLOYER_ONLY" && !events(h1.appId).some((e) => e.type === "HIRE_CONFIRMED") && !outcome(h1.appId, "hired") && appDoc(h1.appId).status === "interview", r.text);
  r = await call("POST", `/api/career/offers/${h1.off._id}/confirm-hire`, { tok: T.E2, body: { version: await ver(h1.appId) } });
  check("another employer can't confirm it (404)", r.status === 404, r.status);
  r = await call("POST", `/api/career/offers/${h1.off._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(h1.appId) } });
  check("the job's employer confirms → verified hire, the event records the employer", r.status === 201 && outcome(h1.appId, "hired")?.verificationLevel === "verified" && events(h1.appId).slice(-1)[0].actorRole === "employer", r.text.slice(0, 120));
  r = await call("POST", `/api/career/applications/${h1.appId}/events`, { tok: T.S1, body: { type: "HIRE_DISPUTED", version: await ver(h1.appId, T.S1), note: "I never started this job" } });
  const tl1 = async (tok) => (await call("GET", `/api/career/applications/${h1.appId}/timeline`, { tok })).json.data;
  check("the candidate disputes → revoked, dispute open", r.status === 201 && outcome(h1.appId, "hired").verificationLevel === "revoked" && (await tl1(T.admin)).hire?.dispute === "open", r.text.slice(0, 200));
  const adminNext = (await tl1(T.admin)).nextAllowedActions;
  check("the admin can now restore or revoke (uphold), not confirm", ["HIRE_RESTORED", "HIRE_REVOKED"].every((t) => adminNext.includes(t)) && !adminNext.includes("HIRE_CONFIRMED"), JSON.stringify(adminNext));
  const disputesAudit = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("GET", "/api/career/admin/disputes", { tok: T.admin });
  const d1 = r.json?.data?.disputes?.find((d) => same(d.applicationId, h1.appId));
  check("admin disputes list: the open dispute with job, candidate, employer, the reason and dates; resolvable", r.status === 200 && d1 && d1.job.title === "Data intern" && same(d1.candidate.id, ids.S1) && d1.candidate.name && same(d1.employer.id, ids.E1) && d1.employer.name && d1.reason === "I never started this job" && d1.disputedAt && d1.hireConfirmedAt && d1.resolvable === true && Number.isInteger(d1.version), r.text.slice(0, 300));
  check("…every listed dispute is still open (A4 from section 10 too); nothing resolved is listed", r.json.data.disputes.some((d) => same(d.applicationId, ctx.A4)) && !r.json.data.disputes.some((d) => same(d.applicationId, ctx.A5)));
  check("…no contact details in it (no e-mail, phone, CV)", !/@|0300|resume|cv/i.test(JSON.stringify(r.json.data)), r.text.slice(0, 200));
  check("…reading the list is audited", rows("DomainEvent", (e) => e.type === "career.admin.access").length > disputesAudit);
  r = await call("GET", "/api/career/admin/disputes", { tok: T.E1 });
  const rS = await call("GET", "/api/career/admin/disputes", { tok: T.S1 });
  check("only admins: employer 403, student 403", r.status === 403 && rS.status === 403, `${r.status} ${rS.status}`);
  const flagWas = process.env.FLAG_CAREER_TIMELINE;
  process.env.FLAG_CAREER_TIMELINE = "off";
  r = await call("GET", "/api/career/admin/disputes", { tok: T.admin });
  process.env.FLAG_CAREER_TIMELINE = flagWas;
  check("FLAG_CAREER_TIMELINE off (or unset): 404 CAREER_OFF, so the portal hides the page", r.status === 404 && r.json?.error?.code === "CAREER_OFF", r.text);
  r = await call("POST", `/api/career/applications/${h1.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(h1.appId, T.admin) } });
  check("restoring without a reason → 400 REASON_REQUIRED", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  r = await call("POST", `/api/career/applications/${h1.appId}/events`, { tok: T.E1, body: { type: "HIRE_RESTORED", version: await ver(h1.appId), note: "they did start, here is the contract" } });
  check("the employer can't restore it themselves (403)", r.status === 403, r.text);
  r = await call("POST", `/api/career/offers/${h1.off._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(h1.appId) } });
  check("…nor confirm it again while the dispute is open (409)", r.status === 409, r.text);
  const audits2 = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("POST", `/api/career/applications/${h1.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(h1.appId, T.admin), note: "contract and first payslip checked (ticket 77)" } });
  const o1 = outcome(h1.appId, "hired");
  check("the admin restores with a reason → verified again, private, old status 'hired', audited, the event records the admin and reason", r.status === 201 && o1.verificationLevel === "verified" && o1.visibility === "private" && !o1.revokedAt && appDoc(h1.appId).status === "hired" && rows("DomainEvent", (e) => e.type === "career.admin.access").length > audits2 && events(h1.appId).slice(-1)[0].actorRole === "admin" && /ticket 77/.test(events(h1.appId).slice(-1)[0].metadata.note), r.text.slice(0, 200));
  check("…the offer is verified again", rows("CareerOffer", (o) => same(o._id, h1.off._id))[0].verificationStatus === "verified");
  r = await call("GET", "/api/career/admin/disputes", { tok: T.admin });
  check("…and it leaves the open disputes list", r.status === 200 && !r.json.data.disputes.some((d) => same(d.applicationId, h1.appId)));
  r = await call("POST", `/api/career/applications/${h1.appId}/events`, { tok: T.S1, body: { type: "HIRE_DISPUTED", version: await ver(h1.appId, T.S1), note: "disputing again" } });
  check("a restored hire can't be disputed again (409)", r.status === 409 && r.json?.error?.code === "INVALID_TRANSITION", r.text);
  check("both sides were told about the restore", new Set(rows("CareerNotificationOutbox", (o) => o.eventType === "HIRE_RESTORED" && same(o.application, h1.appId)).map((o) => String(o.recipient))).size === 2);
  const h2 = await acceptedApp("Ops intern", T.S2, "S2");
  await call("POST", `/api/career/offers/${h2.off._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(h2.appId) } });
  await call("POST", `/api/career/applications/${h2.appId}/events`, { tok: T.S2, body: { type: "HIRE_DISPUTED", version: await ver(h2.appId, T.S2), note: "offer was withdrawn on day one" } });
  r = await call("POST", `/api/career/applications/${h2.appId}/events`, { tok: T.admin, body: { type: "HIRE_REVOKED", version: await ver(h2.appId, T.admin), note: "employer confirmed the offer was withdrawn" } });
  const h2tl = (await call("GET", `/api/career/applications/${h2.appId}/timeline`, { tok: T.admin })).json.data;
  check("the admin upholds a dispute (HIRE_REVOKED with a reason) → stays revoked, dispute upheld", r.status === 201 && h2tl.hire?.dispute === "upheld" && outcome(h2.appId, "hired").verificationLevel === "revoked", r.text.slice(0, 200));
  r = await call("POST", `/api/career/applications/${h2.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(h2.appId, T.admin), note: "changed my mind" } });
  check("…an upheld dispute can't be restored afterwards (409)", r.status === 409, r.text);

  console.log("── 12. offer deadlines");
  await call("POST", `/api/career/applications/${ids.Ae2}/events`, { tok: T.E2, body: { type: "SHORTLISTED", version: 0 } });
  r = await call("POST", "/api/career/offers", { tok: T.E2, body: { applicationId: String(ids.Ae2), version: await ver(ids.Ae2, T.E2), title: "Designer", expiresAt: inHours(30) } });
  const offE2 = rows("CareerOffer", (o) => same(o.application, ids.Ae2))[0];
  check("employer B sends an offer to its own applicant", r.status === 201 && offE2, r.text.slice(0, 120));
  const expired = new Date(Date.now() - 3600e3);
  offE2.expiresAt = expired;
  for (const e of events(ids.Ae2)) if (e.type === "OFFER_SENT") e.metadata.expiresAt = expired;
  r = await call("POST", `/api/career/offers/${offE2._id}/respond`, { tok: T.S1, body: { version: await ver(ids.Ae2, T.S1), response: "accept" } });
  check("accepting after the deadline → 409 OFFER_EXPIRED; the timeline shows it expired", r.status === 409 && r.json?.error?.code === "OFFER_EXPIRED" && (await call("GET", `/api/career/applications/${ids.Ae2}/timeline`, { tok: T.S1 })).json.data.offer.status === "expired", r.text);
  r = await call("POST", "/api/career/offers", { tok: T.E2, body: { applicationId: String(ids.Ae2), version: await ver(ids.Ae2, T.E2), title: "Designer", expiresAt: inHours(48) } });
  check("…the employer can send a new offer", r.status === 201, r.text.slice(0, 120));

  console.log("── 13. notifications: outbox, retries never repeat the event");
  const outbox = (f = () => true) => rows("CareerNotificationOutbox", f);
  const notif = reqS("./services/career/careerNotificationService");
  const invited = events(ctx.A2).find((e) => e.type === "INTERVIEW_INVITED");
  const invRows = outbox((o) => same(o.event, invited._id));
  check("an interview invite queued push + in-app for the candidate only", invRows.length === 2 && invRows.every((o) => same(o.recipient, ids.S2)) && invRows.map((o) => o.channel).sort().join() === "inapp,push", invRows.map((o) => o.channel).join());
  check("…in-app delivered as a Notification without its own push; push through the gateway (no device here: skipped)", invRows.find((o) => o.channel === "inapp").status === "sent" && rows("Notification", (n) => n.metadata?.careerOutboxId === String(invRows.find((o) => o.channel === "inapp")._id) && n.metadata.skipPush === true).length === 1 && ["sent", "skipped"].includes(invRows.find((o) => o.channel === "push").status), invRows.map((o) => `${o.channel}:${o.status}:${o.lastError}`).join());
  check("…the texts name the job and company, no e-mail or phone", invRows.every((o) => o.payload.body.includes("Frontend dev") && !/@|0300/.test(JSON.stringify(o.payload))));
  check("REVIEWED queues nothing (no message for it)", outbox((o) => o.eventType === "REVIEWED").length === 0);
  check("HIRE_CONFIRMED notified both sides", new Set(outbox((o) => o.eventType === "HIRE_CONFIRMED" && same(o.application, ctx.A4)).map((o) => String(o.recipient))).size === 2);
  // the in-app provider fails once
  const realInapp = notif.providers.inapp;
  let failOnce = true;
  notif.providers.inapp = async (row) => { if (failOnce) { failOnce = false; throw new Error("provider down"); } return realInapp(row); };
  const offE2b = rows("CareerOffer", (o) => same(o.application, ids.Ae2) && o.status === "sent")[0];
  r = await call("POST", `/api/career/offers/${offE2b._id}/respond`, { tok: T.S1, body: { version: await ver(ids.Ae2, T.S1), response: "accept" } });
  const acc = events(ids.Ae2).find((e) => e.type === "OFFER_ACCEPTED");
  let accRow = outbox((o) => same(o.event, acc._id) && o.channel === "inapp")[0];
  check("the offer is accepted; the employer's in-app notification failed (attempt 1, retry later)", r.status === 201 && accRow?.status === "failed" && accRow.attempts === 1 && accRow.lastError === "provider down", JSON.stringify(accRow && { s: accRow.status, a: accRow.attempts }));
  const evBefore = rows("CareerApplicationEvent").length;
  const later = new Date(Date.now() + 3 * 3600e3);
  await notif.drain({ now: later });
  accRow = outbox((o) => same(o.event, acc._id) && o.channel === "inapp")[0];
  check("the retry delivers it (attempt 2); no timeline event written again", accRow.status === "sent" && accRow.attempts === 2 && rows("CareerApplicationEvent").length === evBefore && events(ids.Ae2).filter((e) => e.type === "OFFER_ACCEPTED").length === 1);
  check("…exactly one in-app notification for it", rows("Notification", (n) => n.metadata?.careerOutboxId === String(accRow._id)).length === 1);
  const requeued = await notif.enqueue(acc, { job: { title: "Designer", companyName: "Other Co" } });
  await notif.drain({ now: later });
  check("processing the same event again queues nothing new (event + recipient + channel is unique)", requeued === 0 && outbox((o) => same(o.event, acc._id)).length === 1);
  notif.providers.inapp = async () => { throw new Error("still down"); };
  r = await call("POST", `/api/career/applications/${ctx.A2}/events`, { tok: T.E1, body: { type: "REJECTED", version: await ver(ctx.A2) } });
  const stuck = outbox((o) => o.eventType === "REJECTED" && same(o.application, ctx.A2) && o.channel === "inapp")[0];
  for (let i = 0; i < 8; i++) await notif.drain({ now: new Date(Date.now() + (i + 1) * 2 * 3600e3) });
  const stuckAfter = stuck ? outbox((o) => same(o._id, stuck._id))[0] : null;
  check("a delivery that keeps failing stops after 5 attempts (no endless retries); the rejection itself stands", r.status === 201 && stuckAfter?.status === "failed" && stuckAfter.attempts === notif.MAX_ATTEMPTS && appDoc(ctx.A2).status === "rejected", stuckAfter && `${stuckAfter.status} ${stuckAfter.attempts}`);
  notif.providers.inapp = realInapp;
  r = await call("POST", "/api/career/admin/outbox/drain", { tok: T.S1 });
  check("only an admin can drain the outbox (403)", r.status === 403, r.status);

  console.log("── 14. analytics, from events only");
  ids.J6 = oid();
  fake.seed(coll("Job"), [job(ids.J6, ids.E1, "Support lead")]);
  await call("POST", `/api/jobs/apply/${ids.J6}`, { tok: T.S2, body: applyBody("S2") });
  ctx.A6 = rows("JobApplication", (a) => same(a.userId, ids.S2) && same(a.jobId, ids.J6))[0]._id;
  await call("POST", `/api/career/applications/${ctx.A6}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  await call("POST", "/api/career/offers", { tok: T.E1, body: { applicationId: String(ctx.A6), version: 2, title: "Support lead", expiresAt: inHours(72) } });
  const off6 = rows("CareerOffer", (o) => same(o.application, ctx.A6))[0];
  await call("POST", `/api/career/offers/${off6._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A6, T.S2), response: "accept" } });
  r = await call("POST", `/api/career/offers/${off6._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(ctx.A6) } });
  check("A6: a hire that stands", r.status === 201 && appDoc(ctx.A6).status === "hired");
  r = await call("GET", "/api/career/employers/me/analytics", { tok: T.E1 });
  const a1 = r.json?.data;
  // independent count from the raw events of employer A
  const mineEv = rows("CareerApplicationEvent", (e) => same(e.employer, ids.E1));
  const apps1 = [...new Set(mineEv.map((e) => String(e.application)))];
  const evOf = (id) => mineEv.filter((e) => String(e.application) === id).sort((x, y) => x.seq - y.seq);
  const lastI = (l, t) => l.map((e) => e.type).lastIndexOf(t);
  const want = {
    applications: apps1.length,
    verifiedHires: apps1.filter((id) => { const l = evOf(id); const h = lastI(l, "HIRE_CONFIRMED"); return h >= 0 && Math.max(h, lastI(l, "HIRE_RESTORED")) > Math.max(lastI(l, "HIRE_DISPUTED"), lastI(l, "HIRE_REVOKED")); }).length,
    interviewsCompleted: apps1.filter((id) => { const l = evOf(id); return lastI(l, "INTERVIEW_COMPLETED") > lastI(l, "INTERVIEW_DISPUTED"); }).length,
    offersAccepted: apps1.filter((id) => evOf(id).some((e) => e.type === "OFFER_ACCEPTED")).length,
    disputes: mineEv.filter((e) => ["INTERVIEW_DISPUTED", "HIRE_DISPUTED", "HIRE_REVOKED"].includes(e.type)).length,
  };
  check("employer A's funnel matches its events (applications, verified hires, completed interviews, accepted offers, disputes)", r.status === 200 && ["applications", "verifiedHires", "interviewsCompleted", "offersAccepted", "disputes"].every((k) => a1.counts[k] === want[k]), `${JSON.stringify(want)} vs ${JSON.stringify(a1?.counts)}`);
  check("…5 accepted offers but 2 verified hires (one disputed, one revoked, one dispute upheld; the restored one counts)", a1.counts.offersAccepted === 5 && a1.counts.verifiedHires === 2, JSON.stringify(a1?.counts));
  check("…the interview that was disputed doesn't count as completed; scheduled ones neither", a1.counts.interviewsCompleted === 1 && a1.counts.interviewsInvited >= 3, JSON.stringify(a1?.counts));
  check("…the pre-pilot application is counted as joined later, not submitted", a1.counts.joinedPilotLater >= 1 && a1.counts.submitted === a1.counts.applications - a1.counts.joinedPilotLater);
  check("…median response times are hours (numbers)", typeof a1.medianHours.firstEmployerResponse === "number" && typeof a1.medianHours.toVerifiedHire === "number", JSON.stringify(a1?.medianHours));
  r = await call("GET", "/api/career/employers/me/analytics", { tok: T.E2 });
  check("employer B's funnel holds only B's applications", r.status === 200 && r.json.data.counts.applications === new Set(rows("CareerApplicationEvent", (e) => same(e.employer, ids.E2)).map((e) => String(e.application))).size && r.json.data.counts.verifiedHires === 0, JSON.stringify(r.json?.data?.counts));
  r = await call("GET", "/api/career/employers/me/analytics", { tok: T.S1 });
  check("a student can't read employer analytics (403)", r.status === 403, r.status);
  const adminAudits = rows("DomainEvent", (e) => e.type === "career.admin.access").length;
  r = await call("GET", "/api/career/admin/analytics", { tok: T.admin });
  check("admin: everything, and the read is audited", r.status === 200 && r.json.data.counts.applications === new Set(rows("CareerApplicationEvent").map((e) => String(e.application))).size && rows("DomainEvent", (e) => e.type === "career.admin.access").length === adminAudits + 1, JSON.stringify(r.json?.data?.counts));
  r = await call("GET", "/api/career/admin/analytics", { tok: T.E1 });
  check("an employer can't read admin analytics (403)", r.status === 403, r.status);
  r = await call("GET", `/api/career/admin/analytics?from=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`, { tok: T.admin });
  check("a range in the future: nothing counted", r.status === 200 && r.json.data.counts.applications === 0);

  console.log("── 15. the outbox job (JOB_CAREER_OUTBOX)");
  const flagsMod = reqS("./config/featureFlags");
  const withEnv = (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; } try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } } };
  check("production: on by default", flagsMod.jobEnabled("careerOutbox") === true);
  check("staging: off (APP_ENV or Railway's environment name)", withEnv({ APP_ENV: "staging" }, () => !flagsMod.jobEnabled("careerOutbox")) && withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging" }, () => !flagsMod.jobEnabled("careerOutbox")));
  check("staging + JOB_CAREER_OUTBOX=on: on; production + BACKGROUND_JOBS=off: off", withEnv({ APP_ENV: "staging", JOB_CAREER_OUTBOX: "on" }, () => flagsMod.jobEnabled("careerOutbox")) && withEnv({ BACKGROUND_JOBS: "off" }, () => !flagsMod.jobEnabled("careerOutbox")));
  const serverSrc = require("fs").readFileSync(path.join(SERVER, "server.js"), "utf8").replace(/\r\n/g, "\n");
  check("server.js starts it only behind its switch", /if \(jobEnabled\("careerOutbox"\)\) \{\n\s+require\("\.\/services\/career\/careerOutboxJob"\)\.start\(\);/.test(serverSrc));
  const job7 = reqS("./services/career/careerOutboxJob");
  const gateway = reqS("./services/engagement/pushGateway");
  const realSend = gateway.send;
  const realInapp2 = notif.providers.inapp;
  ids.J7 = oid();
  fake.seed(coll("Job"), [job(ids.J7, ids.E1, "QA engineer")]);
  await call("POST", `/api/jobs/apply/${ids.J7}`, { tok: T.S1, body: applyBody("S1") });
  ctx.A7 = rows("JobApplication", (a) => same(a.userId, ids.S1) && same(a.jobId, ids.J7))[0]._id;
  let failNext = true;
  notif.providers.inapp = async (row) => { if (failNext) { failNext = false; throw new Error("provider down"); } return realInapp2(row); };
  gateway.send = async () => ({ sent: false, reason: "quiet_hours" });
  r = await call("POST", `/api/career/applications/${ctx.A7}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
  const shortEv = events(ctx.A7).find((e) => e.type === "SHORTLISTED");
  const rowOf = (ch) => outbox((o) => same(o.event, shortEv._id) && o.channel === ch)[0];
  check("shortlisted: in-app failed (attempt 1), push held back by quiet hours (pending, no attempt used)", r.status === 201 && rowOf("inapp").status === "failed" && rowOf("inapp").attempts === 1 && rowOf("push").status === "pending" && rowOf("push").attempts === 0 && rowOf("push").lastError === "quiet_hours", `${rowOf("inapp")?.status}/${rowOf("inapp")?.attempts} ${rowOf("push")?.status}/${rowOf("push")?.attempts}`);
  const evCount = rows("CareerApplicationEvent").length;
  let out = await job7.tick(new Date());
  check("a tick right away: nothing due yet (backoff), nothing re-sent", rowOf("inapp").status === "failed" && rowOf("inapp").attempts === 1, JSON.stringify(out));
  for (let i = 1; i <= 8; i++) await job7.tick(new Date(Date.now() + i * 31 * 60e3)); // 4 hours of quiet-hours ticks
  check("quiet hours all night: the push keeps waiting without using up its attempts", rowOf("push").status === "pending" && rowOf("push").attempts === 0, `${rowOf("push").status}/${rowOf("push").attempts}`);
  check("…meanwhile the failed in-app row was retried by the job and delivered (attempt 2)", rowOf("inapp").status === "sent" && rowOf("inapp").attempts === 2);
  gateway.send = async () => ({ sent: true });
  out = await job7.tick(new Date(Date.now() + 5 * 3600e3));
  check("quiet hours over: the next tick delivers the push", rowOf("push").status === "sent", JSON.stringify(out));
  check("…and no timeline event was written by any of it", rows("CareerApplicationEvent").length === evCount && events(ctx.A7).filter((e) => e.type === "SHORTLISTED").length === 1);
  check("…exactly one in-app notification for the shortlist", rows("Notification", (n) => n.metadata?.careerOutboxId === String(rowOf("inapp")._id)).length === 1);
  const both = await Promise.all([job7.tick(new Date(Date.now() + 6 * 3600e3)), job7.tick(new Date(Date.now() + 6 * 3600e3))]);
  check("two ticks at the same moment: the second one stands aside", both.some((x) => x.skipped === "already running"), JSON.stringify(both));
  const t1 = job7.start({ intervalMs: 60 * 60e3 });
  const t2 = job7.start({ intervalMs: 60 * 60e3 });
  check("start() runs one timer (a second start reuses it); stop() clears it", t1 === t2 && (job7.stop(), true));
  gateway.send = realSend;
  notif.providers.inapp = realInapp2;

  console.log("── 16. old job routes: imported jobs without a poster, missing jobs (403 / 404, never 500)");
  const in2days = new Date(Date.now() + 2 * 864e5).toISOString();
  const noPoster = [
    ["PATCH", `/api/jobs/application/${ids.Aext}/status`, { status: "shortlisted" }],
    ["GET", `/api/jobs/job/${ids.JX}/applications`],
    ["POST", "/api/jobs/interviews/schedule", { applicationId: String(ids.Aext), interviewDate: in2days }],
    ["PUT", `/api/jobs/interviews/reschedule/${ids.Aext}`, { interviewDate: in2days }],
    ["DELETE", `/api/jobs/interviews/cancel/${ids.Aext}`],
    ["PATCH", `/api/jobs/interviews/complete/${ids.Aext}`],
    ["GET", `/api/jobs/candidates/${ids.Aext}`],
    ["PATCH", "/api/jobs/candidates/bulk-status", { candidateIds: [String(ids.Aext)], status: "rejected" }],
    ["GET", `/api/jobs/resume/${ids.Aext}`],
    ["PUT", `/api/jobs/update/${ids.JX}`, { title: "x" }],
    ["PATCH", `/api/jobs/toggle/${ids.JX}`],
  ];
  const got = [];
  for (const [m, u, b] of noPoster) got.push([m, u, (await call(m, u, { tok: T.E1, body: b })).status]);
  check("an employer on an imported job (no poster): every old route answers 403, none 500", got.every((g) => g[2] === 403), got.map((g) => `${g[0]} ${g[1].replace(/\/api\/jobs/, "")} ${g[2]}`).join(" | "));
  check("…and nothing changed (status still pending)", appDoc(ids.Aext).status === "pending");
  r = await call("GET", `/api/jobs/candidates/${ids.Aext}`, { tok: T.S1 });
  check("the candidate still sees their own application on it (200)", r.status === 200, r.status);
  r = await call("GET", `/api/jobs/resume/${ids.Aext}`, { tok: T.S1 });
  check("…and their resume link: 404 'no resume uploaded' (not 500)", r.status === 404, r.status);
  r = await call("PATCH", `/api/jobs/application/${ids.Aext}/status`, { tok: T.admin, body: { status: "reviewed" } });
  check("an admin can still manage it (200)", r.status === 200 && appDoc(ids.Aext).status === "reviewed", r.status);
  ids.Agone = oid();
  fake.seed(coll("JobApplication"), [application(ids.Agone, oid(), "S2")]); // its job document is gone
  const gone = [
    ["PATCH", `/api/jobs/application/${ids.Agone}/status`, { status: "shortlisted" }],
    ["POST", "/api/jobs/interviews/schedule", { applicationId: String(ids.Agone), interviewDate: in2days }],
    ["PUT", `/api/jobs/interviews/reschedule/${ids.Agone}`, { interviewDate: in2days }],
    ["DELETE", `/api/jobs/interviews/cancel/${ids.Agone}`],
    ["PATCH", `/api/jobs/interviews/complete/${ids.Agone}`],
    ["PATCH", "/api/jobs/candidates/bulk-status", { candidateIds: [String(ids.Agone)], status: "rejected" }],
  ];
  const got2 = [];
  for (const who of ["E1", "admin"]) for (const [m, u, b] of gone) got2.push([who, m, u, (await call(m, u, { tok: T[who], body: b })).status]);
  check("an application whose job no longer exists: 404 for the employer and the admin, none 500", got2.every((g) => g[3] === 404), got2.map((g) => `${g[0]} ${g[1]} ${g[2].replace(/\/api\/jobs/, "")} ${g[3]}`).join(" | "));
  r = await call("GET", `/api/jobs/candidates/${ids.Agone}`, { tok: T.E1 });
  const r2 = await call("GET", `/api/jobs/candidates/${ids.Agone}`, { tok: T.S2 });
  check("candidate detail with a missing job: 403 for an employer, 200 for the candidate", r.status === 403 && r2.status === 200, `${r.status} ${r2.status}`);

  console.log("── 17. interview reminders, 24 h and 1 h before (through the outbox)");
  const reminderRows = (ivId, kind) => outbox((o) => o.kind === "reminder" && same(o.interview, ivId) && (!kind || o.eventType === `INTERVIEW_REMINDER_${kind}`));
  ids.J8 = oid();
  fake.seed(coll("Job"), [job(ids.J8, ids.E1, "Mobile dev")]);
  for (const who of ["S1", "S2"]) await call("POST", `/api/jobs/apply/${ids.J8}`, { tok: T[who], body: applyBody(who) });
  ctx.A8 = rows("JobApplication", (a) => same(a.userId, ids.S1) && same(a.jobId, ids.J8))[0]._id;
  ctx.A9 = rows("JobApplication", (a) => same(a.userId, ids.S2) && same(a.jobId, ids.J8))[0]._id;
  const T0 = Date.now();
  const slot8 = { ...slot, startsAt: new Date(T0 + 20 * 3600e3).toISOString() };
  const slot9 = { ...slot, startsAt: new Date(T0 + 21 * 3600e3).toISOString(), meetingLink: "https://meet.example.test/nine" };
  for (const [a, s, tok] of [[ctx.A8, slot8, T.S1], [ctx.A9, slot9, T.S2]]) {
    await call("POST", `/api/career/applications/${a}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: 1 } });
    await call("POST", "/api/career/interviews", { tok: T.E1, body: { applicationId: String(a), version: 2, ...s } });
  }
  const iv8 = rows("CareerInterview", (i) => same(i.application, ctx.A8))[0];
  const iv9 = rows("CareerInterview", (i) => same(i.application, ctx.A9))[0];
  await call("POST", `/api/career/interviews/${iv8._id}/respond`, { tok: T.S1, body: { version: await ver(ctx.A8, T.S1), response: "accept" } });
  // iv9 stays "invited" (not accepted)
  const evBeforeRem = rows("CareerApplicationEvent").length;
  gateway.send = async () => ({ sent: true });
  await job7.tick(new Date(T0));
  check("20 h before: 24 h reminders queued for the accepted interview: candidate push + in-app, employer in-app", reminderRows(iv8._id, "24H").length === 3 && reminderRows(iv8._id, "24H").filter((o) => same(o.recipient, ids.S1)).map((o) => o.channel).sort().join() === "inapp,push" && reminderRows(iv8._id, "24H").some((o) => same(o.recipient, ids.E1) && o.channel === "inapp"), reminderRows(iv8._id).map((o) => `${o.channel}:${o.status}`).join());
  check("…delivered on the same tick; the text has the job, company, Karachi time; no e-mail / phone", reminderRows(iv8._id, "24H").every((o) => o.status === "sent") && reminderRows(iv8._id, "24H").every((o) => o.payload.body.includes("Mobile dev") && /Asia\/Karachi/.test(o.payload.body) && !/@|0300/.test(JSON.stringify(o.payload))));
  check("an interview not accepted yet gets no reminder", reminderRows(iv9._id).length === 0);
  await job7.tick(new Date(T0 + 5 * 60e3));
  await job7.tick(new Date(T0 + 3 * 3600e3));
  check("later ticks queue nothing new for it (one 24 h reminder per slot); no event written", reminderRows(iv8._id, "24H").length === 3 && rows("CareerApplicationEvent").length === evBeforeRem);
  const saved = process.env.FLAG_CAREER_TIMELINE;
  process.env.FLAG_CAREER_TIMELINE = `ids:${ids.E1},${ids.E2}`; // the students leave the pilot
  await job7.tick(new Date(T0 + 19.5 * 3600e3));
  check("outside the pilot: no 1 h reminder", reminderRows(iv8._id, "1H").length === 0);
  process.env.FLAG_CAREER_TIMELINE = saved;
  gateway.send = async () => ({ sent: false, reason: "quiet_hours" });
  await job7.tick(new Date(T0 + 19.4 * 3600e3)); // 36 minutes before
  const push1h = () => reminderRows(iv8._id, "1H").find((o) => o.channel === "push");
  check("in the last hour: 1 h reminders queued; the in-app ones delivered, the push held back by quiet hours", reminderRows(iv8._id, "1H").length === 3 && reminderRows(iv8._id, "1H").filter((o) => o.channel === "inapp").every((o) => o.status === "sent") && push1h().status === "pending" && push1h().lastError === "quiet_hours", reminderRows(iv8._id, "1H").map((o) => `${o.channel}:${o.status}:${o.lastError}`).join());
  gateway.send = async () => ({ sent: true });
  await job7.tick(new Date(T0 + 20.2 * 3600e3)); // after the start
  check("quiet hours end after the interview started: the push is dropped (expired), never sent late", push1h().status === "skipped" && push1h().lastError === "expired", `${push1h().status} ${push1h().lastError}`);
  // iv9: accepted, reminders queued while quiet hours hold the push, then the employer cancels
  await call("POST", `/api/career/interviews/${iv9._id}/respond`, { tok: T.S2, body: { version: await ver(ctx.A9, T.S2), response: "accept" } });
  gateway.send = async () => ({ sent: false, reason: "quiet_hours" });
  await job7.tick(new Date(T0 + 1 * 3600e3));
  const push9 = () => reminderRows(iv9._id, "24H").find((o) => o.channel === "push");
  check("A9 accepted: its 24 h push reminder waits for quiet hours to end", push9()?.status === "pending", push9() && push9().status);
  r = await call("POST", `/api/career/interviews/${iv9._id}/cancel`, { tok: T.E1, body: { version: await ver(ctx.A9) } });
  gateway.send = async () => ({ sent: true });
  await job7.tick(new Date(T0 + 2 * 3600e3));
  check("the employer cancels: the waiting reminder is dropped ('interview changed'), not sent", r.status === 201 && push9().status === "skipped" && push9().lastError === "interview changed", push9() && `${push9().status} ${push9().lastError}`);
  check("reminders never write timeline events", rows("CareerApplicationEvent", (e) => /REMINDER/.test(e.type)).length === 0);
  check("dueKind: 24 h window (1 h, 24 h], 1 h window (0, 1 h], nothing outside", reqS("./services/career/careerReminderService").dueKind(25 * 3600e3) === null && reqS("./services/career/careerReminderService").dueKind(2 * 3600e3) === "24h" && reqS("./services/career/careerReminderService").dueKind(30 * 60e3) === "1h" && reqS("./services/career/careerReminderService").dueKind(-1) === null);
  gateway.send = realSend;

  // @@MORE@@

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses; /api/career has no contact details, resume files or secrets`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
