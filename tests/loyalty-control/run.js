// Loyalty: brand control, the reward applied to the bill, celebrations (feat/loyalty-control), on fixed in-memory data:
//   1 to 10 visits (0 and 11 refused); any % (25, 60) without an admin cap; an admin cap (logged, with a reason) the
//   brand sees and can't exceed; "on top" / "replace"; programs saved before keep their values
//   the breakdown on the original bill: 1,000 / 15% / 25% on top -> pay 600, replace -> 750; PKR off, a free item,
//   never above the bill; the counter (QR), promo verify / confirm, an online code that carries the reward, a store
//   order (Woo); one use per reward on retries and two taps at once; the card restarts at 0; "reward unlocked" /
//   "reward used, you saved PKR X" once; revenue, savings and the brand receipts use the final amount; members.
//   node tests/loyalty-control/run.js [serverDir]
// Harness from tests/loyalty-rewards (real routes, models, services; fake MongoDB with unique indexes and
// interleaving; no database, network or .env).
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
for (const k of ["C", "D", "E", "F", "O", "S1", "S2", "S3", "S4", "admin", "oC", "oD", "oE", "oF", "oO", "old"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03005550142", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.C, "brand", "cafe", { brandName: "Chai Cafe" }), user(ids.D, "brand", "deli", { brandName: "Deli Ten" }), user(ids.E, "brand", "eats", { brandName: "Eats Swap" }),
  user(ids.F, "brand", "fries", { brandName: "Fries Co" }), user(ids.O, "brand", "oldie", { brandName: "Old Stamps" }),
  user(ids.S1, "student", "sana"), user(ids.S2, "student", "taha"), user(ids.S3, "student", "umar"), user(ids.S4, "student", "zoya"), user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, title, pct) => ({ _id: id, brand, title, discountPercentage: pct, category: "Cafe & Coffee", isOnline: true, isInStore: true, claimedBy: [ids.S1, ids.S2, ids.S3, ids.S4], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed(coll("Offer"), [offer(ids.oC, ids.C, "Chai 15%", 15), offer(ids.oD, ids.D, "Deli 15%", 15), offer(ids.oE, ids.E, "Eats 15%", 15), offer(ids.oF, ids.F, "Fries 15%", 15), offer(ids.oO, ids.O, "Old 10%", 10)]);
// a reward program saved before this change: 15 visits, no "combine" field (no migration)
fake.seed(coll("LoyaltyProgram"), [{ _id: ids.old, brand: ids.O, status: "active", mode: "reward", reward: { visitsNeeded: 15, kind: "percent", value: 20, item: "", maxPerStudent: null, maxPerMonth: null }, tiers: [{ name: "Member", minVisit: 1, maxVisit: null, discountPct: 15 }], eligibleOfferIds: [], branchIds: [], maxDiscountPct: 25, adminMaxDiscountPct: null, maxVisitsPerDay: 1, resetMonths: 12, terms: "", startsAt: null, endsAt: null, version: 3, history: [], createdAt: new Date(), updatedAt: new Date() }]);
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
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 400) + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const offerDoc = (id) => rows("Offer", (o) => same(o._id, id))[0];
const rewardsOf = (brand, who, f = () => true) => rows("LoyaltyReward", (r) => same(r.brand, ids[brand]) && same(r.student, ids[who]) && f(r));
// a visit on an earlier day (seeded + credited, as tests/loyalty-rewards does): keeps today's 2-a-day cap free
let dayBack = 2;
const visitBefore = async (offerKey, who, bill = 1000) => {
  const rid = oid();
  offerDoc(ids[offerKey]).redemptions.push({ _id: rid, student: ids[who], billAmount: bill, savedAmount: Math.round(bill * 0.15), redeemedAt: new Date(Date.now() - dayBack++ * 864e5) });
  return loyalty.onVerifiedRedemption(rid, { source: "test", at: new Date(Date.now() - (dayBack - 1) * 864e5) });
};
const redemptionsOf = (offerKey, who) => (offerDoc(ids[offerKey]).redemptions || []).filter((r) => same(r.student, ids[who]));

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["C", "D", "E", "F", "O", "S1", "S2", "S3", "S4", "admin"].map((k) => [k, token(k, k === "admin" ? "admin" : /^S/.test(k) ? "student" : "brand")]));
  process.env.FLAG_LOYALTY_V2 = `ids:${["C", "D", "E", "F", "O", "S1", "S2", "S3", "S4"].map((k) => ids[k]).join(",")}`;
  const LP = "/api/loyalty/programs";
  const me = async (brand, who) => (await call("GET", `/api/loyalty/brands/${ids[brand]}/me`, { tok: T[who] })).json.data;
  const mine = async (brand) => (await call("GET", `${LP}/mine`, { tok: T[brand] })).json.data;
  const pay = (brand, offerKey, who, bill, extra = {}) => call("POST", "/api/offers/redeem-payment", { tok: T[brand], body: { offerId: String(ids[offerKey]), userId: String(ids[who]), billAmount: bill, ...extra } });
  let r;

  console.log("── 1. brand control");
  r = await call("POST", LP, { tok: T.C, body: { mode: "reward", maxVisitsPerDay: 0, reward: { visitsNeeded: 1, kind: "percent", value: 25 } } });
  const pC = r.json?.data;
  check("1 visit: a 25% reward, accepted with no admin cap; combine 'on top' by default", r.status === 201 && pC.reward.visitsNeeded === 1 && pC.reward.value === 25 && pC.reward.combine === "stack", r.text);
  r = await call("POST", LP, { tok: T.D, body: { mode: "reward", maxVisitsPerDay: 0, reward: { visitsNeeded: 10, kind: "percent", value: 60 } } });
  const pD = r.json?.data;
  check("10 visits and a 60% reward: accepted (no fixed 25% cap)", r.status === 201 && pD.reward.visitsNeeded === 10 && pD.reward.value === 60, r.text);
  for (const [n, label] of [[0, "0 visits"], [11, "11 visits"]]) {
    r = await call("PATCH", `${LP}/${pD.id}`, { tok: T.D, body: { reward: { visitsNeeded: n, kind: "percent", value: 60 }, version: pD.version } });
    check(`${label} → 400 INVALID_REWARD`, r.status === 400 && r.json.error.code === "INVALID_REWARD", r.text);
  }
  check("a new program: at most 1 visit a day counts (default), editable", (await mine("C")).maxVisitsPerDay === 0 && (await call("POST", LP, { tok: T.F, body: { mode: "reward", reward: { visitsNeeded: 2, kind: "item", item: "a free drink" } } })).json.data.maxVisitsPerDay === 1);
  // the admin cap: set (logged with the reason), seen by the brand, enforced, cleared
  let A = (await call("GET", `/api/loyalty/admin/programs/${pD.id}`, { tok: T.admin })).json.data.program;
  r = await call("PATCH", `/api/loyalty/admin/programs/${pD.id}`, { tok: T.admin, body: { adminMaxDiscountPct: 30, version: A.version, reason: "pilot limit for Deli" } });
  check("admin sets a 30% cap on Deli: saved, the 60% reward now shows (and applies) as 30%", r.status === 200 && r.json.data.adminMaxDiscountPct === 30 && r.json.data.reward.value === 30, r.text);
  const log = rows("AdminActionLog", (l) => l.targetId === String(pD.id) && l.action === "loyalty.program.update").pop();
  check("…logged with the admin, the reason, before and after", log && same(log.admin, ids.admin) && log.reason === "pilot limit for Deli" && log.before?.adminMaxDiscountPct == null && log.after?.adminMaxDiscountPct === 30, JSON.stringify(log));
  let m = await mine("D");
  check("the brand sees the cap only once one is set (30)", m.adminMaxDiscountPct === 30 && (await mine("C")).adminMaxDiscountPct == null);
  r = await call("PATCH", `${LP}/${pD.id}`, { tok: T.D, body: { reward: { visitsNeeded: 10, kind: "percent", value: 40 }, version: m.version } });
  check("with the 30% cap, the brand can't set 40% (400 OVER_MAX_DISCOUNT)", r.status === 400 && r.json.error.code === "OVER_MAX_DISCOUNT", r.text);
  A = (await call("GET", `/api/loyalty/admin/programs/${pD.id}`, { tok: T.admin })).json.data.program;
  r = await call("PATCH", `/api/loyalty/admin/programs/${pD.id}`, { tok: T.admin, body: { adminMaxDiscountPct: null, version: A.version, reason: "cap no longer needed" } });
  m = await mine("D");
  r = await call("PATCH", `${LP}/${pD.id}`, { tok: T.D, body: { reward: { visitsNeeded: 10, kind: "percent", value: 40, combine: "replace" }, version: m.version } });
  check("cap cleared (logged): 40% accepted; 'replace the offer' saved", r.status === 200 && r.json.data.reward.value === 40 && r.json.data.reward.combine === "replace" && (await mine("D")).adminMaxDiscountPct == null, r.text);
  const old = (await call("GET", `/api/loyalty/brands/${ids.O}/program`, { tok: T.S1 })).json.data;
  check("a program saved before keeps its values (15 visits, 20%) and reads 'on top' for the new setting", old.reward.visitsNeeded === 15 && old.reward.value === 20 && old.reward.combine === "stack", JSON.stringify(old.reward));

  console.log("── 2. the breakdown (all on the ORIGINAL bill)");
  const bd = (o) => loyalty.breakdownOf(o);
  let b = bd({ bill: 1000, offerPct: 15, reward: { kind: "percent", value: 25 }, combine: "stack" });
  check("bill 1,000, offer 15%, reward 25% on top → offer 150 + reward 250 = 400, pay 600", b.offerDiscount === 150 && b.rewardDiscount === 250 && b.totalDiscount === 400 && b.pay === 600, JSON.stringify(b));
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "percent", value: 25 }, combine: "replace" });
  check("…replace → the bigger one (reward 250), pay 750", b.totalDiscount === 250 && b.offerDiscount === 0 && b.rewardDiscount === 250 && b.pay === 750 && b.used === "reward", JSON.stringify(b));
  b = bd({ bill: 1000, offerPct: 30, reward: { kind: "percent", value: 25 }, combine: "replace" });
  check("replace when the offer is bigger (30% vs 25%) → the offer, pay 700, reward adds nothing", b.totalDiscount === 300 && b.rewardDiscount === 0 && b.used === "offer");
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "amount", value: 200 }, combine: "stack" });
  check("PKR 200 off on top → 150 + 200 = 350, pay 650", b.totalDiscount === 350 && b.pay === 650);
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "amount", value: 200 }, combine: "replace" });
  check("PKR 200 off, replace → 200, pay 800", b.totalDiscount === 200 && b.pay === 800);
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "amount", value: 5000 }, combine: "stack" });
  check("PKR 5,000 off a 1,000 bill → discount 1,000 (never above the bill), pay 0", b.totalDiscount === 1000 && b.pay === 0);
  b = bd({ bill: 1000, offerPct: 60, reward: { kind: "percent", value: 60 }, combine: "stack" });
  check("60% + 60% on top → 1,000 (never above the bill)", b.totalDiscount === 1000 && b.pay === 0 && b.rewardDiscount === 400);
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "item", item: "a free chai" }, combine: "stack" });
  check("a free item: the offer discount as normal (150, pay 850) + give: a free chai", b.totalDiscount === 150 && b.pay === 850 && b.giveItem === "a free chai");
  b = bd({ bill: 1000, offerPct: 15, reward: { kind: "percent", value: 60 }, combine: "stack", capPct: 30 });
  check("an admin cap of 30% on a 60% reward: the reward part is 300", b.rewardDiscount === 300 && b.totalDiscount === 450);
  check("the text: 'bill PKR 1,000 · offer 15% −PKR 150 · reward 25% off −PKR 250 · pay PKR 600'", loyalty.breakdownText(bd({ bill: 1000, offerPct: 15, reward: { kind: "percent", value: 25, label: "25% off" }, combine: "stack" })) === "bill PKR 1,000 · offer 15% −PKR 150 · reward 25% off −PKR 250 · pay PKR 600");

  console.log("── 3. counter (QR): the reward on the bill");
  await call("PATCH", `${LP}/${pC.id}`, { tok: T.C, body: { status: "active", version: pC.version } });
  r = await pay("C", "oC", "S1", 1000);
  check("a 1-visit program: the first paid visit (offer 15%, saved 150) earns the reward", r.status === 200 && r.json.savedAmount === 150 && rewardsOf("C", "S1", (x) => x.status === "available").length === 1, r.text);
  let st = await me("C", "S1");
  check("student: the card is full (1 of 1), reward ready: 25% off", st.stamps.stamps === 1 && st.stamps.needed === 1 && st.stamps.available?.label === "25% off", JSON.stringify(st.stamps));
  const unlocked = rows("Notification", (n) => same(n.recipient, ids.S1) && /Reward unlocked at Chai Cafe$/.test(n.title));
  check("'Reward unlocked at Chai Cafe: 25% off your next bill' in-app (push data: event + reward id)", unlocked.length === 1 && /25% off your next bill/.test(unlocked[0].description) && unlocked[0].metadata?.event === "reward_unlocked" && !!unlocked[0].metadata?.rewardId, JSON.stringify(unlocked));
  const rw = rewardsOf("C", "S1")[0];
  r = await call("POST", "/api/loyalty/quotes", { tok: T.C, body: { studentId: String(ids.S1), offerId: String(ids.oC), billAmount: 1000 } });
  check("BEFORE confirming, the brand's quote shows the ready reward and its breakdown (pay 600)", r.status === 200 && r.json.data.readyReward?.id === String(rw._id) && r.json.data.readyReward.breakdown.totalDiscount === 400 && r.json.data.readyReward.breakdown.pay === 600, r.text);
  const before = redemptionsOf("oC", "S1").length;
  r = await pay("C", "oC", "S1", 1000, { applyRewardId: String(rw._id) });
  const red = redemptionsOf("oC", "S1").pop();
  check("'apply reward to this bill': saved 400 (offer 150 + reward 250), pay 600, breakdown in the reply", r.status === 200 && r.json.savedAmount === 400 && r.json.breakdown.pay === 600 && r.json.breakdown.offerDiscount === 150 && r.json.breakdown.rewardDiscount === 250 && r.json.rewardUsed?.id === String(rw._id), r.text);
  check("…the redemption saved is the final 400, linked to the reward", red.savedAmount === 400 && same(red.loyaltyRewardId, rw._id) && redemptionsOf("oC", "S1").length === before + 1);
  const used = rewardsOf("C", "S1")[0];
  check("…the reward: used once, on that redemption, with the breakdown (reward part 250, total 400)", used.status === "used" && same(used.redemptionId, red._id) && used.savedAmount === 250 && used.totalDiscount === 400 && used.billAmount === 1000 && used.combine === "stack");
  st = await me("C", "S1");
  check("after use, the card restarts at 0 (the visit that used it doesn't start the next card) and nothing is waiting", st.stamps.stamps === 0 && st.stamps.available === null && rewardsOf("C", "S1").length === 1, JSON.stringify(st.stamps));
  const usedNote = rows("Notification", (n) => same(n.recipient, ids.S1) && /Reward used at Chai Cafe$/.test(n.title));
  check("student told once: 'Reward used… You saved PKR 400: bill PKR 1,000 · offer 15% −PKR 150 · reward 25% off −PKR 250 · pay PKR 600'", usedNote.length === 1 && /You saved PKR 400: bill PKR 1,000 · offer 15% −PKR 150 · reward 25% off −PKR 250 · pay PKR 600/.test(usedNote[0].description) && usedNote[0].metadata?.event === "reward_used" && usedNote[0].metadata?.savedAmount === 400, JSON.stringify(usedNote.map((n) => n.description)));
  const payNote = rows("Notification", (n) => same(n.recipient, ids.S1) && /payment successful.$/.test(n.title)).pop();
  check("the 'payment successful' message carries the same breakdown", /you saved rs 400 at Chai 15%\. bill PKR 1,000 · offer 15% −PKR 150 · reward 25% off −PKR 250 · pay PKR 600/.test(payNote?.description || "") && payNote.metadata?.breakdown?.pay === 600, payNote?.description);
  // retries and two taps
  r = await pay("C", "oC", "S1", 1000, { applyRewardId: String(rw._id) });
  check("the same request again (a retry): the first answer (duplicate), no second redemption, no second discount", r.status === 200 && r.json.duplicate === true && r.json.redemptionId === String(red._id) && r.json.savedAmount === 400 && redemptionsOf("oC", "S1").length === before + 1, r.text);
  check("…and 'reward used' was still said only once", rows("Notification", (n) => same(n.recipient, ids.S1) && /Reward used at Chai Cafe$/.test(n.title)).length === 1);
  await visitBefore("oC", "S2"); // S2 earns a reward (yesterday)
  const rw2 = rewardsOf("C", "S2")[0];
  const s2Before = redemptionsOf("oC", "S2").length;
  const taps = await Promise.all([1, 2].map(() => pay("C", "oC", "S2", 1000, { applyRewardId: String(rw2._id) })));
  const withReward = redemptionsOf("oC", "S2").filter((x) => x.loyaltyRewardId);
  check("two taps at once: one redemption with the reward, the other answered with it (duplicate); reward used once", taps.every((x) => x.status === 200) && taps.filter((x) => x.json.duplicate).length === 1 && withReward.length === 1 && rewardsOf("C", "S2", (x) => x.status === "used").length === 1 && redemptionsOf("oC", "S2").length === s2Before + 1, taps.map((x) => x.text.slice(0, 80)).join(" | "));
  r = await pay("C", "oC", "S3", 1000, { applyRewardId: String(rw2._id) });
  check("another student's reward can't be applied (404)", r.status === 404 && r.json.code === "REWARD_NOT_FOUND");
  r = await pay("D", "oD", "S1", 1000, { applyRewardId: String(rewardsOf("C", "S3")[0]?._id || oid()) });
  check("an unknown or other brand's reward → 404, nothing written", r.status === 404 && redemptionsOf("oD", "S1").length === 0);

  console.log("── 4. replace, PKR off, free item");
  r = await call("POST", LP, { tok: T.E, body: { mode: "reward", maxVisitsPerDay: 0, reward: { visitsNeeded: 1, kind: "percent", value: 25, combine: "replace" } } });
  await call("PATCH", `${LP}/${r.json.data.id}`, { tok: T.E, body: { status: "active", version: r.json.data.version } });
  await pay("E", "oE", "S1", 1000);
  r = await pay("E", "oE", "S1", 1000, { applyRewardId: String(rewardsOf("E", "S1")[0]._id) });
  check("replace: bill 1,000, offer 15%, reward 25% → saved 250, pay 750", r.status === 200 && r.json.savedAmount === 250 && r.json.breakdown.pay === 750 && r.json.breakdown.used === "reward", r.text);
  const pF = await mine("F");
  await call("PATCH", `${LP}/${pF.id}`, { tok: T.F, body: { reward: { visitsNeeded: 1, kind: "amount", value: 200 }, maxVisitsPerDay: 0, version: pF.version } });
  await call("PATCH", `${LP}/${pF.id}`, { tok: T.F, body: { status: "active", version: pF.version + 1 } });
  await pay("F", "oF", "S1", 1000);
  r = await pay("F", "oF", "S1", 1000, { applyRewardId: String(rewardsOf("F", "S1")[0]._id) });
  check("PKR 200 off on top: saved 350, pay 650", r.status === 200 && r.json.savedAmount === 350 && r.json.breakdown.pay === 650, r.text);
  await pay("F", "oF", "S2", 100);
  r = await pay("F", "oF", "S2", 100, { applyRewardId: String(rewardsOf("F", "S2")[0]._id) });
  check("PKR 200 off a PKR 100 bill: saved 100 (never above the bill), pay 0", r.status === 200 && r.json.savedAmount === 100 && r.json.breakdown.pay === 0, r.text);
  const pF2 = await mine("F");
  await call("PATCH", `${LP}/${pF2.id}`, { tok: T.F, body: { reward: { visitsNeeded: 1, kind: "item", item: "a free drink" }, version: pF2.version } });
  await pay("F", "oF", "S3", 1000);
  r = await pay("F", "oF", "S3", 1000, { applyRewardId: String(rewardsOf("F", "S3")[0]._id) });
  check("a free item: the offer as normal (saved 150, pay 850) + 'give: a free drink'", r.status === 200 && r.json.savedAmount === 150 && r.json.breakdown.giveItem === "a free drink" && rewardsOf("F", "S3")[0].status === "used", r.text);

  console.log("── 5. promo codes (in person): verify, confirm");
  const genCode = async (who, offerKey) => (await call("POST", "/api/promo-codes/generate", { tok: T[who], body: { offerId: String(ids[offerKey]) } })).json?.promoCode;
  await visitBefore("oC", "S3"); // S3 earns at Chai
  // S3 makes a code: their 25% reward goes into it (15 + 25 = 40%)
  const code3 = await genCode("S3", "oC");
  check("an online code made with a % reward waiting carries it: 15% + 25% = 40%", code3?.discountPercentage === 40 && code3.rewardIncluded?.totalPct === 40 && code3.rewardIncluded.offerPct === 15, JSON.stringify(code3));
  r = await call("POST", "/api/promo-codes/brand-verify", { tok: T.C, body: { promoCode: code3.code, offerId: String(ids.oC), billAmount: 1000 } });
  check("brand-verify shows the reward the code carries, with the breakdown (pay 600)", r.status === 200 && r.json.data.readyReward?.carried === true && r.json.data.readyReward.breakdown.pay === 600, r.text);
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.C, body: { promoCode: code3.code, offerId: String(ids.oC), billAmount: 1000 } });
  check("confirm: saved 400 (the code's 40% isn't counted twice: offer 15% + reward 25% on the original bill)", r.status === 200 && r.json.data.transaction.savedAmount === 400 && r.json.data.breakdown.pay === 600 && rewardsOf("C", "S3")[0].status === "used", r.text);
  r = await call("POST", "/api/promo-codes/confirm-redemption", { tok: T.C, body: { promoCode: code3.code, offerId: String(ids.oC), billAmount: 1000 } });
  check("confirming the same code again: refused (the code is used), nothing new", (r.status === 409 || r.status === 400) && r.json.success === false && rewardsOf("C", "S3").length === 1, r.text);
  await visitBefore("oC", "S4"); // S4 earns
  const rw4 = rewardsOf("C", "S4")[0];
  // an in-person code made BEFORE the reward existed: the brand ticks "apply reward"
  const LoyaltyReward = reqS("./models/LoyaltyReward");
  await LoyaltyReward.updateOne({ _id: rw4._id }, { $set: { promoCodeId: oid() } }); // its code was another one (expired): not carried by this one
  const code4 = await genCode("S4", "oC");
  check("a reward already given to another (dead) code is put into the new code instead", code4?.rewardIncluded?.id === String(rw4._id), JSON.stringify(code4?.rewardIncluded));
  r = await call("POST", "/api/promo-codes/verify", { tok: T.C, body: { promoCode: code4.code, offerId: String(ids.oC), billAmount: 2000 } });
  check("promo verify: bill 2,000 → offer 300 + reward 500 = 800, pay 1,200", r.status === 200 && r.json.data.savedAmount === 800 && r.json.data.breakdown.pay === 1200 && rewardsOf("C", "S4")[0].status === "used", r.text);

  console.log("── 6. online store order (Woo webhook), a 'replace' program");
  await visitBefore("oE", "S2"); // S2 earns at Eats (25%, replace)
  const rwE = rewardsOf("E", "S2", (x) => x.status === "available")[0];
  const codeE = await genCode("S2", "oE");
  check("S2's code at Eats carries the reward: replace → the bigger of 15% and 25% = 25%", codeE?.discountPercentage === 25 && codeE.rewardIncluded?.id === String(rwE?._id), JSON.stringify(codeE));
  const out = await recordWooOrder(ids.E, { id: 9001, status: "processing", total: "750", coupon_lines: [{ code: codeE.code, discount: "250" }] });
  const wooRed = redemptionsOf("oE", "S2").pop();
  check("the store order: one redemption, saved 250 (what the store took off), linked to the reward; the reward used", out.counted === 1 && wooRed.savedAmount === 250 && wooRed.billAmount === 1000 && same(wooRed.loyaltyRewardId, rwE._id) && rewardsOf("E", "S2", (x) => same(x._id, rwE._id))[0].status === "used", JSON.stringify(out));
  const usedE = rewardsOf("E", "S2", (x) => same(x._id, rwE._id))[0];
  check("…replace: the reward was used instead of the offer (reward 250, offer 0)", usedE.savedAmount === 250 && usedE.offerDiscount === 0 && usedE.totalDiscount === 250, JSON.stringify(usedE));
  await recordWooOrder(ids.E, { id: 9001, status: "processing", total: "750", coupon_lines: [{ code: codeE.code, discount: "250" }] });
  check("the same webhook again: nothing new", redemptionsOf("oE", "S2").filter((x) => x.loyaltyRewardId).length === 1);
  check("…and 'Reward used at Eats Swap' told once", rows("Notification", (n) => same(n.recipient, ids.S2) && /Reward used at Eats Swap$/.test(n.title)).length === 1);

  console.log("── 7. revenue and savings use the final amount");
  r = await call("GET", "/api/offers/my-total-savings", { tok: T.S1 });
  const s1Saved = redemptionsOf("oC", "S1").reduce((n, x) => n + x.savedAmount, 0);
  check("student S1's savings include the 400 (offer + reward)", r.json.totalSaved >= 400 && redemptionsOf("oC", "S1").some((x) => x.savedAmount === 400) && s1Saved === 550, `${r.json.totalSaved} ${s1Saved}`);
  r = await call("GET", "/api/offers/savings-report", { tok: T.C });
  const rowOf = (r.json || []).find((x) => x.bill === 1000 && x.saved === 400 && x.paid === 600);
  check("the brand's receipts / savings history: the bill with the reward shows saved 400, paid 600", !!rowOf, JSON.stringify((r.json || []).slice(0, 3)));
  const sales = await reqS("./services/brandSales").salesRows({ brandIds: [ids.C] });
  const viaReward = sales.filter((x) => x.saved === 400 || x.saved === 800);
  check("revenue (brand sales): the reward bills count at what was paid (600, 1,200)", viaReward.some((x) => x.paid === 600) && viaReward.some((x) => x.paid === 1200), JSON.stringify(viaReward.map((x) => [x.bill, x.saved, x.paid])));

  console.log("── 8. members: rewards used with the amount saved");
  r = await call("GET", "/api/loyalty/brands/me/members", { tok: T.C });
  const s1 = r.json.data.members.find((x) => x.rewardsUsed === 1 && x.rewardSavings === 250 && x.rewardUses?.[0]?.totalDiscount === 400);
  check("members: a member with 1 reward used, PKR 250 saved by it (bill 1,000, total 400)", r.status === 200 && !!s1 && r.json.data.totals.rewardSavings >= 250 && r.json.data.members.every((x) => !("email" in x) && !("phone" in x)), JSON.stringify(r.json.data.members.slice(0, 2)));
  A = (await call("GET", `/api/loyalty/admin/programs/${pC.id}/members`, { tok: T.admin })).json.data;
  check("admin sees the same members view per brand", A.totals.rewardsUsed === r.json.data.totals.rewardsUsed && A.totals.rewardSavings === r.json.data.totals.rewardSavings);

  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url).join(" "));
  check("no personal data leaked in loyalty replies", !responses.some((x) => x.leaks.length), responses.filter((x) => x.leaks.length).map((x) => `${x.url} ${x.leaks}`).join(" "));
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
