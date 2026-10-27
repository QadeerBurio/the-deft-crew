// GET /api/offers/my-redemptions and the "payment successful." push data.
//   node tests/my-redemptions/run.js [serverDir]
// Real offer routes and models; only MongoDB (the in-memory layer from tests/hide-user-secrets/fake-mongo.js),
// e-mail, Expo and outgoing HTTP are replaced. No database, no network, no .env (dotenv is stubbed; run it
// from a folder without one).
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
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const Offer = reqS("./models/Offer");
const Notification = reqS("./models/Notification");

// ---------- leak scanner (hidden user fields + anything a redemption must not expose) ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "shopifyClientId", "shopifyClientSecret", "shopifyWebhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const NOT_IN_MY_REDEMPTIONS = ["billAmount", "savedAmount", "student", "email", "name", "phone", "title", "claimedBy"];
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
    if (/\/my-redemptions/.test(req.originalUrl)) leaks.push(...NOT_IN_MY_REDEMPTIONS.filter((k) => keys.has(k)));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks });
    return send(body);
  };
  next();
});
app.use("/api/offers", reqS("./routes/offer.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = { a: oid(), b: oid(), brand: oid(), admin: oid(), offer1: oid(), offer2: oid() };
const now = Date.now();
const ago = (h) => new Date(now - h * 3600 * 1000);
const user = (id, role, name) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", pushTokens: [{ token: `ExponentPushToken[SEED-${name}]` }], createdAt: new Date(), updatedAt: new Date() });
fake.seed("users", [user(ids.a, "student", "studenta"), user(ids.b, "student", "studentb"), user(ids.brand, "brand", "brand"), user(ids.admin, "admin", "admin")]);
const red = (student, hoursAgo) => ({ _id: oid(), student, billAmount: 1000, savedAmount: 200, redeemedAt: ago(hoursAgo) });
const r = { a1: red(ids.a, 2), a2: red(ids.a, 24 * 10), aOld: red(ids.a, 24 * 40), b1: red(ids.b, 1), a3: red(ids.a, 5) };
const offer = (id, title, redemptions) => ({ _id: id, brand: ids.brand, title, discountPercentage: 20, category: "Restaurant", active: true, claimedBy: [ids.a, ids.b], redemptions, promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed("offers", [offer(ids.offer1, "20% off", [r.a1, r.b1, r.aOld]), offer(ids.offer2, "buy one", [r.a2, r.a3])]);
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
const check = (name, ok, detail = "") => { results.push({ ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const idsOf = (res) => (res.json?.redemptions || []).map((x) => x.redemptionId).sort().join();
const want = (...rs) => rs.map((x) => String(x._id)).sort().join();

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const A = token("a", "student"), B = token("b", "student"), BRAND = token("brand", "brand"), ADMIN = token("admin", "admin");

  console.log("── access");
  let res = await call("GET", "/api/offers/my-redemptions");
  check("no token (auth treats it as a guest) → 401", res.status === 401, res.status);
  res = await call("GET", "/api/offers/my-redemptions", { tok: "guest-token-2024" });
  check("the shared guest token → 401", res.status === 401, res.status);
  res = await call("GET", "/api/offers/my-redemptions", { tok: "not-a-token" });
  check("bad token → refused", res.status === 401 || res.status === 403, res.status);

  console.log("── a student sees only their own");
  res = await call("GET", "/api/offers/my-redemptions", { tok: A });
  check("student A: their 3 redemptions from the last 30 days", res.status === 200 && idsOf(res) === want(r.a1, r.a2, r.a3), idsOf(res));
  check("student A: student B's redemption of the same offer is never returned", !idsOf(res).includes(String(r.b1._id)));
  check("student A: the 40-day-old one is not returned (30 days max)", !idsOf(res).includes(String(r.aOld._id)));
  const row = res.json?.redemptions?.[0] || {};
  check("each row has exactly redemptionId, offerId, redeemedAt", Object.keys(row).sort().join() === "offerId,redeemedAt,redemptionId", Object.keys(row).join());
  check("newest first", res.json?.redemptions?.[0]?.redemptionId === String(r.a1._id));
  check("offerId is the redeemed offer", res.json?.redemptions?.find((x) => x.redemptionId === String(r.a2._id))?.offerId === String(ids.offer2));
  res = await call("GET", "/api/offers/my-redemptions", { tok: B });
  check("student B: only their own", res.status === 200 && idsOf(res) === want(r.b1), idsOf(res));

  console.log("── ?since=");
  res = await call("GET", `/api/offers/my-redemptions?since=${encodeURIComponent(ago(24).toISOString())}`, { tok: A });
  check("since 24 h ago → only the last day's", idsOf(res) === want(r.a1, r.a3), idsOf(res));
  res = await call("GET", `/api/offers/my-redemptions?since=${encodeURIComponent(ago(24 * 365).toISOString())}`, { tok: A });
  check("since a year ago → still capped at 30 days", idsOf(res) === want(r.a1, r.a2, r.a3), idsOf(res));
  res = await call("GET", "/api/offers/my-redemptions?since=garbage", { tok: A });
  check("invalid since → treated as 30 days, no error", res.status === 200 && idsOf(res) === want(r.a1, r.a2, r.a3), `${res.status} ${idsOf(res)}`);
  res = await call("GET", `/api/offers/my-redemptions?since[$gt]=x&studentId=${ids.b}`, { tok: A });
  check("query tricks (operator object, another student's id) → still only A's", res.status === 200 && idsOf(res) === want(r.a1, r.a2, r.a3), `${res.status} ${idsOf(res)}`);

  console.log("── brand / admin");
  res = await call("GET", "/api/offers/my-redemptions", { tok: BRAND });
  check("brand → their own redemptions (none), never their customers'", res.status === 200 && idsOf(res) === "", idsOf(res));
  res = await call("GET", "/api/offers/my-redemptions", { tok: ADMIN });
  check("admin → their own (none), not everyone's", res.status === 200 && idsOf(res) === "", idsOf(res));

  console.log("── redeem-payment (brand side) unchanged, push data added");
  res = await call("POST", "/api/offers/redeem-payment", { tok: A, body: { offerId: String(ids.offer2), userId: String(ids.a), billAmount: 500 } });
  check("a student still can't redeem (403)", res.status === 403, res.status);
  res = await call("POST", "/api/offers/redeem-payment", { tok: BRAND, body: { offerId: String(ids.offer1), userId: String(ids.b), billAmount: 500 } });
  check("brand redeems for student B: 200, same response fields", res.status === 200 && ["message", "offer", "redemptionsUsed", "redemptionsRemaining", "savedAmount"].every((k) => k in (res.json || {})) && res.json.savedAmount === 100, `${res.status} ${Object.keys(res.json || {}).join()}`);
  const saved = await Offer.findById(ids.offer1).lean();
  const newest = saved.redemptions[saved.redemptions.length - 1];
  check("the redemption is recorded for student B", String(newest.student) === String(ids.b) && newest.savedAmount === 100);
  await new Promise((ok) => setTimeout(ok, 30));
  const notes = await Notification.find({ recipient: ids.b }).lean();
  const note = notes.find((n) => /payment successful/.test(n.title || ""));
  check("\"payment successful.\" notification still created", !!note, notes.map((n) => n.title).join(" | "));
  check("push data: pushType redemption", note?.metadata?.pushType === "redemption", JSON.stringify(note?.metadata));
  check("push data: redemptionId is the new redemption", note?.metadata?.redemptionId === String(newest._id), note?.metadata?.redemptionId);
  check("push data: offerId", note?.metadata?.offerId === String(ids.offer1));
  check("push data: no bill, saving, name or email", !["billAmount", "savedAmount", "name", "email", "student"].some((k) => k in (note?.metadata || {})), Object.keys(note?.metadata || {}).join());
  res = await call("GET", "/api/offers/my-redemptions", { tok: B });
  check("student B now sees it, with the same redemptionId as the push", idsOf(res).includes(String(newest._id)) && !idsOf(res).includes(String(r.a1._id)), idsOf(res));
  res = await call("GET", "/api/offers/my-redemptions", { tok: A });
  check("student A still doesn't see B's new one", !idsOf(res).includes(String(newest._id)));
  res = await call("POST", "/api/offers/redeem-payment", { tok: BRAND, body: { offerId: String(ids.offer1), userId: String(ids.b), billAmount: 500 } });
  check("daily cap unchanged: B's 3rd today on the same offer → 400", res.status === 400, res.status);

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, none expose hidden user fields (my-redemptions: ids and date only)`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));

  server.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
