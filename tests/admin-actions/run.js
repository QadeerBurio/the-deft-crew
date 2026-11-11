// The unified admin action log (models/AdminActionLog.js, services/adminActionLog.js, /api/admin/actions):
// append-only, scrubbed summaries, admin-only reads with filters and paging, and the existing admin writes
// (loyalty update / restart / reversal) logging themselves without ever failing the action.
//   node tests/admin-actions/run.js [serverDir]
// Same harness as tests/loyalty: real routes, models and services; fake MongoDB; no database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

class Expo {
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

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Offer", "Branch", "DomainEvent", "RedemptionGuard", "LoyaltyProgram", "LoyaltyLedger", "LoyaltySnapshot", "LoyaltyProgramRestart", "AdminActionLog"]) reqS(`./models/${m}`);
const AdminActionLog = reqS("./models/AdminActionLog");
const adminLog = reqS("./services/adminActionLog");
const loyalty = reqS("./services/loyalty");

const responses = [];
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/admin/actions", reqS("./routes/adminActions.routes"));
app.use("/api/loyalty", reqS("./routes/loyalty.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "S", "admin", "admin2", "oA"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [user(ids.A, "brand", "brandA", { brandName: "Alpha Cafe", brandApprovalStatus: "approved" }), user(ids.S, "student", "sana"), user(ids.admin, "admin", "Ayesha Admin"), user(ids.admin2, "admin", "Bilal Admin")]);
fake.seed(coll("Offer"), [{ _id: ids.oA, brand: ids.A, title: "Alpha 20%", discountPercentage: 20, isInStore: true, claimedBy: [], redemptions: [], createdAt: new Date() }]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

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
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const logRows = (f = () => true) => rows("AdminActionLog", f);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { A: token("A", "brand"), S: token("S", "student"), admin: token("admin", "admin"), admin2: token("admin2", "admin") };

  console.log("── 1. the service: required fields, scrubbed summaries");
  let threw = null;
  try { await adminLog.record({ action: "x.y", targetType: "T", targetId: "1" }); } catch (e) { threw = e.message; }
  check("record without an admin id throws", /admin id is required/.test(threw || ""), threw);
  threw = null;
  try { await adminLog.record({ adminId: ids.admin, targetType: "T", targetId: "1" }); } catch (e) { threw = e.message; }
  check("record without an action throws", /action is required/.test(threw || ""), threw);
  check("recordSafe never throws (bad entry → null, logged)", (await adminLog.recordSafe({ action: "x" })) === null);
  const s = adminLog.summarize({
    status: "active", tiers: [{ name: "Member", minVisit: 1, discountPct: 15 }], tierName: "Regular", companyName: "Hire Co",
    email: "a@b.co", phone: "0300 1234567", password: "x", token: "t", address: "House 1", fullName: "Sana Khan", studentName: "Sana",
    nested: { webhookSecret: "s", apiKey: "k", ok: 1, text: "mail me at sana@example.com or 0300 1234567" }, note: "private", comment: "c",
    long: "x".repeat(500), list: Array.from({ length: 30 }, (_, i) => i), when: new Date("2026-11-10T00:00:00Z"), id: ids.S,
  });
  check("summary keeps the plain fields", s.status === "active" && s.tierName === "Regular" && s.companyName === "Hire Co" && s.nested.ok === 1 && s.when === "2026-11-10T00:00:00.000Z" && s.id === String(ids.S));
  check("summary drops contact details, secrets, personal names, notes and comments", ["email", "phone", "password", "token", "address", "fullName", "studentName", "note", "comment"].every((k) => !(k in s)) && !("webhookSecret" in s.nested) && !("apiKey" in s.nested) && !("name" in s.tiers[0]), JSON.stringify(Object.keys(s)));
  check("…e-mails and phone numbers inside text are cut out", s.nested.text === "mail me at [email] or [number]", s.nested.text);
  check("…long text and long lists are capped", s.long.length === 201 && s.list.length === 21 && s.list[20] === "+10 more");

  console.log("── 2. append-only");
  const row = await adminLog.record({ adminId: ids.admin, action: "test.write", targetType: "Thing", targetId: "t1", before: { a: 1 }, after: { a: 2 }, reason: "testing, call 0300 1234567", requestId: "r1" });
  check("a row is written with admin, action, target, before/after, reason, time", logRows().length === 1 && row.action === "test.write" && row.before.a === 1 && row.after.a === 2 && row.at instanceof Date && String(row.admin) === String(ids.admin));
  check("…the reason keeps the admin's words, numbers cut out", row.reason === "testing, call [number]", row.reason);
  const attempts = [
    ["updateOne", () => AdminActionLog.updateOne({ _id: row._id }, { $set: { reason: "changed" } })],
    ["findOneAndUpdate", () => AdminActionLog.findOneAndUpdate({ _id: row._id }, { $set: { reason: "changed" } })],
    ["updateMany", () => AdminActionLog.updateMany({}, { $set: { reason: "changed" } })],
    ["deleteOne", () => AdminActionLog.deleteOne({ _id: row._id })],
    ["deleteMany", () => AdminActionLog.deleteMany({})],
    ["findOneAndDelete", () => AdminActionLog.findOneAndDelete({ _id: row._id })],
    ["save an existing row", async () => { const d = await AdminActionLog.findById(row._id); d.reason = "changed"; return d.save(); }],
  ];
  for (const [name, fn] of attempts) {
    let err = null;
    try { await fn(); } catch (e) { err = e.message; }
    check(`append-only: ${name} is refused`, /append-only/.test(err || ""), err);
  }
  check("…the row is unchanged and still there", logRows().length === 1 && logRows()[0].reason === "testing, call [number]");

  console.log("── 3. the read API: admins only, filters, paging, no write routes");
  let r = await call("GET", "/api/admin/actions");
  check("no token → 401", r.status === 401, r.status);
  for (const who of ["S", "A"]) {
    r = await call("GET", "/api/admin/actions", { tok: T[who] });
    check(`${who === "S" ? "a student" : "a brand"} → 403`, r.status === 403 && r.json?.error?.code === "FORBIDDEN", r.status);
  }
  r = await call("GET", "/api/admin/actions/facets", { tok: T.S });
  check("facets: a student → 403", r.status === 403, r.status);
  for (const [m, u] of [["POST", "/api/admin/actions"], ["PATCH", `/api/admin/actions/${row._id}`], ["DELETE", `/api/admin/actions/${row._id}`], ["PUT", `/api/admin/actions/${row._id}`]]) {
    r = await call(m, u, { tok: T.admin, body: { reason: "x" } });
    check(`${m} ${u.replace(/[0-9a-f]{24}/, ":id")} doesn't exist (404)`, r.status === 404, r.status);
  }
  check("…and nothing changed", logRows().length === 1 && logRows()[0].reason === "testing, call [number]");
  // more rows: two admins, several actions and targets, spread over time
  const base = Date.parse("2026-11-01T00:00:00Z");
  for (let i = 0; i < 12; i++) {
    await adminLog.record({ adminId: i % 3 === 0 ? ids.admin2 : ids.admin, action: i % 2 ? "loyalty.program.update" : "surplus.case.decide", targetType: i % 2 ? "LoyaltyProgram" : "SurplusSupportCase", targetId: `T${i % 4}`, after: { i }, reason: `reason ${i}`, at: new Date(base + i * 3600e3) });
  }
  r = await call("GET", "/api/admin/actions?limit=5", { tok: T.admin });
  check("admin: newest first, 5 per page, a cursor for more", r.status === 200 && r.json.data.rows.length === 5 && r.json.data.next && new Date(r.json.data.rows[0].at) >= new Date(r.json.data.rows[4].at), r.text.slice(0, 160));
  check("…rows carry admin id + name, action, target, before/after, reason", ["id", "at", "admin", "action", "targetType", "targetId", "before", "after", "reason"].every((k) => k in r.json.data.rows[0]) && r.json.data.rows[0].admin.name.endsWith("Admin"));
  const seen = new Set(r.json.data.rows.map((x) => x.id));
  let next = r.json.data.next, pages = 1;
  while (next && pages < 10) {
    r = await call("GET", `/api/admin/actions?limit=5&before=${next}`, { tok: T.admin });
    r.json.data.rows.forEach((x) => seen.add(x.id));
    next = r.json.data.next; pages++;
  }
  check("paging walks every row once (13 rows, 3 pages)", seen.size === 13 && pages === 3, `${seen.size} rows, ${pages} pages`);
  r = await call("GET", `/api/admin/actions?adminId=${ids.admin2}`, { tok: T.admin });
  check("filter by admin", r.json.data.rows.length === 4 && r.json.data.rows.every((x) => x.admin.id === String(ids.admin2)), r.json.data.rows.length);
  r = await call("GET", "/api/admin/actions?action=loyalty.program.update", { tok: T.admin });
  check("filter by action", r.json.data.rows.length === 6 && r.json.data.rows.every((x) => x.action === "loyalty.program.update"));
  r = await call("GET", "/api/admin/actions?action=surplus.*", { tok: T.admin });
  check("filter by action prefix (surplus.*)", r.json.data.rows.length === 6 && r.json.data.rows.every((x) => x.action.startsWith("surplus.")));
  r = await call("GET", "/api/admin/actions?targetType=LoyaltyProgram&targetId=T1", { tok: T.admin });
  check("filter by target type and id", r.json.data.rows.length === 3 && r.json.data.rows.every((x) => x.targetId === "T1"));
  r = await call("GET", `/api/admin/actions?from=${new Date(base + 2 * 3600e3).toISOString()}&to=${new Date(base + 5 * 3600e3).toISOString()}`, { tok: T.admin });
  check("filter by time range", r.json.data.rows.length === 4, r.json.data.rows.length);
  r = await call("GET", "/api/admin/actions?adminId=nope&before=nope", { tok: T.admin });
  check("bad ids in filters: empty result, not an error", r.status === 200 && r.json.data.rows.length === 0, r.status);
  r = await call("GET", "/api/admin/actions?action[$ne]=x&targetId[$gt]=", { tok: T.admin });
  check("operator-looking query keys are plain names to the server (no filter applied, no error)", r.status === 200 && r.json.data.rows.length === 13, `${r.status} ${r.json?.data?.rows?.length}`);
  const inj = await adminLog.list({ action: { $ne: "x" }, targetType: { $gt: "" }, targetId: { $exists: true }, adminId: { $ne: null } });
  check("…and the service turns operator objects into text: nothing matches", inj.rows.length === 0, inj.rows.length);
  const inj2 = await adminLog.list({ action: { $ne: "x" } });
  check("…even one at a time (action as an object matches nothing)", inj2.rows.length === 0, inj2.rows.length);
  r = await call("GET", "/api/admin/actions/facets", { tok: T.admin });
  check("facets: actions, target types, admins", r.status === 200 && r.json.data.actions.includes("surplus.case.decide") && r.json.data.targetTypes.includes("LoyaltyProgram") && r.json.data.admins.length === 2, r.text.slice(0, 200));
  check("no e-mail or phone anywhere in the replies", !responses.some((x) => x.url.startsWith("/api/admin/actions") && /@test\.local|0300\s?1234567/.test(x.text)));

  console.log("── 4. existing admin writes log themselves (loyalty)");
  process.env.FLAG_LOYALTY_V2 = `ids:${ids.A},${ids.S}`;
  r = await call("POST", "/api/loyalty/programs", { tok: T.A, body: {} });
  const P = r.json.data.id;
  const before4 = logRows().length;
  r = await call("PATCH", `/api/loyalty/programs/${P}`, { tok: T.A, body: { status: "active", version: 1 } });
  check("a brand's own edit isn't an admin action (not logged)", r.status === 200 && logRows().length === before4);
  r = await call("PATCH", `/api/loyalty/programs/${P}`, { tok: T.admin, body: { adminMaxDiscountPct: 20, reason: "too generous for the pilot" } });
  const l1 = logRows((x) => x.action === "loyalty.program.update")[0 + logRows((x) => x.action === "loyalty.program.update").length - 1];
  check("admin caps the program → logged: changed field before/after, reason", r.status === 200 && l1 && l1.targetType === "LoyaltyProgram" && l1.targetId === P && l1.before.adminMaxDiscountPct === null && l1.after.adminMaxDiscountPct === 20 && l1.reason === "too generous for the pilot" && String(l1.admin) === String(ids.admin), JSON.stringify(l1 && { b: l1.before, a: l1.after }));
  const rid = oid();
  rows("Offer")[0].redemptions.push({ _id: rid, student: ids.S, billAmount: 1000, savedAmount: 150, redeemedAt: new Date(Date.now() - 3 * 864e5) });
  const cr = await loyalty.onVerifiedRedemption(rid, { source: "test" });
  r = await call("POST", "/api/loyalty/admin/reverse", { tok: T.admin, body: { redemptionId: String(rid), reason: "refund: order returned" } });
  const l2 = logRows((x) => x.action === "loyalty.visit.reverse")[0];
  check("admin reversal → logged against the credit, with the reason", r.status === 201 && cr.credited && l2 && l2.targetType === "LoyaltyLedger" && l2.targetId === String(cr.entry._id) && l2.after.counted === false && l2.reason === "refund: order returned", JSON.stringify(l2 && l2.after));
  r = await call("GET", `/api/loyalty/programs/mine`, { tok: T.A });
  await call("PATCH", `/api/loyalty/programs/${P}`, { tok: T.A, body: { status: "ended", version: r.json.data.version } });
  r = await call("GET", `/api/loyalty/programs/mine`, { tok: T.A });
  r = await call("POST", `/api/loyalty/programs/${P}/restart`, { tok: T.admin, body: { version: r.json.data.version, reason: "brand asked by phone" } });
  const l3 = logRows((x) => x.action === "loyalty.program.restart")[0];
  check("admin restart → logged: ended → draft, versions", r.status === 200 && l3 && l3.before.status === "ended" && l3.after.status === "draft" && l3.after.version === l3.before.version + 1 && l3.reason === "brand asked by phone", JSON.stringify(l3 && [l3.before, l3.after]));
  // a logging failure never fails the admin's action
  const realCreate = AdminActionLog.create;
  AdminActionLog.create = async () => { throw new Error("log store down"); };
  r = await call("PATCH", `/api/loyalty/programs/${P}`, { tok: T.admin, body: { adminMaxDiscountPct: 25 } });
  AdminActionLog.create = realCreate;
  check("log store down: the admin's edit still succeeds", r.status === 200 && r.json.data.adminMaxDiscountPct === 25, r.text.slice(0, 120));
  delete process.env.FLAG_LOYALTY_V2;

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
