// POST /api/webhooks/confirm (brand site / WordPress plugin) and /api/webhooks/shopify/confirm: signatures.
//   node tests/woo-webhook-confirm/run.js [serverDir]
// Real webhook routes and models; only MongoDB (tests/hide-user-secrets/fake-mongo.js), e-mail, Expo and
// outgoing HTTP are replaced (a brand's WooCommerce store is answered in-process). No database, no
// network, no .env (dotenv is stubbed; run it from a folder without one).
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "DEFAULT_WEBHOOK_SECRET", "WEBHOOK_CONFIRM_RATE_LIMIT", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_WEBHOOK_SECRET"]) delete process.env[k];

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
// outgoing HTTP: only the brand's store (https://store.example) answers; everything else is blocked
const axios = reqS("axios");
const storeOrders = new Map(); // order id -> order the store returns
const storeCalls = [];
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);
axios.get = async (url, cfg = {}) => {
  storeCalls.push({ url, auth: cfg.auth, maxRedirects: cfg.maxRedirects });
  const m = String(url).match(/^https:\/\/store\.example\/wp-json\/wc\/v3\/orders\/(\d+)$/);
  if (!m || cfg.auth?.username !== "ck_store_key" || cfg.auth?.password !== "cs_store_secret") throw new Error("store unreachable");
  if (!storeOrders.has(m[1])) { const e = new Error("404"); e.response = { status: 404 }; throw e; }
  return { data: storeOrders.get(m[1]) };
};

// capture every log line: no secret, signature or expected signature may appear
const logLines = [];
for (const k of ["log", "warn", "error", "info"]) {
  const orig = console[k];
  console[k] = (...a) => { logLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); if (process.env.SHOW_LOGS) orig(...a); };
}

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const express = reqS("express");
const PromoCode = reqS("./models/PromoCode");
const Offer = reqS("./models/Offer");

// same raw-body capture as server.js
const responses = [];
const app = express();
app.use(express.json({ limit: "5mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/webhooks", reqS("./routes/webhook.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const SECRET_A = "whsec_brand_a_0123456789", SECRET_K = "whsec_brand_k_9876543210", SHOP_SECRET = "shpss_brand_s_5555";
const ids = { A: oid(), N: oid(), K: oid(), H: oid(), S: oid(), st: oid(), offA: oid(), offN: oid(), offK: oid(), offH: oid(), offS: oid() };
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("users", [
  user(ids.A, "brand", "brandA", { brandName: "Alpha", webhookSecret: SECRET_A }),
  user(ids.N, "brand", "brandN", { brandName: "NoSecret" }),
  user(ids.K, "brand", "brandK", { brandName: "Kappa", webhookSecret: SECRET_K, websiteUrl: "https://store.example/", wooConsumerKey: "ck_store_key", wooConsumerSecret: "cs_store_secret" }),
  user(ids.H, "brand", "brandH", { brandName: "Hotel", webhookSecret: "whsec_h", websiteUrl: "http://store.example", wooConsumerKey: "ck_store_key", wooConsumerSecret: "cs_store_secret" }),
  user(ids.S, "brand", "brandS", { brandName: "ShopCo", shopifyStoreUrl: "shopco.myshopify.com", shopifyWebhookSecret: SHOP_SECRET }),
  user(ids.st, "student", "sana"),
]);
const offer = (id, brand) => ({ _id: id, brand, title: "deal", discountPercentage: 20, category: "Cafe & Coffee", redemptions: [], claimedBy: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date() });
fake.seed("offers", [offer(ids.offA, ids.A), offer(ids.offN, ids.N), offer(ids.offK, ids.K), offer(ids.offH, ids.H), offer(ids.offS, ids.S)]);
const code = (c, brand, off) => ({ _id: oid(), code: c, offer: off, student: ids.st, brand, discountPercentage: 20, offerTitle: "deal", brandName: "brand", status: "active", externalProvider: "none", expiresAt: new Date(Date.now() + 864e5), usedCount: 0, createdAt: new Date() });
fake.seed("promocodes", [
  code("ALPA11111", ids.A, ids.offA), code("ALPB22222", ids.A, ids.offA), code("NOSC33333", ids.N, ids.offN),
  code("KAPA44444", ids.K, ids.offK), code("KAPB55555", ids.K, ids.offK), code("KAPC66666", ids.K, ids.offK), code("KAPD77777", ids.K, ids.offK),
  code("HOTA88888", ids.H, ids.offH), code("SHPA99999", ids.S, ids.offS), code("SHPB00000", ids.S, ids.offS),
]);

// ---------- HTTP ----------
let PORT;
function post(url, raw, headers = {}) {
  return new Promise((resolve) => {
    const h = { "content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers };
    const q = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, text: String(e) }));
    q.write(raw); q.end();
  });
}
function get(url) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path: url }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, text: t })); });
  });
}
const hex = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const b64 = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("base64");
const confirm = (body, secret, extraHeaders = {}) => { const raw = JSON.stringify(body); return post("/api/webhooks/confirm", raw, { ...(secret ? { "x-webhook-signature": hex(secret, raw) } : {}), ...extraHeaders }); };
const promo = (c) => (fake.STORE.get("promocodes") || []).find((x) => x.code === c);
const redemptionsOf = (offerId) => (fake.STORE.get("offers") || []).find((o) => String(o._id) === String(offerId)).redemptions;
const results = [];
const check = (name, ok) => { results.push({ ok: !!ok }); }; // printed at the end (console is captured as server logs)
const say = (...a) => process.stdout.write(a.join(" ") + "\n");

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const out = [];
  const c = (name, ok, detail) => { check(name, ok, detail); out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

  // -- rejected: nothing changes
  let r = await confirm({ coupon_code: "NOSC33333", order_id: "101", amount: 1000, status: "completed" }, "anything");
  const noSecretReply = r.text;
  c("brand with no webhook secret → 403, code still active", r.status === 403 && promo("NOSC33333").status === "active", `${r.status} ${r.text}`);
  r = await confirm({ coupon_code: "NOPE00000", order_id: "102", amount: 1000, status: "completed" }, SECRET_A);
  c("unknown code → the same 403 reply (no 'not found')", r.status === 403 && r.text === noSecretReply, r.text);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "103", amount: 1000, status: "completed" });
  c("no signature → same 403", r.status === 403 && r.text === noSecretReply && promo("ALPA11111").status === "active", r.text);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "103", amount: 1000, status: "completed" }, "wrong_secret");
  c("signed with the wrong secret → same 403", r.status === 403 && r.text === noSecretReply, r.text);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "103", amount: 1000, status: "completed" }, SECRET_K);
  c("signed with another brand's secret → same 403", r.status === 403 && r.text === noSecretReply);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "103", amount: 1000, status: "completed" }, null, { "x-webhook-signature": "not-hex" });
  c("malformed signature → same 403", r.status === 403 && r.text === noSecretReply);
  { // the signature covers the exact bytes: changing the amount after signing fails
    const raw = JSON.stringify({ coupon_code: "ALPA11111", order_id: "103", amount: 1000, status: "completed" });
    r = await post("/api/webhooks/confirm", raw.replace("1000", "99999"), { "x-webhook-signature": hex(SECRET_A, raw) });
    c("amount changed after signing → same 403", r.status === 403 && promo("ALPA11111").status === "active");
  }
  r = await confirm({ coupon_code: "ALPA11111", amount: 1000, status: "completed" }, SECRET_A);
  c("no order_id → 400", r.status === 400, r.status);

  // -- signed by brand A, no store keys: signed amount after checks
  r = await confirm({ coupon_code: "ALPA11111", order_id: "104", amount: 2000, status: "pending" }, SECRET_A);
  c("pending order → 200 ignored, code still active, nothing counted", r.status === 200 && r.json?.ignored === true && promo("ALPA11111").status === "active" && redemptionsOf(ids.offA).length === 0, r.text);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "104", amount: 2000, status: "cancelled" }, SECRET_A);
  c("cancelled order → ignored", r.json?.ignored === true && promo("ALPA11111").status === "active");
  for (const bad of [-5, 0, "abc", 1e9]) {
    r = await confirm({ coupon_code: "ALPA11111", order_id: "105", amount: bad, status: "completed" }, SECRET_A);
    c(`amount ${JSON.stringify(bad)} → 400, code still active`, r.status === 400 && promo("ALPA11111").status === "active", r.status);
  }
  r = await confirm({ coupon_code: "alpa11111 ", order_id: "106", amount: 2000, status: "completed" }, SECRET_A);
  c("completed, signed → 200 confirmed (code matched case-insensitively)", r.status === 200 && r.json?.data?.status === "confirmed" && r.json?.data?.savedAmount === 400, r.text);
  const pA = promo("ALPA11111");
  c("code used: order id, amount, via webhook", pA.status === "used" && pA.externalOrderId === "106" && pA.externalAmount === 2000 && pA.redeemedVia === "webhook");
  c("one redemption on the offer: bill 2000, saved 400", redemptionsOf(ids.offA).length === 1 && redemptionsOf(ids.offA)[0].billAmount === 2000 && redemptionsOf(ids.offA)[0].savedAmount === 400);
  r = await confirm({ coupon_code: "ALPA11111", order_id: "106", amount: 2000, status: "completed" }, SECRET_A);
  c("the same order again → alreadyUsed, still one redemption", r.json?.alreadyUsed === true && redemptionsOf(ids.offA).length === 1, r.text);
  c("response holds no student name or e-mail", !/sana|@test\.local/.test(r.text));

  // -- brand K has store keys: the order is read back, the sent amount ignored
  storeOrders.set("201", { id: 201, status: "completed", total: "1600.00", coupon_lines: [{ code: "kapa44444", discount: "400.00" }] });
  r = await confirm({ coupon_code: "KAPA44444", order_id: "201", amount: 99999, status: "completed" }, SECRET_K);
  c("store brand: amount from the store (1600 paid + 400 discount = 2000), not the 99999 sent", r.status === 200 && promo("KAPA44444").externalAmount === 2000 && redemptionsOf(ids.offK)[0]?.billAmount === 2000, `${r.status} ${promo("KAPA44444").externalAmount}`);
  c("store read: https, the brand's keys, no redirects", storeCalls.length === 1 && storeCalls[0].url === "https://store.example/wp-json/wc/v3/orders/201" && storeCalls[0].maxRedirects === 0);
  storeOrders.set("202", { id: 202, status: "completed", total: "500.00", coupon_lines: [{ code: "SOMEOTHER", discount: "50" }] });
  r = await confirm({ coupon_code: "KAPB55555", order_id: "202", amount: 500, status: "completed" }, SECRET_K);
  c("code not on the store's order → 409, code still active", r.status === 409 && promo("KAPB55555").status === "active", r.text);
  storeOrders.set("203", { id: 203, status: "pending", total: "500.00", coupon_lines: [{ code: "KAPC66666", discount: "100" }] });
  r = await confirm({ coupon_code: "KAPC66666", order_id: "203", amount: 500, status: "completed" }, SECRET_K);
  c("store says the order isn't paid (sender said completed) → ignored", r.json?.ignored === true && promo("KAPC66666").status === "active", r.text);
  r = await confirm({ coupon_code: "KAPD77777", order_id: "999", amount: 500, status: "completed" }, SECRET_K);
  c("store can't find the order → 502, code still active (the plugin retries)", r.status === 502 && promo("KAPD77777").status === "active", r.text);
  r = await confirm({ coupon_code: "HOTA88888", order_id: "201", amount: 500, status: "completed" }, "whsec_h");
  c("store on plain http → not read (502), code still active", r.status === 502 && promo("HOTA88888").status === "active", r.text);

  // -- the public status lookup is gone
  r = await get("/api/webhooks/status/ALPA11111");
  c("GET /status/:code → 410, nothing about the code", r.status === 410 && !/ALPA|sana|@test|used/.test(r.text), `${r.status} ${r.text}`);

  // -- Shopify: the signature is always required
  const shopBody = (c2, id) => JSON.stringify({ id, name: `#${id}`, total_price: "1000.00", discount_codes: [{ code: c2 }] });
  let raw = shopBody("SHPA99999", 301);
  r = await post("/api/webhooks/shopify/confirm", raw, { "x-shopify-shop-domain": "shopco.myshopify.com", "x-shopify-topic": "orders/paid" });
  c("Shopify: no signature → 403, code still active (used to be accepted)", r.status === 403 && promo("SHPA99999").status === "active", `${r.status} ${r.text}`);
  r = await post("/api/webhooks/shopify/confirm", raw, { "x-shopify-shop-domain": "shopco.myshopify.com", "x-shopify-hmac-sha256": b64("wrong", raw) });
  c("Shopify: wrong signature → 403", r.status === 403 && promo("SHPA99999").status === "active");
  r = await post("/api/webhooks/shopify/confirm", raw, { "x-shopify-shop-domain": "shopco.myshopify.com", "x-shopify-hmac-sha256": b64(SHOP_SECRET, raw) });
  c("Shopify: good signature → accepted, code used", r.status === 200 && promo("SHPA99999").status === "used", `${r.status} ${r.text.slice(0, 120)}`);

  // -- rate limit (a separate client address)
  process.env.WEBHOOK_CONFIRM_RATE_LIMIT = "3";
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await confirm({ coupon_code: "NOPE00000", order_id: String(400 + i), amount: 1, status: "completed" }, SECRET_A, { "x-forwarded-for": "203.0.113.9" })).status);
  c("rate limit: 4th request in a minute from one address → 429", codes.slice(0, 3).every((x) => x === 403) && codes[3] === 429 && codes[4] === 429, codes.join(","));
  delete process.env.WEBHOOK_CONFIRM_RATE_LIMIT;

  // -- logs
  const all = logLines.join("\n");
  const sigs = [SECRET_A, SECRET_K, SHOP_SECRET, "cs_store_secret", "ck_store_key"];
  c("logs never hold a secret, key, signature or 'expected' value", !sigs.some((s) => all.includes(s)) && !/expected/i.test(all) && !/[0-9a-f]{64}/i.test(all), all.split("\n").filter((l) => /expected|[0-9a-f]{64}/i.test(l)).slice(0, 2).join(" | "));
  c("no response holds a key, secret, student e-mail or ck_/cs_ value", responses.every((x) => !/ck_|cs_|whsec_|shpss_|@test\.local/.test(x.text)), responses.filter((x) => /ck_|cs_|whsec_|@test/.test(x.text)).map((x) => x.url).join());

  server.close();
  for (const line of out) say(line);
  const failed = results.filter((x) => !x.ok).length;
  say(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { process.stdout.write("FATAL " + (e.stack || e) + "\n"); process.exit(2); });
