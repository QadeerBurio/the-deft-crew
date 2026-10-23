// Hidden user secrets: route checks with a leak scanner on every response.
//   node tests/hide-user-secrets/run.js <serverDir> <out.json>
// Real route files and the real User model; only MongoDB (fake-mongo.js), e-mail, Expo and
// outgoing HTTP are replaced. No database, no network, no .env (dotenv is stubbed; run it from
// a folder that has no .env). Run it against the old and the new server folder and compare.
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const OUT = process.argv[3];
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of ["SHOPIFY_CLIENT_SECRET", "SHOPIFY_WEBHOOK_SECRET", "WEBHOOK_SECRET", "MONGO_URI", "MONGODB_URI"]) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
const mails = [];
const pushes = [];
const httpCalls = [];
class Expo {
  constructor() {}
  static isExpoPushToken(t) { return typeof t === "string" && t.startsWith("ExponentPushToken["); }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { pushes.push(...ms); return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) {
    return { sendMail: async (m) => { mails.push(m); return { sent: true }; }, logMailerStatus: () => {}, mailProvider: "test" };
  }
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const fakeHttp = (method) => async (url, a, b) => {
  const cfg = method === "get" || method === "delete" ? a : b;
  httpCalls.push({ method, url, auth: cfg?.auth || null });
  if (/woo\.example\.test/.test(url)) return { status: 201, data: { id: 123, code: "ok" } };
  throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`);
};
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = fakeHttp(m);
axios.request = async (cfg) => fakeHttp((cfg.method || "get").toLowerCase())(cfg.url, cfg.data, cfg);

const mongoose = reqS("mongoose");
const fake = require("./fake-mongo");
fake.install(mongoose, mongoose.Types.ObjectId);

const express = reqS("express");
const bcrypt = reqS("bcryptjs");
const jwt = reqS("jsonwebtoken");
const User = reqS("./models/User");
const routes = {
  "/api/webhooks": reqS("./routes/webhook.routes"),
  "/api/auth": reqS("./routes/auth.routes"),
  "/api/brands": reqS("./routes/brands.routes"),
  "/api/admin": reqS("./routes/admin.routes"),
  "/api/brand-approval": reqS("./routes/brandApproval.routes"),
  "/api/promo-codes": reqS("./routes/promoCode.routes"),
};
const push = reqS("./utils/pushNotification");

// ---------- leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "shopifyClientId", "shopifyClientSecret", "shopifyWebhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture"];
const SECRET_VALUES = ["ck_SEEDKEY", "cs_SEEDSECRET", "whsec_SEED", "shpss_SEED", "shpat_SEED", "shpci_SEED", "shpcs_SEED", "ExponentPushToken[SEED", "kyc.test/", "$2a$", "$2b$"];
function leaksIn(body) {
  const found = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (HIDDEN.includes(k)) found.add(`key:${k}`); walk(x); }
  };
  try { walk(typeof body === "string" ? JSON.parse(body) : body); } catch { /* not JSON */ }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  for (const s of SECRET_VALUES) if (text && text.includes(s)) found.add(`value:${s}`);
  return [...found];
}
const responses = [];
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json({ limit: "5mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const text = Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body);
    responses.push({ method: req.method, url: req.originalUrl, status: res.statusCode, leaks: leaksIn(text) });
    return send(body);
  };
  next();
});
for (const [p, r] of Object.entries(routes)) app.use(p, r);

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = { admin: oid(), student: oid(), student2: oid(), brand: oid(), shopBrand: oid(), employer: oid(), uni: oid(), offer: oid() };
const now = new Date();
const PW = { admin: "Admin#123", student: "Student#123", student2: "Other#123", brand: "Brand#123", employer: "Employer#123" };
const hash = (p) => bcrypt.hashSync(p, 4);
const kyc = { idCardFront: "https://kyc.test/front.jpg", idCardBack: "https://kyc.test/back.jpg", livePicture: "https://kyc.test/live.jpg" };
const base = (id, role, name, email, extra = {}) => ({ _id: id, name, email, password: hash(PW[role] || PW.student), role, status: "Verified", accountStatus: "active", emailVerified: true, createdAt: now, updatedAt: now, pushTokens: [{ token: `ExponentPushToken[SEED-${name}]`, platform: "android", channels: "snd_v1", updatedAt: now }], ...kyc, ...extra });
fake.seed("universities", [{ _id: ids.uni, name: "SZABIST", location: "Karachi" }]);
fake.seed("users", [
  base(ids.admin, "admin", "Admin", "admin@test.local"),
  base(ids.student, "student", "Student One", "student@test.local", { university: ids.uni, referralCode: "STU001", phone: "03001111111" }),
  { ...base(ids.student2, "student", "Student Two", "student2@test.local", { referralCode: "STU002" }), password: hash(PW.student2) },
  base(ids.brand, "brand", "Brand Owner", "brand@test.local", {
    brandName: "Seed Cafe", logo: "seed.png", category: "Food", address: "DHA", phone: "03002222222", isOnline: true, isInStore: true,
    brandApprovalStatus: "approved", platform: "woocommerce", websiteUrl: "https://woo.example.test",
    wooConsumerKey: "ck_SEEDKEY", wooConsumerSecret: "cs_SEEDSECRET", webhookSecret: "whsec_SEED",
  }),
  base(ids.shopBrand, "brand", "Shop Owner", "shop@test.local", {
    brandName: "Seed Shop", logo: "shop.png", category: "Fashion", brandApprovalStatus: "approved", platform: "shopify", isOnline: true,
    shopifyStoreUrl: "seed-shop.myshopify.com", shopifyAccessToken: "shpat_SEED", shopifyClientId: "shpci_SEED", shopifyClientSecret: "shpcs_SEED", shopifyWebhookSecret: "shpss_SEED",
  }),
  base(ids.employer, "employee", "Employer", "employer@test.local", { companyName: "Seed Co" }),
]);
fake.seed("offers", [{ _id: ids.offer, brand: ids.brand, title: "20% off", discountPercentage: 20, category: "Food", isOnline: true, isInStore: true, active: true, claimedBy: [ids.student], redemptions: [], promoCodesGenerated: [], createdAt: now, updatedAt: now }]);
const promo = (code, extra = {}) => ({ _id: oid(), code, brand: ids.brand, offer: ids.offer, student: ids.student2, discountPercentage: 20, offerTitle: "20% off", brandName: "Seed Cafe", status: "active", expiresAt: new Date(Date.now() + 864e5), createdAt: now, updatedAt: now, ...extra });
fake.seed("promocodes", [promo("SEEDWOO1"), promo("SEEDSHOP1", { brand: ids.shopBrand, brandName: "Seed Shop" })]);
const token = (who) => jwt.sign({ id: String(ids[who]), role: { admin: "admin", student: "student", student2: "student", brand: "brand", employer: "employee" }[who] }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok, headers = {}, raw } = {}) {
  return new Promise((resolve) => {
    const data = raw != null ? raw : body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${token(tok)}`;
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) r.write(data);
    r.end();
  });
}

// ---------- checks ----------
const results = [];
async function check(name, fn) {
  const before = responses.length;
  let ok = false, detail = "";
  try { const r = await fn(); ok = !!r.ok; detail = r.detail || ""; } catch (e) { detail = `threw: ${e.message}`; }
  const leaks = [...new Set(responses.slice(before).flatMap((x) => x.leaks))];
  results.push({ name, ok, detail, leaks });
}
const has = (o, ...ks) => o && ks.every((k) => o[k] !== undefined);
const hmacHex = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const hmacB64 = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("base64");

async function main() {
  const server = app.listen(0); PORT = server.address().port;

  // login / signup / passwords
  await check("login: right password", async () => { const r = await call("POST", "/api/auth/login", { body: { email: "student@test.local", password: PW.student } }); return { ok: r.status === 200 && r.json?.token && r.json?.user?.email === "student@test.local", detail: `${r.status}` }; });
  await check("login: wrong password rejected", async () => { const r = await call("POST", "/api/auth/login", { body: { email: "student@test.local", password: "nope" } }); return { ok: r.status >= 400 && !r.json?.token, detail: `${r.status}` }; });
  await check("signup + email code -> logged in", async () => {
    const r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "new@test.local", password: "NewUser#123", fullName: "New User", universityName: "SZABIST", phone: "03003333333", city: "Karachi" } });
    if (r.status >= 300) return { detail: `signup ${r.status} ${r.text.slice(0, 120)}` };
    if (!r.json?.requiresVerification) return { ok: !!r.json?.token, detail: `signup ${r.status} (no OTP step)` };
    const mail = mails.filter((m) => /new@test\.local/.test(JSON.stringify(m.to || m))).pop();
    const code = (JSON.stringify(mail || {}).match(/\b(\d{6})\b/) || [])[1];
    const v = await call("POST", "/api/auth/signup/verify-otp", { body: { userId: r.json.userId, otp: code } });
    const l = await call("POST", "/api/auth/login", { body: { email: "new@test.local", password: "NewUser#123" } });
    return { ok: v.status === 200 && v.json?.token && l.status === 200, detail: `signup ${r.status}, verify ${v.status}, login ${l.status}` };
  });
  await check("change password, then log in with it", async () => {
    const bad = await call("POST", "/api/auth/change-password", { tok: "student2", body: { currentPassword: "wrong", newPassword: "Changed#456" } });
    const r = await call("POST", "/api/auth/change-password", { tok: "student2", body: { currentPassword: PW.student2, newPassword: "Changed#456" } });
    const l = await call("POST", "/api/auth/login", { body: { email: "student2@test.local", password: "Changed#456" } });
    return { ok: bad.status >= 400 && r.status === 200 && l.status === 200, detail: `wrong-current ${bad.status}, change ${r.status}, login ${l.status}` };
  });
  await check("forgot -> code -> reset -> log in", async () => {
    const f = await call("POST", "/api/auth/forgot-password", { body: { emailOrPhone: "employer@test.local" } });
    const mail = mails.filter((m) => /employer@test\.local/.test(JSON.stringify(m.to || m))).pop();
    const code = (JSON.stringify(mail || {}).match(/\b(\d{6})\b/) || [])[1];
    const v = await call("POST", "/api/auth/verify-otp", { body: { userId: String(ids.employer), otp: code } });
    const rs = await call("POST", "/api/auth/reset-password", { body: { resetToken: v.json?.resetToken, newPassword: "Reset#789" } });
    const l = await call("POST", "/api/auth/login", { body: { email: "employer@test.local", password: "Reset#789" } });
    return { ok: f.status === 200 && v.status === 200 && rs.status === 200 && l.status === 200, detail: `forgot ${f.status}, verify ${v.status}, reset ${rs.status}, login ${l.status}` };
  });

  // admin lists and profiles
  for (const role of ["student", "brand", "employee", "traveler"]) {
    await check(`admin: list ${role}s`, async () => { const r = await call("GET", `/api/admin/users/${role}`, { tok: "admin" }); return { ok: r.status === 200 && Array.isArray(r.json), detail: `${r.status}, ${Array.isArray(r.json) ? r.json.length : "?"} users` }; });
  }
  await check("admin: all users", async () => { const r = await call("GET", "/api/admin/users/all", { tok: "admin" }); return { ok: r.status === 200, detail: `${r.status}` }; });
  for (const who of ["student", "brand", "employer"]) {
    await check(`admin: full profile (${who})`, async () => { const r = await call("GET", `/api/admin/users/details/${ids[who]}`, { tok: "admin" }); return { ok: r.status === 200 && has(r.json, "name", "email", "role"), detail: `${r.status} ${r.json?.role || ""}` }; });
  }
  await check("admin: brand approval detail", async () => { const r = await call("GET", `/api/brand-approval/${ids.brand}`, { tok: "admin" }); return { ok: r.status === 200, detail: `${r.status}` }; });
  await check("admin: 'show password' endpoint gone (410)", async () => { const r = await call("GET", `/api/admin/users/password/${ids.student}`, { tok: "admin" }); return { ok: r.status === 410, detail: `${r.status}` }; });
  await check("admin: log in as brand", async () => { const r = await call("POST", "/api/auth/admin-login-as-brand", { tok: "admin", body: { brandId: String(ids.brand) } }); return { ok: r.status === 200 && r.json?.token && r.json?.user?.brandName === "Seed Cafe", detail: `${r.status}` }; });

  // access checks
  await check("auth/:id: own account", async () => { const r = await call("GET", `/api/auth/${ids.student}`, { tok: "student" }); return { ok: r.status === 200 && r.json?.email === "student@test.local" && r.json?.referralCode === "STU001", detail: `${r.status}` }; });
  await check("auth/:id: someone else -> 403", async () => { const r = await call("GET", `/api/auth/${ids.brand}`, { tok: "student" }); return { ok: r.status === 403, detail: `${r.status}` }; });
  await check("auth/:id: admin may view anyone", async () => { const r = await call("GET", `/api/auth/${ids.brand}`, { tok: "admin" }); return { ok: r.status === 200, detail: `${r.status}` }; });
  await check("auth/student/:id: own", async () => { const r = await call("GET", `/api/auth/student/${ids.student}`, { tok: "student" }); return { ok: r.status === 200 && r.json?.user?.email === "student@test.local", detail: `${r.status}` }; });
  await check("auth/student/:id: someone else -> 403", async () => { const r = await call("GET", `/api/auth/student/${ids.student2}`, { tok: "student" }); return { ok: r.status === 403, detail: `${r.status}` }; });
  await check("auth approve-user by a student -> 403", async () => { const r = await call("POST", `/api/auth/approve-user/${ids.student}`, { tok: "student" }); return { ok: r.status === 403, detail: `${r.status}` }; });
  await check("auth approve-user by admin", async () => { const r = await call("POST", `/api/auth/approve-user/${ids.student}`, { tok: "admin" }); return { ok: r.status === 200, detail: `${r.status}` }; });
  await check("auth verify-user by a student -> 403", async () => { const r = await call("PATCH", `/api/auth/verify-user/${ids.student}`, { tok: "student" }); return { ok: r.status === 403, detail: `${r.status}` }; });
  await check("brands/:id (app brand page): public fields", async () => {
    const r = await call("GET", `/api/brands/${ids.brand}`, { tok: "student" }); const b = r.json?.brand;
    const extra = b ? Object.keys(b).filter((k) => ["email", "phone"].includes(k)) : [];
    return { ok: r.status === 200 && b?.brandName === "Seed Cafe" && b?.logo && b?.category && extra.length === 0, detail: `${r.status}${extra.length ? " has " + extra.join(",") : ""}` };
  });
  await check("brands/:id as a guest (no login)", async () => { const r = await call("GET", `/api/brands/${ids.brand}`); return { ok: r.status === 200 && r.json?.brand?.brandName === "Seed Cafe", detail: `${r.status}` }; });
  // GET /brand-approval/approved is declared after GET /:id, so /:id answers it and the handler never runs
  // (true before this change too). Check the handler's field list in the source instead.
  await check("brand-approval/approved: field list has no email or phone (route itself unreachable)", async () => {
    const src = fs.readFileSync(path.join(SERVER, "routes", "brandApproval.routes.js"), "utf8");
    const block = src.slice(src.indexOf('router.get("/approved"'), src.indexOf('router.get("/stats"'));
    const sel = (block.match(/\.select\("([^"]+)"\)/) || [])[1] || "";
    const r = await call("GET", "/api/brand-approval/approved");
    return { ok: sel && !/(email|phone)/.test(sel), detail: `select "${sel}"; live call ${r.status}` };
  });

  // integrations that need the hidden secrets
  await check("Woo: promo code creates the store coupon with the brand's keys", async () => {
    httpCalls.length = 0;
    const r = await call("POST", "/api/promo-codes/generate", { tok: "student", body: { offerId: String(ids.offer) } });
    const woo = httpCalls.find((c) => /wc\/v3\/coupons/.test(c.url));
    return { ok: r.status < 300 && woo?.auth?.username === "ck_SEEDKEY" && woo?.auth?.password === "cs_SEEDSECRET", detail: `${r.status}, woo call ${woo ? "with " + (woo.auth?.username === "ck_SEEDKEY" ? "brand keys" : "NO keys") : "missing"}${r.status >= 300 ? " " + r.text.slice(0, 120) : ""}` };
  });
  const wooBody = JSON.stringify({ coupon_code: "SEEDWOO1", order_id: 991, order_total: 1000, discount_amount: 200, status: "completed", customer_email: "x@test.local" });
  await check("Woo webhook: bad signature rejected (secret loaded)", async () => { const r = await call("POST", "/api/webhooks/confirm", { raw: wooBody, headers: { "x-webhook-signature": "bad" } }); return { ok: r.status === 403, detail: `${r.status} ${r.json?.message || ""}` }; });
  await check("Woo webhook: good signature accepted", async () => { const r = await call("POST", "/api/webhooks/confirm", { raw: wooBody, headers: { "x-webhook-signature": hmacHex("whsec_SEED", wooBody) } }); return { ok: r.status !== 403, detail: `${r.status} ${r.json?.message || ""}` }; });
  const shopBody = JSON.stringify({ id: 5001, name: "#5001", total_price: "1000.00", subtotal_price: "1000.00", total_discounts: "200.00", discount_codes: [{ code: "SEEDSHOP1", amount: "200.00" }], customer: { email: "x@test.local" } });
  const shopHeaders = (sig) => ({ "x-shopify-hmac-sha256": sig, "x-shopify-shop-domain": "seed-shop.myshopify.com", "x-shopify-topic": "orders/create" });
  await check("Shopify webhook: bad signature rejected (secret loaded)", async () => { const r = await call("POST", "/api/webhooks/shopify/confirm", { raw: shopBody, headers: shopHeaders("bad") }); return { ok: r.status === 403, detail: `${r.status} ${r.json?.message || ""}` }; });
  await check("Shopify webhook: good signature accepted", async () => { const r = await call("POST", "/api/webhooks/shopify/confirm", { raw: shopBody, headers: shopHeaders(hmacB64("shpss_SEED", shopBody)) }); return { ok: r.status !== 403, detail: `${r.status} ${r.json?.message || ""}` }; });
  await check("push: sendToUser finds the device token", async () => {
    pushes.length = 0;
    await push.sendToUser(String(ids.student), "hi", "test", { type: "System" });
    const to = pushes.flatMap((m) => [].concat(m.to));
    return { ok: to.some((t) => String(t).includes("SEED-Student One")), detail: `${pushes.length} message(s)` };
  });

  server.close();
  const leakyResponses = responses.filter((x) => x.leaks.length);
  const out = { server: SERVER, checks: results, responses: responses.length, leakyResponses };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(58)} ${r.detail}${r.leaks.length ? "  LEAKS: " + r.leaks.join(" ") : ""}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks pass; ${responses.length} responses scanned, ${leakyResponses.length} leaked hidden fields`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
