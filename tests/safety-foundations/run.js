// Safety foundations: feature flags (+ /api/app/flags/me), background-job switches (staging off),
// DomainEvent / recordOnce(), pending scans in a TTL collection, log redaction and request ids.
//   node tests/safety-foundations/run.js [serverDir]
// Same harness as tests/live-security: real routes, models and services, fake MongoDB with unique
// indexes and interleaving (simultaneous requests really interleave), no database, no network, no .env.
const path = require("path");
const fs = require("fs");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "BACKGROUND_JOBS", "META_EVENTS_ENABLED", "LOG_DEV_CODES"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

// ---------- what reaches stdout / stderr, after redaction ----------
const written = [];
for (const stream of [process.stdout, process.stderr]) {
  const w = stream.write.bind(stream);
  stream.write = (chunk, enc, cb) => { written.push(String(chunk)); return w(chunk, enc, cb); };
}
const logSafety = reqS("./utils/logSafety");
logSafety.install(); // wraps the capture above: what is captured is what would reach Railway

// ---------- stubs (before any server file loads) ----------
const expoSends = [];
class Expo {
  constructor() {}
  static isExpoPushToken() { return true; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { expoSends.push(...ms); return ms.map(() => ({ status: "ok", id: "ticket" })); }
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
for (const m of ["User", "Offer", "PromoCode", "Reward", "RewardRedemption", "EngagementProfile", "PointsLedger", "RedemptionGuard", "Notification", "University", "PendingScan", "DomainEvent"]) reqS(`./models/${m}`);
const flags = reqS("./config/featureFlags");
const { recordOnce } = reqS("./services/domainEvents");

// ---------- app (as server.js: request ids first) + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(logSafety.requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const text = Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body);
    let keys = new Set();
    try { keys = keysIn(JSON.parse(text)); } catch {}
    const leaks = HIDDEN.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks });
    return send(body);
  };
  next();
});
app.get("/test/log", (req, res) => { console.log("support asked about sana@uni.edu.pk, phone 0300-1234567"); res.json({ ok: true }); });
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/promo-codes", reqS("./routes/promoCode.routes"));
app.use("/api/rewards", reqS("./routes/rewards.routes"));
app.use("/api/engagement", reqS("./routes/engagement.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "B", "S1", "S2", "S3", "admin", "oA", "oB", "uni", "R1", "RC"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("universities", [{ _id: ids.uni, name: "SZABIST" }]);
fake.seed(coll("User"), [
  user(ids.A, "brand", "brandA", { brandName: "Alpha Cafe" }), user(ids.B, "brand", "brandB", { brandName: "Beta" }),
  user(ids.S1, "student", "sana", { rollNo: "21K-1", university: ids.uni }), user(ids.S2, "student", "taha", { rollNo: "21K-2" }),
  user(ids.S3, "student", "umar"), user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, title) => ({ _id: id, brand, title, discountPercentage: 20, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [ids.S1, ids.S2, ids.S3], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("Offer"), [offer(ids.oA, ids.A, "Alpha 20%"), offer(ids.oB, ids.B, "Beta deal")]);
fake.seed(coll("PromoCode"), [{ _id: oid(), code: "ALPEVENT01", offer: ids.oA, student: ids.S1, brand: ids.A, discountPercentage: 20, offerTitle: "Alpha 20%", brandName: "Alpha Cafe", status: "active", externalProvider: "none", expiresAt: new Date(Date.now() + 864e5), maxUses: 1, usedCount: 0, createdAt: new Date() }]);
fake.seed(coll("Reward"), [{ _id: ids.R1, title: "free coffee", costPoints: 100, active: true, perUserLimit: 1, stock: 5, brand: ids.A, kind: "voucher" }]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: ids.S1, points: { balance: 500, lifetime: 500 } }, { _id: oid(), user: ids.S2, points: { balance: 500, lifetime: 500 } }]);
fake.seed(coll("RewardRedemption"), [{ _id: ids.RC, user: ids.S3, reward: ids.R1, rewardBrand: ids.A, code: "TDC-EVT-USE", costPoints: 100, status: "active", expiresAt: new Date(Date.now() + 864e5), snapshot: { title: "free coffee", brand: ids.A } }]);
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
const events = (type) => rows("DomainEvent", (e) => e.type === type);
// async: the variables stay set until the promise settles
const withEnvAsync = async (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; } try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } } };
const withEnv = (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; } try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } } };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { A: token("A", "brand"), B: token("B", "brand"), S1: token("S1", "student"), S2: token("S2", "student"), S3: token("S3", "student"), admin: token("admin", "admin") };

  console.log("── 1. feature flags");
  check("metaEvents off by default", flags.isEnabled("metaEvents", { id: "u1", role: "student" }) === false);
  check("older META_EVENTS_ENABLED=true still switches it on", withEnv({ META_EVENTS_ENABLED: "true" }, () => flags.isEnabled("metaEvents", null)));
  check("FLAG_META_EVENTS wins over the older variable", withEnv({ META_EVENTS_ENABLED: "true", FLAG_META_EVENTS: "off" }, () => !flags.isEnabled("metaEvents", { id: "u" })));
  const pct = withEnv({ FLAG_META_EVENTS: "30%" }, () => Array.from({ length: 2000 }, (_, i) => flags.isEnabled("metaEvents", { id: `user${i}`, role: "student" })));
  const share = pct.filter(Boolean).length / pct.length;
  check("30% rollout reaches ~30% of users", share > 0.25 && share < 0.35, share.toFixed(3));
  check("…the same users every time", withEnv({ FLAG_META_EVENTS: "30%" }, () => Array.from({ length: 2000 }, (_, i) => flags.isEnabled("metaEvents", { id: `user${i}`, role: "student" })).every((v, i) => v === pct[i])));
  check("…and nobody signed out", withEnv({ FLAG_META_EVENTS: "100%" }, () => !flags.isEnabled("metaEvents", null)));
  check("roles:admin → admins only", withEnv({ FLAG_META_EVENTS: "roles:admin" }, () => flags.isEnabled("metaEvents", { id: "x", role: "admin" }) && !flags.isEnabled("metaEvents", { id: "y", role: "student" })));
  check("users:<id> → that user", withEnv({ FLAG_META_EVENTS: `users:${ids.S1}` }, () => flags.isEnabled("metaEvents", { id: String(ids.S1) }) && !flags.isEnabled("metaEvents", { id: String(ids.S2) })));
  check("rules combine: roles:admin;users:<id>", withEnv({ FLAG_META_EVENTS: `roles:admin;users:${ids.S2}` }, () => flags.isEnabled("metaEvents", { id: "z", role: "admin" }) && flags.isEnabled("metaEvents", { id: String(ids.S2), role: "student" })));
  check("an unreadable value keeps the default (off)", withEnv({ FLAG_META_EVENTS: "yes please" }, () => !flags.isEnabled("metaEvents", { id: "u" })));
  check("an unknown flag is off", flags.isEnabled("noSuchFlag", { id: "u" }) === false);
  let r = await call("GET", "/api/app/flags");
  check("GET /api/app/flags: same reply as before ({ metaEvents }), public cache", r.status === 200 && JSON.stringify(r.json) === '{"metaEvents":false}' && /public/.test(r.headers["cache-control"]), r.text);
  process.env.FLAG_META_EVENTS = `users:${ids.S1}`;
  r = await call("GET", "/api/app/flags/me", { tok: T.S1 });
  const r2 = await call("GET", "/api/app/flags/me", { tok: T.S2 });
  check("GET /api/app/flags/me: per user (S1 on, S2 off), never cached", r.json?.metaEvents === true && r2.json?.metaEvents === false && /no-store/.test(r.headers["cache-control"]), `${r.text} ${r2.text}`);
  check("…server-only flags are not listed", !("domainEvents" in (r.json || {})));
  process.env.FLAG_META_EVENTS = "roles:guest";
  r = await call("GET", "/api/app/flags/me");
  check("…a guest is evaluated as role guest", r.status === 200 && r.json?.metaEvents === true, r.text);
  r = await call("GET", "/api/app/flags/me", { headers: { authorization: "Bearer not-a-jwt" } });
  check("…a bad token → 401", r.status === 401, r.status);
  delete process.env.FLAG_META_EVENTS;

  console.log("── 2. background jobs");
  const ALL = Object.keys(flags.JOBS);
  check("production (nothing set): every job on", ALL.every((j) => flags.jobEnabled(j)), ALL.join());
  check("APP_ENV=staging: every job off", withEnv({ APP_ENV: "staging" }, () => ALL.every((j) => !flags.jobEnabled(j))));
  check("Railway's RAILWAY_ENVIRONMENT_NAME=staging alone: every job off", withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging" }, () => ALL.every((j) => !flags.jobEnabled(j))));
  check("staging + JOB_CHAT_SYNC=on: only chatSync on", withEnv({ APP_ENV: "staging", JOB_CHAT_SYNC: "on" }, () => ALL.filter((j) => flags.jobEnabled(j)).join() === "chatSync"));
  check("production + BACKGROUND_JOBS=off: every job off", withEnv({ BACKGROUND_JOBS: "off" }, () => ALL.every((j) => !flags.jobEnabled(j))));
  check("production + JOB_SOCIAL_PUSH=off: only that one off", withEnv({ JOB_SOCIAL_PUSH: "off" }, () => ALL.filter((j) => !flags.jobEnabled(j)).join() === "socialPush"));
  check("startup line names what runs", withEnv({ APP_ENV: "staging", JOB_PUSHES: "on" }, () => flags.describeJobs()) === `[jobs] staging: on pushes; off ${ALL.filter((j) => j !== "pushes").join(", ")}`);
  let threw = false; try { flags.jobEnabled("typo"); } catch { threw = true; }
  check("an unknown job name throws (a typo can't silently run or skip a job)", threw);
  const expoProjects = reqS("./utils/expoProjects");
  const msg = [{ to: "ExponentPushToken[test-device-1]", title: "hi", body: "x" }];
  const offTickets = (await withEnvAsync({ APP_ENV: "staging" }, () => expoProjects.sendByProject(msg))).tickets;
  check("staging: a push is not sent, ticket PUSHES_OFF", expoSends.length === 0 && offTickets[0]?.details?.error === "PUSHES_OFF", JSON.stringify(offTickets));
  const onTickets = (await expoProjects.sendByProject(msg)).tickets;
  check("production: the same push is sent", expoSends.length === 1 && onTickets[0]?.status === "ok", JSON.stringify(onTickets));
  // server.js starts each scheduler only behind its switch (it can't be started here: it connects to MongoDB)
  const src = fs.readFileSync(path.join(SERVER, "server.js"), "utf8").replace(/\r\n/g, "\n");
  // the call sits after its own guard and before the next guard
  const guarded = (call, job) => {
    const g = src.indexOf(`if (jobEnabled("${job}")) {`);
    const next = src.indexOf("if (jobEnabled(", g + 1);
    const c = src.indexOf(call, g);
    return g > -1 && c > g && (next === -1 || c < next);
  };
  check("server.js: each scheduler behind its switch", guarded("eventScheduler.initialize()", "eventIngestion") && guarded('require("./services/socialPush").startScheduler()', "socialPush") && guarded("archiveForeignImportedJobs()", "jobCleanup") && guarded("engagementScheduler.start()", "engagementScheduler") && guarded("schedulerService.initialize()", "chatSync"));
  check("server.js: no scheduler started outside a switch", (src.match(/eventScheduler\.initialize\(\)|startScheduler\(\)|engagementScheduler\.start\(\)|schedulerService\.initialize\(\)|cleanupExpiredJobs\(\)/g) || []).length === 6);
  check("server.js: log redaction installed before anything else", src.indexOf("logSafety.install()") > -1 && src.indexOf("logSafety.install()") < src.indexOf('require("express")') && src.indexOf("app.use(logSafety.requestId())") < src.indexOf("app.use(cors"));

  console.log("── 3. DomainEvent / recordOnce");
  const subj = { kind: "Offer", id: ids.oB };
  const first = await recordOnce("test.happened", "k1", { actor: ids.admin, subject: subj, data: { n: 1 } });
  const again = await recordOnce("test.happened", "k1", { actor: ids.admin, subject: subj, data: { n: 2 } });
  check("first write created, repeat not; the repeat returns the original", first.created === true && again.created === false && again.event?.data?.n === 1);
  const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => recordOnce("test.happened", "k2", { data: { n } })));
  check("5 simultaneous writes of one key → exactly one created, one row", burst.filter((x) => x.created).length === 1 && rows("DomainEvent", (e) => e.key === "test.happened:k2").length === 1, burst.map((x) => x.created).join());
  const off = await withEnvAsync({ FLAG_DOMAIN_EVENTS: "off" }, () => recordOnce("test.happened", "k3"));
  check("FLAG_DOMAIN_EVENTS=off → nothing written, skipped", off.skipped === true && rows("DomainEvent", (e) => e.key === "test.happened:k3").length === 0);
  threw = false; try { await recordOnce("", "x"); } catch { threw = true; }
  check("a type and a key are required", threw);

  console.log("── 4. pending scans (TTL collection) and their events");
  r = await call("POST", "/api/offers/scan-verify", { tok: T.S1, body: { offerId: String(ids.oA) } });
  const scanRow = rows("PendingScan", (p) => same(p.student, ids.S1))[0];
  const ttlMin = scanRow ? (new Date(scanRow.expiresAt) - new Date(scanRow.scannedAt)) / 60000 : 0;
  check("scan-verify → one PendingScan row, expires 30 min after the scan", r.status === 200 && scanRow && same(scanRow.brand, ids.A) && scanRow.status === "pending" && Math.round(ttlMin) === 30, `${r.status} ${ttlMin}`);
  check("…reply keeps its shape; scanId = the row id", r.json?.success === true && r.json.scanId === String(scanRow?._id) && r.json.student?.studentId === String(ids.S1) && r.json.student.universityName === "SZABIST" && r.json.student.brandId === String(ids.A));
  const PendingScan = reqS("./models/PendingScan");
  check("TTL index on expiresAt (MongoDB removes rows itself)", PendingScan.schema.indexes().some(([f, o]) => f.expiresAt === 1 && o.expireAfterSeconds === 0));
  let rs = await Promise.all([1, 2, 3].map(() => call("POST", "/api/offers/scan-verify", { tok: T.S2, body: { offerId: String(ids.oA) } })));
  check("3 simultaneous scans by one student → all 200, one pending row, one scanId", rs.every((x) => x.status === 200) && rows("PendingScan", (p) => same(p.student, ids.S2) && p.status === "pending").length === 1 && new Set(rs.map((x) => x.json?.scanId)).size === 1, statuses(rs));
  r = await call("POST", "/api/offers/scan-verify", { tok: T.S2, body: { offerId: String(ids.oB) } });
  check("the same student at another brand → a separate pending scan", r.status === 200 && rows("PendingScan", (p) => same(p.student, ids.S2) && p.status === "pending").length === 2);
  r = await call("GET", "/api/offers/pending-scans", { tok: T.A });
  const keys = "studentId,name,rollNo,university,universityName,email,offerId,offerTitle,discountPercentage,scannedAt,status,redemptionsUsed,maxRedemptions";
  check("pending-scans: brand A sees its 2, with the fields the portal reads", r.status === 200 && r.json.length === 2 && r.json.every((s) => keys.split(",").every((k) => k in s)), r.text.slice(0, 160));
  r = await call("GET", "/api/offers/pending-scans", { tok: T.B });
  check("pending-scans: brand B sees only its own", r.status === 200 && r.json.length === 1 && r.json[0].studentId === String(ids.S2) && r.json[0].offerId === String(ids.oB), r.text.slice(0, 120));
  // an expired row (MongoDB's TTL sweep runs every minute) is not shown meanwhile
  rows("PendingScan", (p) => same(p.student, ids.S1))[0].expiresAt = new Date(Date.now() - 1000);
  r = await call("GET", "/api/offers/pending-scans", { tok: T.A });
  check("an expired scan isn't listed while it waits for the TTL sweep", r.json.length === 1 && r.json[0].studentId === String(ids.S2));
  rs = await Promise.all([1, 2].map(() => call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S2), billAmount: 1000 } })));
  check("redeem-payment closes S2's scan at brand A only", rs.every((x) => x.status === 200) && rows("PendingScan", (p) => same(p.student, ids.S2) && same(p.brand, ids.A))[0].status === "processed" && rows("PendingScan", (p) => same(p.student, ids.S2) && same(p.brand, ids.B))[0].status === "pending", statuses(rs));
  check("…one offer.redeemed event per redemption (2), ids and amounts only", events("offer.redeemed").length === 2 && events("offer.redeemed").every((e) => same(e.actor, ids.A) && same(e.subject.id, ids.oA) && e.data.savedAmount === 200 && !JSON.stringify(e).includes("@")), JSON.stringify(events("offer.redeemed")[0]?.data));
  r = await call("POST", "/api/offers/scan-processed", { tok: T.A, body: { studentId: String(ids.S2) } });
  check("scan-processed by brand A: nothing of its own left pending → 404, brand B's scan untouched", r.status === 404 && rows("PendingScan", (p) => same(p.brand, ids.B))[0].status === "pending", r.status);
  r = await call("POST", "/api/offers/scan-processed", { tok: T.B, body: { studentId: String(ids.S2) } });
  check("scan-processed by brand B → closes its own", r.status === 200 && rows("PendingScan", (p) => same(p.brand, ids.B))[0].status === "processed", r.status);
  r = await call("POST", "/api/offers/scan-processed", { tok: T.A, body: { studentId: "not-an-id" } });
  check("scan-processed with a bad id → 404, no crash", r.status === 404, r.status);
  rs = await Promise.all([1, 2, 3].map(() => call("POST", "/api/promo-codes/verify", { tok: T.A, body: { promoCode: "ALPEVENT01", offerId: String(ids.oA), billAmount: 500 } })));
  check("promo verify ×3 at once → one promo.redeemed event", rs.filter((x) => x.status === 200).length === 1 && events("promo.redeemed").length === 1, statuses(rs));
  rs = await Promise.all([call("POST", `/api/rewards/${ids.R1}/redeem`, { tok: T.S1 }), call("POST", `/api/engagement/rewards/${ids.R1}/redeem`, { tok: T.S2 })]);
  check("a reward redeemed on each route → one reward.redeemed each", rs[0].status === 200 && rs[1].status === 201 && events("reward.redeemed").length === 2, statuses(rs));
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/engagement/brand/redemptions/${ids.RC}/use`, { tok: T.A })));
  check("brand 'use' ×2 at once → one reward.used event", rs.filter((x) => x.status === 200).length === 1 && events("reward.used").length === 1, statuses(rs));
  r = await withEnvAsync({ FLAG_DOMAIN_EVENTS: "off" }, () => call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S3), billAmount: 300 } }));
  check("events switched off: the redemption still succeeds, no event", r.status === 200 && events("offer.redeemed").length === 2, r.status);

  console.log("── 5. logs: redaction and request ids");
  written.length = 0;
  r = await call("GET", "/test/log", { headers: { "x-request-id": "support-ticket-42" } });
  const line = written.find((w) => w.includes("support asked")) || "";
  check("the caller's X-Request-Id comes back and starts the log line", r.headers["x-request-id"] === "support-ticket-42" && line.startsWith("[rid:support-ticket-42] "), line.trim());
  check("…e-mail and phone redacted in what was written", line.includes("***@uni.edu.pk") && line.includes("[phone]") && !line.includes("sana@") && !line.includes("1234567"), line.trim());
  r = await call("GET", "/test/log", { headers: { "x-request-id": "bad id <script>" } });
  check("a bad X-Request-Id is replaced by a fresh one", /^[a-f0-9]{12}$/.test(r.headers["x-request-id"] || ""), r.headers["x-request-id"]);
  r = await call("GET", "/api/app/flags");
  check("every response carries an X-Request-Id", /^[a-f0-9]{12}$/.test(r.headers["x-request-id"] || ""));
  const { redact } = logSafety;
  const samples = {
    "mongodb+srv://tdc:pw123@cluster0.abcd.mongodb.net/tdc?retryWrites=true": "mongodb://[redacted]",
    "redis://default:s3cret@redis.railway.internal:6379": "redis://[redacted]@redis.railway.internal:6379",
    "Bearer abc.def.ghijklmnop": "Bearer [redacted]",
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1Njc4In0.abcdefghijkl": "[jwt]",
    "ExponentPushToken[AbCdEf123456]": "ExponentPushToken[redacted]",
    "+92 300 1234567 / 0092-321-7654321 / 03451234567": "[phone] / [phone] / [phone]",
    "42101-1234567-1": "[cnic]",
    [`ck_${"a1".repeat(20)} cs_${"b2".repeat(20)}`]: "ck_[redacted] cs_[redacted]",
  };
  const bad = Object.entries(samples).filter(([a, b]) => redact(a) !== b);
  check("redaction samples", bad.length === 0, bad.map(([a]) => `${a} → ${redact(a)}`).join(" | "));
  const keep = "offer 6ae8b013cd4801a740dc5b84 bill 1500 saved 300 at 2026-11-02T15:46:51.483Z from 10.0.0.12:5000 status 404";
  check("ids, amounts, dates, IPs and status codes are kept", redact(keep) === keep, redact(keep));
  check("everything written during this run: no e-mail of a seeded user, no password hash", !written.some((w) => /@test\.local|\$2a\$04\$/.test(w)));
  const authSrc = fs.readFileSync(path.join(SERVER, "routes", "auth.routes.js"), "utf8");
  check("one-time codes logged only with LOG_DEV_CODES=true (not when NODE_ENV is merely unset)", (authSrc.match(/LOG_DEV_CODES === "true" && process\.env\.NODE_ENV !== "production"/g) || []).length === 2 && !/if \(process\.env\.NODE_ENV !== "production"\) \{\s*console\.log\(`🔑/.test(authSrc));

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, none expose hidden user fields`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
