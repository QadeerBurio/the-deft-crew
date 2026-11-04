// Load and concurrency (Sprint 7), against the in-memory test database with interleaving (simultaneous
// requests really interleave between reads and writes); never against production. 50 requests at once for:
// redemptions (and one student tapping 50 times), holds on the last box and on 10 boxes, order confirms,
// approvals of one draft, hire confirmations with First Hire Free on. Reports p50 / p95 and duplicates.
//   node tests/load/run.js [serverDir]
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
for (const m of ["User", "Job", "JobApplication", "JobInteraction", "Notification", "DomainEvent", "EngagementProfile", "PointsLedger", "RedemptionGuard", "PushLog", "Offer", "Branch", "PromoCode", "PendingScan",
  "LoyaltyProgram", "LoyaltyLedger", "LoyaltySnapshot", "CareerApplicationEvent", "CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox", "Resume",
  "CareerResumeTailorJob", "CareerResumeDraft", "CareerResumeApprovedVersion", "SurplusListing", "SurplusInventoryHold", "SurplusOrder", "SurplusNotificationOutbox",
  "EmployerCompanyVerification", "EmployerHiringTrial", "EmployerHiringBillingEvent"]) reqS(`./models/${m}`);
reqS("./services/resumeStudio/ai").setCaller(async () => JSON.stringify({ suggestions: [] }));
reqS("./services/surplus/notifications").providers.push = async () => ({ status: "sent" });
process.env.SURPLUS_CODE_SECRET = "test-only-surplus-code-secret-0123456789abcdef";

const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/jobs", reqS("./routes/jobs.routes"));
app.use("/api/loyalty", reqS("./routes/loyalty.routes"));
app.use("/api/career/resume", reqS("./routes/careerResume.routes"));
app.use("/api/career", reqS("./routes/careerTrial.routes"));
app.use("/api/career", reqS("./routes/career.routes"));
app.use("/api/surplus", reqS("./routes/surplus.routes"));

const N = 50;
const oid = () => new mongoose.Types.ObjectId();
const ids = { B: oid(), E: oid(), A: oid(), BR: oid(), offer: oid(), R1: oid(), J1: oid() };
const students = Array.from({ length: N + 1 }, () => oid());
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [user(ids.B, "brand", "alpha", { brandName: "Alpha" }), user(ids.E, "employee", "hireco", { email: "hr@hireco.pk" }), user(ids.A, "admin", "admin"), ...students.map((id, i) => user(id, "student", `student${i}`))]);
fake.seed(coll("Branch"), [{ _id: ids.BR, brand: ids.B, name: "Alpha Clifton", location: "Clifton", city: "Karachi", isActive: true, createdAt: new Date() }]);
fake.seed(coll("Offer"), [{ _id: ids.offer, brand: ids.B, title: "Alpha 20%", discountPercentage: 20, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() }]);
fake.seed(coll("Job"), [{ _id: ids.J1, title: "Frontend dev", department: "Eng", location: "Karachi", type: "Full-time", salaryRange: "1", contactEmail: "j@test.local", description: "React developer", requirements: ["React"], skills: ["JavaScript"], companyName: "Hire Co", postedBy: ids.E, isExternal: false, active: true, archivedAt: null, createdAt: new Date() }]);
fake.seed(coll("Resume"), [{ _id: ids.R1, user: students[0], title: "r", createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-10-01"), personalInfo: { firstName: "S", lastName: "Z" }, professionalSummary: { summary: "Student who builds React apps." }, workExperience: [], education: [], projects: [], skills: [{ name: "React" }], certifications: [], languages: [] }]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { body, tok } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h, agent: false }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e), ms: 0 }));
    if (data != null) q.write(data);
    q.end();
  });
}
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10 : null; };
const results = [];
const report = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const statusCount = (rs) => Object.entries(rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})).map(([k, v]) => `${k}x${v}`).join(" ");
function record(name, rs, duplicates) {
  const ms = rs.map((r) => r.ms);
  const line = { name, requests: rs.length, p50: q(ms, 50), p95: q(ms, 95), statuses: statusCount(rs), duplicates };
  report.push(line);
  console.log(`  ${name}: ${line.requests} at once, p50 ${line.p50} ms, p95 ${line.p95} ms, ${line.statuses}, duplicates ${duplicates}`);
}

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const all = [...Object.values(ids), ...students].map(String).join(",");
  for (const f of ["LOYALTY_V2", "CAREER_TIMELINE", "RESUME_STUDIO_V2", "SURPLUS_BOXES", "EMPLOYER_FIRST_HIRE_FREE"]) process.env[`FLAG_${f}`] = `ids:${all}`;
  const TB = token(ids.B, "brand"), TE = token(ids.E, "employee"), TA = token(ids.A, "admin");
  const TS = students.map((s) => token(s, "student"));
  let kn = 0;
  const key = () => `load-${++kn}-${Date.now()}`;

  console.log("-- 1. 50 simultaneous redemptions (brand confirms the bill, loyalty on)");
  const prog = (await call("POST", "/api/loyalty/programs", { tok: TB, body: {} })).json.data;
  await call("PATCH", `/api/loyalty/programs/${prog.id || prog.program?.id}`, { tok: TB, body: { status: "active" } });
  let rs = await Promise.all(students.slice(0, N).map((s) => call("POST", "/api/offers/redeem-payment", { tok: TB, body: { offerId: String(ids.offer), userId: String(s), billAmount: 1000 } })));
  const offerDoc = () => rows("Offer", (o) => same(o._id, ids.offer))[0];
  const reds = offerDoc().redemptions;
  const credits = rows("LoyaltyLedger", (l) => l.type === "CREDIT");
  const dupRedemptions = reds.length - new Set(reds.map((r) => String(r.student))).size;
  const dupCredits = credits.length - new Set(credits.map((c) => String(c.redemptionId))).size;
  record("redemptions, 50 different students", rs, dupRedemptions + dupCredits);
  check("50 students at once: 50 redemptions, one loyalty credit each, no duplicates", rs.every((r) => r.status === 200) && reds.length === N && credits.length === N && dupRedemptions === 0 && dupCredits === 0, `${reds.length} redemptions, ${credits.length} credits, ${statusCount(rs)}`);
  const one = students[N];
  rs = await Promise.all(Array.from({ length: N }, () => call("POST", "/api/offers/redeem-payment", { tok: TB, body: { offerId: String(ids.offer), userId: String(one), billAmount: 1000 } })));
  const mine = offerDoc().redemptions.filter((r) => same(r.student, one)).length;
  record("redemptions, 1 student x 50 taps (daily cap 2)", rs, Math.max(0, mine - 2));
  check("one student, 50 taps at once: the daily cap holds (2 redemptions, 2 credits)", mine === 2 && rows("LoyaltyLedger", (l) => same(l.student, one) && l.type === "CREDIT").length === 2, `${mine} redemptions`);

  console.log("-- 2. Surprise Box: holds on the last box, and on 10 boxes");
  const lb = (title, qty) => ({ branchId: String(ids.BR), title, allergenNotes: "contains gluten", quantityTotal: qty, listPrice: 1000, price: 400, pickupStart: inHours(3), pickupEnd: inHours(4), status: "published" });
  const last = (await call("POST", "/api/surplus/merchant/listings", { tok: TB, body: lb("Last box", 1) })).json.data.id;
  rs = await Promise.all(TS.slice(0, N).map((t) => call("POST", "/api/surplus/holds", { tok: t, body: { listingId: last, qty: 1, idempotencyKey: key() } })));
  const lastDoc = rows("SurplusListing", (l) => same(l._id, last))[0];
  const won = rs.filter((r) => r.status === 201).length;
  record("holds, 50 students on the last box", rs, Math.max(0, won - 1));
  check("the last box, 50 at once: exactly one hold, stock 0 (never negative)", won === 1 && lastDoc.quantityAvailable === 0, `${won} holds, stock ${lastDoc.quantityAvailable}`);
  const ten = (await call("POST", "/api/surplus/merchant/listings", { tok: TB, body: lb("Ten boxes", 10) })).json.data.id;
  rs = await Promise.all(TS.slice(0, N).map((t) => call("POST", "/api/surplus/holds", { tok: t, body: { listingId: ten, qty: 1, idempotencyKey: key() } })));
  const tenDoc = rows("SurplusListing", (l) => same(l._id, ten))[0];
  const held = rows("SurplusInventoryHold", (h) => same(h.listing, ten) && h.state === "active").reduce((n, h) => n + h.qty, 0);
  record("holds, 50 students on 10 boxes", rs, Math.max(0, held - 10));
  check("10 boxes, 50 at once: exactly 10 held, stock 0", held === 10 && tenDoc.quantityAvailable === 0, `${held} held, stock ${tenDoc.quantityAvailable}`);
  const winners = rs.map((r, i) => ({ r, i })).filter((x) => x.r.status === 201);
  const confirms = await Promise.all(winners.flatMap(({ r, i }) => { const k = key(); return [1, 2, 3].map(() => call("POST", "/api/surplus/orders", { tok: TS[i], body: { holdId: r.json.data.hold.id, idempotencyKey: k, acceptedTerms: true } })); }));
  const orders = rows("SurplusOrder", (o) => same(o.listing, ten));
  record("order confirms, 10 holders x 3 taps", confirms, orders.length - 10);
  check("10 holders tapping confirm 3 times each: 10 orders", orders.length === 10, `${orders.length} orders`);

  console.log("-- 3. Resume Studio: 50 simultaneous approvals of one draft");
  const tj = (await call("POST", "/api/career/resume/tailor-jobs", { tok: TS[0], body: { resumeId: String(ids.R1), jobId: String(ids.J1), idempotencyKey: key() } })).json.data;
  for (let i = 0; i < 100 && rows("CareerResumeTailorJob", (j) => same(j._id, tj.id))[0].status !== "succeeded"; i++) await tick(10);
  const draftId = String(rows("CareerResumeTailorJob", (j) => same(j._id, tj.id))[0].draftId);
  const d = (await call("GET", `/api/career/resume/drafts/${draftId}`, { tok: TS[0] })).json.data;
  rs = await Promise.all(Array.from({ length: N }, () => call("POST", `/api/career/resume/drafts/${draftId}/approve`, { tok: TS[0], body: { revision: d.revision, confirmAccurate: true, confirmReviewed: true } })));
  const versions = rows("CareerResumeApprovedVersion", (v) => same(v.draftId, draftId)).length;
  record("approvals, one draft x 50", rs, versions - 1);
  check("50 approvals at once: one version, every reply the same version", versions === 1 && new Set(rs.map((r) => r.json?.data?.version?.id)).size === 1, `${versions} versions, ${statusCount(rs)}`);

  console.log("-- 4. hire confirmations (First Hire Free on)");
  await call("POST", "/api/career/employers/me/verification", { tok: TE, body: { companyName: "Hire Co", registrationType: "ntn", ntnOrSecp: "1234567-8", businessEmailDomain: "hireco.pk", website: "hireco.pk" } });
  const cv = rows("EmployerCompanyVerification")[0]._id;
  await call("POST", `/api/career/admin/verifications/${cv}/review`, { tok: TA, body: { action: "approve", reason: "load test" } });
  await call("POST", "/api/career/employers/me/trial/activate", { tok: TE });
  const ver = async (appId, tok) => (await call("GET", `/api/career/applications/${appId}/timeline`, { tok })).json.data.version;
  await call("POST", `/api/jobs/apply/${ids.J1}`, { tok: TS[1], body: { fullName: "x", email: "x@test.local", phone: "03001234567", coverLetter: "hi" } });
  const appId = rows("JobApplication", (a) => same(a.jobId, ids.J1) && same(a.userId, students[1]))[0]._id;
  await call("POST", `/api/career/applications/${appId}/events`, { tok: TE, body: { type: "SHORTLISTED", version: await ver(appId, TE) } });
  await call("POST", "/api/career/offers", { tok: TE, body: { applicationId: String(appId), version: await ver(appId, TE), title: "dev", terms: "ft", expiresAt: inHours(48) } });
  const offerId = rows("CareerOffer", (o) => same(o.application, appId))[0]._id;
  await call("POST", `/api/career/offers/${offerId}/respond`, { tok: TS[1], body: { version: await ver(appId, TS[1]), response: "accept" } });
  const v = await ver(appId, TE);
  rs = await Promise.all(Array.from({ length: N }, () => call("POST", `/api/career/offers/${offerId}/confirm-hire`, { tok: TE, body: { version: v } })));
  await tick(100);
  const hires = rows("CareerApplicationEvent", (e) => same(e.application, appId) && e.type === "HIRE_CONFIRMED").length;
  const billing = rows("EmployerHiringBillingEvent", (b) => same(b.applicationId, appId)).length;
  const trial = rows("EmployerHiringTrial")[0];
  record("hire confirmations, one offer x 50", rs, (hires - 1) + (billing - 1));
  check("50 confirm-hires at once: one HIRE_CONFIRMED, one billing row, the free hire used once", hires === 1 && billing === 1 && trial.consumedCount === 1 && rs.filter((r) => r.status === 201).length === 1, `${hires} hires, ${billing} billing, ${statusCount(rs)}`);

  console.log("\nSummary (in-memory database with interleaving: timings show contention, not production speed)");
  console.log("| scenario | requests at once | p50 ms | p95 ms | statuses | duplicates |\n|---|---|---|---|---|---|");
  for (const l of report) console.log(`| ${l.name} | ${l.requests} | ${l.p50} | ${l.p95} | ${l.statuses} | ${l.duplicates} |`);
  check("no duplicates anywhere", report.every((l) => l.duplicates === 0));
  check("no 500s", report.length > 0 && !report.some((l) => /^5\d\d/.test(l.statuses) || / 5\d\dx/.test(l.statuses)));
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
