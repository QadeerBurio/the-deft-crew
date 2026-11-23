// Phase A (owner): admin replies never carry push tokens, ID-card / document images, webhook or store secrets,
// passwords or one-time codes, unless the caller has the permission that needs them (utils/safeRecord.js, applied to
// every mapped admin route by middleware/adminAccess.js).
//   every mapped admin GET route is called with records full of sentinel values (students, a brand, an employer):
//   - an admin today: no secret sentinel anywhere (ID cards and full contact details: allowed, as before)
//   - a member with students.view / brands.view / employers.view, enforced: no secret, no ID card, phone and e-mail
//     masked; with students.verify too: ID cards on that route
//   - the helper itself: any depth, Mongoose documents, the reply envelope ({ success, data }) untouched
//   node tests/admin-safe-fields/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["AdminAccessShadow", "AdminActionLog", "OtpCode"] });
const { check, oid, user, token, fake, coll, rows, reqS, SERVER } = h;
process.env.MONGO_URI = process.env.BACKEND_MONGO_URI = "mongodb://127.0.0.1:9/safe-fields";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-only";
const quiet = { log: console.log, error: console.error };
console.log = (...a) => { const s = a.join(" "); if (/^(PASS|FAIL) {2}|^\n?\d+\/\d+ passed/.test(s)) quiet.log(...a); }; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };
const say = (...a) => quiet.log(...a);

const express = reqS("express");
const src = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
const mounts = [...src.matchAll(/app\.use\(\s*["'](\/api[^"']*)["']\s*,\s*require\(["']([^"']+)["']\)/g)].map((m) => [m[1], m[2]]);
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } });
app.use(express.json());
const routes = [];
for (const [mount, file] of mounts) {
  let router; try { router = reqS(file); } catch { continue; }
  if (!router || !router.stack) continue;
  app.use(mount, router);
  for (const layer of router.stack) {
    if (!layer.route || !layer.route.methods.get) continue;
    const tag = layer.route.stack.map((l) => l.handle).find((f) => f.permission && !f.inline);
    if (tag) routes.push({ mount, path: layer.route.path, permission: tag.permission });
  }
}

const SENT = { pw: "SENTINEL_PASSWORD", push: "SENTINEL_PUSHTOKEN", hook: "SENTINEL_WEBHOOK", shop: "SENTINEL_SHOPIFY", woo: "SENTINEL_WOO", otp: "SENTINEL_OTP", id: "SENTINEL_IDCARD", live: "SENTINEL_LIVEPIC", phone: "03001112233" };
const SECRET_VALUES = [SENT.pw, SENT.push, SENT.hook, SENT.shop, SENT.woo, SENT.otp];
const secrets = { password: `$2a$04$${SENT.pw}`, pushTokens: [{ token: `ExponentPushToken[${SENT.push}]`, channels: "snd_v2" }], webhookSecret: SENT.hook, shopifyAccessToken: SENT.shop, shopifyWebhookSecret: SENT.hook, wooConsumerSecret: SENT.woo, wooConsumerKey: SENT.woo, idCardFront: `https://img/${SENT.id}_f.jpg`, idCardBack: `https://img/${SENT.id}_b.jpg`, livePicture: `https://img/${SENT.live}.jpg`, phone: SENT.phone };
const ST = oid(); const BR = oid(); const EM = oid(); const A = oid(); const M = oid(); const MV = oid();
fake.seed(coll("User"), [
  user(ST, "student", "Sana Student", { ...secrets, status: "Pending" }),
  user(BR, "brand", "Brand Co", { ...secrets, brandName: "Brand Co", brandApprovalStatus: "pending" }),
  user(EM, "employee", "Emp Loyer", { ...secrets, companyName: "Hire Co" }),
  user(A, "admin", "Ada Admin"),
  user(M, "admin", "Mo Member", { adminAccess: { level: "member", status: "active", permissions: ["students.view", "brands.view", "employers.view", "analytics.view", "crew.view", "safety.view", "audit.view", "dashboard.view"] } }),
  user(MV, "admin", "Vi Verifier", { adminAccess: { level: "member", status: "active", permissions: ["students.view", "students.verify"] } }),
]);
fake.seed(coll("OtpCode"), [{ _id: oid(), user: ST, purpose: "signup-verify", codeHash: SENT.otp, expiresAt: new Date(Date.now() + 3600e3), createdAt: new Date() }]);
const T = { A: token(A, "admin"), M: token(M, "admin"), MV: token(MV, "admin") };
const fill = (p) => p.replace(/:([A-Za-z_]+)/g, (_, n) => (/brand/i.test(n) ? String(BR) : /employer/i.test(n) ? String(EM) : n === "role" ? "student" : n === "status" ? "pending" : String(ST)));

(async () => {
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const get = (url, tok) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: url, headers: { authorization: `Bearer ${tok}` }, timeout: 5000 }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); });
    req.on("timeout", () => { req.destroy(); resolve({ status: "timeout", text: "" }); }); req.on("error", () => resolve({ status: "error", text: "" })); req.end();
  });
  const extra = ["/api/admin/users/brand", "/api/admin/users/employee", "/api/admin/users/credentials/brand", "/api/admin/users/credentials/employee"];
  const urls = [...routes.map((r) => ({ url: r.mount + fill(r.path), permission: r.permission })), ...extra.map((u) => ({ url: u, permission: "students.view" }))];
  say(`-- ${urls.length} admin GET routes`);

  say("-- an admin today (every permission but team.manage)");
  let leaks = []; let sawStudent = 0;
  for (const u of urls) {
    const r = await get(u.url, T.A);
    if (r.text.includes("Sana Student") || r.text.includes("Brand Co") || r.text.includes("Hire Co")) sawStudent++;
    const hit = SECRET_VALUES.filter((v) => r.text.includes(v));
    if (hit.length) leaks.push(`${u.url}: ${hit.join(",")}`);
  }
  check(`no secret in any admin reply (passwords, codes, push tokens, webhook / store secrets)`, leaks.length === 0, leaks.join(" | "));
  check(`…the scan reached the seeded records (${sawStudent} replies name them)`, sawStudent >= 8, String(sawStudent));

  say("-- a member, enforced");
  process.env.FLAG_ADMIN_RBAC_ENFORCE = "on";
  leaks = []; let allowed = 0;
  for (const u of urls) {
    const r = await get(u.url, T.M);
    if (r.status === 403) continue;
    allowed++;
    const hit = [...SECRET_VALUES, SENT.id, SENT.live, SENT.phone].filter((v) => r.text.includes(v));
    if (hit.length) leaks.push(`${u.url}: ${hit.join(",")}`);
  }
  check(`member with view permissions: no secret, no ID card / live picture, no full phone (${allowed} routes answered)`, leaks.length === 0 && allowed >= 20, leaks.join(" | ") || String(allowed));
  const details = await get(`/api/admin/users/details/${ST}`, T.M);
  check("…the student's phone shows masked (03••••••33)", details.status === 200 && details.text.includes("03••") && !details.text.includes(SENT.phone), details.text.slice(0, 200));
  const verifier = await get(`/api/admin/users/details/${ST}`, T.MV);
  check("a member with students.verify: no ID cards on a students.view route either (it needs pii.view or the route's own verify permission)", verifier.status === 200 && !verifier.text.includes(SENT.id));
  delete process.env.FLAG_ADMIN_RBAC_ENFORCE;

  say("-- the helper");
  const { safeRecord } = reqS("./utils/safeRecord");
  const User = reqS("./models/User");
  const doc = new User({ name: "X", email: "x@test.local", role: "brand", webhookSecret: "S1", idCardFront: "I1", phone: "03009998877" });
  const out = safeRecord({ success: true, data: [{ user: doc, nested: { pushTokens: [1], otp: "1", ok: 1 } }], count: 1 }, { documents: false, mask: true });
  check("any depth, a Mongoose document, the envelope kept ({ success, data, count })", out.success === true && out.count === 1 && out.data[0].nested.ok === 1 && !("pushTokens" in out.data[0].nested) && !("otp" in out.data[0].nested) && !("webhookSecret" in out.data[0].user) && !("idCardFront" in out.data[0].user) && out.data[0].user.phone === "03•••••••77" && out.data[0].user.email === "x••@test.local", JSON.stringify(out).slice(0, 300));
  const keep = safeRecord({ idCardFront: "I1", phone: "0300", when: new Date(0), id: oid() }, { documents: true, mask: false });
  check("with the permission: documents and contact details kept; dates and ids untouched", keep.idCardFront === "I1" && keep.phone === "0300" && keep.when instanceof Date && keep.id._bsontype);
  server.close();
  h.finish({ close() {} });
})().catch((e) => { quiet.error(e); process.exit(1); });
