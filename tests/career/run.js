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

  // @@MORE@@

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses; /api/career has no contact details, resume files or secrets`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
