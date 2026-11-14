// Loyalty backfill (chore/loyalty-backfill, scripts/loyaltyBackfill.js): the dry run (default) prints the plan and
// writes nothing; --apply needs an admin, credits each never-counted redemption once through the live counter (same
// key, daily limit on the redemption's own day, offer / branch rules), dates it when it happened, earns rewards
// silently (no push, no notice) and logs one admin action per brand; running it again changes nothing.
//   node tests/loyalty-backfill/run.js [serverDir]
// Real models and services; fake MongoDB; no network.
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



(async () => {
  await reqS("./services/featureAccess").load(); // account roles + defaults, as the script does before running
  const backfill = reqS("./scripts/loyaltyBackfill.js");
  const DAY = 864e5;
  // d days ago at h o'clock Karachi time (two times on the same day stay on the same Karachi day whenever the suite runs)
  const { dayKey } = reqS("./utils/karachiTime");
  const ago = (d, h = 12) => new Date(new Date(`${dayKey(new Date(Date.now() - d * DAY))}T00:00:00+05:00`).getTime() + h * 3600e3);
  const pR = oid(), pP = oid();
  // Roast: the bug: a 2-visit stamp card with a branch chosen (counter visits never counted), daily limit 1, only oR
  fake.seed(coll("LoyaltyProgram"), [
    { _id: pR, brand: ids.R, status: "active", mode: "reward", reward: { visitsNeeded: 2, kind: "item", item: "a free coffee", value: null, maxPerStudent: null, maxPerMonth: null }, tiers: [{ name: "Member", minVisit: 1, maxVisit: null, discountPct: 10 }],
      eligibleOfferIds: [ids.oR], branchIds: [ids.b1], maxDiscountPct: 50, adminMaxDiscountPct: null, maxVisitsPerDay: 1, resetMonths: 12, version: 2, countAfterVersion: 0,
      startsAt: null, history: [{ version: 1, status: "draft", changedAt: ago(20) }], createdAt: ago(40), updatedAt: ago(20) },
    // Pizza: tiers, 2 visits a day count
    { _id: pP, brand: ids.P, status: "active", mode: "tiers", tiers: [{ name: "Member", minVisit: 1, maxVisit: null, discountPct: 15 }], eligibleOfferIds: [], branchIds: [], maxDiscountPct: 50, adminMaxDiscountPct: null,
      maxVisitsPerDay: 2, resetMonths: 12, version: 1, countAfterVersion: 0, startsAt: ago(30), history: [], createdAt: ago(30), updatedAt: ago(30) },
    // Mini Mart: a paused program is never touched
    { _id: oid(), brand: ids.M, status: "paused", mode: "tiers", tiers: [{ name: "Member", minVisit: 1, maxVisit: null, discountPct: 5 }], eligibleOfferIds: [], branchIds: [], maxVisitsPerDay: 1, resetMonths: 12, version: 1, startsAt: ago(30), history: [], createdAt: ago(30), updatedAt: ago(30) },
  ]);
  const red = (offerKey, who, at) => { const rid = oid(); offerDoc(ids[offerKey]).redemptions.push({ _id: rid, student: ids[who], billAmount: 1000, savedAmount: 100, redeemedAt: at }); return rid; };
  const r1 = red("oR", "S1", ago(3)); // counts
  const r2 = red("oR", "S1", ago(2, 10)); // counts: the card is full → a free coffee
  const r3 = red("oR", "S1", ago(2, 15)); // the same day: the daily limit (1)
  const r4 = red("oR2", "S2", ago(1)); // an offer outside the program
  const r5 = red("oR", "S3", ago(25)); // before the program was published (20 days ago)
  const r6 = red("oP", "S2", ago(4, 10)); const r7 = red("oP", "S2", ago(4, 16)); // Pizza: same day, limit 2 → both
  const r8 = red("oM", "S1", ago(2)); // Mini Mart: paused program
  const counted0 = red("oR", "S2", ago(5)); // already counted at the time
  fake.seed(coll("LoyaltyLedger"), [{ _id: oid(), program: pR, programVersion: 2, brand: ids.R, student: ids.S2, type: "CREDIT", visitsDelta: 1, redemptionId: counted0, offer: ids.oR, source: "redeem-payment", reason: "", visitNumber: 1, idempotencyKey: `credit:${counted0}`, effectiveAt: ago(5), createdAt: ago(5) }]);

  const sizes = () => Object.fromEntries(["LoyaltyLedger", "LoyaltyReward", "LoyaltyNotice", "Notification", "AdminActionLog", "LoyaltySnapshot", "RedemptionGuard", "DomainEvent"].map((m) => [m, rows(m).length]));
  const quiet = [];
  const log = (l) => quiet.push(l);

  console.log("── 1. dry run (the default): the plan, nothing written");
  const before = sizes();
  const dry = await backfill.run({}, undefined, log);
  const dR = dry.find((x) => x.brandId === String(ids.R))?.plan, dP = dry.find((x) => x.brandId === String(ids.P))?.plan;
  check("Roast: 5 redemptions since publishing (1 already counted, 1 before publishing ignored), would count 2, 1 not counted (daily limit), 1 skipped (offer outside the program), 1 reward would become ready",
    dR && dR.found === 5 && dR.alreadyCounted === 1 && dR.pending === 4 && dR.wouldCount === 2 && dR.notCounted["daily-limit"] === 1 && dR.skipped["offer-not-in-program"] === 1 && dR.rewardsReady === 1, JSON.stringify(dR));
  check("Pizza (limit 2 a day): would count both same-day visits", dP && dP.wouldCount === 2 && dP.notCounted["daily-limit"] === 0, JSON.stringify(dP));
  check("only active programs: Roast and Pizza (and the harness's older tiers program), never the paused one (Mini Mart)", dry.some((x) => x.brandId === String(ids.R)) && dry.some((x) => x.brandId === String(ids.P)) && !dry.some((x) => x.brandId === String(ids.M)));
  check("…nothing was written (ledger, rewards, notices, admin log, guards, snapshots, events)", JSON.stringify(sizes()) === JSON.stringify(before), JSON.stringify({ before, after: sizes() }));
  check("…the printout: per brand, 'DRY RUN', no student id or name", quiet.some((l) => /DRY RUN/.test(l)) && quiet.some((l) => /would count: 2/.test(l)) && !quiet.join("\n").match(new RegExp([ids.S1, ids.S2, ids.S3].map(String).join("|") + "|sana|taha")), quiet.join(" | ").slice(0, 300));

  console.log("── 2. --apply needs an admin");
  let err = null;
  try { await backfill.run({ apply: true }, undefined, log); } catch (e) { err = e; }
  check("no --admin: refused, nothing written", err && /--admin/.test(err.message) && JSON.stringify(sizes()) === JSON.stringify(before));
  err = null;
  try { await backfill.run({ apply: true, adminId: String(ids.R) }, undefined, log); } catch (e) { err = e; }
  check("--admin that isn't an admin: refused", err && /admin account/.test(err.message) && JSON.stringify(sizes()) === JSON.stringify(before));

  console.log("── 3. --apply: through the live counter, each redemption once, silently");
  const applied = await backfill.run({ apply: true, adminId: String(ids.admin) }, undefined, log);
  const aR = applied.find((x) => x.brandId === String(ids.R))?.applied, aP = applied.find((x) => x.brandId === String(ids.P))?.applied;
  check("Roast: counted 2, 1 not counted (daily limit), 1 skipped (offer outside the program), 1 reward now ready: the same as the dry run said",
    aR && aR.counted === 2 && aR.notCounted["daily-limit"] === 1 && aR.skipped["offer-not-in-program"] === 1 && aR.rewardsReady === 1 && aR.errors === 0, JSON.stringify(aR));
  const rowOf = (rid) => rows("LoyaltyLedger", (e) => same(e.redemptionId, rid));
  check("one ledger row per redemption, idempotency key credit:<redemptionId>, source backfill", [r1, r2, r3].every((rid) => rowOf(rid).length === 1 && rowOf(rid)[0].idempotencyKey === `credit:${rid}` && rowOf(rid)[0].source === "backfill"));
  check("…dated when the redemption happened (not today)", [r1, r2].every((rid) => Math.abs(new Date(rowOf(rid)[0].effectiveAt) - new Date(offerDoc(ids.oR).redemptions.find((x) => same(x._id, rid)).redeemedAt)) < 1000));
  check("…the second visit the same day: a row with visitsDelta 0, reason daily-limit (as the live counter writes)", rowOf(r3)[0].visitsDelta === 0 && rowOf(r3)[0].reason === "daily-limit");
  check("…the offer outside the program, the redemption before publishing and the paused program: no row", [r4, r5, r8].every((rid) => rowOf(rid).length === 0));
  check("Pizza: both same-day visits counted (limit 2)", aP && aP.counted === 2 && rowOf(r6)[0].visitsDelta === 1 && rowOf(r7)[0].visitsDelta === 1);
  const rw = rows("LoyaltyReward", (x) => same(x.brand, ids.R) && same(x.student, ids.S1));
  check("S1's card filled: one reward ready (a free coffee)", rw.length === 1 && rw[0].status === "available" && rw[0].label === "a free coffee");
  const st = await loyalty.standing(ids.R, ids.S1);
  check("…the app's card now says 2 of 2, reward ready", st.stamps.stamps === 2 && st.stamps.available?.label === "a free coffee", JSON.stringify(st.stamps));
  check("no push and no in-app notice for any of it", rows("LoyaltyNotice").length === before.LoyaltyNotice && rows("Notification").length === before.Notification);
  const logs = rows("AdminActionLog", (l) => l.action === "loyalty.backfill");
  check("one admin action per brand (Roast, Pizza) under the admin, with the counts", logs.length === 2 && logs.every((l) => same(l.admin, ids.admin) && l.targetType === "LoyaltyProgram") && logs.some((l) => l.targetId === String(pR) && l.after.counted === 2), JSON.stringify(logs.map((l) => ({ t: l.targetId, a: l.after }))));

  console.log("── 4. running it again changes nothing");
  const snap = sizes();
  const again = await backfill.run({ apply: true, adminId: String(ids.admin) }, undefined, log);
  check("second --apply: nothing left to count (only the offer outside the program, which never counts), no new rows, rewards or log entries", again.every((x) => x.plan.pending === (x.brandId === String(ids.R) ? 1 : 0) && (!x.applied || x.applied.counted === 0)) && JSON.stringify(sizes()) === JSON.stringify(snap),
    JSON.stringify(again.map((x) => ({ b: x.name, plan: x.plan, applied: x.applied }))));
  const dry2 = await backfill.run({}, undefined, log);
  check("…and a dry run afterwards would count 0", dry2.every((x) => x.plan.wouldCount === 0));

  console.log("── 5. options");
  check("--since overrides the start (Karachi midnight); --brand limits to one brand", (await backfill.startOf({ history: [], createdAt: ago(40) }, { since: "2026-11-01", LoyaltyProgramRestart: reqS("./models/LoyaltyProgramRestart") })).toISOString() === "2026-10-31T19:00:00.000Z"
    && (await backfill.run({ brandId: String(ids.P) }, undefined, log)).length === 1);
  check("parseArgs: dry run unless --apply; unknown options refused", backfill.parseArgs([]).apply === false && backfill.parseArgs(["--apply", "--admin", "a"]).apply === true && (() => { try { backfill.parseArgs(["--aply"]); return false; } catch { return true; } })());
  const src = fs.readFileSync(path.join(SERVER, "scripts/loyaltyBackfill.js"), "utf8");
  check("the script never prints MONGO_URI (only host and database) and asks 'type APPLY' before writing", /new URL\(process\.env\.MONGO_URI\)/.test(src) && !/console\.log\([^)]*process\.env\.MONGO_URI/.test(src) && /Type APPLY to continue/.test(src));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
