// Loyalty visits from redemptions (fix/loyalty-visits): a 2-visit stamp card fills over two days and the reward is
// ready; using it restarts the count; the daily limit (1 / 2) is the brand's setting and "visit already counted
// today" reaches the brand and the student; every redemption path goes to the counter and a retry counts once; an
// offer or branch outside the program is said on the verify screen; a visit from a screen that doesn't know the
// branch counts; the student's "my loyalty"; the brand's members (filters, totals, CSV, no contact details) and the
// admin's view of them.
//   node tests/loyalty-visits/run.js [serverDir]
// Real routes and models; fake MongoDB; no network.
const path = require("path");
const fs = require("fs");
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
for (const k of ["R", "P", "M", "T", "S1", "S2", "S3", "admin", "oR", "oP", "oM", "oT", "oR2", "U", "b1", "b2"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03005550142", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.R, "brand", "roast", { brandName: "Roast Cafe" }), user(ids.P, "brand", "pizza", { brandName: "Pizza Point" }), user(ids.M, "brand", "mart", { brandName: "Mini Mart" }), user(ids.T, "brand", "tiers", { brandName: "Old Tiers" }),
  user(ids.S1, "student", "sana", { university: ids.U }), user(ids.S2, "student", "taha"), user(ids.S3, "student", "umar"), user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, title, pct = 20) => ({ _id: id, brand, title, discountPercentage: pct, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("University"), [{ _id: ids.U, name: "NED University" }]);
fake.seed(coll("Branch"), [{ _id: ids.b1, brand: ids.P, name: "Clifton", city: "Karachi", createdAt: new Date() }, { _id: ids.b2, brand: ids.P, name: "DHA", city: "Karachi", createdAt: new Date() }]);
fake.seed(coll("Offer"), [offer(ids.oR2, ids.R, "Roast cake 10%", 10), offer(ids.oR, ids.R, "Roast 10%", 10), offer(ids.oP, ids.P, "Pizza 15%", 15), offer(ids.oM, ids.M, "Mart 5%", 5), offer(ids.oT, ids.T, "Tiers 20%")]);
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


// "a day later": every stored loyalty / redemption date moves one day into the past and the per-day caps (keyed by
// today's date) start again, as they do on a real new day
function nextDay() {
  const back = (d) => (d ? new Date(new Date(d).getTime() - 864e5) : d);
  for (const e of rows("LoyaltyLedger")) { e.effectiveAt = back(e.effectiveAt); e.createdAt = back(e.createdAt); }
  for (const r of rows("LoyaltyReward")) { r.earnedAt = back(r.earnedAt); if (r.usedAt) r.usedAt = back(r.usedAt); }
  for (const o of rows("Offer")) for (const r of o.redemptions || []) r.redeemedAt = back(r.redeemedAt);
  (fake.STORE.get(coll("RedemptionGuard")) || []).length = 0;
}
const setDay = (n) => { if (n > 0) nextDay(); };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const tk = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });
  const T = Object.fromEntries(["R", "P", "M", "T", "S1", "S2", "S3", "admin"].map((k) => [k, tk(k, k === "admin" ? "admin" : /^S/.test(k) ? "student" : "brand")]));
  delete process.env.FLAG_LOYALTY_V2; // every brand and student has Loyalty by default (feat/features-on-by-default)
  await reqS("./services/featureAccess").load(); // account roles + defaults, as the server does at start
  const LP = "/api/loyalty/programs";
  const me = async (brand, who) => (await call("GET", `/api/loyalty/brands/${ids[brand]}/me`, { tok: T[who] })).json?.data;
  const redeem = (brand, offerKey, who, extra = {}) => call("POST", "/api/offers/redeem-payment", { tok: T[brand], body: { offerId: String(ids[offerKey]), userId: String(ids[who]), billAmount: 1000, ...extra } });
  const program = async (brand, body) => {
    let r = await call("POST", LP, { tok: T[brand], body });
    const p = r.json?.data;
    r = await call("PATCH", `${LP}/${p.id}`, { tok: T[brand], body: { status: "active", version: p.version } });
    return r.json?.data || p;
  };
  const credits = (brand, who) => rows("LoyaltyLedger", (e) => same(e.brand, ids[brand]) && same(e.student, ids[who]) && e.type === "CREDIT");

  console.log("── 1. a 2-visit stamp card: two redemptions on different days fill it");
  const pR = await program("R", { mode: "reward", reward: { visitsNeeded: 2, kind: "item", item: "a free coffee" }, eligibleOfferIds: [String(ids.oR)] });
  check("Roast: a published stamp card, 2 visits = a free coffee, max visits counted per day 1 (the default)", pR.status === "active" && pR.reward.visitsNeeded === 2 && pR.maxVisitsPerDay === 1, JSON.stringify(pR).slice(0, 200));
  setDay(0);
  let r = await redeem("R", "oR", "S1");
  check("redemption 1 (QR at the counter): the brand is told 'visit counted'", r.status === 200 && r.json.loyalty?.credited === true && r.json.loyalty.message === "visit counted", JSON.stringify(r.json?.loyalty));
  let st = await me("R", "S1");
  check("…the student's card: 1 of 2 visits", st.stamps.stamps === 1 && st.stamps.needed === 2 && st.stamps.visitsToReward === 1, JSON.stringify(st.stamps));

  console.log("── 2. the same day: the daily limit (1)");
  r = await redeem("R", "oR", "S1");
  check("redemption 2 the same day: the discount applies, the brand is told 'visit already counted today'", r.status === 200 && r.json.savedAmount === 100 && r.json.loyalty?.credited === false && r.json.loyalty.reason === "daily-limit" && r.json.loyalty.message === "visit already counted today", JSON.stringify(r.json?.loyalty));
  const nt = rows("LoyaltyNotice", (n) => same(n.student, ids.S1) && /already counted today/.test(n.title));
  check("…the student is told too (in-app + push): 'Visit already counted today at Roast Cafe'", nt.length === 1 && /Roast Cafe/.test(nt[0].title), JSON.stringify(nt.map((n) => n.title)));
  check("…still 1 of 2", (await me("R", "S1")).stamps.stamps === 1);

  console.log("── 3. the next day: the card fills, the reward is ready; using it restarts the count");
  setDay(1);
  r = await redeem("R", "oR", "S1");
  check("redemption on the next day: 'visit counted · reward ready'", r.status === 200 && r.json.loyalty?.credited === true && r.json.loyalty.message === "visit counted · reward ready", JSON.stringify(r.json?.loyalty));
  st = await me("R", "S1");
  check("…the card: 2 of 2, reward ready (a free coffee)", st.stamps.stamps === 2 && st.stamps.visitsToReward === 0 && st.stamps.available?.label === "a free coffee", JSON.stringify(st.stamps));
  r = await call("POST", `/api/loyalty/rewards/${st.stamps.available.id}/use`, { tok: T.R, body: {}, headers: { "Idempotency-Key": "use-1" } });
  check("the brand applies the reward", r.status < 300 && r.json?.success === true && r.json.data.status === "used", `${r.status} ${r.text.slice(0, 120)}`);
  st = await me("R", "S1");
  check("…the count restarts: 0 of 2, no reward waiting", st.stamps.stamps === 0 && st.stamps.available === null, JSON.stringify(st.stamps));
  setDay(2);
  await redeem("R", "oR", "S1");
  check("…and the next visit is 1 of 2 again", (await me("R", "S1")).stamps.stamps === 1);

  console.log("── 4. the daily limit is the brand's setting: 2 a day counts two");
  const pP = await program("P", { mode: "reward", reward: { visitsNeeded: 3, kind: "item", item: "a slice" }, maxVisitsPerDay: 2 });
  check("Pizza: max visits counted per day 2", pP.maxVisitsPerDay === 2);
  setDay(3);
  await redeem("P", "oP", "S2"); await redeem("P", "oP", "S2");
  check("two redemptions the same day with the limit 2: 2 of 3", (await me("P", "S2")).stamps.stamps === 2);

  console.log("── 5. retries count once; every path goes to the counter");
  const rid = oid();
  offerDoc(ids.oP).redemptions.push({ _id: rid, student: ids.S3, billAmount: 500, savedAmount: 75, redeemedAt: new Date() });
  const [a, b] = await Promise.all([loyalty.creditSafe(rid, { source: "webhook-confirm" }), loyalty.creditSafe(rid, { source: "webhook-confirm" })]);
  await loyalty.creditSafe(rid, { source: "webhook-confirm" });
  check("the same redemption sent 3 times (a retried webhook, at once and later): one ledger row, one visit", rows("LoyaltyLedger", (e) => same(e.redemptionId, rid)).length === 1 && [a, b].filter((x) => x.credited).length === 1 && (await me("P", "S3")).stamps.stamps === 1);
  // promo code (online / brand dashboard): confirm-redemption
  fake.seed(coll("PromoCode"), [{ _id: oid(), code: "TDCLOY1", offer: ids.oM, student: ids.S1, brand: ids.M, discountPercentage: 5, offerTitle: "Mart 5%", brandName: "Mini Mart", status: "active", expiresAt: new Date(Date.now() + 864e5), maxUses: 1, usedCount: 0, createdAt: new Date() }]);
  await program("M", { mode: "reward", reward: { visitsNeeded: 2, kind: "item", item: "a snack" }, maxVisitsPerDay: 0 });
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.M, body: { promoCode: "TDCLOY1", offerId: String(ids.oM), billAmount: 800 } });
  check("promo code confirmed at the brand: the visit counts, the brand is told", r.status === 200 && r.json?.data?.loyalty?.credited === true && r.json.data.loyalty.message === "visit counted", JSON.stringify(r.json?.data?.loyalty || r.json));
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.M, body: { promoCode: "TDCLOY1", offerId: String(ids.oM), billAmount: 800 } });
  check("…the same request again (a retry): refused ('already used'), still one visit", [400, 409].includes(r.status) && (await me("M", "S1")).stamps.stamps === 1 && credits("M", "S1").length === 1, r.status);
  const read = (f) => fs.readFileSync(path.join(SERVER, f), "utf8");
  const pushes = [["routes/offer.routes.js", "redeem-payment"], ["routes/promoCode.routes.js", "promo-verify"], ["routes/promoCode.routes.js", "promo-confirm"], ["routes/webhook.routes.js", "webhook-confirm"], ["routes/webhook.routes.js", "shopify-webhook"], ["routes/shopifyApp.routes.js", "shopify-app"], ["services/storeOrders.js", "woo-webhook"]];
  check("every redemption path calls the counter, never behind a tier-only check: QR at the counter, promo verify, promo confirm, store webhook, Shopify webhook, Shopify app, WooCommerce",
    pushes.every(([f, src]) => new RegExp(`creditSafe\\([^)]*source: ["']${src}["']`).test(read(f))) && !/quote\.applies \|\| quote\.mode === ["']reward["'] \? await loyalty\.creditSafe/.test(read("routes/offer.routes.js") + read("routes/promoCode.routes.js")));

  console.log("── 6. outside the program: the brand sees why");
  r = await redeem("R", "oR2", "S2");
  check("an offer that isn't one of the program's offers: redeemed, and the brand is told 'this offer isn't part of your loyalty program'", r.status === 200 && r.json.loyalty?.credited === false && r.json.loyalty.reason === "offer-not-in-program" && /this offer isn't part of your loyalty program/.test(r.json.loyalty.message) && credits("R", "S2").length === 0, JSON.stringify(r.json?.loyalty));
  const pB = rows("LoyaltyProgram", (p) => same(p.brand, ids.P))[0];
  pB.branchIds = [ids.b1];
  setDay(5);
  r = await redeem("P", "oP", "S1");
  check("a program with chosen branches: a visit from a screen that doesn't know the branch still counts (it used to count none)", r.json.loyalty?.credited === true, JSON.stringify(r.json?.loyalty));
  r = await redeem("P", "oP", "S1", { branchId: String(ids.b2) });
  check("…a branch outside the program: 'this branch isn't part of your loyalty program'", r.json.loyalty?.credited === false && r.json.loyalty.reason === "branch-not-in-program", JSON.stringify(r.json?.loyalty));
  pB.branchIds = [];

  console.log("── 7. the student's 'my loyalty'");
  r = await call("GET", "/api/loyalty/me/cards", { tok: T.S1 });
  const cR = r.json?.data?.cards?.find((c) => c.brandId === String(ids.R));
  check("Roast's card: 1 of 2, 1 reward earned and used, the history (visits, 'visit already counted today', reward used)", r.status === 200 && cR && cR.stamps.stamps === 1 && cR.stamps.needed === 2 && cR.rewardsEarned === 1 && cR.rewardsUsed === 1 && !cR.rewardReady
    && cR.history.some((h) => h.kind === "reward-used") && cR.history.some((h) => h.status === "not-counted" && h.message === "visit already counted today"), JSON.stringify(cR).slice(0, 400));
  check("…a card per brand with visits (Roast, Pizza, Mini Mart)", ["R", "P", "M"].every((k) => r.json.data.cards.some((c) => c.brandId === String(ids[k]))));

  console.log("── 8. the brand's members");
  r = await call("GET", "/api/loyalty/brands/me/members", { tok: T.R });
  let v = r.json?.data;
  const s1 = v?.members?.find((m) => m.studentId === String(ids.S1));
  check("Roast's members: S1 with 1 of 2 visits, 1 reward earned, 1 used, a last visit date, 'tdc verified user · university'", r.status === 200 && s1 && s1.visits === 1 && s1.visitsNeeded === 2 && s1.rewardsEarned === 1 && s1.rewardsUsed === 1 && !!s1.lastVisitAt && s1.label === "tdc verified user" && s1.university === "NED University", JSON.stringify(s1));
  check("…only Roast's students (S2 was there only with an offer outside the program, S3 never)", v.members.every((m) => m.studentId === String(ids.S1)), JSON.stringify(v.members.map((m) => m.studentId)));
  check("…totals: 1 member, 3 visits this month, 1 reward earned, 1 used", v.totals.members === 1 && v.totals.visitsThisMonth === 3 && v.totals.rewardsEarned === 1 && v.totals.rewardsUsed === 1, JSON.stringify(v.totals));
  check("…no name, phone or e-mail in the reply", !/sana|@test\.local|0300/.test(JSON.stringify(v)));
  r = await call("GET", "/api/loyalty/brands/me/members?filter=reward-ready", { tok: T.R });
  check("filter 'reward ready': nobody (S1 used theirs)", r.json?.data?.members?.length === 0);
  r = await call("GET", "/api/loyalty/brands/me/members?filter=reward-used", { tok: T.R });
  check("filter 'reward used': S1", r.json?.data?.members?.length === 1);
  r = await call("GET", "/api/loyalty/brands/me/members?format=csv", { tok: T.R });
  const lines = r.text.trim().split("\n");
  check("CSV export: the same fields, no phone or e-mail", r.status === 200 && lines[0] === "student,university,visits,visits needed,rewards earned,rewards used,reward ready,last visit" && lines.length === 2 && /^tdc verified user,NED University,1,2,1,1,no,\d{4}-\d\d-\d\d$/.test(lines[1]) && !/@|0300/.test(r.text), r.text);
  r = await call("GET", "/api/loyalty/brands/me/members", { tok: T.S1 });
  check("students can't see members", r.status === 403, r.status);
  r = await call("GET", `/api/loyalty/admin/programs/${pR.id}/members`, { tok: T.admin });
  check("admin: the same view for Roast's program", r.status === 200 && r.json.data.totals.members === 1 && r.json.data.members[0].rewardsUsed === 1, r.text.slice(0, 200));
  r = await call("GET", `/api/loyalty/admin/programs/${pR.id}/members`, { tok: T.R });
  check("…admins only", r.status === 403, r.status);

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
