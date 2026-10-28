// App speed (perf/server): S0 to S10 and the "no other student's id" check.
//   node tests/perf-server/run.js [serverDir]
// Real route files, models and middleware; only MongoDB (tests/hide-user-secrets/fake-mongo.js, plus a
// small $match/$unwind/$group interpreter below for the aggregates these routes use), e-mail, Expo and
// outgoing HTTP are replaced. No database, no network, no .env (dotenv is stubbed; run it from a folder
// without one).
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "PERF_LOG"]) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);

// ---------- aggregate interpreter: $match, $unwind, $group ($push, $sum incl. $cond) ----------
const isOid = (v) => v != null && typeof v === "object" && v._bsontype === "ObjectId";
const norm = (v) => (isOid(v) ? String(v) : v instanceof Date ? v.getTime() : v);
const at = (doc, p) => p.split(".").reduce((o, k) => (o == null ? undefined : Array.isArray(o) ? o.map((x) => x?.[k]) : o[k]), doc);
const condOk = (val, cond) => {
  const vals = (Array.isArray(val) ? val.flat() : [val]).map(norm);
  if (cond && typeof cond === "object" && !isOid(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$gt") return vals.some((v) => v > norm(arg));
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
reqS("./models/University"); // server.js loads it through the university routes
const jwt = reqS("jsonwebtoken");
const { clearOfferCaches } = reqS("./utils/cache");
const { optionalUserId, withMyClaim } = reqS("./utils/myClaims");
const { shouldCompress } = reqS("./middleware/compress");

// ---------- capture [perf] lines ----------
const logs = [];
const origLog = console.log;
console.log = (...a) => { const line = a.join(" "); if (line.startsWith("[perf")) logs.push(line); else if (process.env.VERBOSE) origLog(...a); };
console.warn = () => {};
console.error = (...a) => { if (process.env.VERBOSE) origLog(...a); };
const perfLog = reqS("./middleware/perfLog");

// ---------- app: same middleware order as server.js ----------
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json());
app.use(reqS("./middleware/compress")());
app.use(perfLog());
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/brands", reqS("./routes/brands.routes"));
app.use("/api/brand-approval", reqS("./routes/brandApproval.routes"));
app.use("/api/social", reqS("./routes/social.routes"));
app.use("/api/engagement", reqS("./routes/engagement.routes"));
app.get("/api/v1/stream", (req, res) => { res.json({ big: "x".repeat(5000) }); });
app.get("/api/test/sse", (req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.end("data: " + "y".repeat(5000) + "\n\n"); });
app.get("/api/test/big", (req, res) => { res.json({ big: "z".repeat(5000) }); });

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = { a: oid(), b: oid(), c: oid(), brand1: oid(), brand2: oid(), admin: oid(), uni: oid(), o1: oid(), o2: oid(), o3: oid(), post: oid(), conf1: oid(), conf2: oid() };
const STUDENT_IDS = { b: String(ids.b), c: String(ids.c) };
const now = Date.now();
const ago = (h) => new Date(now - h * 3600 * 1000);
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", university: ids.uni, pushTokens: [{ token: `ExponentPushToken[SEED-${name}]` }], connections: [], sentRequests: [], receivedRequests: [], createdAt: ago(100), updatedAt: new Date(), ...extra });
fake.seed("universities", [{ _id: ids.uni, name: "Test University" }]);
fake.seed("users", [
  user(ids.a, "student", "studenta", { connections: [], sentRequests: [] }),
  user(ids.b, "student", "studentb", { connections: [ids.c], sentRequests: [ids.c], receivedRequests: [ids.a] }),
  user(ids.c, "student", "studentc", { connections: [ids.b] }),
  user(ids.brand1, "brand", "brand1", { brandName: "Brand One", brandApprovalStatus: "approved", logo: "https://res.cloudinary.com/x/image/upload/v1/logo1.png", createdAt: ago(10) }),
  user(ids.brand2, "brand", "brand2", { brandName: "Brand Two", brandApprovalStatus: "pending", createdAt: ago(5) }),
  user(ids.admin, "admin", "admin"),
]);
const red = (student, hoursAgo, saved) => ({ _id: oid(), student, billAmount: 1000, savedAmount: saved, redeemedAt: ago(hoursAgo) });
const offer = (id, brand, title, claimedBy, redemptions) => ({ _id: id, brand, title, description: "d", discountPercentage: 20, category: "Restaurant", image: "https://res.cloudinary.com/x/image/upload/v1/o.png", isOnline: false, isInStore: true, active: true, claimedBy, redemptions, promoCodesGenerated: [oid()], createdAt: ago(20), updatedAt: new Date() });
fake.seed("offers", [
  offer(ids.o1, ids.brand1, "20% off", [ids.a, ids.b, ids.c], [red(ids.a, 2, 200), red(ids.b, 3, 500), red(ids.a, 50, 100)]),
  offer(ids.o2, ids.brand1, "buy one", [ids.b], [red(ids.b, 1, 50)]),
  offer(ids.o3, ids.brand2, "pending brand offer", [ids.c], []),
]);
fake.seed("posts", [{
  _id: ids.post, author: ids.b, content: "hello", category: "General", likes: [ids.a, ids.c], favorites: [ids.a, ids.c], viewedBy: [ids.c],
  poll: [{ _id: oid(), option: "yes", votes: 1, votedBy: [ids.c] }],
  comments: [{ _id: oid(), user: ids.c, text: "hi", mentions: [], createdAt: ago(1) }], createdAt: ago(2),
}]);
fake.seed("confessions", [
  { _id: ids.conf1, authorId: ids.c, text: "newest", university: ids.uni, visibility: "public", likes: 2, likedBy: [ids.b, ids.c], comments: [{ _id: oid(), user: ids.c, text: "c says", createdAt: ago(1) }], createdAt: ago(1) },
  { _id: ids.conf2, authorId: ids.b, text: "older", university: ids.uni, visibility: "public", likes: 1, likedBy: [ids.a], comments: [{ _id: oid(), user: ids.a, text: "mine", createdAt: ago(3) }], createdAt: ago(5) },
]);
fake.seed("pointsledgers", [
  { _id: oid(), user: ids.a, delta: 10, reason: "referral_signup", createdAt: ago(10) },
  { _id: oid(), user: ids.a, delta: 5, reason: "daily_open", createdAt: ago(9) },
  { _id: oid(), user: ids.a, delta: -3, reason: "reward_spend", createdAt: ago(8) },
  { _id: oid(), user: ids.b, delta: 99, reason: "referral_signup", createdAt: ago(8) },
]);
fake.seed("engagementprofiles", [{ _id: oid(), user: ids.a, sortedCount: 0, points: { balance: 12 }, streak: { count: 1 } }]);

const token = (id, role = "student") => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET, { expiresIn: "1h" });
const T = { a: token(ids.a), admin: token(ids.admin, "admin") };

// ---------- helpers ----------
let base;
function request(method, url, { tok, gzip, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (gzip) headers["Accept-Encoding"] = "gzip";
    if (body) headers["Content-Type"] = "application/json";
    const r = http.request(base + url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") buf = zlib.gunzipSync(buf);
        const text = buf.toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, enc, text, json });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const get = (url, opts) => request("GET", url, opts);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; origLog(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`); };

const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "shopifyClientId", "shopifyClientSecret", "shopifyWebhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const leaksIn = (r) => { const keys = keysIn(r.json); const l = HIDDEN.filter((k) => keys.has(k)); if (/\$2[ab]\$|ExponentPushToken\[/.test(r.text)) l.push("secret value"); return l; };

// paths (dotted, array indexes as []) where another student's id is found
function idPaths(v, wanted, p = "", out = []) {
  if (Array.isArray(v)) v.forEach((x) => idPaths(x, wanted, `${p}[]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) idPaths(x, wanted, p ? `${p}.${k}` : k, out);
  else if (typeof v === "string" && wanted.includes(v)) out.push(p);
  return out;
}
const others = Object.values(STUDENT_IDS);

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const all = [];
  const track = async (p) => { const r = await p; all.push(r); return r; };

  // ===== S0 perf log =====
  logs.length = 0;
  await track(get("/api/brands?limit=200&lat=24.86&lng=67.01"));
  await track(get(`/api/offers/claimed`, { tok: T.a }));
  const line = logs.find((l) => l.startsWith("[perf] GET /api/brands/ 200 "));
  check("S0 [perf] line for GET /api/brands/ with status, ms and bytes", !!line && /\d+ms \d+B$/.test(line), logs.join(" | "));
  check("S0 log has no query string, ids or coordinates", logs.every((l) => !/[?=]|24\.86|67\.01/.test(l) && !l.includes(String(ids.a))), logs.join(" | "));
  check("S0 /api/offers/claimed is logged as its route pattern", logs.some((l) => l.startsWith("[perf] GET /api/offers/claimed 200")), logs.join(" | "));
  logs.length = 0;
  await get("/api/test/big");
  check("S0 unwatched routes are not logged", logs.length === 0, logs.join(" | "));
  perfLog.logSummary();
  check("S0 summary line with n, p50, p90 and size", logs.some((l) => /^\[perf-summary\] GET \/api\/brands\/ n=1 p50=\d+ms p90=\d+ms p50size=\d+B$/.test(l)), logs.join(" | "));

  // ===== S1 compression =====
  const big = await get("/api/test/big", { gzip: true });
  check("S1 JSON over 1 KB is gzipped", big.enc === "gzip" && big.json?.big?.length === 5000, big.enc);
  const v1 = await get("/api/v1/stream", { gzip: true });
  check("S1 /api/v1 (AI chat / travel) is never gzipped", !v1.enc, v1.enc);
  const sse = await get("/api/test/sse", { gzip: true });
  check("S1 text/event-stream is never gzipped", !sse.enc, sse.enc);
  check("S1 filter refuses x-no-compression", shouldCompress({ path: "/api/x", headers: {} }, { getHeader: (h) => (h === "x-no-compression" ? "true" : undefined) }) === false);
  const plain = await get("/api/test/big");
  check("S1 clients without Accept-Encoding get plain JSON", !plain.enc && plain.json?.big?.length === 5000);

  // ===== S2 /brands =====
  await clearOfferCaches();
  let r = await track(get("/api/brands"));
  check("S2 /brands lists approved brands only", Array.isArray(r.json) && r.json.length === 1 && r.json[0].name === "Brand One", r.text.slice(0, 200));
  fake.seed("users", [user(oid(), "brand", "brand3", { brandName: "Brand Three", brandApprovalStatus: "approved", createdAt: ago(1) })]);
  r = await track(get("/api/brands"));
  check("S2 second call within 120 s comes from the cache", r.json?.length === 1);
  r = await track(get("/api/brands?limit=200"));
  check("S2 ?limit=200 with fewer brands returns them all (old builds)", r.json?.length === 1);
  await clearOfferCaches();
  r = await track(get("/api/brands"));
  check("S2 clearing offer caches refreshes the list", r.json?.length === 2 && r.json[0].name === "Brand Three", JSON.stringify(r.json?.map((b) => b.name)));
  r = await track(get("/api/brands?limit=1"));
  check("S2 ?limit=1 returns the newest one", r.json?.length === 1 && r.json[0].name === "Brand Three");
  r = await track(request("PUT", `/api/brand-approval/${ids.brand2}/status`, { tok: T.admin, body: { status: "approved" } }));
  const afterApprove = await track(get("/api/brands"));
  check("S2 approving a brand clears the cache at once", r.status === 200 && afterApprove.json?.some((b) => b.name === "Brand Two"), `${r.status} ${JSON.stringify(afterApprove.json?.map((b) => b.name))}`);
  await track(request("PUT", `/api/brand-approval/${ids.brand2}/status`, { tok: T.admin, body: { status: "pending" } }));
  const afterPending = await track(get("/api/brands"));
  check("S2 un-approving clears it too", afterPending.json?.every((b) => b.name !== "Brand Two"));

  // ===== S3 /offers/brandss =====
  await clearOfferCaches();
  r = await track(get("/api/offers/brandss"));
  const b1 = r.json?.brands?.find((b) => String(b._id) === String(ids.brand1));
  check("S3 same shape: success, count, brands[].offersCount/offers", r.json?.success === true && r.json.count === r.json.brands.length && b1?.offersCount === 2 && b1.offers.length === 2, r.text.slice(0, 300));
  check("S3 approved brands only (pending brand2 not listed)", !r.json?.brands?.some((b) => String(b._id) === String(ids.brand2)));
  check("S3 offers carry no brand, claimedBy or redemptions", b1?.offers.every((o) => !("brand" in o) && !("claimedBy" in o) && !("redemptions" in o)));
  check("S3 offer fields kept (title, discountPercentage, image, isInStore)", b1?.offers.some((o) => o.title === "20% off" && o.discountPercentage === 20 && o.image && o.isInStore === true));
  fake.seed("offers", [offer(oid(), ids.brand1, "new offer", [], [])]);
  const cached = await track(get("/api/offers/brandss"));
  check("S3 cached for 120 s", cached.json?.brands?.find((b) => String(b._id) === String(ids.brand1))?.offersCount === 2);
  await clearOfferCaches();
  const fresh = await track(get("/api/offers/brandss"));
  check("S3 offer writes (cache clear) show the new offer", fresh.json?.brands?.find((b) => String(b._id) === String(ids.brand1))?.offersCount === 3);

  // ===== S4 /offers/summary =====
  r = await track(get("/api/offers/summary", { tok: T.a }));
  const s1 = r.json?.[String(ids.brand1)] || [];
  const so1 = s1.find((o) => String(o._id) === String(ids.o1));
  const so2 = s1.find((o) => String(o._id) === String(ids.o2));
  check("S4 summary: my claimed offer has claimedBy [me]", JSON.stringify(so1?.claimedBy) === JSON.stringify([String(ids.a)]), JSON.stringify(so1));
  check("S4 summary: an offer I did not claim has claimedBy []", Array.isArray(so2?.claimedBy) && so2.claimedBy.length === 0);
  check("S4 old-build check still works: claimedBy.some(id => id === me)", so1.claimedBy.some((id) => String(id) === String(ids.a)) && !so2.claimedBy.some((id) => String(id) === String(ids.a)));
  check("S4 summary has no other student's id", idPaths(r.json, others).length === 0, idPaths(r.json, others).join(", "));
  const pushStage = aggCalls.filter((c) => c.coll === "offers").map((c) => JSON.stringify(c.pipeline)).find((p) => p.includes("$push"));
  check("S4 the shared summary aggregate no longer pushes claimedBy", !!pushStage && !pushStage.includes("claimedBy"));
  const guest = await track(get("/api/offers/summary"));
  check("S4 guest summary: every claimedBy is []", Object.values(guest.json || {}).flat().every((o) => Array.isArray(o.claimedBy) && o.claimedBy.length === 0));
  const cachedSummary = await track(get("/api/offers/summary", { tok: T.a }));
  check("S4 cached summary still gets my own claim", cachedSummary.json?.[String(ids.brand1)]?.find((o) => String(o._id) === String(ids.o1))?.claimedBy?.[0] === String(ids.a));
  check("S4 optionalUserId: valid token -> id", optionalUserId({ headers: { authorization: `Bearer ${T.a}` } }) === String(ids.a));
  check("S4 optionalUserId: no, guest, bad or expired token -> null (never rejects)", [undefined, "Bearer guest-token-2024", "Bearer nonsense", `Bearer ${jwt.sign({ id: String(ids.a) }, process.env.JWT_SECRET, { expiresIn: -10 })}`].every((h) => optionalUserId({ headers: { authorization: h } }) === null));
  const w = withMyClaim({ _id: ids.o1, claimedBy: [ids.a, ids.b] }, new Set([String(ids.o1)]), String(ids.a));
  check("S4 withMyClaim (used by /brands/nearby) keeps only me", JSON.stringify(w.claimedBy) === JSON.stringify([String(ids.a)]));

  // ===== S5 my-total-savings =====
  r = await track(get("/api/offers/my-total-savings", { tok: T.a }));
  check("S5 total saved counts only my redemptions (200 + 100)", r.json?.totalSaved === 300 && r.json?.redemptionCount === 2, r.text);
  const savingsAgg = aggCalls.filter((c) => c.coll === "offers").map((c) => c.pipeline).find((p) => p.some((s) => s.$unwind));
  check("S5 pipeline starts with $match on redemptions.student, before $unwind", !!savingsAgg && Object.keys(savingsAgg[0])[0] === "$match" && "redemptions.student" in savingsAgg[0].$match && Object.keys(savingsAgg[1])[0] === "$unwind");

  // ===== S6 /engagement/me =====
  const before6 = aggCalls.length;
  r = await track(get("/api/engagement/me", { tok: T.a }));
  const ledgerAggs = aggCalls.slice(before6).filter((c) => c.coll === "pointsledgers");
  const find = (obj, key) => { let hit; (function walk(o) { if (hit !== undefined || !o || typeof o !== "object") return; if (key in o && typeof o[key] === "number") { hit = o[key]; return; } Object.values(o).forEach(walk); })(obj); return hit; };
  check("S6 /engagement/me answers 200", r.status === 200, r.text.slice(0, 200));
  check("S6 one ledger aggregate (was three)", ledgerAggs.length === 1, String(ledgerAggs.length));
  check("S6 lifetime 15, referral 10, activity 5 (same split as before)", find(r.json, "lifetime") === 15 && find(r.json, "lifetimeReferral") === 10 && find(r.json, "activityPoints") === 5, `${find(r.json, "lifetime")} ${find(r.json, "lifetimeReferral")} ${find(r.json, "activityPoints")}`);

  // ===== S7 confessions feed paging =====
  r = await track(get("/api/social/confessions/feed?scope=all", { tok: T.a }));
  check("S7 no params: whole feed, newest first (old builds)", Array.isArray(r.json) && r.json.length === 2 && r.json[0].text === "newest", r.text.slice(0, 200));
  r = await track(get("/api/social/confessions/feed?scope=all&limit=1", { tok: T.a }));
  check("S7 ?limit=1 returns only the newest", r.json?.length === 1 && r.json[0].text === "newest");
  r = await track(get(`/api/social/confessions/feed?scope=all&limit=5&before=${encodeURIComponent(ago(2).toISOString())}`, { tok: T.a }));
  check("S7 ?before= pages to older ones", r.json?.length === 1 && r.json[0].text === "older");
  r = await track(get("/api/social/confessions/feed?scope=all&limit=999", { tok: T.a }));
  check("S7 limit is capped at 50 and bad values are ignored", r.json?.length === 2);

  // ===== S9 /offers/claimed =====
  await clearOfferCaches({ userId: String(ids.a) });
  r = await track(get("/api/offers/claimed?fresh=1", { tok: T.a }));
  const c1 = r.json?.find((o) => String(o._id) === String(ids.o1));
  check("S9 claimed lists my offer with claimedBy [me]", JSON.stringify(c1?.claimedBy) === JSON.stringify([String(ids.a)]), JSON.stringify(c1?.claimedBy));
  check("S9 redemptions are only mine", c1?.redemptions?.length === 2 && c1.redemptions.every((x) => String(x.student) === String(ids.a)));
  check("S9 promoCodesGenerated is not sent", c1 && !("promoCodesGenerated" in c1));
  check("S9 redemptionsToday, canRedeem, isClaimed, brandCities unchanged", c1?.redemptionsToday >= 0 && c1.canRedeem === true && c1.isClaimed === true && Array.isArray(c1.brandCities));
  check("S9 claimed has no other student's id", idPaths(r.json, others).length === 0, idPaths(r.json, others).join(", "));
  const cachedClaimed = await track(get("/api/offers/claimed", { tok: T.a }));
  check("S9 cached copy is the trimmed one too", idPaths(cachedClaimed.json, others).length === 0);

  // ===== S10 social feed + confessions =====
  r = await track(get("/api/social/feed?limit=10", { tok: T.a }));
  const post = r.json?.posts?.[0];
  const feedKeys = keysIn(r.json);
  check("S10 feed answers with posts", r.status === 200 && !!post, r.text.slice(0, 200));
  check("S10 no connections, sentRequests or receivedRequests anywhere", !["connections", "sentRequests", "receivedRequests"].some((k) => feedKeys.has(k)));
  check("S10 author has display fields only", post && Object.keys(post.author).every((k) => ["_id", "name", "profileImage", "university", "connectionStatus", "isConnected", "isPending", "isReceived"].includes(k)) && post.author.name === "studentb" && post.author.university?.name === "Test University", JSON.stringify(post?.author));
  check("S10 connection status 'received' still computed", post?.author.connectionStatus === "received" && post.author.isReceived === true);
  check("S10 viewedBy and poll votedBy are not sent; hasViewed kept", post && !("viewedBy" in post) && post.poll.every((o) => !("votedBy" in o) && o.option === "yes") && post.hasViewed === false);
  check("S10 favorites is [me] (I saved it)", JSON.stringify(post?.favorites) === JSON.stringify([String(ids.a)]));
  check("S10 likes kept for old builds (likes.length = 2)", post?.likes?.length === 2);
  const feedIds = idPaths(r.json, others);
  const allowed = ["posts[].author._id", "posts[].comments[].user._id", "posts[].likes[]"];
  check("S10 other students' ids only as post author, comment author or like", feedIds.every((p) => allowed.includes(p)), feedIds.join(", "));
  r = await track(get("/api/social/confessions/feed?scope=all", { tok: T.a }));
  check("S10 confessions: no likedBy, likedByCurrentUser still right", Array.isArray(r.json) && r.json.every((c) => !("likedBy" in c)) && r.json.find((c) => c.text === "older")?.likedByCurrentUser === true && r.json.find((c) => c.text === "newest")?.likedByCurrentUser === false);
  check("S10 confessions have no other student's id", idPaths(r.json, others).length === 0, idPaths(r.json, others).join(", "));

  // ===== R1 /offers/brand/:id =====
  await clearOfferCaches({ brandId: String(ids.brand1) });
  const brandUrl = `/api/offers/brand/${ids.brand1}`;
  r = await track(get(brandUrl, { tok: T.a }));
  const bo1 = Array.isArray(r.json) && r.json.find((o) => String(o._id) === String(ids.o1));
  const bo2 = Array.isArray(r.json) && r.json.find((o) => String(o._id) === String(ids.o2));
  check("R1 brand offers as a student: no other student's id", Array.isArray(r.json) && idPaths(r.json, others).length === 0, idPaths(r.json, others).join(", "));
  check("R1 claimedBy keeps its length (claimed by 3) with only my id in it", bo1?.claimedBy?.length === 3 && bo1.claimedBy.filter(Boolean).length === 1 && bo1.claimedBy.includes(String(ids.a)), JSON.stringify(bo1?.claimedBy));
  check("R1 an offer I did not claim: claimedBy all null, count kept", bo2?.claimedBy?.length === 1 && bo2.claimedBy[0] === null);
  // OfferScreen (old builds): isOfferClaimedByUser skips empty entries, count = claimedBy.length
  const oldIsClaimed = (offer, me) => (offer.claimedBy || []).some((e) => { if (!e) return false; if (typeof e === "string") return e === me; return (e._id?.toString?.() || e.toString?.()) === me; });
  check("R1 old-build claim check and count still right", oldIsClaimed(bo1, String(ids.a)) && !oldIsClaimed(bo2, String(ids.a)) && bo1.claimedBy.length === 3);
  check("R1 redemptions only mine, promoCodesGenerated not sent", bo1?.redemptions?.length === 2 && bo1.redemptions.every((x) => String(x.student) === String(ids.a)) && !("promoCodesGenerated" in bo1) && bo2?.redemptions?.length === 0);
  const brandCached = await track(get(brandUrl, { tok: T.a }));
  check("R1 cached copy is trimmed per caller too", idPaths(brandCached.json, others).length === 0 && brandCached.json.find((o) => String(o._id) === String(ids.o1))?.claimedBy?.length === 3);
  const brandGuest = await track(get(brandUrl));
  check("R1 guest: every claimedBy entry null, no redemptions", Array.isArray(brandGuest.json) && brandGuest.json.every((o) => o.claimedBy.every((x) => x === null) && o.redemptions.length === 0));
  const brandAdmin = await get(brandUrl, { tok: T.admin });
  check("R1 admin still sees every claim and redemption (admin web)", brandAdmin.json?.find((o) => String(o._id) === String(ids.o1))?.claimedBy?.length === 3 && idPaths(brandAdmin.json, others).length > 0);
  const brandOwner = await get(brandUrl, { tok: token(ids.brand1, "brand") });
  check("R1 the brand itself still sees every claim (brand dashboard)", idPaths(brandOwner.json, others).length > 0);
  const otherBrand = await get(`/api/offers/brand/${ids.brand2}`, { tok: token(ids.brand1, "brand") });
  check("R1 another brand is trimmed like a student", Array.isArray(otherBrand.json) && idPaths(otherBrand.json, others).length === 0);

  // ===== every response =====
  const leaky = all.filter((x) => leaksIn(x).length);
  check(`no hidden user field or secret in any of ${all.length} responses`, leaky.length === 0, leaky.map((x) => leaksIn(x).join("/")).join(", "));

  origLog(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { origLog("CRASH", e); process.exit(1); });
