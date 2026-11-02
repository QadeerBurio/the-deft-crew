// A brand's own WooCommerce store: connect (wc-auth and manual), status, test, disconnect, coupons, the
// native order webhook, admin payloads and the platform migration.
//   node tests/brand-online-store/run.js [serverDir]
// Real routes, models and services; MongoDB is tests/hide-user-secrets/fake-mongo.js, DNS and HTTPS are a
// fake WooCommerce store answered in-process (shop.example), e-mail and Expo are stubbed. No database, no
// network, no .env (dotenv is stubbed; run it from a folder without one).
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "STORE_CONNECT_RATE_LIMIT", "STORE_CALLBACK_RATE_LIMIT", "STORE_WEBHOOK_RATE_LIMIT"]) delete process.env[k];
process.env.STORE_CONNECT_ENABLED = "true";
process.env.STORE_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
process.env.PUBLIC_BASE_URL = "https://api.test";
process.env.BRAND_PORTAL_URL = "https://portal.test";

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

// ---------- fake DNS: public, private and unknown hosts ----------
const dns = require("dns");
const HOSTS = { "shop.example": "93.184.216.34", "brandc.example": "93.184.216.36", "notwoo.example": "93.184.216.35", "evil.example": "10.0.0.5", "metadata.example": "169.254.169.254", "mixed.example": ["93.184.216.40", "127.0.0.1"] };
dns.promises.lookup = async (host) => {
  const v = HOSTS[host];
  if (!v) { const e = new Error("ENOTFOUND"); e.code = "ENOTFOUND"; throw e; }
  return (Array.isArray(v) ? v : [v]).map((address) => ({ address, family: 4 }));
};

// ---------- fake WooCommerce stores (one per host) ----------
const stores = {};
const mkStore = (host) => (stores[host] = { keys: new Map(), coupons: new Map(), webhooks: new Map(), orders: new Map(), nextId: 100, calls: [] });
mkStore("shop.example"); mkStore("brandc.example");
const axios = reqS("axios");
const unsafeCalls = [];
const blocked = (m) => async (url) => { throw new Error(`network blocked in test: ${m} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => {
  const u = new URL(cfg.url);
  if (!cfg.httpsAgent || cfg.maxRedirects !== 0 || cfg.proxy !== false) unsafeCalls.push(cfg.url);
  if (u.hostname === "notwoo.example") return { status: 200, data: { namespaces: ["wp/v2"] } };
  const st = stores[u.hostname];
  if (!st) throw new Error("connect ECONNREFUSED");
  const method = String(cfg.method || "GET").toUpperCase();
  st.calls.push({ method, path: u.pathname, params: cfg.params, data: cfg.data });
  if (u.pathname === "/wp-json/" || u.pathname === "/wp-json") return { status: 200, data: { namespaces: ["wp/v2", "wc/v3"] } };
  const okAuth = cfg.auth && st.keys.get(cfg.auth.username) === cfg.auth.password;
  if (!okAuth) return { status: 401, data: { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." } };
  const p = u.pathname.replace("/wp-json/wc/v3", "");
  let m;
  if (p === "/coupons" && method === "GET") return { status: 200, data: [...st.coupons.values()].slice(0, 1) };
  if (p === "/coupons" && method === "POST") { const id = st.nextId++; st.coupons.set(String(id), { id, ...cfg.data }); return { status: 201, data: { id, code: cfg.data.code } }; }
  if ((m = p.match(/^\/coupons\/(\d+)$/)) && method === "DELETE") { const had = st.coupons.delete(m[1]); return { status: had ? 200 : 404, data: {} }; }
  if (p === "/webhooks" && method === "POST") { const id = st.nextId++; st.webhooks.set(String(id), { id, status: "active", ...cfg.data }); return { status: 201, data: { id } }; }
  if ((m = p.match(/^\/webhooks\/(\d+)$/)) && method === "GET") { const w = st.webhooks.get(m[1]); return w ? { status: 200, data: w } : { status: 404, data: {} }; }
  if ((m = p.match(/^\/webhooks\/(\d+)$/)) && method === "DELETE") { const had = st.webhooks.delete(m[1]); return { status: had ? 200 : 404, data: {} }; }
  if ((m = p.match(/^\/orders\/(\d+)$/)) && method === "GET") { const o = st.orders.get(m[1]); return o ? { status: 200, data: o } : { status: 404, data: {} }; }
  return { status: 404, data: {} };
};
const KEY = (ch) => "ck_" + ch.repeat(40), SEC = (ch) => "cs_" + ch.repeat(40);
stores["shop.example"].keys.set(KEY("a"), SEC("a"));
stores["brandc.example"].keys.set(KEY("c"), SEC("c"));

// capture logs (no key or secret may be printed)
const logLines = [];
for (const k of ["log", "warn", "error", "info"]) {
  const orig = console[k];
  console[k] = (...a) => { logLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); if (process.env.SHOW_LOGS) orig(...a); };
}

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const box = reqS("./utils/secretBox");
const migration = reqS("./scripts/migrate-store-platform");

const responses = [];
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json({ limit: "5mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/brand/store", reqS("./routes/brandStore.routes"));
app.use("/api/webhooks/woocommerce", reqS("./routes/storeWebhook.routes"));
app.use("/api/promo-codes", reqS("./routes/promoCode.routes"));
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/brand-approval", reqS("./routes/brandApproval.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["B", "C", "S", "admin", "oB1", "oB2", "oB3", "oC1", "M1", "M2", "M3", "M4"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("users", [
  user(ids.B, "brand", "brandb", { brandName: "Bistro" }),
  user(ids.C, "brand", "brandc", { brandName: "Cafe C" }),
  user(ids.S, "student", "sana"),
  user(ids.admin, "admin", "admin"),
]);
const offer = (id, brand, extra = {}) => ({ _id: id, brand, title: "deal", discountPercentage: 20, category: "Cafe & Coffee", isOnline: true, isInStore: false, claimedBy: [ids.S], redemptions: [], promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed("offers", [offer(ids.oB1, ids.B), offer(ids.oB2, ids.B), offer(ids.oB3, ids.B), offer(ids.oC1, ids.C)]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok, headers = {}, raw, form } = {}) {
  return new Promise((resolve) => {
    const data = raw != null ? raw : form != null ? form : body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data != null) { h["content-type"] = h["content-type"] || (form != null ? "application/x-www-form-urlencoded" : "application/json"); h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const out = [];
const check = (name, ok, detail = "") => { results.push(!!ok); out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (coll, f = () => true) => (fake.STORE.get(coll) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const conn = (brand) => rows("brandstoreconnections", (c) => same(c.brand, brand))[0];
const userDoc = (id) => rows("users", (u) => same(u._id, id))[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (secret, rawBody) => crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
const plainKeyAnywhere = () => [...fake.STORE].filter(([n]) => n !== "platformmigrationlogs").filter(([, docs]) => /c[ks]_[a-f0-9]{40}/.test(JSON.stringify(docs))).map(([n]) => n);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const B = token("B", "brand"), C = token("C", "brand"), S = token("S", "student"), ADMIN = token("admin", "admin");

  // ── access and switch
  let r = await call("GET", "/api/brand/store", { tok: B });
  check("status: brand sees enabled, not connected", r.status === 200 && r.json.enabled === true && r.json.connection === null && r.json.onlineOffers === 3, r.text);
  r = await call("GET", "/api/brand/store", { tok: S });
  check("status: a student → 403", r.status === 403);
  r = await call("POST", "/api/brand/store/woocommerce/start", { body: { storeUrl: "https://shop.example" } });
  check("start: no login → refused", r.status === 401 || r.status === 403, r.status);
  process.env.STORE_CONNECT_ENABLED = "false";
  r = await call("POST", "/api/brand/store/woocommerce/start", { tok: B, body: { storeUrl: "https://shop.example" } });
  check("STORE_CONNECT_ENABLED off → 503", r.status === 503, r.status);
  r = await call("GET", "/api/brand/store", { tok: B });
  check("…and status says enabled: false", r.json?.enabled === false);
  process.env.STORE_CONNECT_ENABLED = "true";

  // ── address checks (nothing stored)
  for (const [url, why] of [["http://shop.example", "http"], ["https://evil.example", "private address"], ["https://metadata.example", "metadata address"], ["https://mixed.example", "one private answer"], ["https://10.0.0.5", "IP literal"], ["https://localhost", "localhost"], ["https://user:pw@shop.example", "credentials in URL"], ["https://shop.example:8443", "other port"], ["https://nowhere.example", "unknown host"], ["https://notwoo.example", "no WooCommerce"]]) {
    r = await call("POST", "/api/brand/store/woocommerce/start", { tok: B, body: { storeUrl: url } });
    check(`start refused: ${why}`, r.status === 400 && r.json?.message && !conn(ids.B), `${r.status} ${r.json?.message}`);
  }
  check("no request ever reached a private address", stores["shop.example"].calls.length === 0);

  // ── wc-auth connect
  r = await call("POST", "/api/brand/store/woocommerce/start", { tok: B, body: { storeUrl: "https://shop.example/" } });
  const auth = r.json?.authorizeUrl ? new URL(r.json.authorizeUrl) : null;
  check("start: authorize URL on the store, read_write, our callback and portal return", !!auth && auth.origin === "https://shop.example" && auth.pathname === "/wc-auth/v1/authorize" && auth.searchParams.get("scope") === "read_write" && auth.searchParams.get("callback_url") === "https://api.test/api/brand/store/woocommerce/callback" && auth.searchParams.get("return_url") === "https://portal.test/settings?store=woocommerce", r.json?.authorizeUrl);
  const state = auth?.searchParams.get("user_id") || "";
  check("pending connection, state stored only as a hash", conn(ids.B)?.status === "pending" && conn(ids.B).stateHash && !JSON.stringify(conn(ids.B)).includes(state.split(".")[1]));
  const cb = (body) => call("POST", "/api/brand/store/woocommerce/callback", { body });
  const goodKeys = { key_id: 7, consumer_key: KEY("a"), consumer_secret: SEC("a"), key_permissions: "read_write" };
  r = await cb({ ...goodKeys, user_id: state.split(".")[0] + "." + "0".repeat(48) });
  check("callback with a wrong state → 400, nothing stored", r.status === 400 && !conn(ids.B).keyEnc);
  r = await cb({ ...goodKeys, user_id: state, key_permissions: "read" });
  check("callback with read-only keys → 400", r.status === 400 && !conn(ids.B).keyEnc);
  r = await cb({ ...goodKeys, user_id: state, consumer_key: "ck_short" });
  check("callback with a malformed key → 400", r.status === 400);
  r = await cb({ ...goodKeys, user_id: state });
  check("callback with the right state → 200", r.status === 200 && r.json?.success === true, r.text);
  r = await cb({ ...goodKeys, user_id: state });
  check("the same callback again (replay) → 400", r.status === 400);
  for (let i = 0; i < 40 && conn(ids.B)?.status === "pending"; i++) await sleep(25);
  const cB = conn(ids.B);
  check("after the callback: connected, keys sealed, webhook added", cB.status === "connected" && cB.keyEnc.startsWith("v1:") && box.open(cB.keyEnc) === KEY("a") && cB.webhookStatus === "active" && cB.wcKeyId === 7, `${cB.status} ${cB.lastError}`);
  const hook = [...stores["shop.example"].webhooks.values()][0];
  check("webhook on the store: order.updated → our URL for this connection, with a secret", hook && hook.topic === "order.updated" && hook.delivery_url === `https://api.test/api/webhooks/woocommerce/${cB._id}` && hook.secret && box.open(cB.webhookSecretEnc) === hook.secret);
  check("brand platform is now woocommerce", userDoc(ids.B).platform === "woocommerce");
  r = await call("GET", "/api/brand/store", { tok: B });
  check("status: connected, store URL, no key fields", r.json?.connection?.status === "connected" && r.json.connection.storeUrl === "https://shop.example" && !/keyEnc|secretEnc|webhookSecret|stateHash|ck_|cs_|v1:/.test(r.text), r.text);
  r = await call("POST", "/api/brand/store/woocommerce/start", { tok: B, body: { storeUrl: "https://shop.example" } });
  check("start again while connected → 409", r.status === 409);
  check("every store request: pinned agent, no redirects, no proxy", unsafeCalls.length === 0, unsafeCalls.join());

  // ── coupons
  r = await call("POST", "/api/promo-codes/generate", { tok: S, body: { offerId: String(ids.oB1) } });
  const codeB1 = r.json?.promoCode?.code;
  const coupon = [...stores["shop.example"].coupons.values()].find((c) => c.code === codeB1);
  check("code at a connected brand: a real single-use 20% coupon on the store", r.status === 200 && coupon && coupon.discount_type === "percent" && coupon.amount === "20" && coupon.usage_limit === 1 && coupon.individual_use === true, r.text);
  const pB1 = rows("promocodes", (p) => p.code === codeB1)[0];
  check("promo code remembers the coupon id", pB1.externalProvider === "woocommerce" && pB1.externalDiscountId === String(coupon?.id));
  check("onlineStore for the student: connected, store URL", JSON.stringify(r.json?.promoCode?.onlineStore) === JSON.stringify({ platform: "woocommerce", storeUrl: "https://shop.example", connected: true }), JSON.stringify(r.json?.promoCode?.onlineStore));
  r = await call("POST", "/api/promo-codes/generate", { tok: S, body: { offerId: String(ids.oC1) } });
  check("brand without a store: online code still issued (manual check), onlineStore not connected", r.status === 200 && r.json?.promoCode?.externalProvider === "none" && JSON.stringify(r.json.promoCode.onlineStore) === JSON.stringify({ platform: "none", storeUrl: "", connected: false }), r.text);
  r = await call("GET", "/api/promo-codes/my-codes", { tok: S });
  const mine = r.json?.promoCodes || [];
  check("my-codes: onlineStore on every code", mine.length === 2 && mine.every((x) => x.onlineStore) && mine.find((x) => x.code === codeB1).onlineStore.connected === true, JSON.stringify(mine.map((x) => x.onlineStore)));
  r = await call("POST", "/api/promo-codes/generate", { tok: S, body: { offerId: String(ids.oB2) } });
  const codeB2 = r.json?.promoCode?.code;
  const idB2 = rows("promocodes", (p) => p.code === codeB2)[0]._id;
  r = await call("POST", `/api/promo-codes/cancel/${idB2}`, { tok: S });
  check("cancelling a code deletes its coupon on the store", r.status === 200 && ![...stores["shop.example"].coupons.values()].some((c) => c.code === codeB2), r.text);

  // ── native order webhook
  const hookUrl = `/api/webhooks/woocommerce/${cB._id}`;
  stores["shop.example"].orders.set("501", { id: 501, status: "completed", total: "1600.00", coupon_lines: [{ code: codeB1.toLowerCase(), discount: "400.00" }] });
  const orderBody = JSON.stringify({ id: 501, status: "completed", total: "99999", coupon_lines: [{ code: codeB1, discount: "1" }] });
  r = await call("POST", hookUrl, { form: "webhook_id=55" });
  check("WooCommerce's form ping on webhook creation → 200", r.status === 200 && r.json?.ping === true);
  r = await call("POST", hookUrl, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated" } });
  check("order webhook without a signature → 401, code still active", r.status === 401 && rows("promocodes", (p) => p.code === codeB1)[0].status === "active");
  r = await call("POST", hookUrl, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64("wrong", orderBody) } });
  check("wrong signature → 401", r.status === 401);
  r = await call("POST", `/api/webhooks/woocommerce/${oid()}`, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64(hook.secret, orderBody) } });
  check("unknown connection → 401", r.status === 401);
  r = await call("POST", hookUrl, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64(hook.secret, orderBody) } });
  const used = rows("promocodes", (p) => p.code === codeB1)[0];
  check("signed order → counted from the store's order (1600 + 400 = 2000), not the body's 99999", r.status === 200 && r.json?.counted === 1 && used.status === "used" && used.externalAmount === 2000 && used.externalOrderId === "501", r.text);
  check("one redemption on the offer, saving 20% of 2000", rows("offers", (o) => same(o._id, ids.oB1))[0].redemptions.length === 1 && rows("offers", (o) => same(o._id, ids.oB1))[0].redemptions[0].savedAmount === 400);
  r = await call("POST", hookUrl, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64(hook.secret, orderBody) } });
  check("the same order again → counted 0, still one redemption", r.json?.counted === 0 && rows("offers", (o) => same(o._id, ids.oB1))[0].redemptions.length === 1, r.text);
  r = await call("POST", "/api/promo-codes/generate", { tok: S, body: { offerId: String(ids.oB3) } });
  const codeB3 = r.json?.promoCode?.code;
  stores["shop.example"].orders.set("502", { id: 502, status: "pending", total: "500", coupon_lines: [{ code: codeB3, discount: "100" }] });
  const pendingBody = JSON.stringify({ id: 502, status: "completed", coupon_lines: [{ code: codeB3 }] });
  r = await call("POST", hookUrl, { raw: pendingBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64(hook.secret, pendingBody) } });
  check("body says completed but the store says pending → not counted", r.status === 200 && r.json?.counted === 0 && rows("promocodes", (p) => p.code === codeB3)[0].status === "active", r.text);
  const otherTopic = JSON.stringify({ id: 9 });
  r = await call("POST", hookUrl, { raw: otherTopic, headers: { "x-wc-webhook-topic": "product.updated", "x-wc-webhook-signature": b64(hook.secret, otherTopic) } });
  check("other topics → 200 ignored", r.status === 200 && r.json?.ignored === "topic");

  // ── test connection: keys revoked, then back
  stores["shop.example"].keys.delete(KEY("a"));
  r = await call("POST", "/api/brand/store/test", { tok: B });
  check("revoked keys → test says error with a clear message, platform none", r.json?.success === false && r.json?.connection?.status === "error" && /rejected the keys/.test(r.json.connection.lastError) && userDoc(ids.B).platform === "none", r.text);
  stores["shop.example"].keys.set(KEY("a"), SEC("a"));
  stores["shop.example"].webhooks.clear();
  r = await call("POST", "/api/brand/store/test", { tok: B });
  check("keys back, webhook removed on the store → test reconnects and re-adds the webhook", r.json?.success === true && r.json.connection.status === "connected" && stores["shop.example"].webhooks.size === 1 && userDoc(ids.B).platform === "woocommerce", r.text);

  // ── manual keys (brand C)
  r = await call("POST", "/api/brand/store/woocommerce/manual", { tok: C, body: { storeUrl: "https://brandc.example", consumerKey: "abc", consumerSecret: "def" } });
  check("manual: malformed keys → 400", r.status === 400);
  r = await call("POST", "/api/brand/store/woocommerce/manual", { tok: C, body: { storeUrl: "https://brandc.example", consumerKey: KEY("d"), consumerSecret: SEC("d") } });
  check("manual: keys the store rejects → 400, nothing stored", r.status === 400 && /rejected the keys/.test(r.json?.message) && !conn(ids.C), r.text);
  r = await call("POST", "/api/brand/store/woocommerce/manual", { tok: C, body: { storeUrl: "https://brandc.example", consumerKey: KEY("c"), consumerSecret: SEC("c") } });
  check("manual: working keys → connected, webhook added, platform woocommerce", r.status === 200 && conn(ids.C)?.status === "connected" && conn(ids.C).connectMethod === "manual" && stores["brandc.example"].webhooks.size === 1 && userDoc(ids.C).platform === "woocommerce", r.text);

  // ── admin payloads
  r = await call("GET", "/api/brand-approval", { tok: ADMIN });
  const bB = r.json?.brands?.find((x) => same(x._id, ids.B)), bC = r.json?.brands?.find((x) => same(x._id, ids.C));
  check("Brand Approvals list: real platform and status per brand", bB?.onlineStore?.platform === "woocommerce" && bB.onlineStore.status === "connected" && bC?.onlineStore?.platform === "woocommerce", JSON.stringify([bB?.onlineStore, bC?.onlineStore]));
  r = await call("GET", "/api/offers/admin/brands-revenue", { tok: ADMIN });
  const rB = r.json?.brands?.find((x) => same(x._id, ids.B));
  check("All Brands Revenue: platform from the real connection", rB?.platform === "woocommerce" && rB.onlineStore?.status === "connected", JSON.stringify(rB?.onlineStore));

  // ── disconnect
  r = await call("DELETE", "/api/brand/store", { tok: B });
  const cB2 = conn(ids.B);
  check("disconnect: webhook removed from the store, keys forgotten, platform none", r.status === 200 && r.json?.webhookRemoved === true && stores["shop.example"].webhooks.size === 0 && !cB2.keyEnc && !cB2.secretEnc && !cB2.webhookSecretEnc && cB2.status === "disconnected" && userDoc(ids.B).platform === "none", r.text);
  check("disconnect reply tells the brand to delete the key in WooCommerce", /REST API/.test(r.json?.message || ""));
  r = await call("DELETE", "/api/brand/store", { tok: B });
  check("disconnect again → 404", r.status === 404);
  r = await call("POST", hookUrl, { raw: orderBody, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": b64(hook.secret, orderBody) } });
  check("webhook for a disconnected store → 401", r.status === 401);
  fake.STORE.get("promocodes").filter((p) => same(p.brand, ids.B) && p.status === "active").forEach((p) => (p.status = "cancelled"));
  r = await call("POST", "/api/promo-codes/generate", { tok: S, body: { offerId: String(ids.oB3) } });
  check("after disconnect: codes are plain tdc codes again (show it to the brand)", r.status === 200 && r.json?.promoCode?.onlineStore?.connected === false && r.json.promoCode.externalProvider === "none", r.text);

  // ── migration: dry run, apply, reverse
  stores["shop.example"].keys.set(KEY("e"), SEC("e"));
  fake.seed("users", [
    user(ids.M1, "brand", "m1", { brandName: "No Store" }), // no platform stored at all
    user(ids.M2, "brand", "m2", { brandName: "Works", platform: "woocommerce", websiteUrl: "https://shop.example", wooConsumerKey: KEY("e"), wooConsumerSecret: SEC("e"), webhookSecret: "whsec_old" }),
    user(ids.M3, "brand", "m3", { brandName: "Broken", platform: "woocommerce", websiteUrl: "https://shop.example", wooConsumerKey: KEY("f"), wooConsumerSecret: SEC("f") }),
    user(ids.M4, "brand", "m4", { brandName: "Shopify One", platform: "woocommerce", shopifyStoreUrl: "one.myshopify.com" }),
  ]);
  fake.STORE.get("users").find((u) => same(u._id, ids.M1)).platform = undefined;
  delete fake.STORE.get("users").find((u) => same(u._id, ids.M1)).platform;
  fake.seed("shopifystores", [{ _id: oid(), brandId: ids.M4, shop: "one.myshopify.com", accessToken: "shpat_x", status: "active" }]);
  const snapshot = JSON.stringify([...fake.STORE.entries()].filter(([n]) => n !== "platformmigrationlogs"));
  const said = [];
  const dry = await migration.plan({ mode: "dry-run", say: (l) => said.push(l) });
  check("dry run writes nothing", JSON.stringify([...fake.STORE.entries()].filter(([n]) => n !== "platformmigrationlogs")) === snapshot && !fake.STORE.get("platformmigrationlogs"));
  const want = (id) => dry.rows.find((x) => same(x.id, id))?.after;
  check("dry run: M1 none, M2 woocommerce, M3 none (keys fail), M4 shopify", want(ids.M1) === "none" && want(ids.M2) === "woocommerce" && want(ids.M3) === "none" && want(ids.M4) === "shopify", JSON.stringify(dry.rows.map((x) => [x.name, x.before, x.after])));
  check("dry run output holds no key or secret", !/c[ks]_[a-f0-9]{40}|whsec_old/.test(said.join("\n")), said.join(" | ").slice(0, 200));
  const applied = await migration.plan({ mode: "apply", say: () => {} });
  const m2 = userDoc(ids.M2), m3 = userDoc(ids.M3);
  check("apply: platforms set (M1 none, M2 woocommerce, M3 none, M4 shopify)", userDoc(ids.M1).platform === "none" && m2.platform === "woocommerce" && m3.platform === "none" && userDoc(ids.M4).platform === "shopify", [userDoc(ids.M1).platform, m2.platform, m3.platform, userDoc(ids.M4).platform].join());
  check("apply: M2's keys moved and sealed, connection works with a webhook; plain keys gone from User", conn(ids.M2)?.status === "connected" && box.open(conn(ids.M2).keyEnc) === KEY("e") && !m2.wooConsumerKey && !m2.wooConsumerSecret && !m2.webhookSecret);
  check("apply: M3's failing keys kept sealed with status error (brand can retest)", conn(ids.M3)?.status === "error" && conn(ids.M3).keyEnc.startsWith("v1:") && !m3.wooConsumerKey);
  check("no plain key left anywhere outside the migration log", plainKeyAnywhere().length === 0, plainKeyAnywhere().join());
  const log = rows("platformmigrationlogs");
  check("migration log: one entry per brand, keys in it sealed", log.length === dry.rows.length && log.every((e) => e.runId === applied.runId) && !/c[ks]_[a-f0-9]{40}/.test(JSON.stringify(log)));
  await migration.reverse(applied.runId, { say: () => {} });
  const r1 = userDoc(ids.M1), r2 = userDoc(ids.M2);
  check("reverse: platforms back (M1 not set again, M2 woocommerce), M2 keys back as before, its connection and webhook removed", !("platform" in r1) && r2.platform === "woocommerce" && r2.wooConsumerKey === KEY("e") && r2.webhookSecret === "whsec_old" && !conn(ids.M2) && !conn(ids.M3), JSON.stringify({ m1: r1.platform, m2: r2.platform }));
  check("reverse: log entries marked and their sealed keys dropped", rows("platformmigrationlogs").every((e) => e.reversedAt && !(e.before && e.before.keys)));

  // ── rate limit
  process.env.STORE_CONNECT_RATE_LIMIT = "2";
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call("POST", "/api/brand/store/woocommerce/start", { tok: C, body: { storeUrl: "https://brandc.example" } })).status);
  check("connect attempts are rate limited per brand", codes.includes(429), codes.join(","));
  delete process.env.STORE_CONNECT_RATE_LIMIT;

  // ── leaks
  const leaky = responses.filter((x) => /c[ks]_[a-f0-9]{40}|"v1:|keyEnc|secretEnc|webhookSecretEnc|stateHash|whsec_|shpat_/.test(x.text));
  check(`leak scan: ${responses.length} responses, no key, secret or sealed value`, leaky.length === 0, leaky.map((x) => x.url).join());
  check("no key or secret in any log line", !/c[ks]_[a-f0-9]{40}|whsec_|shpat_/.test(logLines.join("\n")), logLines.filter((l) => /c[ks]_[a-f0-9]{40}/.test(l)).slice(0, 2).join(" | "));

  server.close();
  process.stdout.write(out.join("\n") + "\n");
  const failed = results.filter((x) => !x).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { process.stdout.write("FATAL " + (e.stack || e) + "\n" + out.join("\n") + "\n"); process.exit(2); });
