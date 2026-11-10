// Loyalty reward mode (FLAG_LOYALTY_V2): every N verified visits earn one reward (% off, PKR off, a free item).
// Validation, the offer's own % on the visit, earning exactly once (retries, simultaneous visits), using it once
// (brand only, idempotent, simultaneous uses), the count restarting after use, per-month / per-program limits, the
// admin cap, a restart never reopening old rewards, programs without a mode staying tiers, outside the pilot.
//   node tests/loyalty-rewards/run.js [serverDir]
// Harness copied from tests/loyalty (real routes, models, services; fake MongoDB; no database, network or .env).
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
for (const m of ["User", "Offer", "PromoCode", "Branch", "Notification", "University", "PendingScan", "DomainEvent", "RedemptionGuard", "EngagementProfile", "PointsLedger", "LoyaltyProgram", "LoyaltyLedger", "LoyaltySnapshot", "LoyaltyProgramRestart", "AdminActionLog", "LoyaltyReward", "LoyaltyNotice"]) reqS(`./models/${m}`);
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
for (const k of ["R", "P", "M", "T", "S1", "S2", "S3", "admin", "oR", "oP", "oM", "oT"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03005550142", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.R, "brand", "roast", { brandName: "Roast Cafe" }), user(ids.P, "brand", "pizza", { brandName: "Pizza Point" }), user(ids.M, "brand", "mart", { brandName: "Mini Mart" }), user(ids.T, "brand", "tiers", { brandName: "Old Tiers" }),
  user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "umar"), user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, title, pct = 20) => ({ _id: id, brand, title, discountPercentage: pct, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("Offer"), [offer(ids.oR, ids.R, "Roast 10%", 10), offer(ids.oP, ids.P, "Pizza 15%", 15), offer(ids.oM, ids.M, "Mart 5%", 5), offer(ids.oT, ids.T, "Tiers 20%")]);
// a program from before reward mode: no "mode" field at all (no migration)
fake.seed(coll("LoyaltyProgram"), [{ _id: oid(), brand: ids.T, status: "active", tiers: [{ name: "Member", minVisit: 1, maxVisit: 5, discountPct: 15 }, { name: "Regular", minVisit: 6, maxVisit: null, discountPct: 25 }], eligibleOfferIds: [], branchIds: [], maxDiscountPct: 25, adminMaxDiscountPct: null, maxVisitsPerDay: 0, resetMonths: 12, terms: "", startsAt: null, endsAt: null, version: 4, history: [], createdAt: new Date(), updatedAt: new Date() }]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

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
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const statuses = (rs) => rs.map((r) => r.status).sort().join(",");
const offerDoc = (id) => rows("Offer", (o) => same(o._id, id))[0];
let seedDay = 3;
function seedRedemption(offerId, who, bill = 1000) {
  const rid = oid();
  offerDoc(offerId).redemptions.push({ _id: rid, student: ids[who], billAmount: bill, savedAmount: Math.round(bill * 0.1), redeemedAt: new Date(Date.now() - seedDay++ * 864e5) });
  return rid;
}
const visit = (offerKey, who) => loyalty.onVerifiedRedemption(seedRedemption(ids[offerKey], who), { source: "test" });
const rewardsOf = (brand, who, f = () => true) => rows("LoyaltyReward", (r) => same(r.brand, ids[brand]) && same(r.student, ids[who]) && f(r));

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["R", "P", "M", "T", "S1", "S2", "S3", "admin"].map((k) => [k, token(k, k === "admin" ? "admin" : /^S/.test(k) ? "student" : "brand")]));
  process.env.FLAG_LOYALTY_V2 = `ids:${["R", "P", "M", "T", "S1", "S2"].map((k) => ids[k]).join(",")}`; // S3 not in the pilot
  const LP = "/api/loyalty/programs";
  const me = async (brand, who) => (await call("GET", `/api/loyalty/brands/${ids[brand]}/me`, { tok: T[who] })).json.data;

  console.log("── 1. a program from before reward mode is unchanged (no mode = tiers, no migration)");
  let r = await call("GET", `/api/loyalty/brands/${ids.T}/me`, { tok: T.S1 });
  check("old program: tiers progress as before, mode tiers, no stamps", r.status === 200 && r.json.data.program.mode === "tiers" && r.json.data.program.reward === null && r.json.data.progress.currentTier.discountPct === 15 && !("stamps" in r.json.data), r.text.slice(0, 200));

  console.log("── 2. setting up a reward program: validation");
  const bad = [
    [{ mode: "reward" }, "INVALID_REWARD", "reward mode without a reward"],
    [{ mode: "reward", reward: { visitsNeeded: 1, kind: "item", item: "coffee" } }, "INVALID_REWARD", "1 visit"],
    [{ mode: "reward", reward: { visitsNeeded: 21, kind: "item", item: "coffee" } }, "INVALID_REWARD", "21 visits"],
    [{ mode: "reward", reward: { visitsNeeded: 3, kind: "cash", value: 5 } }, "INVALID_REWARD", "an unknown kind"],
    [{ mode: "reward", maxDiscountPct: 25, reward: { visitsNeeded: 3, kind: "percent", value: 30 } }, "OVER_MAX_DISCOUNT", "% off above the maximum"],
    [{ mode: "reward", reward: { visitsNeeded: 3, kind: "amount", value: 0 } }, "INVALID_REWARD", "PKR 0 off"],
    [{ mode: "reward", reward: { visitsNeeded: 3, kind: "item", item: "x" } }, "INVALID_REWARD", "an item without a name"],
    [{ mode: "reward", reward: { visitsNeeded: 3, kind: "item", item: "coffee", maxPerMonth: 0 } }, "INVALID_REWARD", "a monthly limit of 0"],
    [{ mode: "points" }, "INVALID_MODE", "an unknown mode"],
  ];
  for (const [body, code, label] of bad) {
    r = await call("POST", LP, { tok: T.R, body });
    check(`refused: ${label} → 400 ${code}`, r.status === 400 && r.json?.error?.code === code, r.text.slice(0, 140));
  }
  check("…nothing was created", rows("LoyaltyProgram", (p) => same(p.brand, ids.R)).length === 0);
  r = await call("POST", LP, { tok: T.R, body: { mode: "reward", reward: { visitsNeeded: 3, kind: "item", item: "a free coffee", maxPerMonth: 2 }, maxVisitsPerDay: 0 } });
  const pR = r.json?.data;
  check("Roast: reward program, 3 visits = a free coffee, max 2 a month", r.status === 201 && pR.mode === "reward" && pR.reward.visitsNeeded === 3 && pR.reward.kind === "item" && pR.reward.label === "a free coffee" && pR.reward.maxPerMonth === 2, r.text.slice(0, 200));
  let ver = 1;
  for (const [n, label] of [[2, "quick pick 2"], [5, "quick pick 5"], [20, "custom 20 (the most)"], [3, "back to 3"]]) {
    r = await call("PATCH", `${LP}/${pR.id}`, { tok: T.R, body: { reward: { visitsNeeded: n, kind: "item", item: "a free coffee", maxPerMonth: 2 }, version: ver } });
    check(`visits needed: ${label} → saved`, r.status === 200 && r.json.data.reward.visitsNeeded === n, r.text.slice(0, 120));
    ver = r.json?.data?.version ?? ver;
  }
  r = await call("PATCH", `${LP}/${pR.id}`, { tok: T.R, body: { status: "active", version: ver } });
  check("…published", r.status === 200 && r.json.data.status === "active");

  console.log("── 3. stamps, and the visit keeps the offer's own %");
  let st = await me("R", "S1");
  check("student: no tier progress, stamps 0 of 3, the reward named", st.enabled && st.progress === null && st.stamps.stamps === 0 && st.stamps.needed === 3 && st.stamps.reward.label === "a free coffee" && st.stamps.available === null, JSON.stringify(st.stamps));
  r = await call("POST", "/api/offers/redeem-payment", { tok: T.R, body: { offerId: String(ids.oR), userId: String(ids.S1), billAmount: 1000 } });
  check("a redemption in reward mode saves the offer's own 10% (no tier %)", r.status === 200 && r.json.savedAmount === 100, JSON.stringify(r.json).slice(0, 160));
  st = await me("R", "S1");
  check("…and counts as stamp 1 of 3", st.stamps.stamps === 1 && st.stamps.visitsToReward === 2, JSON.stringify(st.stamps));
  const q1 = (await call("POST", "/api/loyalty/quotes", { tok: T.R, body: { studentId: String(ids.S1), offerId: String(ids.oR) } })).json.data;
  check("brand quote: reward mode, applies false (offer %), 1 of 3", q1.mode === "reward" && q1.applies === false && q1.stamps === 1 && q1.needed === 3);

  console.log("── 4. earning: exactly once, even with retries and simultaneous visits");
  const rid2 = seedRedemption(ids.oR, "S1");
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => loyalty.onVerifiedRedemption(rid2, { source: "test" })));
  check("the same visit 5 times at once: one credit", rows("LoyaltyLedger", (e) => same(e.redemptionId, rid2) && e.type === "CREDIT").length === 1 && many.filter((x) => x.credited && !x.duplicate).length === 1, many.map((x) => `${x.credited}/${!!x.duplicate}`).join(" "));
  check("…stamp 2 of 3, no reward yet", (await me("R", "S1")).stamps.stamps === 2 && rewardsOf("R", "S1").length === 0);
  const two = await Promise.all([visit("oR", "S1"), visit("oR", "S1")]);
  check("two different visits at once fill the card: both counted, ONE reward", two.every((x) => x.credited) && rewardsOf("R", "S1").length === 1 && rewardsOf("R", "S1")[0].status === "available", `${rewardsOf("R", "S1").length} rewards`);
  for (let i = 0; i < 3; i++) await loyalty.earnRewardIfDue(await loyalty.activeProgram(ids.R), ids.R, ids.S1);
  check("earning again by hand (retries): still one reward", rewardsOf("R", "S1").length === 1);
  st = await me("R", "S1");
  check("student: card full, the reward waiting", st.stamps.stamps === 3 && st.stamps.available?.label === "a free coffee" && st.stamps.visitsToReward === 0, JSON.stringify(st.stamps));
  const notices = rows("LoyaltyNotice", (n) => same(n.student, ids.S1) && same(n.brand, ids.R));
  check("notifications: 'Visit 1 of 3' … and 'Reward unlocked' once", notices.some((n) => n.title === "Visit 1 of 3 at Roast Cafe" && n.body === "2 more visits to a free coffee.") && notices.filter((n) => n.title === "Reward unlocked at Roast Cafe").length === 1, notices.map((n) => n.title).join(" | "));
  await visit("oR", "S1");
  check("another visit while the reward waits: no second reward (the card stays full)", rewardsOf("R", "S1").length === 1 && (await me("R", "S1")).stamps.stamps === 3);

  console.log("── 5. using it: once, by the brand, idempotent; then the count restarts");
  const rw = rewardsOf("R", "S1")[0];
  const U = `/api/loyalty/rewards/${rw._id}/use`;
  r = await call("POST", U, { tok: T.P, body: {} });
  check("another brand can't use it (404)", r.status === 404 && r.json.error.code === "NOT_FOUND");
  r = await call("POST", U, { tok: T.S1, body: {} });
  check("the student can't use it themselves (403)", r.status === 403);
  r = await call("POST", U, { tok: T.R, body: { billAmount: -5 } });
  check("a negative bill → 400, still waiting", r.status === 400 && rewardsOf("R", "S1")[0].status === "available");
  r = await call("POST", U, { tok: T.R, body: { billAmount: 800 }, headers: { "Idempotency-Key": "till-1" } });
  check("Roast uses it: 201, used, a free item saves nothing in money", r.status === 201 && r.json.data.status === "used" && r.json.data.savedAmount === null && rewardsOf("R", "S1")[0].status === "used", r.text.slice(0, 160));
  r = await call("POST", U, { tok: T.R, body: { billAmount: 800 }, headers: { "Idempotency-Key": "till-1" } });
  check("the same request again (retry): 200, the same answer, nothing new", r.status === 200 && r.json.data.duplicate === true && rewardsOf("R", "S1").length === 1);
  r = await call("POST", U, { tok: T.R, body: {}, headers: { "Idempotency-Key": "till-2" } });
  check("a second use → 409 ALREADY_USED", r.status === 409 && r.json.error.code === "ALREADY_USED");
  st = await me("R", "S1");
  check("after the reward is used, the count restarts at 0 (the visit made while it waited doesn't carry)", st.stamps.stamps === 0 && st.stamps.available === null, JSON.stringify(st.stamps));
  check("…a domain event per earn and per use", rows("DomainEvent", (e) => e.type === "loyalty.reward.earned").length === 1 && rows("DomainEvent", (e) => e.type === "loyalty.reward.used").length === 1);
  for (let i = 0; i < 3; i++) await visit("oR", "S1");
  const rw2 = rewardsOf("R", "S1", (x) => x.status === "available")[0];
  check("3 more visits: a second reward", !!rw2 && rewardsOf("R", "S1").length === 2);
  const uses = await Promise.all([1, 2, 3, 4, 5].map((i) => call("POST", `/api/loyalty/rewards/${rw2._id}/use`, { tok: T.R, body: {}, headers: { "Idempotency-Key": `race-${i}` } })));
  check("5 different uses at once: exactly one 201, the rest 409", uses.filter((x) => x.status === 201).length === 1 && uses.filter((x) => x.status === 409).length === 4, statuses(uses));

  console.log("── 6. limits: per month, per program");
  for (let i = 0; i < 3; i++) await visit("oR", "S1");
  st = await me("R", "S1");
  check("max 2 rewards a month: the third full card earns nothing, says so", rewardsOf("R", "S1").length === 2 && st.stamps.stamps === 3 && st.stamps.available === null && st.stamps.limitReached === "monthly-limit", JSON.stringify(st.stamps));
  r = await call("POST", LP, { tok: T.M, body: { mode: "reward", maxVisitsPerDay: 0, reward: { visitsNeeded: 2, kind: "amount", value: 150, maxPerStudent: 1 } } });
  await call("PATCH", `${LP}/${r.json.data.id}`, { tok: T.M, body: { status: "active", version: 1 } });
  for (let i = 0; i < 2; i++) await visit("oM", "S2");
  const mr = rewardsOf("M", "S2")[0];
  await call("POST", `/api/loyalty/rewards/${mr._id}/use`, { tok: T.M, body: { billAmount: 1000 } });
  for (let i = 0; i < 2; i++) await visit("oM", "S2");
  check("max 1 reward per student: no second one, 'program-limit'", rewardsOf("M", "S2").length === 1 && (await me("M", "S2")).stamps.limitReached === "program-limit");
  check("PKR 150 off on a 1000 bill: saved 150", rewardsOf("M", "S2")[0].savedAmount === 150);

  console.log("── 7. the admin cap still applies");
  r = await call("POST", LP, { tok: T.P, body: { mode: "reward", maxVisitsPerDay: 0, maxDiscountPct: 25, reward: { visitsNeeded: 2, kind: "percent", value: 20 } } });
  const pP = r.json.data;
  await call("PATCH", `${LP}/${pP.id}`, { tok: T.P, body: { status: "active", version: 1 } });
  r = await call("PATCH", `${LP}/${pP.id}`, { tok: T.P, body: { maxDiscountPct: 15, version: 2 } });
  check("the brand can't lower its maximum below its own 20% reward (400)", r.status === 400 && r.json.error.code === "OVER_MAX_DISCOUNT", r.text.slice(0, 120));
  r = await call("PATCH", `${LP}/${pP.id}`, { tok: T.admin, body: { adminMaxDiscountPct: 10 } });
  check("admin caps Pizza at 10%: the reward shows as 10% off", r.status === 200 && r.json.data.reward.value === 10 && r.json.data.reward.label === "10% off", JSON.stringify(r.json?.data?.reward));
  for (let i = 0; i < 2; i++) await visit("oP", "S2");
  const pr = rewardsOf("P", "S2")[0];
  r = await call("POST", `/api/loyalty/rewards/${pr._id}/use`, { tok: T.P, body: { billAmount: 1000 } });
  check("20% reward under a 10% cap on 1000: saves 100, not 200", r.status === 201 && r.json.data.savedAmount === 100, r.text.slice(0, 160));
  r = await call("PATCH", `${LP}/${pP.id}`, { tok: T.P, body: { reward: { visitsNeeded: 2, kind: "percent", value: 15 }, version: (await call("GET", `${LP}/mine`, { tok: T.P })).json.data.version } });
  check("the brand can't set a % reward above the admin cap (400)", r.status === 400 && r.json.error.code === "OVER_MAX_DISCOUNT");
  r = await call("PATCH", `${LP}/${(await call("GET", `${LP}/mine`, { tok: T.M })).json.data.id}`, { tok: T.admin, body: { adminMaxDiscountPct: 5 } });
  for (let i = 0; i < 2; i++) await visit("oM", "S1");
  const m1 = rewardsOf("M", "S1")[0];
  r = await call("POST", `/api/loyalty/rewards/${m1._id}/use`, { tok: T.M, body: { billAmount: 1000 } });
  check("PKR 150 off under a 5% cap on 1000: saves 50", r.status === 201 && r.json.data.savedAmount === 50, r.text.slice(0, 160));

  console.log("── 8. a restart never reopens rewards from before");
  for (let i = 0; i < 2; i++) await visit("oP", "S1");
  const waiting = rewardsOf("P", "S1", (x) => x.status === "available")[0];
  let mine = (await call("GET", `${LP}/mine`, { tok: T.P })).json.data;
  await call("PATCH", `${LP}/${mine.id}`, { tok: T.P, body: { status: "ended", version: mine.version } });
  r = await call("POST", `/api/loyalty/rewards/${waiting._id}/use`, { tok: T.P, body: {} });
  check("program ended: a waiting reward can't be used (409)", r.status === 409 && r.json.error.code === "PROGRAM_NOT_ACTIVE");
  mine = (await call("GET", `${LP}/mine`, { tok: T.P })).json.data;
  await call("POST", `${LP}/${mine.id}/restart`, { tok: T.P, body: { version: mine.version } });
  mine = (await call("GET", `${LP}/mine`, { tok: T.P })).json.data;
  r = await call("PATCH", `${LP}/${mine.id}`, { tok: T.P, body: { status: "active", version: mine.version } });
  check("restarted and published (still reward mode)", r.status === 200 && r.json.data.mode === "reward");
  r = await call("POST", `/api/loyalty/rewards/${waiting._id}/use`, { tok: T.P, body: {} });
  check("…the old reward still can't be used", r.status === 409 && r.json.error.code === "PROGRAM_NOT_ACTIVE");
  st = await me("P", "S1");
  check("…and the student starts again at 0 with nothing waiting", st.stamps.stamps === 0 && st.stamps.available === null, JSON.stringify(st.stamps));

  console.log("── 9. brand numbers; outside the pilot");
  r = await call("GET", "/api/loyalty/brands/me/analytics", { tok: T.R });
  check("Roast analytics: rewards earned / used / waiting", r.status === 200 && r.json.data.rewards.earned === 2 && r.json.data.rewards.used === 2 && r.json.data.rewards.waiting === 0, JSON.stringify(r.json?.data?.rewards));
  r = await call("GET", `/api/loyalty/brands/${ids.R}/me`, { tok: T.S3 });
  check("a student outside the pilot: not enabled", r.status === 200 && r.json.data.enabled === false);
  await visit("oR", "S3");
  check("…earns nothing", rewardsOf("R", "S3").length === 0 && !rows("LoyaltyLedger", (e) => same(e.student, ids.S3)).length);
  r = await call("GET", "/api/offers/pending-scans", { tok: T.R });
  check("pending scans reply still works in reward mode", r.status === 200);

  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, no hidden user fields (and no e-mail / phone in /api/loyalty)`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
