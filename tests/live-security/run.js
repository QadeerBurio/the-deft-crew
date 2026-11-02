// Live security fixes: ownership checks, atomic redemptions and rewards (simultaneous requests),
// offers archived instead of deleted, jobs archived instead of deleted.
//   node tests/live-security/run.js [serverDir]
// Real routes, models and services; MongoDB is tests/hide-user-secrets/fake-mongo.js with unique
// indexes enforced (as MongoDB does), plus the aggregate interpreter from tests/perf-server; Cloudinary,
// e-mail, Expo and outgoing HTTP are stubbed. No database, no network, no .env (dotenv is stubbed; run
// it from a folder without one). "Simultaneous" = several requests sent at once with Promise.all: they
// interleave at every await, exactly where a check-then-write race happens.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL"]) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const destroyed = [];
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async (id) => { destroyed.push(id); return { result: "ok" }; } }, url: () => "" }, hasCloudinary: true, deleteFromCloudinary: async (id) => { destroyed.push(id); return {}; }, getCloudinaryUrl: () => "", storage: {} },
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
// models whose unique indexes the fake must know (loaded before seeding)
for (const m of ["User", "Offer", "PromoCode", "Reward", "RewardRedemption", "EngagementProfile", "PointsLedger", "RedemptionGuard", "Job", "JobApplication", "Notification", "University"]) reqS(`./models/${m}`);

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
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
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/brands", reqS("./routes/brands.routes"));
app.use("/api/promo-codes", reqS("./routes/promoCode.routes"));
app.use("/api/notification", reqS("./routes/notification.routes"));
app.use("/api/rewards", reqS("./routes/rewards.routes"));
app.use("/api/engagement", reqS("./routes/engagement.routes"));
app.use("/api/jobs", reqS("./routes/jobs.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "B", "S1", "S2", "S3", "S4", "admin", "E", "oA", "oB", "uni", "R1", "R2", "R3", "RC", "J1", "J2", "J3", "app1"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("universities", [{ _id: ids.uni, name: "SZABIST" }]);
fake.seed(coll("User"), [
  user(ids.A, "brand", "brandA", { brandName: "Alpha Cafe" }), user(ids.B, "brand", "brandB", { brandName: "Beta" }),
  user(ids.S1, "student", "sana", { rollNo: "21K-1", university: ids.uni }), user(ids.S2, "student", "taha", { rollNo: "21K-2" }),
  user(ids.S3, "student", "umar"), user(ids.S4, "student", "zara"),
  user(ids.admin, "admin", "admin"), user(ids.E, "employee", "employer", { companyName: "Hire Co" }),
]);
const offer = (id, brand, title, extra = {}) => ({ _id: id, brand, title, discountPercentage: 20, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [ids.S1, ids.S2, ids.S3, ids.S4], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date(), ...extra });
const oldRedemption = { _id: oid(), student: ids.S2, billAmount: 1000, savedAmount: 200, redeemedAt: new Date(Date.now() - 40 * 864e5) };
fake.seed(coll("Offer"), [offer(ids.oA, ids.A, "Alpha 20%", { redemptions: [oldRedemption] }), offer(ids.oB, ids.B, "Beta deal")]);
const promo = (code, extra = {}) => ({ _id: oid(), code, offer: ids.oA, student: ids.S1, brand: ids.A, discountPercentage: 20, offerTitle: "Alpha 20%", brandName: "Alpha Cafe", status: "active", externalProvider: "none", expiresAt: new Date(Date.now() + 864e5), maxUses: 1, usedCount: 0, createdAt: new Date(), ...extra });
fake.seed(coll("PromoCode"), [promo("ALPVERIFY1"), promo("ALPCONFIRM", { student: ids.S2 })]);
fake.seed(coll("Reward"), [
  { _id: ids.R1, title: "free coffee", costPoints: 100, active: true, perUserLimit: 1, stock: 5, brand: ids.A, kind: "voucher" },
  { _id: ids.R2, title: "free cake", costPoints: 100, active: true, perUserLimit: 1, stock: 10, brand: ids.A, kind: "voucher" },
  { _id: ids.R3, title: "big prize", costPoints: 200, active: true, perUserLimit: 0, stock: null, brand: ids.A, kind: "voucher" },
]);
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: ids.S1, points: { balance: 150, lifetime: 500 } },
  { _id: oid(), user: ids.S2, points: { balance: 300, lifetime: 300 } },
  { _id: oid(), user: ids.S3, points: { balance: 300, lifetime: 300 } },
]);
fake.seed(coll("RewardRedemption"), [{ _id: ids.RC, user: ids.S4, reward: ids.R1, rewardBrand: ids.A, code: "TDC-USE-ONCE", costPoints: 100, status: "active", expiresAt: new Date(Date.now() + 864e5), snapshot: { title: "free coffee", brand: ids.A } }]);
fake.seed(coll("Job"), [
  { _id: ids.J1, title: "Remote designer", companyName: "Hire Co", location: "Remote", postedBy: ids.E, isExternal: false, source: "manual", active: true, type: "Full-time", createdAt: new Date() },
  { _id: ids.J2, title: "Berlin dev", companyName: "Imported GmbH", location: "Berlin, Germany", isExternal: true, source: "arbeitnow", active: true, type: "Full-time", createdAt: new Date() },
  { _id: ids.J3, title: "Karachi dev", companyName: "Imported PK", location: "Karachi", isExternal: true, source: "adzuna", active: true, type: "Full-time", createdAt: new Date() },
  { _id: oid(), title: "No location import", companyName: "Imported X", isExternal: true, source: "remotive", active: true, type: "Full-time", createdAt: new Date() },
  { _id: oid(), title: "Employer job, no location", companyName: "Hire Co", postedBy: ids.E, isExternal: false, source: "manual", active: true, type: "Full-time", createdAt: new Date() },
]);
fake.seed(coll("JobApplication"), [{ _id: ids.app1, jobId: ids.J1, userId: ids.S1, status: "pending", coverLetter: "hi", resumePublicId: "TDC_Job_Resumes/sana.pdf", appliedAt: new Date() }]);
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
const offerDoc = (id) => rows("Offer", (o) => same(o._id, id))[0];
// spends and awards (redeeming can complete a mission, which awards points)
const ledger = (who) => rows("PointsLedger", (l) => same(l.user, ids[who]));
const spends = (who, cost) => ledger(who).filter((l) => l.delta === -cost).length;
const ledgerSum = (who) => ledger(who).reduce((t, l) => t + l.delta, 0);
const balance = (who) => rows("EngagementProfile", (p) => same(p.user, ids[who]))[0].points.balance;

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["A", "B", "S1", "S2", "S3", "S4", "admin", "E"].map((k) => [k, token(k, k === "admin" ? "admin" : k === "E" ? "employee" : /^S/.test(k) ? "student" : "brand")]));

  console.log("── 1. ownership");
  let r = await call("POST", "/api/offers/redeem-payment", { tok: T.B, body: { offerId: String(ids.oA), userId: String(ids.S1), billAmount: 500 } });
  check("redeem-payment: another brand → 403", r.status === 403, `${r.status} ${r.json?.message}`);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.E, body: { offerId: String(ids.oA), userId: String(ids.S1), billAmount: 500 } });
  check("redeem-payment: an employer → 403", r.status === 403, r.status);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.S1, body: { offerId: String(ids.oA), userId: String(ids.S1), billAmount: 500 } });
  check("redeem-payment: a student → 403", r.status === 403, r.status);
  check("…nothing recorded", offerDoc(ids.oA).redemptions.length === 1);
  r = await call("POST", "/api/offers/scan-verify", { tok: T.S1, body: { offerId: String(ids.oA), studentId: String(ids.S2), name: "Somebody Else", email: "x@evil.test", brandId: String(ids.B), brandName: "Beta" } });
  check("scan-verify: the student and brand come from the login and the offer, not the body", r.status === 200 && r.json?.student?.studentId === String(ids.S1) && r.json.student.name === "sana" && r.json.student.email === "sana@test.local" && r.json.student.brandId === String(ids.A) && r.json.student.universityName === "SZABIST", JSON.stringify(r.json?.student || r.json));
  r = await call("POST", "/api/offers/scan-verify", { tok: T.A, body: { offerId: String(ids.oA) } });
  check("scan-verify: a brand account → 403", r.status === 403, r.status);
  r = await call("POST", "/api/offers/scan-verify", { body: { offerId: String(ids.oA) } });
  check("scan-verify: no login → refused", r.status === 401 || r.status === 403, r.status);
  r = await call("GET", "/api/offers/pending-scans", { tok: T.B });
  check("brand B doesn't see the scan made for brand A", r.status === 200 && JSON.stringify(r.json).indexOf(String(ids.S1)) === -1, r.text.slice(0, 120));
  r = await call("POST", "/api/offers/scan-processed", { tok: T.S2, body: { studentId: String(ids.S1) } });
  check("scan-processed: a student → 403", r.status === 403, r.status);
  r = await call("POST", "/api/offers/scan-processed", { tok: T.B, body: { studentId: String(ids.S1) } });
  check("scan-processed: another brand → not found, the scan stays pending", r.status === 404, r.status);
  r = await call("POST", "/api/offers/scan-processed", { tok: T.A, body: { studentId: String(ids.S1) } });
  check("scan-processed: the brand it was made for → 200", r.status === 200, r.status);
  r = await call("GET", `/api/offers/student/${ids.S2}`, { tok: T.S1 });
  check("student details: someone else's → 403", r.status === 403, r.status);
  r = await call("GET", `/api/offers/student/${ids.S1}`, { tok: T.S1 });
  check("student details: own → 200", r.status === 200 && r.json?.email === "sana@test.local", r.status);
  r = await call("GET", `/api/offers/student/${ids.S2}`, { tok: T.admin });
  check("student details: admin → 200", r.status === 200, r.status);
  r = await call("GET", `/api/brands/${ids.A}/offers/details`, { tok: T.S1 });
  check("brand offer details (who claimed, e-mails): a student → 403", r.status === 403, r.status);
  r = await call("GET", `/api/brands/${ids.A}/offers/details`, { tok: T.B });
  check("brand offer details: another brand → 403", r.status === 403, r.status);
  r = await call("GET", `/api/brands/${ids.A}/offers/details`, { tok: T.A });
  check("brand offer details: the brand itself → 200", r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
  r = await call("POST", "/api/notification/send", { tok: T.S1, body: { recipientId: String(ids.S2), title: "free money", description: "click" } });
  check("notification/send: a student → 403, nothing created", r.status === 403 && rows("Notification", (n) => String(n.title).includes("free money")).length === 0, r.status);
  r = await call("POST", "/api/notification/send", { tok: T.admin, body: { recipientId: String(ids.S2), title: "hello", description: "from tdc" } });
  check("notification/send: an admin → sent", (r.status === 200 || r.status === 201) && rows("Notification", (n) => String(n.title).includes("hello")).length === 1, r.status);

  console.log("── 2. promo codes: simultaneous verifications");
  let rs = await Promise.all([1, 2, 3].map(() => call("POST", "/api/promo-codes/verify", { tok: T.A, body: { promoCode: "ALPVERIFY1", offerId: String(ids.oA), billAmount: 1000 } })));
  check("3 simultaneous /verify of one code → one 200, the others refused", rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409 || x.status === 400).length === 2, statuses(rs));
  check("…exactly one redemption written for it", offerDoc(ids.oA).redemptions.filter((x) => x.promoCode === "ALPVERIFY1").length === 1);
  rs = await Promise.all([1, 2].map(() => call("POST", "/api/promo-codes/confirm-redemption", { tok: T.A, body: { promoCode: "ALPCONFIRM", offerId: String(ids.oA), billAmount: 800 } })));
  check("2 simultaneous /confirm-redemption → one 200, one refused", rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409 || x.status === 400).length === 1, statuses(rs));
  check("…exactly one redemption written for it", offerDoc(ids.oA).redemptions.filter((x) => x.promoCode === "ALPCONFIRM").length === 1);

  console.log("── 3. redeem-payment: the 2-a-day cap under simultaneous scans");
  const before = offerDoc(ids.oA).redemptions.length;
  rs = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S3), billAmount: 500 } })));
  check("4 simultaneous scans for one student → 2 accepted, 2 refused", rs.filter((x) => x.status === 200).length === 2 && rs.filter((x) => x.status === 400).length === 2, statuses(rs));
  check("…2 redemptions recorded for that student today", offerDoc(ids.oA).redemptions.filter((x) => same(x.student, ids.S3)).length === 2);
  rs = await Promise.all([call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S4), billAmount: 300 } }), call("POST", "/api/offers/redeem-payment", { tok: T.admin, body: { offerId: String(ids.oA), userId: String(ids.S2), billAmount: 400 } })]);
  check("two students at the same moment (brand and admin) → both recorded, none lost", rs.every((x) => x.status === 200) && offerDoc(ids.oA).redemptions.length === before + 4, `${statuses(rs)} ${offerDoc(ids.oA).redemptions.length - before}`);
  check("S3 used it twice → their claim is removed", !offerDoc(ids.oA).claimedBy.some((x) => same(x, ids.S3)));

  console.log("── 4. rewards: points spent once");
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/rewards/${ids.R1}/redeem`, { tok: T.S1 })));
  check("/rewards: 2 simultaneous redeems, 150 points, cost 100 → one code", rs.filter((x) => x.status === 200).length === 1 && rows("RewardRedemption", (x) => same(x.user, ids.S1)).length === 1, statuses(rs));
  check("…100 spent once (balance = 150 + ledger)", spends("S1", 100) === 1 && balance("S1") === 150 + ledgerSum("S1"), String(balance("S1")));
  rs = await Promise.all([1, 2, 3].map(() => call("POST", `/api/engagement/rewards/${ids.R2}/redeem`, { tok: T.S2 })));
  check("/engagement: per-user limit 1 under 3 simultaneous redeems → one code", rs.filter((x) => x.status === 201).length === 1 && rows("RewardRedemption", (x) => same(x.user, ids.S2) && same(x.reward, ids.R2)).length === 1, statuses(rs));
  check("…100 points spent once (balance = 300 + ledger), stock 10 → 9", spends("S2", 100) === 1 && balance("S2") === 300 + ledgerSum("S2") && rows("Reward", (x) => same(x._id, ids.R2))[0].stock === 9, `${balance("S2")} ${rows("Reward", (x) => same(x._id, ids.R2))[0].stock}`);
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/engagement/rewards/${ids.R3}/redeem`, { tok: T.S3 })));
  check("/engagement: 300 points, cost 200, 2 simultaneous → one code, 200 spent once", rs.filter((x) => x.status === 201).length === 1 && spends("S3", 200) === 1 && balance("S3") === 300 + ledgerSum("S3") && rows("RewardRedemption", (x) => same(x.user, ids.S3)).length === 1, `${statuses(rs)} ${balance("S3")}`);
  rs = await Promise.all([1, 2].map(() => call("POST", `/api/engagement/brand/redemptions/${ids.RC}/use`, { tok: T.A })));
  check("brand 'use' tapped twice at once → one ok, one refused", rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 400).length === 1 && rows("RewardRedemption", (x) => same(x._id, ids.RC))[0].status === "used", statuses(rs));

  console.log("── 5. a new offer archives the old one");
  const revBefore = (await call("GET", "/api/offers/admin/brands-revenue", { tok: T.admin })).json?.summary;
  const savBefore = (await call("GET", "/api/offers/my-total-savings", { tok: T.S3 })).json;
  r = await call("POST", "/api/offers", { tok: T.A, body: { title: "Alpha 30%", description: "new", discountPercentage: 30, category: "Cafe & Coffee", isOnline: "true", isInStore: "true" } });
  const newOffer = rows("Offer", (o) => same(o.brand, ids.A) && o.title === "Alpha 30%")[0];
  check("POST /offers → 200/201, new offer active", (r.status === 200 || r.status === 201) && newOffer && newOffer.status !== "archived", `${r.status} ${r.text.slice(0, 80)}`);
  const old = offerDoc(ids.oA);
  check("old offer kept, archived, with all its redemptions", old && old.status === "archived" && old.archivedAt && old.redemptions.length >= 7, `${old?.status} ${old?.redemptions?.length}`);
  r = await call("GET", "/api/offers/summary", { tok: T.S1 });
  const summaryIds = Object.values(r.json || {}).flat().map((o) => String(o._id));
  check("students' summary: archived offer gone, new one there", r.status === 200 && !summaryIds.includes(String(ids.oA)) && summaryIds.includes(String(newOffer._id)), summaryIds.join(","));
  r = await call("GET", `/api/offers/brand/${ids.A}`, { tok: T.S1 });
  check("a brand's offers for students: only the active one", r.status === 200 && JSON.stringify(r.json).includes(String(newOffer._id)) && !JSON.stringify(r.json).includes(String(ids.oA)), r.status);
  r = await call("GET", "/api/offers/claimed", { tok: T.S1 });
  check("student's claimed list: archived offer gone", r.status === 200 && !JSON.stringify(r.json).includes(String(ids.oA)), r.status);
  r = await call("POST", `/api/offers/claim/${ids.oA}`, { tok: T.S2 });
  check("claim an archived offer → 410", r.status === 410, r.status);
  r = await call("POST", "/api/promo-codes/generate", { tok: T.S2, body: { offerId: String(ids.oA) } });
  check("promo code for an archived offer → 410", r.status === 410, r.status);
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.A, body: { offerId: String(ids.oA), userId: String(ids.S2), billAmount: 100 } });
  check("redeem-payment on an archived offer → 410", r.status === 410, r.status);
  r = await call("GET", "/api/offers/my-offers", { tok: T.A });
  check("brand's my-offers: only the active one (what it scans with)", r.status === 200 && JSON.stringify(r.json).includes(String(newOffer._id)) && !JSON.stringify(r.json).includes(String(ids.oA)), r.status);
  const revAfter = (await call("GET", "/api/offers/admin/brands-revenue", { tok: T.admin })).json?.summary;
  check("revenue page totals unchanged (archived offer still counted)", ["totalRevenue", "totalBill", "totalSaved", "totalRedemptions", "uniqueStudents"].every((k) => revAfter?.[k] === revBefore?.[k]), `${JSON.stringify(revBefore)} → ${JSON.stringify(revAfter)}`);
  const savAfter = (await call("GET", "/api/offers/my-total-savings", { tok: T.S3 })).json;
  check("student's total savings unchanged", JSON.stringify(savAfter) === JSON.stringify(savBefore) && savAfter.redemptionCount === 2, `${JSON.stringify(savBefore)} → ${JSON.stringify(savAfter)}`);
  r = await call("GET", `/api/offers/brand/${ids.A}/redemptions`, { tok: T.A });
  check("brand's redemption history still includes the archived offer's", r.status === 200 && (r.json?.data?.qrRedemptions?.length || r.json?.qrRedemptions?.length || JSON.stringify(r.json).split("studentName").length - 1) >= 7, r.text.slice(0, 120));

  console.log("── 6. startup clean-up: imported jobs only, archived");
  const jobsBefore = rows("Job").length;
  const { archiveForeignImportedJobs } = reqS("./services/jobArchive");
  const out = await archiveForeignImportedJobs();
  const job = (id) => rows("Job", (j) => same(j._id, id))[0];
  check("nothing deleted", rows("Job").length === jobsBefore, `${jobsBefore} → ${rows("Job").length}`);
  check("imported Berlin job archived (active false, reason outside-pakistan)", job(ids.J2).active === false && job(ids.J2).archivedAt && job(ids.J2).archivedReason === "outside-pakistan");
  check("imported Karachi job untouched", job(ids.J3).active === true && !job(ids.J3).archivedAt);
  check("employer's 'Remote' job and employer job without location untouched", job(ids.J1).active === true && !job(ids.J1).archivedAt && rows("Job", (j) => j.title === "Employer job, no location")[0].active === true);
  check("imported job without a location archived (imported only)", rows("Job", (j) => j.title === "No location import")[0].archivedAt != null);
  check("counts reported", out.archived === 2 && out.checked === 3, JSON.stringify(out));
  check("running it again changes nothing", (await archiveForeignImportedJobs()).archived === 0);

  console.log("── 7. deleting a job archives it");
  r = await call("DELETE", `/api/jobs/delete/${ids.J1}`, { tok: T.E });
  check("employer deletes their job → 200, same reply", r.status === 200 && r.json?.message === "Job deleted successfully", r.status);
  check("job kept, archived (reason deleted, by the employer)", job(ids.J1) && job(ids.J1).active === false && job(ids.J1).archivedReason === "deleted" && same(job(ids.J1).archivedBy, ids.E));
  check("its application kept, resume file not deleted", rows("JobApplication", (a) => same(a._id, ids.app1)).length === 1 && destroyed.length === 0, destroyed.join());
  r = await call("GET", "/api/jobs/my-jobs", { tok: T.E });
  check("employer's job list leaves it out", r.status === 200 && !JSON.stringify(r.json).includes(String(ids.J1)), r.status);
  r = await call("GET", `/api/jobs/public/job/${ids.J1}`);
  check("public job page → 404", r.status === 404, r.status);
  r = await call("PUT", `/api/jobs/update/${ids.J1}`, { tok: T.E, body: { title: "x" } });
  check("editing it → 410", r.status === 410, r.status);
  r = await call("DELETE", `/api/jobs/delete/${ids.J3}`, { tok: T.E });
  check("another employer's / imported job → 403", r.status === 403, r.status);

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, none expose hidden user fields`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
