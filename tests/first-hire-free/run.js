// First Hire Free (Sprint 6): company verification (free-mail refused, duplicates to review), idempotent
// activation, one trial per company group, consumed only by a verified hire and exactly once, the second
// hire pending pricing, revoke within 7 days restores (not after), admin decisions with reasons and audit,
// isolation between companies, real summary counts, flag off = Sprint 3 unchanged, leak scan.
//   node tests/first-hire-free/run.js [serverDir]
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
for (const m of ["User", "Job", "JobApplication", "JobInteraction", "Notification", "DomainEvent", "EngagementProfile", "PointsLedger", "RedemptionGuard", "PushLog", "CareerApplicationEvent", "CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox", "EmployerCompanyVerification", "EmployerHiringTrial", "EmployerHiringBillingEvent", "CareerAdminAudit"]) reqS(`./models/${m}`);
const trialService = reqS("./services/career/trialService");

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
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
    const leaks = HIDDEN.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks, text, who: req.headers.authorization || "" });
    return send(body);
  };
  next();
});
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/jobs", reqS("./routes/jobs.routes"));
app.use("/api/career", reqS("./routes/careerTrial.routes"));
app.use("/api/career", reqS("./routes/career.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["E1", "E2", "E3", "E4", "E5", "S1", "S2", "S3", "S4", "S5", "S6", "admin"]) ids[k] = oid();
const user = (id, role, name, email) => ({ _id: id, name, email: email || `${name.replace(/ /g, "")}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: role === "employee" ? "Not Verified" : "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("User"), [
  user(ids.E1, "employee", "Hina Bright", "hina@brightlabs.pk"), user(ids.E2, "employee", "Omar Bright", "omar@brightlabs.pk"), user(ids.E3, "employee", "Zara Lookalike", "zara@brightlabs-careers.pk"),
  user(ids.E4, "employee", "Ali Nova", "ali@novasystems.com"), user(ids.E5, "employee", "Not In Pilot", "x@offpilot.pk"),
  ...["S1", "S2", "S3", "S4", "S5", "S6"].map((k) => user(ids[k], "student", `Student ${k}`)), user(ids.admin, "admin", "admin"),
]);
const job = (id, by, title) => ({ _id: id, title, department: "Engineering", location: "Karachi", type: "Full-time", salaryRange: "100k", contactEmail: "jobs@test.local", description: "build things", companyName: "Bright Labs", postedBy: by, isExternal: false, active: true, archivedAt: null, createdAt: new Date() });
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
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
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
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const billing = (f = () => true) => rows("EmployerHiringBillingEvent", f);
const trials = () => rows("EmployerHiringTrial");

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["E1", "E2", "E3", "E4", "E5", "S1", "S2", "S3", "S4", "S5", "S6"].map((k) => [k, token(k, /^S/.test(k) ? "student" : "employee")]));
  T.admin = token("admin", "admin");
  let r;
  const B = "/api/career";
  process.env.FLAG_CAREER_TIMELINE = `ids:${Object.values(ids).join(",")}`;

  // a hire through the real Sprint 3 routes: apply -> shortlist -> offer -> accept -> (confirm)
  const ver = async (appId, tok) => (await call("GET", `${B}/applications/${appId}/timeline`, { tok })).json.data.version;
  async function toAccepted(employer, student, title) {
    const jobId = oid();
    fake.seed(coll("Job"), [job(jobId, ids[employer], title)]);
    await call("POST", `/api/jobs/apply/${jobId}`, { tok: T[student], body: { fullName: `${student} full name`, email: `${student}@test.local`, phone: "03001234567", coverLetter: "hello" } });
    const appId = rows("JobApplication", (a) => same(a.jobId, jobId))[0]._id;
    await call("POST", `${B}/applications/${appId}/events`, { tok: T[employer], body: { type: "SHORTLISTED", version: await ver(appId, T[employer]) } });
    await call("POST", `${B}/offers`, { tok: T[employer], body: { applicationId: String(appId), version: await ver(appId, T[employer]), title, terms: "full time", expiresAt: inHours(24 * 7) } });
    const offer = rows("CareerOffer", (o) => same(o.application, appId))[0];
    await call("POST", `${B}/offers/${offer._id}/respond`, { tok: T[student], body: { version: await ver(appId, T[student]), response: "accept" } });
    return { appId, offer };
  }
  const confirm = async (employer, h) => call("POST", `${B}/offers/${h.offer._id}/confirm-hire`, { tok: T[employer], body: { version: await ver(h.appId, T[employer]) } });
  const hireEvent = (appId) => rows("CareerApplicationEvent", (e) => same(e.application, appId) && e.type === "HIRE_CONFIRMED").slice(-1)[0];

  // ---------- flag off ----------
  delete process.env.FLAG_EMPLOYER_FIRST_HIRE_FREE;
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E1 });
  check("flag off: the trial route is 404", r.status === 404 && r.json?.error?.code === "FIRST_HIRE_FREE_OFF");
  r = await call("GET", `${B}/admin/verifications`, { tok: T.admin });
  check("flag off: admin pages are 404 too", r.status === 404);
  const off = await toAccepted("E1", "S6", "Pre-pilot role");
  r = await confirm("E1", off);
  await tick();
  check("flag off: a Sprint 3 hire works as before and writes no billing row", r.status === 201 && rows("CareerOutcome", (o) => same(o.application, off.appId) && o.verificationLevel === "verified").length === 1 && billing().length === 0, r.text.slice(0, 120));
  r = await call("GET", "/api/app/flags/me", { tok: T.E1 });
  check("flag off: /flags/me says employerFirstHireFree false", JSON.stringify(r.json).includes('"employerFirstHireFree":false'));

  process.env.FLAG_EMPLOYER_FIRST_HIRE_FREE = `ids:${ids.E1},${ids.E2},${ids.E3},${ids.E4}`;
  r = await call("GET", "/api/app/flags/me", { tok: T.E1 });
  check("pilot employer: /flags/me says employerFirstHireFree true", JSON.stringify(r.json).includes('"employerFirstHireFree":true'));
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E5 });
  check("an employer outside the pilot still gets 404", r.status === 404);
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.S1 });
  check("a student can't use the employer routes", [403, 404].includes(r.status));

  // ---------- verification ----------
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E1 });
  check("not activated: next step 'verify your company', the policy shown, no prices", r.status === 200 && r.json.data.status === "not_activated" && r.json.data.nextAction.action === "verify_company" && /first verified hire/i.test(r.json.data.policy.text) && /coming soon/.test(r.json.data.policy.furtherHires) && !/PKR\s*\d|Rs\.?\s*\d/.test(r.text));
  const details = (extra = {}) => ({ companyName: "Bright Labs (Pvt) Ltd", registrationType: "ntn", ntnOrSecp: "1234567-8", businessEmailDomain: "brightlabs.pk", website: "https://www.brightlabs.pk/about", ...extra });
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details({ businessEmailDomain: "gmail.com" }) });
  check("a free-mail domain is refused (Gmail)", r.status === 400 && r.json.error.code === "FREE_MAIL_DOMAIN");
  for (const d of ["yahoo.com", "outlook.com", "hotmail.co.uk", "icloud.com"]) {
    r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details({ businessEmailDomain: d }) });
    if (r.json?.error?.code !== "FREE_MAIL_DOMAIN") check(`free mail ${d} refused`, false, r.text);
  }
  check("Yahoo, Outlook, Hotmail, iCloud are refused too", true);
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details({ ntnOrSecp: "12-3" }) });
  check("a registration number in the wrong format is refused", r.status === 400 && r.json.error.code === "INVALID_REGISTRATION");
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details({ website: "not a website" }) });
  check("a website that isn't one is refused", r.status === 400 && r.json.error.code === "INVALID_WEBSITE");
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details() });
  check("valid details: 201 pending, normalized (NTN 12345678, website brightlabs.pk), sign-in e-mail matches the domain", r.status === 201 && r.json.data.verification.status === "pending" && r.json.data.verification.ntnOrSecp === "12345678" && r.json.data.verification.website === "brightlabs.pk" && rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E1))[0].signInEmailMatchesDomain === true, r.text.slice(0, 200));
  const v1 = r.json.data.verification.id;
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: details() });
  check("the same details again: 200, the same record (idempotent per employer)", r.status === 200 && r.json.data.verification.id === v1 && rows("EmployerCompanyVerification").length === 1);
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E1 });
  check("activating before approval is refused", r.status === 409 && r.json.error.code === "VERIFICATION_NOT_APPROVED");
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E2, body: details({ businessEmailDomain: "brightlabs.pk", website: "brightlabs.pk" }) });
  check("a second account with the same NTN: duplicate_review", r.status === 201 && r.json.data.verification.status === "duplicate_review");
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E3, body: details({ companyName: "Bright Careers", ntnOrSecp: "7654321-0", businessEmailDomain: "brightlabs-careers.pk", website: "brightlabs.pk" }) });
  check("a different NTN but the same website: duplicate_review", r.status === 201 && r.json.data.verification.status === "duplicate_review");
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E4, body: { companyName: "Nova Systems", registrationType: "secp", ntnOrSecp: "SECP 0098765", businessEmailDomain: "novasystems.com", website: "novasystems.com" } });
  check("another company (SECP number): pending", r.status === 201 && r.json.data.verification.status === "pending" && r.json.data.verification.ntnOrSecp === "SECP0098765");

  // ---------- admin review ----------
  r = await call("GET", `${B}/admin/verifications?status=duplicate_review`, { tok: T.E1 });
  check("an employer can't open admin pages (403)", r.status === 403);
  r = await call("GET", `${B}/admin/verifications?status=duplicate_review`, { tok: T.admin });
  const e3v = r.json.data.find((v) => v.employer.id === String(ids.E3));
  check("admin: the duplicate queue says what matched and with whom", r.status === 200 && r.json.data.length === 2 && e3v.duplicateOf[0].matchedOn.includes("website") && e3v.duplicateOf[0].employer.name === "Hina Bright" && r.json.data.find((v) => v.employer.id === String(ids.E2)).duplicateOf[0].matchedOn.includes("registration number"));
  r = await call("POST", `${B}/admin/verifications/${v1}/review`, { tok: T.admin, body: { action: "approve" } });
  check("a decision without a reason: 400", r.status === 400 && r.json.error.code === "REASON_REQUIRED");
  r = await call("POST", `${B}/admin/verifications/${v1}/review`, { tok: T.admin, body: { action: "approve", reason: "NTN checked on FBR; domain owned" } });
  check("admin approves with a reason; it's audited", r.status === 200 && r.json.data.status === "approved" && rows("CareerAdminAudit", (a) => same(a.targetId, v1) && a.action === "verification.approve" && a.reason === "NTN checked on FBR; domain owned" && same(a.admin, ids.admin)).length === 1);

  // ---------- activation ----------
  const acts = await Promise.all([1, 2, 3].map(() => call("POST", `${B}/employers/me/trial/activate`, { tok: T.E1 })));
  check("3 simultaneous activations: one trial", trials().length === 1 && acts.every((x) => [200, 201].includes(x.status)) && acts.some((x) => x.status === 201), acts.map((x) => x.status).join());
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E1 });
  check("activating again: 200, the same trial (idempotent)", r.status === 200 && r.json.data.status === "active" && r.json.data.remainingFreeHires === 1 && trials().length === 1);
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E3 });
  check("employer B (not approved) can't activate", r.status === 409);
  const e3vid = rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E3))[0]._id;
  await call("POST", `${B}/admin/verifications/${e3vid}/review`, { tok: T.admin, body: { action: "approve", reason: "same company, careers team account" } });
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E3 });
  check("a duplicate approved into the same company group shares its trial: no second trial", [200, 201].includes(r.status) && trials().length === 1 && r.json.data.status === "active");
  const e2vid = rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E2))[0]._id;
  r = await call("POST", `${B}/admin/verifications/${e2vid}/review`, { tok: T.admin, body: { action: "reject", reason: "personal account, not the company" } });
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E2 });
  check("rejected: activation refused; the employer sees the admin's reason", r.status === 409 && (await call("GET", `${B}/employers/me/trial`, { tok: T.E2 })).json.data.verification.reason === "personal account, not the company");
  r = await call("POST", `${B}/admin/verifications/${e3vid}/review`, { tok: T.admin, body: { action: "approve", reason: "split", separateGroup: true } });
  check("admin can approve a lookalike as its own company group (different NTN), with a reason", r.status === 200 && r.json.data.companyGroupKey === "reg:76543210");
  await call("POST", `${B}/admin/verifications/${e3vid}/review`, { tok: T.admin, body: { action: "mark_duplicate", reason: "no: same company after all" } });
  rows("EmployerCompanyVerification", (v) => same(v._id, e3vid))[0].companyGroupKey = "reg:12345678";
  await call("POST", `${B}/admin/verifications/${e3vid}/review`, { tok: T.admin, body: { action: "approve", reason: "same company: careers account" } });
  const e4vid = rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E4))[0]._id;
  await call("POST", `${B}/admin/verifications/${e4vid}/review`, { tok: T.admin, body: { action: "approve", reason: "SECP record checked" } });
  await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E4 });
  check("another company gets its own trial", trials().length === 2);

  // ---------- consumed only on a verified hire ----------
  const h1 = await toAccepted("E1", "S1", "Backend dev");
  const t1 = () => trials().find((t) => t.companyGroupKey === "reg:12345678");
  check("application, shortlist, offer, offer accepted: the trial isn't touched", t1().eligibilityStatus === "active" && t1().consumedCount === 0 && billing().length === 0);
  r = await confirm("E1", h1);
  await tick();
  const b1 = billing((b) => same(b.applicationId, h1.appId));
  check("the first verified hire: fee 0, free_hire_consumed (feeWaived), trial Used", r.status === 201 && b1.length === 1 && b1[0].eventType === "free_hire_consumed" && b1[0].feeWaived === true && b1[0].amount === 0 && b1[0].currency === "PKR" && t1().eligibilityStatus === "used" && same(t1().consumedByApplicationId, h1.appId), JSON.stringify(b1));
  const ev1 = hireEvent(h1.appId);
  await Promise.all([1, 2, 3, 4, 5].map(() => trialService.onVerifiedHire(ev1)));
  await trialService.reconcile();
  check("the pre-pilot hire (confirmed while the flag was off) is never picked up later", billing((b) => same(b.applicationId, off.appId)).length === 0);
  check("5 duplicate callbacks + a reconcile: still one billing row, consumed once", billing((b) => same(b.applicationId, h1.appId)).length === 1 && t1().consumedCount === 1);
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E1 });
  check("the employer sees Used, 0 free hires left, 'pricing for further hires is coming soon'", r.json.data.status === "used" && r.json.data.remainingFreeHires === 0 && /coming soon/.test(r.json.data.nextAction.label));
  const h2 = await toAccepted("E3", "S2", "Designer");
  await confirm("E3", h2);
  await tick();
  const b2 = billing((b) => same(b.applicationId, h2.appId));
  check("the company's second verified hire (another account of it) isn't free: hire_billable_pending_pricing, amount null", b2.length === 1 && b2[0].eventType === "hire_billable_pending_pricing" && b2[0].amount === null && b2[0].feeWaived === false);

  // ---------- revoke within 7 days restores; after 7 days doesn't ----------
  r = await call("POST", `${B}/applications/${h1.appId}/events`, { tok: T.S1, body: { type: "HIRE_DISPUTED", version: await ver(h1.appId, T.S1), note: "the job was withdrawn after I accepted" } });
  await tick();
  check("a dispute within 7 days revokes the hire and restores the free hire (free_hire_restored)", r.status === 201 && t1().eligibilityStatus === "active" && t1().consumedCount === 0 && billing((b) => same(b.applicationId, h1.appId) && b.eventType === "free_hire_restored").length === 1 && t1().history.some((x) => x.action === "restored"));
  await trialService.reconcile();
  check("a reconcile doesn't restore twice", billing((b) => b.eventType === "free_hire_restored").length === 1);

  // ---------- an admin never confirms a hire or uses the free hire ----------
  const hA = await toAccepted("E1", "S4", "Analyst");
  const billingBefore = billing().length;
  r = await confirm("admin", hA);
  await tick();
  check("an admin can't confirm a hire for the employer (403 EMPLOYER_ONLY): the free hire stays Active, no billing row", r.status === 403 && r.json?.error?.code === "EMPLOYER_ONLY" && t1().eligibilityStatus === "active" && t1().consumedCount === 0 && billing().length === billingBefore, r.text.slice(0, 160));
  const forged = { ...hireEvent(h1.appId), _id: oid(), actorRole: "admin", occurredAt: new Date() };
  const fr = await trialService.onVerifiedHire(forged);
  check("a hire event recorded by an admin is never billed and never uses the free hire (hook guard)", fr.skipped === "not confirmed by the employer" && t1().consumedCount === 0 && billing().length === billingBefore, JSON.stringify(fr));
  // ---------- an admin rejects a dispute: the restored hire counts again, exactly once ----------
  // the company's ledger always matches its trial: free hires consumed - restored = the trial's consumedCount
  const ledgerMatches = () => billing((b) => b.companyGroupKey === t1().companyGroupKey && b.eventType === "free_hire_consumed").length - billing((b) => b.companyGroupKey === t1().companyGroupKey && b.eventType === "free_hire_restored").length === t1().consumedCount;
  const restoreEvent = (appId) => rows("CareerApplicationEvent", (e) => same(e.application, appId) && e.type === "HIRE_RESTORED").slice(-1)[0];
  const audits0 = rows("CareerAdminAudit").length;
  r = await call("POST", `${B}/applications/${h1.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(h1.appId, T.admin), note: "dispute rejected: payslip checked" } });
  await tick();
  const h1rows = billing((b) => same(b.applicationId, h1.appId));
  check("dispute → restore: the trial is Used again by this hire (free_hire_consumed again, fee 0)", r.status === 201 && t1().eligibilityStatus === "used" && t1().consumedCount === 1 && same(t1().consumedByApplicationId, h1.appId) && h1rows.map((b) => b.eventType).join() === "free_hire_consumed,free_hire_restored,free_hire_consumed" && h1rows[2].amount === 0 && h1rows[2].feeWaived === true, `${r.status} ${t1().eligibilityStatus} ${h1rows.map((b) => b.eventType).join()}`);
  check("…audited: the admin and the reason they gave", rows("CareerAdminAudit").length === audits0 + 1 && rows("CareerAdminAudit").slice(-1).every((a) => a.action === "trial.restored_hire_used_free_hire" && same(a.admin, ids.admin) && /payslip checked/.test(a.reason)));
  const ev = restoreEvent(h1.appId);
  await Promise.all([1, 2, 3, 4, 5].map(() => trialService.onHireRestored(ev)));
  await trialService.reconcile();
  check("5 more callbacks + a reconcile: still one row for the restore, the trial used once, no second audit", billing((b) => same(b.applicationId, h1.appId)).length === 3 && t1().consumedCount === 1 && rows("CareerAdminAudit").length === audits0 + 1);
  check("the ledger matches the trial (consumed - restored = 1)", ledgerMatches());
  r = await call("POST", `${B}/applications/${h1.appId}/events`, { tok: T.admin, body: { type: "HIRE_REVOKED", version: await ver(h1.appId, T.admin), note: "hire record entered twice (ticket 81)" } });
  await tick();
  check("restore → admin revokes again within 7 days: the free hire comes back once more, ledger still matches", r.status === 201 && t1().eligibilityStatus === "active" && t1().consumedCount === 0 && billing((b) => same(b.applicationId, h1.appId)).length === 4 && ledgerMatches());

  // a free hire, disputed (the free hire comes back), then another hire uses it, then the dispute is rejected
  const hX = await toAccepted("E1", "S5", "Support analyst");
  await confirm("E1", hX);
  await tick();
  r = await call("POST", `${B}/applications/${hX.appId}/events`, { tok: T.S5, body: { type: "HIRE_DISPUTED", version: await ver(hX.appId, T.S5), note: "I declined on the first day" } });
  await tick();
  check("hire X used the free hire, then its dispute gave it back", r.status === 201 && t1().eligibilityStatus === "active" && billing((b) => same(b.applicationId, hX.appId)).map((b) => b.eventType).join() === "free_hire_consumed,free_hire_restored");
  const h3 = await toAccepted("E1", "S3", "QA engineer");
  await confirm("E1", h3);
  await tick();
  check("the restored free hire is used by the next verified hire", billing((b) => same(b.applicationId, h3.appId))[0]?.eventType === "free_hire_consumed" && t1().eligibilityStatus === "used");
  const audits1 = rows("CareerAdminAudit").length;
  r = await call("POST", `${B}/applications/${hX.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(hX.appId, T.admin), note: "dispute rejected: contract signed" } });
  await tick();
  await trialService.reconcile();
  const hXrows = billing((b) => same(b.applicationId, hX.appId));
  check("restore after another hire took the free hire: hire_billable_pending_pricing (amount null), the trial stays with hire 3", r.status === 201 && hXrows.length === 3 && hXrows[2].eventType === "hire_billable_pending_pricing" && hXrows[2].amount === null && same(t1().consumedByApplicationId, h3.appId) && t1().consumedCount === 1 && ledgerMatches(), hXrows.map((b) => b.eventType).join());
  check("…audited as pending pricing with the reason", rows("CareerAdminAudit").length === audits1 + 1 && rows("CareerAdminAudit").slice(-1)[0].action === "trial.restored_hire_pending_pricing" && /contract signed/.test(rows("CareerAdminAudit").slice(-1)[0].reason));

  // a hire that was never free (pending pricing) is disputed and restored: its pending row still stands
  r = await call("POST", `${B}/applications/${h2.appId}/events`, { tok: T.S2, body: { type: "HIRE_DISPUTED", version: await ver(h2.appId, T.S2), note: "not hired actually" } });
  await tick();
  r = await call("POST", `${B}/applications/${h2.appId}/events`, { tok: T.admin, body: { type: "HIRE_RESTORED", version: await ver(h2.appId, T.admin), note: "dispute rejected: start letter seen" } });
  await tick();
  await trialService.reconcile();
  check("a pending-pricing hire disputed and restored: still one pending row (no double counting)", r.status === 201 && billing((b) => same(b.applicationId, h2.appId)).length === 1 && billing((b) => same(b.applicationId, h2.appId))[0].eventType === "hire_billable_pending_pricing" && ledgerMatches());
  t1().consumedAt = new Date(Date.now() - 8 * 864e5);
  hireEvent(h3.appId).occurredAt = new Date(Date.now() - 8 * 864e5);
  const restoredBefore = billing((b) => b.eventType === "free_hire_restored").length;
  r = await call("POST", `${B}/applications/${h3.appId}/events`, { tok: T.admin, body: { type: "HIRE_REVOKED", version: await ver(h3.appId, T.admin), note: "duplicate record found 8 days later" } });
  await tick();
  check("revoked after 7 days: not restored, the trial goes to Under review", r.status === 201 && t1().eligibilityStatus === "under_review" && t1().fraudReviewStatus === "open" && billing((b) => b.eventType === "free_hire_restored").length === restoredBefore, `${r.status} ${t1().eligibilityStatus}`);
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E1 });
  check("the employer sees Under review", r.json.data.status === "under_review" && r.json.data.nextAction.action === "wait_for_review");

  // ---------- admin trial decisions ----------
  r = await call("GET", `${B}/admin/trials?status=under_review`, { tok: T.admin });
  const tv = r.json.data.trials[0];
  check("admin: the trial, which hire used it, the company's accounts", r.status === 200 && tv.status === "under_review" && tv.usedBy?.job === "QA engineer" && tv.employers.length >= 2);
  r = await call("POST", `${B}/admin/trials/${tv.id}/review`, { tok: T.admin, body: { action: "restore" } });
  check("a trial decision without a reason: 400", r.status === 400);
  r = await call("POST", `${B}/admin/trials/${tv.id}/review`, { tok: T.admin, body: { action: "keep", reason: "the hire happened; revoked only to fix a record" } });
  check("keep: back to Used; audited", r.status === 200 && r.json.data.status === "used" && rows("CareerAdminAudit", (a) => a.action === "trial.keep").length === 1);
  r = await call("POST", `${B}/admin/trials/${tv.id}/review`, { tok: T.admin, body: { action: "restore", reason: "goodwill after support ticket 77" } });
  check("restore: Active again with a free_hire_restored row; audited", r.status === 200 && r.json.data.status === "active" && billing((b) => b.eventType === "free_hire_restored" && /goodwill/.test(b.note)).length === 1 && rows("CareerAdminAudit", (a) => a.action === "trial.restore").length === 1);
  r = await call("POST", `${B}/admin/trials/${tv.id}/review`, { tok: T.admin, body: { action: "revoke", reason: "fraud: fake hires" } });
  check("revoke: no free hire left (Used, entitlement 0)", r.status === 200 && r.json.data.status === "used" && r.json.data.entitlementCount === 0);
  r = await call("GET", `${B}/admin/billing-events?eventType=free_hire_consumed`, { tok: T.admin });
  check("admin: the billing ledger, filtered (read-only; no amounts beyond 0 / null)", r.status === 200 && r.json.data.length >= 2 && r.json.data.every((b) => b.eventType === "free_hire_consumed" && b.amount === 0));
  check("every admin decision is in the audit with its reason", rows("CareerAdminAudit").every((a) => a.reason && a.reason.length >= 3 && a.admin) && rows("CareerAdminAudit").length === rows("CareerAdminAudit", (a) => /^(verification|trial)\./.test(a.action)).length);

  // ---------- two hires at once for a fresh company ----------
  const ha = await toAccepted("E4", "S4", "Analyst");
  const hb = await toAccepted("E4", "S5", "Support");
  await Promise.all([confirm("E4", ha), confirm("E4", hb)]);
  await tick(80);
  const nova = billing((b) => b.companyGroupKey === "reg:SECP0098765");
  check("two verified hires at the same moment: exactly one free, one pending pricing", nova.length === 2 && nova.filter((b) => b.eventType === "free_hire_consumed").length === 1 && nova.filter((b) => b.eventType === "hire_billable_pending_pricing").length === 1, nova.map((b) => b.eventType).join());

  // ---------- isolation ----------
  r = await call("GET", `${B}/employers/me/trial`, { tok: T.E4 });
  check("employer B sees only its own company and trial", r.json.data.verification.companyName === "Nova Systems" && !r.text.includes("12345678") && !r.text.includes("Bright"));
  const off2 = await toAccepted("E5", "S6", "Off pilot hire");
  await confirm("E5", off2);
  await tick();
  check("an employer outside the pilot: hires write no billing rows", billing((b) => same(b.employerUserId, ids.E5)).length === 0);

  // ---------- summary ----------
  r = await call("GET", `${B}/employers/me/trial/summary`, { tok: T.E1 });
  const e1Jobs = rows("Job", (j) => same(j.postedBy, ids.E1)).map((j) => String(j._id));
  const realApplicants = rows("JobApplication", (a) => e1Jobs.includes(String(a.jobId))).length;
  const realHires = rows("CareerOutcome", (o) => same(o.employer, ids.E1) && o.outcomeType === "hired" && o.verificationLevel === "verified").length;
  check("summary: real counts that match the records (applicants, verified hires), free hire used yes/no", r.status === 200 && r.json.data.applicants === realApplicants && r.json.data.verifiedHires === realHires && typeof r.json.data.freeHireUsed === "boolean" && r.json.data.completedInterviews === 0, JSON.stringify(r.json.data));

  // ---------- leak scan ----------
  const ntns = ["12345678", "76543210", "SECP0098765"];
  const studentReplies = responses.filter((x) => [T.S1, T.S2, T.S3, T.S4, T.S5, T.S6].some((t) => x.who.endsWith(t)));
  check("students never see a registration number", studentReplies.every((x) => !ntns.some((n) => x.text.includes(n))));
  const e4Replies = responses.filter((x) => x.who.endsWith(T.E4));
  check("an employer sees only its own registration number", e4Replies.every((x) => !x.text.includes("12345678") && !x.text.includes("76543210")));
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, no hidden user fields`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks}`).join(" | "));
  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url + " " + x.text.slice(0, 80)).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
