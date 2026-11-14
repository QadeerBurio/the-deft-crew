// Loyalty notifications (FLAG_LOYALTY_V2): push + in-app when a visit is credited, when a tier unlocks and when
// an admin reverses a visit; exactly once per ledger row (also with the credit hook run again at once); quiet
// hours and a failing push provider never lose the in-app notification or the credit; the new 'loyalty' switch
// (own collection, pilot students only, default on); a tap opens the brand's screen with its loyalty card.
//   node tests/loyalty-push/run.js [serverDir]
// No database, no network, no .env (the fake in-memory database from tests/hide-user-secrets); the push gateway is a recorder.
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
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
// the push gateway is recorded, never reached
const sent = [];
let gatewayMode = "sent";
const fakeGateway = { send: async (userId, msg) => {
  if (gatewayMode === "throw") throw new Error("expo down");
  sent.push({ userId: String(userId), ...msg });
  return gatewayMode === "sent" ? { sent: true } : { sent: false, reason: gatewayMode };
} };
const prevLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("engagement", "pushGateway.js"))) return fakeGateway;
  return prevLoad.apply(this, arguments);
};
for (const m of ["User", "Offer", "LoyaltyProgram", "LoyaltyLedger", "LoyaltySnapshot", "LoyaltyNotice", "UserNotificationSetting", "Notification", "EngagementProfile", "RedemptionGuard"]) reqS(`./models/${m}`);
const loyalty = reqS("./services/loyalty");
const notify = reqS("./services/loyaltyNotify");

const app = express();
app.use(express.json());
app.use("/api/engagement", reqS("./routes/engagement.routes"));

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const rows = (m, f = () => true) => (fake.STORE.get(coll(m)) || []).filter(f);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
let PORT;
function call(method, url, { tok, body } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) };
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data) q.write(data);
    q.end();
  });
}

const B = oid(), S = oid(), S2 = oid(), ADMIN = oid(), OFFER = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, role, status: "active", createdAt: new Date(), ...extra });
fake.seed(coll("User"), [user(B, "brand", "alpha", { brandName: "Alpha Cafe" }), user(S, "student", "sana"), user(S2, "student", "taha"), user(ADMIN, "admin", "admin")]);
fake.seed(coll("LoyaltyProgram"), [{ _id: oid(), brand: B, status: "active", tiers: [{ name: "Member", minVisit: 1, maxVisit: 5, discountPct: 15 }, { name: "Regular", minVisit: 6, maxVisit: null, discountPct: 25 }], maxDiscountPct: 50, maxVisitsPerDay: 0, resetMonths: 12, eligibleOfferIds: [], branchIds: [], version: 1, createdAt: new Date() }]);
const reds = Array.from({ length: 9 }, () => oid());
fake.seed(coll("Offer"), [{ _id: OFFER, brand: B, title: "Alpha 20%", discountPercentage: 20, claimedBy: [], redemptions: reds.map((id, i) => ({ _id: id, student: i < 8 ? S : S2, billAmount: 1000, savedAmount: 200, redeemedAt: new Date() })), createdAt: new Date() }]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: S, notifPrefs: {} }, { _id: oid(), user: S2, notifPrefs: {} }]);
const notices = () => rows("LoyaltyNotice", (n) => same(n.student, S)).sort((a, b) => a.createdAt - b.createdAt);
const inapp = () => rows("Notification", (n) => same(n.recipient, S));

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  let r;

  console.log("-- flag off");
  await loyalty.onVerifiedRedemption(reds[0]);
  check("flag off: no credit, no notification", notices().length === 0 && sent.length === 0);
  process.env.FLAG_LOYALTY_V2 = `ids:${B},${S}`;

  console.log("-- visits, a tier, exactly once");
  for (const i of [0, 1, 2]) await loyalty.onVerifiedRedemption(reds[i]);
  const n3 = notices();
  check("3 visits: 3 notices, the third says 'Visit 3 at Alpha Cafe' / '2 more visits to 25%.'", n3.length === 3 && n3[2].kind === "visit" && n3[2].title === "Visit 3 at Alpha Cafe" && n3[2].body === "2 more visits to 25%.", JSON.stringify(n3.map((n) => [n.title, n.body])));
  check("…each pushed through the gateway as a transactional 'loyalty' message (quiet hours and settings apply, not the caps)", sent.length === 3 && sent.every((p) => p.type === "loyalty" && p.essential === true && same(p.userId, S)) && n3.every((n) => n.push === "sent"));
  const tap = inapp()[0]?.metadata;
  check("…and kept in-app; a tap opens the brand's screen with its loyalty card", inapp().length === 3 && tap.screen === "OfferScreen" && same(tap.params.brand._id, B) && tap.params.brand.brandName === "Alpha Cafe" && tap.skipPush === true && sent[0].data.screen === "OfferScreen");
  await Promise.all([1, 2, 3, 4, 5].map(() => loyalty.onVerifiedRedemption(reds[2])));
  await notify.notifyRow(rows("LoyaltyLedger", (x) => same(x.redemptionId, reds[2]))[0], null);
  check("the credit hook 5 more times at once + a direct call for the same row: still one notice, one push", notices().length === 3 && sent.length === 3 && inapp().length === 3);
  await loyalty.onVerifiedRedemption(reds[3]);
  check("visit 4: '1 more visit to 25%.'", notices()[3].body === "1 more visit to 25%.");
  await loyalty.onVerifiedRedemption(reds[4]);
  const n5 = notices()[4];
  check("visit 5 makes the next visit 25%: \"You've unlocked 25% at Alpha Cafe\"", n5.kind === "tier_unlocked" && n5.title === "You've unlocked 25% at Alpha Cafe" && /next visit at Alpha Cafe gets 25%/.test(n5.body), JSON.stringify(n5));
  await loyalty.onVerifiedRedemption(reds[5]);
  check("visit 6 (top tier): \"You're at the top tier: 25% on every visit.\"", notices()[5].body === "You're at the top tier: 25% on every visit." && notices()[5].title === "Visit 6 at Alpha Cafe");

  console.log("-- reversal");
  await loyalty.reverseRedemption({ redemptionId: reds[5], reason: "bill refunded at the counter", actor: ADMIN });
  const rev = notices()[6];
  check("an admin reverses visit 6: 'A visit at Alpha Cafe was reversed', with the reason and the new count", rev.kind === "reversed" && rev.title === "A visit at Alpha Cafe was reversed" && /bill refunded at the counter/.test(rev.body) && /5 visits/.test(rev.body), JSON.stringify(rev));

  console.log("-- delivery outcomes and the setting");
  gatewayMode = "quiet_hours";
  await loyalty.onVerifiedRedemption(reds[6]);
  check("quiet hours: the push is held back by the gateway (recorded), the in-app notification is still there", notices()[7].push === "quiet_hours" && inapp().length === 8);
  gatewayMode = "throw";
  const out = await loyalty.onVerifiedRedemption(reds[7]);
  check("the push provider throws: the visit is still credited, the notice says it failed", out.credited === true && /^failed/.test(notices()[8].push));
  gatewayMode = "sent";
  const TS = token(S, "student"), TS2 = token(S2, "student");
  r = await call("GET", "/api/engagement/notification-prefs", { tok: TS });
  check("settings: a pilot student sees the new 'loyalty' switch, on by default", r.status === 200 && r.json.loyalty === true && r.json.deals === true, r.text.slice(0, 200));
  r = await call("GET", "/api/engagement/notification-prefs", { tok: TS2 });
  check("…a student outside the pilot sees exactly the switches they had (no 'loyalty')", r.status === 200 && !("loyalty" in r.json));
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: TS2, body: { loyalty: false } });
  check("…and can't write it (nothing stored)", rows("UserNotificationSetting").length === 0);
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: TS, body: { loyalty: false } });
  check("the pilot student turns loyalty pushes off (stored in its own collection, EngagementProfile untouched)", r.status === 200 && r.json.loyalty === false && rows("UserNotificationSetting", (x) => same(x.user, S) && x.enabled === false).length === 1 && !("loyalty" in (rows("EngagementProfile", (p) => same(p.user, S))[0].notifPrefs || {})));
  const pushes = sent.length;
  const extra = oid();
  rows("Offer")[0].redemptions.push({ _id: extra, student: S, billAmount: 1000, savedAmount: 200, redeemedAt: new Date() });
  await loyalty.onVerifiedRedemption(extra);
  check("switched off: no push, still in-app, the notice says pref_off", sent.length === pushes && notices().slice(-1)[0].push === "pref_off" && inapp().length === notices().length);
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: TS, body: { loyalty: true } });
  check("…and back on", r.json.loyalty === true);

  console.log("-- a visit that doesn't count says nothing");
  rows("LoyaltyProgram")[0].maxVisitsPerDay = 1;
  const capped = oid();
  rows("Offer")[0].redemptions.push({ _id: capped, student: S, billAmount: 1000, savedAmount: 200, redeemedAt: new Date() });
  const before = notices().length;
  const c = await loyalty.onVerifiedRedemption(capped);
  check("a credit over the daily limit (not counted): no notification", c.credited === false && notices().length === before);
  check("the message text names no amounts, bills or other students", !/1000|200|taha/i.test(JSON.stringify(notices().map((n) => [n.title, n.body]))));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
