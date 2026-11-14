// Brand loyalty (Sprint 2): programs, the verified-redemption hook, tiers at the 5/6 boundary, reversals,
// no cross-brand credit, branch limits, and FLAG_LOYALTY_V2 off = the old behaviour.
//   node tests/loyalty/run.js [serverDir]
// Same harness as tests/live-security: real routes, models and services; fake MongoDB with unique indexes
// and interleaving (simultaneous requests really interleave); no database, no network, no .env.
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
// pilot checks: no built-in "on" default (as before this branch), so "outside the pilot" still means off
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
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
for (const m of ["User", "Offer", "PromoCode", "Branch", "Notification", "University", "PendingScan", "DomainEvent", "RedemptionGuard", "EngagementProfile", "PointsLedger", "LoyaltyProgram", "LoyaltyLedger", "LoyaltySnapshot", "LoyaltyProgramRestart", "AdminActionLog"]) reqS(`./models/${m}`);
const loyalty = reqS("./services/loyalty");
const { recordWooOrder } = reqS("./services/storeOrders");

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "pushTokens", "idCardFront", "idCardBack", "livePicture", "email", "phone"];
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
    // /api/loyalty replies carry no personal data at all (ids, names for the admin only)
    const hidden = req.originalUrl.startsWith("/api/loyalty") ? HIDDEN : HIDDEN.slice(0, 9);
    const leaks = hidden.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks });
    return send(body);
  };
  next();
});
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/promo-codes", reqS("./routes/promoCode.routes"));
app.use("/api/loyalty", reqS("./routes/loyalty.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "B", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "admin", "oA", "oA2", "oB", "bA1", "bA2", "bB", "uni"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("universities", [{ _id: ids.uni, name: "SZABIST" }]);
fake.seed(coll("User"), [
  user(ids.A, "brand", "brandA", { brandName: "Alpha Cafe" }), user(ids.B, "brand", "brandB", { brandName: "Beta Burgers" }),
  user(ids.S1, "student", "sana", { rollNo: "21K-1", university: ids.uni }), user(ids.S2, "student", "taha"),
  user(ids.S3, "student", "umar"), user(ids.S4, "student", "zara"), user(ids.S5, "student", "ali"), user(ids.S6, "student", "hina"), user(ids.S7, "student", "omar"),
  user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, title, pct = 20) => ({ _id: id, brand, title, discountPercentage: pct, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("Offer"), [offer(ids.oA, ids.A, "Alpha 20%"), offer(ids.oA2, ids.A, "Alpha weekend", 10), offer(ids.oB, ids.B, "Beta 20%")]);
const branch = (id, brand, name) => ({ _id: id, brand, name, discountPercentage: 20, isInStore: true, isActive: true, createdAt: new Date() });
fake.seed(coll("Branch"), [branch(ids.bA1, ids.A, "Alpha Clifton"), branch(ids.bA2, ids.A, "Alpha DHA"), branch(ids.bB, ids.B, "Beta Gulshan")]);
const promo = (code, student, extra = {}) => ({ _id: oid(), code, offer: ids.oA, student, brand: ids.A, discountPercentage: 20, offerTitle: "Alpha 20%", brandName: "Alpha Cafe", status: "active", externalProvider: "none", expiresAt: new Date(Date.now() + 864e5), maxUses: 1, usedCount: 0, createdAt: new Date(), ...extra });
fake.seed(coll("PromoCode"), [promo("ALPLOY0001", ids.S3), promo("ALPWOO0001", ids.S5), promo("ALPXBR0001", ids.S2)]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
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
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const statuses = (rs) => rs.map((r) => r.status).sort().join(",");
const ledger = (f = () => true) => rows("LoyaltyLedger", f);
const credits = (who) => ledger((e) => same(e.student, ids[who]) && e.type === "CREDIT");
const counted = (who) => credits(who).filter((e) => e.visitsDelta > 0);
const offerDoc = (id) => rows("Offer", (o) => same(o._id, id))[0];
// an earlier verified redemption, written the way the existing paths write it (dated days ago, so it
// doesn't use up today's 2-a-day offer cap)
let seedDay = 3;
function seedRedemption(offerId, who, bill = 1000) {
  const rid = oid();
  offerDoc(offerId).redemptions.push({ _id: rid, student: ids[who], billAmount: bill, savedAmount: Math.round(bill * 0.2), redeemedAt: new Date(Date.now() - seedDay++ * 864e5) });
  return rid;
}

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["A", "B", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "admin"].map((k) => [k, token(k, k === "admin" ? "admin" : /^S/.test(k) ? "student" : "brand")]));
  const FLAG = `ids:${ids.A},${ids.B},${ids.S1},${ids.S3},${ids.S4},${ids.S5},${ids.S7}`; // S2 is not in the pilot

  console.log("── 1. flag off: nothing changes");
  let r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: {} });
  check("flag off: a brand can't create a program (404 LOYALTY_OFF)", r.status === 404 && r.json?.error?.code === "LOYALTY_OFF", r.text);
  r = await call("GET", "/api/app/flags/me", { tok: T.S1 });
  check("flag off: /flags/me says loyaltyV2 false", r.json?.loyaltyV2 === false, r.text);
  r = await call("GET", "/api/app/flags");
  check("the public /flags reply is unchanged (no loyaltyV2)", r.text === '{"metaEvents":false}', r.text);

  process.env.FLAG_LOYALTY_V2 = FLAG;
  console.log("── 2. programs");
  r = await call("GET", "/api/app/flags/me", { tok: T.S1 });
  const r2 = await call("GET", "/api/app/flags/me", { tok: T.S2 });
  check("flag ids: test student on, other student off", r.json?.loyaltyV2 === true && r2.json?.loyaltyV2 === false, `${r.text} ${r2.text}`);
  r = await call("POST", "/api/loyalty/programs", { tok: T.S1, body: {} });
  check("a student can't create a program (403)", r.status === 403, r.status);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: { tiers: [{ minVisit: 1, maxVisit: 3, discountPct: 15 }, { minVisit: 5, maxVisit: null, discountPct: 25 }] } });
  check("tiers with a gap → 400 INVALID_TIERS", r.status === 400 && r.json?.error?.code === "INVALID_TIERS", r.text);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: { maxDiscountPct: 20 } });
  check("default 25% tier over a 20% maximum → 400 OVER_MAX_DISCOUNT", r.status === 400 && r.json?.error?.code === "OVER_MAX_DISCOUNT", r.text);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: { adminMaxDiscountPct: 50 } });
  check("a brand can't set the admin maximum (403)", r.status === 403 && r.json?.error?.code === "ADMIN_ONLY", r.text);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: { eligibleOfferIds: [String(ids.oB)] } });
  check("another brand's offer in the program → 403", r.status === 403 && r.json?.error?.code === "NOT_YOUR_OFFER", r.text);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: { brand: String(ids.B), terms: "One visit a day counts. Visits expire after 12 months." } });
  const prog = r.json?.data;
  check("brand A creates its program: draft, default tiers 1-5 = 15%, 6+ = 25%, max 25%, own brand", r.status === 201 && prog?.status === "draft" && same(prog.brand, ids.A) && JSON.stringify(prog.tiers.map((t) => [t.minVisit, t.maxVisit, t.discountPct])) === "[[1,5,15],[6,null,25]]" && prog.maxDiscountPct === 25, r.text.slice(0, 200));
  check("…requestId in the reply (common contract)", typeof r.json?.requestId === "string" && r.json.success === true);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: {} });
  check("a second program for the same brand → 409", r.status === 409 && r.json?.error?.code === "EXISTS", r.status);
  r = await call("GET", `/api/loyalty/brands/${ids.A}/program`);
  check("a draft program is not public (404)", r.status === 404, r.status);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.B, body: { status: "active" } });
  check("brand B can't edit brand A's program (403)", r.status === 403 && r.json?.error?.code === "NOT_YOUR_PROGRAM", r.text);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "active", eligibleOfferIds: [String(ids.oA)], version: 1 } });
  check("brand A opts in: active, only 'Alpha 20%' eligible, version 2", r.status === 200 && r.json.data.status === "active" && r.json.data.version === 2 && r.json.data.eligibleOfferIds.join() === String(ids.oA), r.text.slice(0, 160));
  check("…the previous rules kept in history", rows("LoyaltyProgram")[0].history.length === 1 && rows("LoyaltyProgram")[0].history[0].version === 1);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { terms: "x", version: 1 } });
  check("an edit based on an old version → 409 VERSION_CONFLICT", r.status === 409 && r.json?.error?.code === "VERSION_CONFLICT", r.text);
  r = await call("GET", `/api/loyalty/brands/${ids.A}/program`, { tok: T.S1 });
  check("the active program is public", r.status === 200 && r.json.data.status === "active" && r.json.data.tiers.length === 2, r.status);

  console.log("── 3. a claim, a QR, a code: zero visits");
  await call("POST", `/api/offers/claim/${ids.oA}`, { tok: T.S1 });
  await call("POST", "/api/promo-codes/generate", { tok: T.S1, body: { offerId: String(ids.oA) } });
  r = await call("POST", "/api/offers/scan-verify", { tok: T.S1, body: { offerId: String(ids.oA) } });
  check("claim + promo code + QR scan → 0 ledger rows", r.status === 200 && ledger().length === 0, `${r.status} ${ledger().length}`);
  r = await call("GET", `/api/loyalty/brands/${ids.A}/me`, { tok: T.S1 });
  const p0 = r.json?.data?.progress;
  check("student sees 0 visits; next visit 15%; 25% from visit 6 (5 visits to go)", r.status === 200 && r.json.data.enabled && p0.visits === 0 && p0.currentTier.discountPct === 15 && p0.nextTier.minVisit === 6 && p0.nextTier.discountPct === 25 && p0.visitsBeforeNextTier === 5, JSON.stringify(p0));

  console.log("── 4. the brand sees the tier before confirming; savings use it");
  r = await call("GET", "/api/offers/pending-scans", { tok: T.A });
  const scan = (r.json || []).find((s) => s.studentId === String(ids.S1));
  check("pending-scans: % to apply = 15 (tier), offer % kept aside, tier shown", scan?.discountPercentage === 15 && scan.offerDiscountPercentage === 20 && scan.loyalty?.tierName === "Member" && scan.loyalty.countsAsVisit === true, JSON.stringify(scan?.loyalty));
  r = await call("POST", "/api/loyalty/quotes", { tok: T.A, body: { studentId: String(ids.S1), offerId: String(ids.oA) } });
  check("quote (manual verify): 15%, visit 1", r.status === 200 && r.json.data.applies && r.json.data.discountPercentage === 15 && r.json.data.nextVisitNumber === 1, r.text.slice(0, 160));
  r = await call("POST", "/api/loyalty/quotes", { tok: T.B, body: { studentId: String(ids.S1), offerId: String(ids.oA) } });
  check("brand B can't quote brand A's offer (403)", r.status === 403 && r.json?.error?.code === "NOT_YOUR_OFFER", r.text);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S1), billAmount: 1000 } });
  check("redeem-payment: saved 150 (15% tier, not the offer's 20%); visit 1 credited", r.status === 200 && r.json.savedAmount === 150 && r.json.loyalty?.credited === true && r.json.loyalty.visitNumber === 1 && r.json.loyalty.discountPct === 15, JSON.stringify(r.json?.loyalty));
  const red1 = offerDoc(ids.oA).redemptions.find((x) => same(x.student, ids.S1));
  check("…the redemption records the same savings; one ledger CREDIT", red1?.savedAmount === 150 && counted("S1").length === 1 && counted("S1")[0].discountPct === 15 && counted("S1")[0].source === "redeem-payment");
  check("…a loyalty.credited DomainEvent; the scan closed", rows("DomainEvent", (e) => e.type === "loyalty.credited").length === 1 && rows("PendingScan", (p) => same(p.student, ids.S1))[0].status === "processed");

  console.log("── 5. the same visit twice / at once: one credit");
  const again = await Promise.all([1, 2, 3, 4, 5].map(() => loyalty.onVerifiedRedemption(red1._id, { source: "retry" })));
  check("the hook run 5 more times at once for the same redemption → still 1 row", credits("S1").length === 1 && again.every((x) => x.credited === false || x.duplicate), again.map((x) => x.duplicate ? "dup" : x.reason).join());
  let rs = await Promise.all([1, 2].map(() => call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S3), billAmount: 800 } })));
  check("2 simultaneous scans of one student (2 redemptions, the offer allows 2 a day) → 1 counted visit", rs.every((x) => x.status === 200) && counted("S3").length === 1 && credits("S3").length === 2 && credits("S3").some((e) => e.visitsDelta === 0 && e.reason === "daily-limit"), statuses(rs));
  check("…both still saved at the tier %, and the reply says which counted", rs.every((x) => x.json.savedAmount === 120) && rs.filter((x) => x.json.loyalty?.credited).length === 1 && rs.some((x) => x.json.loyalty?.reason === "daily-limit"));
  rs = await Promise.all([1, 2].map(() => call("POST", "/api/promo-codes/confirm-redemption", { tok: T.A, body: { promoCode: "ALPLOY0001", offerId: String(ids.oA), billAmount: 500 } })));
  check("promo confirm ×2 at once → one 200, one 409; no extra visit today (daily limit)", rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 1 && counted("S3").length === 1 && credits("S3").length === 3, statuses(rs));

  console.log("── 6. the 5 → 6 boundary");
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { maxVisitsPerDay: 0 } }); // several visits in one test day
  check("brand sets no daily visit limit", r.status === 200 && r.json.data.maxVisitsPerDay === 0, r.status);
  for (let i = 0; i < 4; i++) await loyalty.onVerifiedRedemption(seedRedemption(ids.oA, "S4"), { source: "test" });
  r = await call("POST", "/api/loyalty/quotes", { tok: T.A, body: { studentId: String(ids.S4), offerId: String(ids.oA) } });
  check("after 4 visits: visit 5 gets 15%", r.json.data.visits === 4 && r.json.data.nextVisitNumber === 5 && r.json.data.discountPct === 15, JSON.stringify(r.json.data).slice(0, 120));
  const red5 = seedRedemption(ids.oA, "S4");
  await loyalty.onVerifiedRedemption(red5, { source: "test" });
  r = await call("POST", "/api/loyalty/quotes", { tok: T.A, body: { studentId: String(ids.S4), offerId: String(ids.oA) } });
  check("after 5 visits: visit 6 gets 25%", r.json.data.visits === 5 && r.json.data.nextVisitNumber === 6 && r.json.data.discountPct === 25 && r.json.data.tierName === "Regular", JSON.stringify(r.json.data).slice(0, 120));
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S4), billAmount: 1000 } });
  check("visit 6 via redeem-payment: saved 250 (25%), visit 6 credited, tier Regular", r.status === 200 && r.json.savedAmount === 250 && r.json.loyalty.visitNumber === 6 && r.json.loyalty.tierName === "Regular", JSON.stringify(r.json.loyalty));
  const red6 = offerDoc(ids.oA).redemptions.filter((x) => same(x.student, ids.S4)).slice(-1)[0]._id;
  r = await call("GET", `/api/loyalty/brands/${ids.A}/me`, { tok: T.S4 });
  check("student sees 6 visits, 25%, no further tier", r.json.data.progress.visits === 6 && r.json.data.progress.currentTier.discountPct === 25 && r.json.data.progress.nextTier === null);

  console.log("── 7. refunds reverse; nothing is deleted");
  const rowsBefore = ledger().length;
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(red6) } });
  check("reversal without a reason → 400 REASON_REQUIRED", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.A, body: { redemptionId: String(red6), reason: "customer refunded" } });
  check("a brand can't reverse (admin only, 403)", r.status === 403, r.status);
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(red6), reason: "refund: order returned" } });
  check("admin reverses visit 6 → 201, a REVERSAL row (-1) with the admin and reason", r.status === 201 && r.json.data.reversal.visitsDelta === -1 && ledger((e) => e.type === "REVERSAL" && same(e.actor, ids.admin) && e.reason === "refund: order returned").length === 1, r.text.slice(0, 160));
  check("…back to 5 visits: the next visit gets 25% again", r.json.data.progress.visits === 5 && r.json.data.progress.currentTier.discountPct === 25);
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(red5), reason: "fraud: duplicate receipt" } });
  check("reverse visit 5 → 4 visits; the next visit gets 15% (tier recomputed)", r.status === 201 && r.json.data.progress.visits === 4 && r.json.data.progress.currentTier.discountPct === 15, JSON.stringify(r.json?.data?.progress));
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(red6), reason: "again" } });
  check("reversing the same credit twice → 409 ALREADY_REVERSED", r.status === 409 && r.json?.error?.code === "ALREADY_REVERSED", r.text);
  check("ledger only grew (+2 rows), no row deleted or edited", ledger().length === rowsBefore + 2 && counted("S4").length === 6);
  check("…each reversal audited (loyalty.reversed event: admin, reason)", rows("DomainEvent", (e) => e.type === "loyalty.reversed").length === 2 && rows("DomainEvent", (e) => e.type === "loyalty.reversed").every((e) => same(e.actor, ids.admin) && e.data.reason));
  r = await call("GET", "/api/loyalty/me/credits", { tok: T.S4 });
  check("student's history: visits 5 and 6 'reversed', the rest 'credited'", r.json.data.credits.filter((c) => c.status === "reversed").length === 2 && r.json.data.credits.filter((c) => c.status === "credited").length === 4, r.json?.data?.credits?.map((c) => c.status).join());
  await rows("LoyaltySnapshot").splice(0); // the cache is disposable
  fake.STORE.get(coll("LoyaltySnapshot")).length = 0;
  const pr = await loyalty.rebuildSnapshot(rows("LoyaltyProgram")[0], ids.A, ids.S4);
  check("snapshot rebuilt from the ledger alone: 4 visits", pr.visits === 4 && rows("LoyaltySnapshot", (s) => same(s.student, ids.S4))[0].visits === 4);

  console.log("── 8. no cross-brand credit");
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.A, body: { promoCode: "ALPXBR0001", offerId: String(ids.oB), billAmount: 900 } });
  check("brand A confirming its code into brand B's offer → 403 (was accepted before)", r.status === 403 && offerDoc(ids.oB).redemptions.length === 0, r.status);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oB), userId: String(ids.S1), billAmount: 900 } });
  check("brand A redeeming brand B's offer → 403", r.status === 403, r.status);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.B, body: { offerId: String(ids.oB), userId: String(ids.S1), billAmount: 1000 } });
  check("S1 at brand B (no program): offer % (20), no credit anywhere", r.status === 200 && r.json.savedAmount === 200 && !r.json.loyalty && ledger((e) => same(e.brand, ids.B)).length === 0 && counted("S1").length === 1, JSON.stringify(r.json?.loyalty));

  console.log("── 9. branches");
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S5), billAmount: 1000, branchId: String(ids.bB) } });
  check("brand A recording at brand B's branch → 403, nothing written", r.status === 403 && !offerDoc(ids.oA).redemptions.some((x) => same(x.student, ids.S5)), r.text);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { branchIds: [String(ids.bB)] } });
  check("a program can't name another brand's branch (403)", r.status === 403 && r.json?.error?.code === "NOT_YOUR_BRANCH", r.text);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { branchIds: [String(ids.bA1)] } });
  check("program limited to the Clifton branch", r.status === 200 && r.json.data.branchIds.join() === String(ids.bA1));
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S5), billAmount: 1000, branchId: String(ids.bA2) } });
  check("at the DHA branch (not in the program): offer % (20), no credit, and the brand is told why", r.status === 200 && r.json.savedAmount === 200 && r.json.loyalty?.credited === false && r.json.loyalty.reason === "branch-not-in-program" && /this branch isn't part of your loyalty program/.test(r.json.loyalty.message) && credits("S5").length === 0, JSON.stringify(r.json));
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S5), billAmount: 1000, branchId: String(ids.bA1) } });
  check("at the Clifton branch: tier % (15), visit credited with the branch", r.status === 200 && r.json.savedAmount === 150 && r.json.loyalty?.credited && same(counted("S5")[0].branch, ids.bA1), JSON.stringify(r.json?.loyalty));
  await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { branchIds: [] } });

  console.log("── 10. verified store orders (WooCommerce)");
  const order = { id: 9911, status: "processing", total: "800", coupon_lines: [{ code: "ALPWOO0001", discount: "200" }] };
  const w1 = await recordWooOrder(ids.A, order);
  const w2 = await recordWooOrder(ids.A, order);
  check("a paid Woo order with the code: one redemption, one credit (source woo-webhook), retry ignored", w1.counted === 1 && w2.counted === 0 && counted("S5").length === 2 && counted("S5").some((e) => e.source === "woo-webhook"), JSON.stringify([w1, w2]));
  check("…online savings stay the store's (code %), no loyalty % recorded for it", offerDoc(ids.oA).redemptions.find((x) => x.externalOrderId === "9911")?.savedAmount === 200 && counted("S5").find((e) => e.source === "woo-webhook").discountPct === null);

  console.log("── 11. promo verify shows and applies the tier");
  fake.seed(coll("PromoCode"), [promo("ALPLOY0002", ids.S1)]);
  r = await call("POST", "/api/promo-codes/brand-verify", { tok: T.A, body: { promoCode: "ALPLOY0002", offerId: String(ids.oA), billAmount: 1000 } });
  check("brand-verify (dry run): 15% shown with the tier, nothing written", r.status === 200 && r.json.data.transaction.discountPercentage === 15 && r.json.data.transaction.savedAmount === 150 && r.json.data.loyalty?.tierName === "Member" && credits("S1").length === 1, r.text.slice(0, 200));
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.A, body: { promoCode: "ALPLOY0002", offerId: String(ids.oA), billAmount: 1000 } });
  check("confirm-redemption: saved 150, visit 2 credited", r.status === 200 && r.json.data.transaction.savedAmount === 150 && r.json.data.loyalty?.credited && r.json.data.loyalty.visitNumber === 2, JSON.stringify(r.json?.data?.loyalty));

  console.log("── 12. analytics and the admin's cap");
  r = await call("GET", "/api/loyalty/brands/me/analytics", { tok: T.A });
  const an = r.json?.data;
  // independent count: net visits per student from the raw ledger rows
  const revd = new Set(ledger((e) => e.type === "REVERSAL").map((e) => String(e.reverses)));
  const net = {};
  for (const e of ledger((e) => same(e.brand, ids.A) && e.type === "CREDIT" && e.visitsDelta > 0 && !revd.has(String(e._id)))) net[e.student] = (net[e.student] || 0) + 1;
  const nets = Object.values(net);
  const want = { visits: nets.reduce((a, b) => a + b, 0), repeat: nets.filter((n) => n >= 2).length, member: nets.filter((n) => n >= 1 && n <= 5).length, regular: nets.filter((n) => n >= 6).length };
  check("brand analytics match the ledger: verified visits, repeat customers, tier counts, reversals", r.status === 200 && an.verifiedVisits === want.visits && an.repeatCustomers === want.repeat && an.tierCounts.Member === want.member && an.tierCounts.Regular === want.regular && an.reversals === 2 && an.members === nets.length, `${JSON.stringify(want)} vs ${JSON.stringify({ v: an?.verifiedVisits, r: an?.repeatCustomers, t: an?.tierCounts, rev: an?.reversals, m: an?.members })}`);
  r = await call("GET", "/api/loyalty/brands/me/analytics", { tok: T.S1 });
  check("a student can't read brand analytics (403)", r.status === 403, r.status);
  r = await call("GET", "/api/loyalty/brands/me/analytics", { tok: T.B });
  check("brand B (no program): program null, no numbers of brand A", r.status === 200 && r.json.data.program === null, r.text.slice(0, 80));
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.admin, body: { adminMaxDiscountPct: 20 } });
  check("admin caps the program at 20%: tiers shown capped", r.status === 200 && r.json.data.maxDiscountPct === 20 && r.json.data.tiers[1].discountPct === 20, r.text.slice(0, 160));
  for (let i = 0; i < 7; i++) await loyalty.onVerifiedRedemption(seedRedemption(ids.oA, "S7"), { source: "test" });
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S7), billAmount: 1000 } });
  check("visit 8 (25% tier) under the admin's 20% cap → saved 200", r.status === 200 && r.json.savedAmount === 200 && r.json.loyalty?.discountPct === 20 && r.json.loyalty.visitNumber === 8, JSON.stringify(r.json?.loyalty || r.json));
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { tiers: [{ minVisit: 1, maxVisit: 5, discountPct: 15 }, { minVisit: 6, maxVisit: null, discountPct: 30 }] } });
  check("the brand can't raise a tier above the admin's cap (400)", r.status === 400 && r.json?.error?.code === "OVER_MAX_DISCOUNT", r.text);
  r = await call("GET", "/api/loyalty/admin/ledger?type=REVERSAL", { tok: T.admin });
  check("admin exceptions list: the 2 reversals with brand and student names", r.status === 200 && r.json.data.rows.length === 2 && r.json.data.rows.every((x) => x.brandName === "Alpha Cafe" && x.studentName === "zara" && x.actorName === "admin"), r.text.slice(0, 160));

  console.log("── 13. not in the pilot / flag off again: old behaviour");
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S2), billAmount: 1000 } });
  check("student outside the flag at brand A: offer % (20), no loyalty, no credit", r.status === 200 && r.json.savedAmount === 200 && !("loyalty" in r.json) && credits("S2").length === 0, JSON.stringify(r.json?.loyalty));
  r = await call("GET", `/api/loyalty/brands/${ids.A}/me`, { tok: T.S2 });
  check("…and their loyalty card says not enabled", r.status === 200 && r.json.data.enabled === false, r.text);
  delete process.env.FLAG_LOYALTY_V2;
  const before = ledger().length;
  await call("POST", "/api/offers/scan-verify", { tok: T.S6, body: { offerId: String(ids.oA) } });
  r = await call("GET", "/api/offers/pending-scans", { tok: T.A });
  const s3 = (r.json || []).find((s) => s.studentId === String(ids.S6));
  check("flag off: pending-scans shows the offer's 20%, no loyalty field", s3?.discountPercentage === 20 && !("loyalty" in s3) && !("offerDiscountPercentage" in s3), JSON.stringify(s3));
  fake.seed(coll("PromoCode"), [promo("ALPOFF0001", ids.S6)]);
  r = await call("POST", "/api/promo-codes/brand-verify", { tok: T.A, body: { promoCode: "ALPOFF0001", offerId: String(ids.oA), billAmount: 1000 } });
  check("flag off: brand-verify at 20%, no loyalty field", r.status === 200 && r.json.data.transaction.discountPercentage === 20 && !("loyalty" in r.json.data), r.text.slice(0, 120));
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S7), billAmount: 1000 } });
  check("flag off: redeem-payment at 20% (S7 is in the Regular tier), no loyalty field, no ledger row", r.status === 200 && r.json.savedAmount === 200 && !("loyalty" in r.json) && ledger().length === before, JSON.stringify(r.json?.loyalty));
  const w3 = await recordWooOrder(ids.A, { id: 9912, status: "completed", total: "800", coupon_lines: [{ code: "ALPOFF0001", discount: "200" }] });
  check("flag off: a Woo order counts as before, no ledger row", w3.counted === 1 && ledger().length === before);
  r = await call("GET", `/api/loyalty/brands/${ids.A}/program`, { tok: T.S1 });
  check("flag off: the program is not shown (404)", r.status === 404, r.status);

  console.log("── 14. end, then restart: a new draft version; old visits never count again");
  process.env.FLAG_LOYALTY_V2 = FLAG;
  const restarts = () => rows("LoyaltyProgramRestart");
  const mine = async () => (await call("GET", "/api/loyalty/programs/mine", { tok: T.A })).json.data;
  const s7Visits = async () => (await call("GET", `/api/loyalty/brands/${ids.A}/me`, { tok: T.S7 })).json.data;
  let st = await s7Visits();
  check("before: S7 has 8 visits (top tier)", st.enabled && st.progress.visits === 8, JSON.stringify(st.progress));
  let pv = await mine();
  r = await call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: T.A, body: { version: pv.version } });
  check("restart while active → 409 NOT_ENDED", r.status === 409 && r.json?.error?.code === "NOT_ENDED", r.text);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "ended", version: pv.version } });
  check("the brand ends its program", r.status === 200 && r.json.data.status === "ended", r.text.slice(0, 120));
  const endedV1 = r.json.data.version;
  st = await s7Visits();
  check("ended: no loyalty for students", st.enabled === false && st.reason === "no-program", JSON.stringify(st));
  const ledgerBefore = ledger().length;
  await loyalty.onVerifiedRedemption(seedRedemption(ids.oA, "S7"), { source: "test" });
  check("ended: a verified redemption credits nothing", ledger().length === ledgerBefore);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "active", version: endedV1 } });
  check("an ended program can't be switched back on (409 ENDED, says restart)", r.status === 409 && r.json?.error?.code === "ENDED" && /restart/.test(r.json.error.message), r.text);
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: {} });
  check("…nor replaced by a second program (409, says restart)", r.status === 409 && /restart/.test(r.json?.error?.message || ""), r.text);
  r = await call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: T.B, body: { version: endedV1 } });
  check("brand B can't restart brand A's program (403)", r.status === 403 && r.json?.error?.code === "NOT_YOUR_PROGRAM", r.text);
  r = await call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: T.S7, body: { version: endedV1 } });
  check("a student can't restart (403)", r.status === 403, r.status);
  r = await call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: T.A, body: { version: endedV1 - 1 } });
  check("restart from an old version → 409 VERSION_CONFLICT", r.status === 409 && r.json?.error?.code === "VERSION_CONFLICT", r.text);
  const histBefore = rows("LoyaltyProgram")[0].history.length;
  r = await call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: T.A, body: { version: endedV1 } });
  check("the brand restarts: a draft at a new version, same rules, dates cleared", r.status === 200 && r.json.data.status === "draft" && r.json.data.version === endedV1 + 1 && r.json.data.startsAt === null && r.json.data.endsAt === null && r.json.data.tiers.length === 2, r.text.slice(0, 200));
  const prow = rows("LoyaltyProgram")[0];
  check("…history keeps the ended version (marked restarted)", prow.history.length === Math.min(histBefore + 1, 20) && prow.history.slice(-1)[0].status === "ended" && prow.history.slice(-1)[0].version === endedV1 && prow.history.slice(-1)[0].restarted === true);
  check("…one LoyaltyProgramRestart row: ended version, new version, rules, who", restarts().length === 1 && restarts()[0].endedVersion === endedV1 && restarts()[0].newVersion === endedV1 + 1 && restarts()[0].endedRules.status === "ended" && same(restarts()[0].restartedBy, ids.A) && restarts()[0].byAdmin === false);
  check("…a domain event loyalty.program.restarted", rows("DomainEvent", (e) => e.type === "loyalty.program.restarted").length === 1);
  check("…nothing deleted from the ledger", ledger().length === ledgerBefore);
  st = await s7Visits();
  check("a restarted draft isn't live yet", st.enabled === false);
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "active", version: endedV1 + 1 } });
  check("the brand publishes the new version", r.status === 200 && r.json.data.status === "active", r.text.slice(0, 120));
  st = await s7Visits();
  check("old redemptions don't count: S7 starts again at 0 visits, first tier", st.enabled && st.progress.visits === 0 && st.progress.currentTier.name === "Member", JSON.stringify(st.progress));
  r = await call("POST", "/api/loyalty/quotes", { tok: T.A, body: { studentId: String(ids.S7), offerId: String(ids.oA) } });
  check("…and the brand's quote agrees: visit 1, first tier", r.json.data.nextVisitNumber === 1 && r.json.data.tierName === "Member", JSON.stringify(r.json.data).slice(0, 120));
  const rNew = seedRedemption(ids.oA, "S7");
  let cr = await loyalty.onVerifiedRedemption(rNew, { source: "test" });
  check("a new visit after the restart is visit 1 of the new period", cr.credited && cr.visitNumber === 1, JSON.stringify({ c: cr.credited, n: cr.visitNumber }));
  const oldCredit = ledger((e) => same(e.student, ids.S7) && e.type === "CREDIT" && e.visitsDelta > 0 && e.programVersion <= endedV1)[0];
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(oldCredit.redemptionId), reason: "refund from before the restart" } });
  check("an admin can still reverse an old-period visit; the new period's count is unchanged (1)", r.status === 201 && r.json.data.progress.visits === 1, r.text.slice(0, 160));
  st = await s7Visits();
  check("…S7 still has 1 visit", st.progress.visits === 1, JSON.stringify(st.progress));
  r = await call("GET", "/api/loyalty/brands/me/analytics", { tok: T.A });
  check("analytics: members and tiers count the current period only (S7 in Member)", r.status === 200 && r.json.data.members === 1 && r.json.data.tierCounts.Member === 1, JSON.stringify({ m: r.json.data.members, t: r.json.data.tierCounts }));

  // a second end, then 5 simultaneous restarts (brand + admin): exactly one
  pv = await mine();
  r = await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "ended", version: pv.version } });
  const endedV2 = r.json.data.version;
  const rs5 = await Promise.all([T.A, T.admin, T.A, T.admin, T.A].map((tk) => call("POST", `/api/loyalty/programs/${prog.id}/restart`, { tok: tk, body: { version: endedV2 } })));
  check("5 restarts at once (brand and admin) → one 200, the rest 409; one restart row for that version", rs5.filter((x) => x.status === 200).length === 1 && rs5.filter((x) => x.status === 409).length === 4 && restarts().filter((x) => x.endedVersion === endedV2).length === 1, statuses(rs5));
  pv = await mine();
  await call("PATCH", `/api/loyalty/programs/${prog.id}`, { tok: T.A, body: { status: "active", version: pv.version } });
  st = await s7Visits();
  check("after the second restart: the visit from the second period doesn't count either (0)", st.progress.visits === 0, JSON.stringify(st.progress));
  check("both periods' rules are kept (2 restart rows)", restarts().length === 2);

  console.log("── 15. admin: every program, create on a brand's behalf (draft), edit / publish / pause / end / restart, all logged");
  const AL = "/api/loyalty/admin/programs";
  const logs = (f = () => true) => rows("AdminActionLog", f);
  // admin only
  for (const [m, u, b] of [["GET", AL], ["GET", `${AL}/${prog.id}`], ["POST", AL, { brandId: String(ids.B), reason: "pilot setup" }], ["PATCH", `${AL}/${prog.id}`, { status: "paused", version: 1, reason: "pilot setup" }], ["POST", `${AL}/${prog.id}/restart`, { version: 1, reason: "pilot setup" }]]) {
    const rr = await Promise.all([T.A, T.S1].map((tk) => call(m, u, { tok: tk, body: b })));
    const anon = await call(m, u, { body: b });
    check(`${m} ${u.replace(/[0-9a-f]{24}/, ":id")}: brand and student 403, no token 401`, rr.every((x) => x.status === 403) && anon.status === 401, `${statuses(rr)} ${anon.status}`);
  }
  check("…and none of that wrote anything", logs((x) => x.action.startsWith("loyalty.program.") && x.action !== "loyalty.program.update").length === 0 && rows("LoyaltyProgram").length === 1);
  r = await call("GET", AL, { tok: T.admin });
  check("admin lists every program with the brand's name and pilot state", r.status === 200 && r.json.data.programs.length === 1 && r.json.data.programs[0].brandName === "Alpha Cafe" && r.json.data.programs[0].inPilot === true, r.text.slice(0, 200));
  // create for brand B
  r = await call("POST", AL, { tok: T.admin, body: { brandId: String(ids.B) } });
  check("create on a brand's behalf without a reason → 400 REASON_REQUIRED, nothing created", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED" && rows("LoyaltyProgram").length === 1, r.text);
  r = await call("POST", AL, { tok: T.admin, body: { brandId: String(ids.S1), reason: "pilot setup for Beta" } });
  check("…for an account that isn't a brand → 404", r.status === 404 && r.json?.error?.code === "BRAND_NOT_FOUND", r.text);
  r = await call("POST", AL, { tok: T.admin, body: { brandId: String(ids.B), reason: "pilot setup for Beta", status: "active", adminMaxDiscountPct: 20, maxDiscountPct: 20, tiers: [{ name: "Member", minVisit: 1, maxVisit: 4, discountPct: 10 }, { name: "Regular", minVisit: 5, maxVisit: null, discountPct: 20 }] } });
  const pB = r.json?.data;
  check("admin creates brand B's program: always a draft, with the admin cap", r.status === 201 && pB.status === "draft" && pB.brandName === "Beta Burgers" && pB.adminMaxDiscountPct === 20 && pB.tiers[1].discountPct === 20, r.text.slice(0, 200));
  const c1 = logs((x) => x.action === "loyalty.program.create")[0];
  check("…logged: create, the brand's program, the reason, after = draft rules", c1 && c1.targetId === pB.id && c1.reason === "pilot setup for Beta" && c1.after.status === "draft" && c1.after.adminMaxDiscountPct === 20 && same(c1.admin, ids.admin), JSON.stringify(c1 && c1.after).slice(0, 160));
  r = await call("POST", AL, { tok: T.admin, body: { brandId: String(ids.B), reason: "pilot setup again" } });
  check("a second program for the same brand → 409, not logged", r.status === 409 && logs((x) => x.action === "loyalty.program.create").length === 1, r.text);
  r = await call("GET", "/api/loyalty/programs/mine", { tok: T.B });
  check("brand B sees the draft in its own portal", r.status === 200 && r.json.data.status === "draft" && r.json.data.id === pB.id);
  r = await call("GET", `${AL}/${pB.id}`, { tok: T.admin });
  check("admin view: program, history, restarts, numbers", r.status === 200 && r.json.data.program.id === pB.id && Array.isArray(r.json.data.history) && Array.isArray(r.json.data.restarts) && r.json.data.numbers.verifiedVisits === 0, r.text.slice(0, 160));
  r = await call("GET", `${AL}?q=beta`, { tok: T.admin });
  const r2b = await call("GET", `${AL}?status=draft`, { tok: T.admin });
  check("list filters: brand name, status", r.json.data.programs.length === 1 && r.json.data.programs[0].brandName === "Beta Burgers" && r2b.json.data.programs.every((p) => p.status === "draft"), `${r.json.data.programs.length} ${r2b.json.data.programs.length}`);
  // edits: version and reason required; a stale version writes nothing (and logs nothing)
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "active", reason: "brand approved the terms" } });
  check("publish without a version → 400 VERSION_REQUIRED", r.status === 400 && r.json?.error?.code === "VERSION_REQUIRED", r.text);
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "active", version: 1, reason: "ok" } });
  check("…a reason under 5 characters → 400", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  const logsBefore = logs().length;
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "active", version: 7, reason: "brand approved the terms" } });
  check("…a stale version → 409, program unchanged, nothing logged", r.status === 409 && rows("LoyaltyProgram", (p) => same(p._id, pB.id))[0].status === "draft" && logs().length === logsBefore, r.text);
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "active", version: 1, reason: "brand approved the terms" } });
  const pub = logs((x) => x.action === "loyalty.program.publish")[0];
  check("admin publishes: active, logged as publish with before/after status and versions", r.status === 200 && r.json.data.status === "active" && pub && pub.before.status === "draft" && pub.after.status === "active" && pub.before.version === 1 && pub.after.version === 2 && pub.reason === "brand approved the terms", JSON.stringify(pub && [pub.before, pub.after]));
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { terms: "dine-in only", maxVisitsPerDay: 2, version: 2, reason: "brand asked by email" } });
  const upd = logs((x) => x.action === "loyalty.program.update" && x.targetId === pB.id).slice(-1)[0];
  check("admin edits rules: logged as update with only the changed fields", r.status === 200 && upd && JSON.stringify(Object.keys(upd.after).sort()) === JSON.stringify(["maxVisitsPerDay", "terms", "version"]) && upd.after.terms === "dine-in only" && upd.before.maxVisitsPerDay === 1, JSON.stringify(upd && upd.after));
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "paused", version: 3, reason: "complaint under review" } });
  check("admin pauses: logged as pause", r.status === 200 && r.json.data.status === "paused" && logs((x) => x.action === "loyalty.program.pause" && x.targetId === pB.id).length === 1);
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { status: "ended", version: 4, reason: "brand left the pilot" } });
  check("admin ends: logged as end", r.status === 200 && r.json.data.status === "ended" && logs((x) => x.action === "loyalty.program.end" && x.targetId === pB.id).length === 1);
  r = await call("POST", `${AL}/${pB.id}/restart`, { tok: T.admin, body: { version: 5 } });
  check("restart without a reason → 400", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED", r.text);
  r = await call("POST", `${AL}/${pB.id}/restart`, { tok: T.admin, body: { version: 5, reason: "brand rejoined the pilot" } });
  const rs1 = logs((x) => x.action === "loyalty.program.restart" && x.targetId === pB.id)[0];
  check("admin restarts: a draft at version 6, a restart row, logged", r.status === 200 && r.json.data.status === "draft" && r.json.data.version === 6 && rows("LoyaltyProgramRestart", (x) => same(x.program, pB.id)).length === 1 && rs1 && rs1.before.status === "ended" && rs1.after.status === "draft", r.text.slice(0, 160));
  r = await call("GET", `${AL}/${pB.id}`, { tok: T.admin });
  check("admin view shows the history and the restart", r.json.data.history.length >= 5 && r.json.data.restarts.length === 1 && r.json.data.restarts[0].byAdmin === true);
  // a write that can't be logged doesn't report success
  const ALog = reqS("./models/AdminActionLog");
  const realCreate = ALog.create;
  ALog.create = async () => { throw new Error("log store down"); };
  r = await call("PATCH", `${AL}/${pB.id}`, { tok: T.admin, body: { terms: "x", version: 6, reason: "testing the log failure" } });
  ALog.create = realCreate;
  check("log store down: the admin write reports an error (never a silent unlogged success)", r.status === 500, r.status);

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, no hidden user fields (and no e-mail / phone in /api/loyalty)`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
