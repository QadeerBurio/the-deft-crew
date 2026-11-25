// Shopify webhooks (routes/shopifyWebhooks.js, mounted at /webhooks in server.js) and the /api/shopify-app limit:
//   valid signature → 200 (shop/redact removes the shop's record; uninstall; scopes); bad signature → 401; missing header
//   → 401 (no crash); SHOPIFY_API_SECRET missing → 401 and one log line, never a crash; the signature is over the raw
//   bytes (a body with odd spacing passes; a signature of the re-serialised JSON fails); server.js parses JSON with the
//   raw-body hook before it mounts /webhooks; rate limits (webhooks and /api/shopify-app) → 429; the guest-write
//   allowlist no longer has the dead "compliance" entry and still lets the four X-API-KEY routes through
//   node tests/shopify-webhooks/run.js [serverDir]
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const Module = require("module");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));

let pass = 0; let fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  (${extra})`}`); };

// the ShopifyStore model, stubbed (no database)
const storeCalls = [];
const ShopifyStore = {
  deleteMany: async (q) => { storeCalls.push(["deleteMany", q]); return { deletedCount: 1 }; },
  findOneAndUpdate: async (q, u) => { storeCalls.push(["findOneAndUpdate", q, u]); return {}; },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("models", "ShopifyStore.js"))) return ShopifyStore;
  return origLoad.apply(this, arguments);
};

const express = reqS("express");
const SECRET = "test-shopify-secret";
const sign = (raw, secret = SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("base64");

function app() {
  const a = express();
  // exactly as server.js: JSON with the raw bytes kept for signatures
  a.use(express.json({ limit: "5mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
  a.use("/webhooks", reqS("./routes/shopifyWebhooks"));
  a.use("/api/shopify-app", reqS("./middleware/shopifyAppLimit"), (req, res) => res.json({ ok: true }));
  return a;
}
const logs = [];
const realWarn = console.warn; const realLog = console.log;
console.warn = (...a) => logs.push(a.join(" "));
const out = (...a) => realLog(...a);
console.log = (...a) => { const s = a.join(" "); if (/^(PASS|FAIL|\n?\d+\/\d+)/.test(s)) out(s); else logs.push(s); };

function send(port, p, { raw, headers = {} }) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw), ...headers } }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end(raw);
  });
}

(async () => {
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.RATE_LIMIT_SHOPIFY_WEBHOOK_MAX = "1000";
  const server = app().listen(0);
  const port = server.address().port;
  const H = (raw, extra = {}) => ({ "X-Shopify-Hmac-Sha256": sign(raw), "X-Shopify-Shop-Domain": "demo.myshopify.com", ...extra });

  const redact = JSON.stringify({ shop_id: 1, shop_domain: "demo.myshopify.com" });
  let r = await send(port, "/webhooks/compliance", { raw: redact, headers: H(redact, { "X-Shopify-Topic": "shop/redact" }) });
  check("valid signature: 200; shop/redact removes that shop's record", r.status === 200 && storeCalls.some((c) => c[0] === "deleteMany" && c[1].shop === "demo.myshopify.com"), `${r.status} ${JSON.stringify(storeCalls)}`);
  const req2 = JSON.stringify({ shop_domain: "demo.myshopify.com", customer: { id: 7 } });
  r = await send(port, "/webhooks/compliance", { raw: req2, headers: H(req2, { "X-Shopify-Topic": "customers/data_request" }) });
  check("valid customers/data_request: 200 (no customer data kept)", r.status === 200);
  r = await send(port, "/webhooks/compliance", { raw: redact, headers: { ...H(redact), "X-Shopify-Hmac-Sha256": sign(redact, "wrong-secret") } });
  check("bad signature: 401", r.status === 401);
  r = await send(port, "/webhooks/compliance", { raw: redact, headers: { ...H(redact), "X-Shopify-Hmac-Sha256": "c2hvcnQ=" } });
  check("a signature of the wrong length: 401 (no exception)", r.status === 401);
  const noHeader = H(redact); delete noHeader["X-Shopify-Hmac-Sha256"];
  r = await send(port, "/webhooks/compliance", { raw: redact, headers: noHeader });
  check("missing signature header: 401 (no exception)", r.status === 401);

  console.log("-- body-parse order: the signature is over the raw bytes");
  const spaced = '{ "shop_domain" :  "demo.myshopify.com",\n  "shop_id": 1 }';
  r = await send(port, "/webhooks/compliance", { raw: spaced, headers: H(spaced, { "X-Shopify-Topic": "customers/redact" }) });
  check("a body with odd spacing, signed as sent: 200", r.status === 200, String(r.status));
  r = await send(port, "/webhooks/compliance", { raw: spaced, headers: H(JSON.stringify(JSON.parse(spaced)), { "X-Shopify-Topic": "customers/redact" }) });
  check("…a signature of the re-serialised JSON: 401 (the parsed object is never what's signed)", r.status === 401);
  const src = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
  const jsonAt = src.search(/app\.use\(express\.json\(\{[\s\S]{0,120}verify:\s*\(req, res, buf\) => \{\s*req\.rawBody = buf;/);
  const hookAt = src.indexOf('app.use("/webhooks", require("./routes/shopifyWebhooks"))');
  check("server.js: express.json keeps req.rawBody and runs before /webhooks is mounted", jsonAt > -1 && hookAt > jsonAt, `${jsonAt} ${hookAt}`);
  check("server.js: no inline app.post(\"/webhooks/...\") handlers left", !/app\.post\("\/webhooks\/(compliance|app\/)/.test(src));

  console.log("-- the other two webhooks");
  const un = JSON.stringify({ id: 1, domain: "demo.myshopify.com" });
  r = await send(port, "/webhooks/app/uninstalled", { raw: un, headers: H(un) });
  check("app/uninstalled, valid: 200, store marked uninstalled", r.status === 200 && storeCalls.some((c) => c[0] === "findOneAndUpdate" && c[2].status === "uninstalled"));
  r = await send(port, "/webhooks/app/uninstalled", { raw: un, headers: { ...H(un), "X-Shopify-Hmac-Sha256": sign(un, "x") } });
  check("app/uninstalled, bad signature: 401", r.status === 401);
  const sc = JSON.stringify({ id: 1, current: ["read_products", "write_discounts"], previous: ["read_products"] });
  r = await send(port, "/webhooks/app/scopes_update", { raw: sc, headers: H(sc) });
  check("app/scopes_update, valid: 200, scopes stored as a list", r.status === 200 && storeCalls.some((c) => c[0] === "findOneAndUpdate" && JSON.stringify(c[2].scopes) === '["read_products","write_discounts"]'));

  console.log("-- SHOPIFY_API_SECRET missing");
  delete process.env.SHOPIFY_API_SECRET;
  reqS("./routes/shopifyWebhooks")._resetWarned();
  logs.length = 0;
  r = await send(port, "/webhooks/compliance", { raw: redact, headers: H(redact) });
  const r2 = await send(port, "/webhooks/app/uninstalled", { raw: un, headers: H(un) });
  const secretLines = logs.filter((l) => /SHOPIFY_API_SECRET is not set/.test(l)).length;
  check("missing secret: 401 for every webhook, no crash", r.status === 401 && r2.status === 401);
  check("…logged once (not per request)", secretLines === 1, String(secretLines));
  process.env.SHOPIFY_API_SECRET = SECRET;
  server.close();

  console.log("-- rate limits");
  process.env.RATE_LIMIT_SHOPIFY_WEBHOOK_MAX = "3";
  process.env.RATE_LIMIT_SHOPIFY_APP_MAX = "2";
  // fresh copies: the limiters count in memory per module, and the requests above would count too
  for (const m of ["./routes/shopifyWebhooks", "./middleware/shopifyAppLimit"]) delete require.cache[reqS.resolve(m)];
  const s2 = app().listen(0); const p2 = s2.address().port;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await send(p2, "/webhooks/compliance", { raw: redact, headers: H(redact) })).status);
  check("webhooks: the 4th request in a minute (limit 3) → 429", JSON.stringify(codes) === "[200,200,200,429]", JSON.stringify(codes));
  const appCodes = [];
  for (let i = 0; i < 3; i++) appCodes.push((await send(p2, "/api/shopify-app/discount", { raw: "{}" })).status);
  check("/api/shopify-app: the 3rd request in a minute (limit 2) → 429", JSON.stringify(appCodes) === "[200,200,429]", JSON.stringify(appCodes));
  s2.close();

  console.log("-- guest-write allowlist");
  const g = fs.readFileSync(path.join(SERVER, "middleware", "rejectGuestWrites.js"), "utf8");
  const line = (g.match(/\["POST", \/\^\\\/shopify-app[^\n]*/) || [""])[0];
  check("the dead 'compliance' entry is gone; link-shop, link-shop/start, discount, order-webhook stay", line && !/order-webhook\|compliance/.test(line) && /link-shop\|link-shop\\\/start\|discount\|order-webhook\)/.test(line), line);

  console.warn = realWarn;
  console.log = realLog;
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
