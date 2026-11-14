// Admin feature access per account (models/FeatureAccess.js, services/featureAccess.js, /api/admin/features) and how
// it combines with the Railway FLAG_* values (config/featureFlags.js):
//   kill switch beats everything; admin access OR Railway rules; old formats unchanged; admin-only access; a brand
//   can't turn on its own features; reasons required and logged; bulk; the in-memory set and its refresh; the
//   startup line (counts only); account deletion removes the rows.
//   node tests/feature-access/run.js [serverDir]
// Same harness as tests/admin-actions: real routes, models and services; fake MongoDB; no database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "META_EVENTS_ENABLED"]) delete process.env[k];
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
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "", api: { delete_resources: async () => ({}) } }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
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
// these checks are about Railway rules / admin rows: no built-in "on" default (as before features-on-by-default)
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "University", "FeatureAccess", "AdminActionLog", "LoyaltyLedger", "SurplusOrder"]) reqS(`./models/${m}`);
const flags = reqS("./config/featureFlags");
const access = reqS("./services/featureAccess");
const FeatureAccess = reqS("./models/FeatureAccess");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api", access.waitReady);
app.use("/api/admin/features", reqS("./routes/adminFeatures.routes"));
app.use("/api/app", reqS("./routes/appFlags.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["B", "B2", "S", "S2", "S3", "E", "T", "A", "A2", "U", "FORMER"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("University"), [{ _id: ids.U, name: "NED University" }]);
fake.seed(coll("User"), [
  user(ids.B, "brand", "alpha", { brandName: "Alpha Cafe", brandApprovalStatus: "approved" }), user(ids.B2, "brand", "beta", { brandName: "Beta" }),
  user(ids.S, "student", "sana", { university: ids.U }), user(ids.S2, "student", "taha"), user(ids.S3, "student", "zara"),
  user(ids.E, "employee", "hireco"), user(ids.T, "traveler", "tariq"), user(ids.A, "admin", "Ayesha Admin"), user(ids.A2, "admin", "Bilal Admin"),
  user(ids.FORMER, "brand", "former-admin"), // a token still says admin, the database says brand
]);
// sana has used Alpha Cafe's loyalty program
fake.seed(coll("LoyaltyLedger"), [{ _id: oid(), brand: ids.B, student: ids.S, type: "CREDIT", visitsDelta: 1, effectiveAt: new Date(), createdAt: new Date() }]);
const tok = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { body, t } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (t) h.authorization = `Bearer ${t}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const accessRows = (f) => rows("FeatureAccess", f);
const logRows = (f = () => true) => rows("AdminActionLog", f);
const withEnv = (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
// the same for a request: the variable stays set until the reply is in
const withEnvAsync = async (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const on = (flag, who, role) => flags.isEnabled(flag, { id: String(ids[who] || who), role });

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { A: tok("A", "admin"), A2: tok("A2", "admin"), B: tok("B", "brand"), S: tok("S", "student"), E: tok("E", "employee"), FORMER: tok("FORMER", "admin") };
  const S = String(ids.S), B = String(ids.B), X = String(oid());

  console.log("── 1. old Railway formats unchanged, no admin access");
  check("not set → off", !on("loyaltyV2", "S", "student"));
  check("ids list still works (quoted, line breaks)", withEnv({ FLAG_LOYALTY_V2: `"ids:${S}\n${B}"` }, () => on("loyaltyV2", "S", "student") && on("loyaltyV2", "B", "brand") && !on("loyaltyV2", X, "student")));
  check("roles / % / on still work", withEnv({ FLAG_LOYALTY_V2: "roles:brand" }, () => on("loyaltyV2", "B", "brand") && !on("loyaltyV2", "S", "student"))
    && withEnv({ FLAG_LOYALTY_V2: "100%" }, () => on("loyaltyV2", "S", "student")) && withEnv({ FLAG_LOYALTY_V2: "on" }, () => on("loyaltyV2", "S", "student")));
  check("off;ids:X is still on for X (not a kill switch: decision 1)", withEnv({ FLAG_LOYALTY_V2: `off;ids:${S}` }, () => on("loyaltyV2", "S", "student") && !flags.isKilled("loyaltyV2")));
  check("domainEvents (not grantable) keeps its default on", flags.isEnabled("domainEvents"));

  console.log("── 2. the startup load and line (counts only)");
  fake.seed(coll("FeatureAccess"), [{ _id: oid(), account: ids.S2, flag: "surplusBoxes", enabled: true, setBy: ids.A, reason: "seeded", setAt: new Date() },
    { _id: oid(), account: ids.S3, flag: "surplusBoxes", enabled: false, setBy: ids.A, reason: "seeded off", setAt: new Date() }]);
  access.expectLoad();
  let waited = false;
  const early = call("GET", "/api/app/flags/me", { t: tok("S2", "student") }).then((r) => { waited = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  check("an API request waits for the first load", waited === false);
  const logs = []; const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  await access.start({ intervalMs: 60 * 60 * 1000 });
  console.log = origLog;
  const r0 = await early;
  check("…then answers with the loaded access (taha has Surprise Box)", r0.status === 200 && r0.json.surplusBoxes === true && r0.json.loyaltyV2 === false, JSON.stringify(r0.json));
  const line = logs.find((l) => l.startsWith("[flags] admin access:")) || "";
  check("startup line: '[flags] admin access: <flag> <count>, …'", /^\[flags\] admin access: resumeStudioV2 0, careerRatings 0, loyaltyV2 0, careerTimeline 0, careerMatching 0, surplusBoxes 1, employerFirstHireFree 0$/.test(line), line);
  check("…and carries no id", !Object.values(ids).some((i) => line.includes(String(i))));
  check("an enabled:false row gives no access", !on("surplusBoxes", "S3", "student"));

  console.log("── 3. admins only; nobody else can turn a feature on");
  const routes = [
    ["GET", "/api/admin/features/flags"], ["GET", `/api/admin/features/account/${B}`], ["GET", "/api/admin/features/flag/loyaltyV2"],
    ["PUT", `/api/admin/features/account/${B}/loyaltyV2`, { enabled: true, reason: "my own pilot" }],
    ["POST", "/api/admin/features/bulk", { flag: "loyaltyV2", enabled: true, accountIds: [B, S], reason: "my own pilot" }],
  ];
  for (const [m, u, body] of routes) {
    const g = await call(m, u, { body });
    check(`${m} ${u.replace(/[0-9a-f]{24}/g, ":id")}: guest → 401`, g.status === 401, g.status);
    for (const who of ["B", "S", "E", "FORMER"]) {
      const r = await call(m, u, { body, t: T[who] });
      check(`…${who === "FORMER" ? "token says admin, database says brand" : who} → 403`, r.status === 403, r.status);
    }
  }
  check("a brand turning on its own Loyalty wrote nothing: no row, no log, still off", accessRows((r) => String(r.account) === B).length === 0 && logRows().length === 0 && !on("loyaltyV2", "B", "brand"));

  console.log("── 4. one switch: reason, role, log");
  let r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: true }, t: T.A });
  check("no reason → 400 REASON", r.status === 400 && r.json?.error?.code === "REASON");
  r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: true, reason: "  " }, t: T.A });
  check("blank reason → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${B}/metaEvents`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("non-grantable flag (metaEvents) → 400 BAD_FLAG", r.status === 400 && r.json?.error?.code === "BAD_FLAG");
  r = await call("PUT", `/api/admin/features/account/${B}/domainEvents`, { body: { enabled: false, reason: "pilot" }, t: T.A });
  check("non-grantable flag (domainEvents) → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${B}/careerTimeline`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("wrong role (career flag on a brand) → 400 WRONG_ROLE", r.status === 400 && r.json?.error?.code === "WRONG_ROLE");
  r = await call("PUT", `/api/admin/features/account/${ids.S}/employerFirstHireFree`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("First Hire Free on a student → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${ids.T}/loyaltyV2`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("traveler → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${ids.A2}/loyaltyV2`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("admin account → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${X}/loyaltyV2`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("unknown account → 404", r.status === 404);
  r = await call("PUT", `/api/admin/features/account/nope/loyaltyV2`, { body: { enabled: true, reason: "pilot" }, t: T.A });
  check("bad id → 400", r.status === 400);
  r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: "yes", reason: "pilot" }, t: T.A });
  check("enabled not a boolean → 400", r.status === 400);
  check("…none of those wrote a row or a log entry", accessRows((x) => x.flag !== "surplusBoxes").length === 0 && logRows().length === 0);

  r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: true, reason: "Alpha Cafe loyalty pilot" }, t: T.A });
  check("admin turns Loyalty on for the brand → 200, changed", r.status === 200 && r.json.data.changed === true && r.json.data.state.effective === true, JSON.stringify(r.json));
  check("…applied at once in memory (no restart)", on("loyaltyV2", "B", "brand"));
  const row = accessRows((x) => String(x.account) === B && x.flag === "loyaltyV2")[0];
  check("…the row: enabled, set by, reason, time", row && row.enabled === true && String(row.setBy) === String(ids.A) && row.reason === "Alpha Cafe loyalty pilot" && row.setAt instanceof Date);
  let lr = logRows();
  check("…one admin log row: feature.grant, before: no row (null), after on, the reason", lr.length === 1 && lr[0].action === "feature.grant" && lr[0].targetType === "User" && lr[0].targetId === B
    && lr[0].before.flag === "loyaltyV2" && lr[0].before.enabled === null && lr[0].after.enabled === true && lr[0].reason === "Alpha Cafe loyalty pilot" && String(lr[0].admin) === String(ids.A));
  r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: true, reason: "again" }, t: T.A2 });
  check("the same switch again → unchanged, no new log row", r.status === 200 && r.json.data.changed === false && logRows().length === 1);
  r = await call("GET", "/api/app/flags/me", { t: T.B });
  check("/api/app/flags/me for the brand now says loyaltyV2: true", r.json?.loyaltyV2 === true, JSON.stringify(r.json));

  console.log("── 5. the kill switch beats everything");
  for (const v of ["off", "\"off\"", "false", "0", "no", "'OFF'", "off;off"]) {
    check(`FLAG_LOYALTY_V2=${v}: off for the admin-access brand and for a Railway id`, withEnv({ FLAG_LOYALTY_V2: v }, () => !on("loyaltyV2", "B", "brand") && flags.isKilled("loyaltyV2") && !flags.flagState("loyaltyV2", { id: B }).effective));
  }
  check("…and /flags/me agrees", (await withEnvAsync({ FLAG_LOYALTY_V2: "off" }, () => call("GET", "/api/app/flags/me", { t: T.B }))).json?.loyaltyV2 === false);
  check("kill switch log line says admin access is ignored", withEnv({ FLAG_LOYALTY_V2: "off" }, () => flags.describeFlags().includes("[flags] FLAG_LOYALTY_V2: off (kill switch): admin access ignored")));
  check("unreadable value: not a kill switch, admin access still applies", withEnv({ FLAG_LOYALTY_V2: "loyalty for alpha" }, () => on("loyaltyV2", "B", "brand") && !flags.isKilled("loyaltyV2")));
  check("empty value: admin access still applies", withEnv({ FLAG_LOYALTY_V2: "" }, () => on("loyaltyV2", "B", "brand")));
  check("Railway ids + admin access: OR (both on)", withEnv({ FLAG_LOYALTY_V2: `ids:${S}` }, () => on("loyaltyV2", "B", "brand") && on("loyaltyV2", "S", "student") && !on("loyaltyV2", "S2", "student")));

  console.log("── 6. switching off: an admin \"off\" now beats the Railway list (feat/feature-defaults)");
  r = await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: false, reason: "pilot paused" }, t: T.A });
  check("off → 200, changed, now off", r.status === 200 && r.json.data.changed === true && !on("loyaltyV2", "B", "brand"));
  lr = logRows();
  check("…logged as feature.revoke with the reason", lr.length === 2 && lr[1].action === "feature.revoke" && lr[1].before.enabled === true && lr[1].after.enabled === false && lr[1].reason === "pilot paused");
  const listed = await withEnvAsync({ FLAG_LOYALTY_V2: `ids:${B}` }, () => call("GET", `/api/admin/features/account/${B}`, { t: T.A }));
  const lf = listed.json?.data?.flags?.find((f) => f.flag === "loyaltyV2");
  check("account view: Railway-listed but forced off → fromRailway true, forced off, effective FALSE (the admin off decides)", lf && lf.fromRailway === true && lf.granted === false && lf.forced === "off" && lf.source === "account" && lf.effective === false && lf.killed === false, JSON.stringify(lf));
  check("…lastChange shows the stored row and the admin's name", lf?.lastChange?.enabled === false && lf.lastChange.reason === "pilot paused" && lf.lastChange.setBy.name === "Ayesha Admin");
  check("…brand view lists only the brand's features (Loyalty, Surprise Box)", listed.json.data.flags.map((f) => f.flag).sort().join() === "loyaltyV2,surplusBoxes");

  console.log("── 7. a brand's students (one-sided pilot is visible)");
  await call("PUT", `/api/admin/features/account/${B}/loyaltyV2`, { body: { enabled: true, reason: "pilot back on" }, t: T.A });
  let v = (await call("GET", `/api/admin/features/account/${B}`, { t: T.A })).json.data.flags.find((f) => f.flag === "loyaltyV2");
  check("brand on, no student has it: 0 / 0, 1 used the brand, 0 of them have it", v.students && v.students.withAdminAccess === 0 && v.students.fromRailwayList === 0 && v.students.usedThisBrand === 1 && v.students.usedThisBrandWithIt === 0 && v.students.allStudentsFromRailway === false, JSON.stringify(v.students));
  await call("PUT", `/api/admin/features/account/${S}/loyaltyV2`, { body: { enabled: true, reason: "test student" }, t: T.A });
  v = (await withEnvAsync({ FLAG_LOYALTY_V2: `ids:${ids.S2},${B}` }, () => call("GET", `/api/admin/features/account/${B}`, { t: T.A }))).json.data.flags.find((f) => f.flag === "loyaltyV2");
  check("after a student is added: 1 with admin access, 1 student in the Railway list (the brand id isn't counted), 1 of 1 who used the brand", v.students.withAdminAccess === 1 && v.students.fromRailwayList === 1 && v.students.usedThisBrandWithIt === 1, JSON.stringify(v.students));
  v = (await withEnvAsync({ FLAG_LOYALTY_V2: "roles:student" }, () => call("GET", `/api/admin/features/account/${B}`, { t: T.A }))).json.data.flags.find((f) => f.flag === "loyaltyV2");
  check("roles:student in Railway → allStudentsFromRailway", v.students.allStudentsFromRailway === true);
  const ev = (await call("GET", `/api/admin/features/account/${ids.E}`, { t: T.A })).json.data;
  check("employer view: the five career flags, no students block", ev.flags.map((f) => f.flag).sort().join() === "careerMatching,careerRatings,careerTimeline,employerFirstHireFree,resumeStudioV2" && ev.flags.every((f) => !f.students));
  const sv = (await call("GET", `/api/admin/features/account/${S}`, { t: T.A })).json.data;
  check("student view: no First Hire Free", sv.flags.length === 6 && !sv.flags.some((f) => f.flag === "employerFirstHireFree"));

  console.log("── 8. bulk");
  const before = logRows().length;
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "loyaltyV2", enabled: true, accountIds: [S, String(ids.S2), String(ids.S3), String(ids.E), X, "junk", String(ids.S2)], reason: "NED test students" }, t: T.A });
  const d = r.json?.data;
  check("bulk → changed S2, S3; unchanged S; skipped employer (wrong role), unknown, junk", r.status === 200 && d.changed.sort().join() === [String(ids.S2), String(ids.S3)].sort().join() && d.unchanged.join() === S
    && d.skipped.length === 3 && d.skipped.some((x) => x.id === String(ids.E) && /wrong role/.test(x.why)) && d.skipped.some((x) => x.id === X) && d.skipped.some((x) => x.id === "junk"), JSON.stringify(d));
  check("…one log row per changed account, same request id", logRows().length === before + 2 && new Set(logRows().slice(-2).map((x) => x.requestId)).size === 1);
  check("…both on at once", on("loyaltyV2", "S2", "student") && on("loyaltyV2", "S3", "student"));
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "loyaltyV2", enabled: true, accountIds: Array.from({ length: 501 }, () => String(oid())), reason: "too many" }, t: T.A });
  check("501 accounts → 400 TOO_MANY", r.status === 400 && r.json?.error?.code === "TOO_MANY");
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "loyaltyV2", enabled: true, accountIds: [], reason: "none" }, t: T.A });
  check("no accounts → 400", r.status === 400);
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "loyaltyV2", enabled: true, accountIds: [S] }, t: T.A });
  check("bulk without a reason → 400", r.status === 400);
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "loyaltyV2", enabled: false, accountIds: [String(ids.S2), String(ids.S3)], reason: "undo" }, t: T.A });
  check("bulk off (undo) → both off", r.json?.data?.changed.length === 2 && !on("loyaltyV2", "S2", "student") && !on("loyaltyV2", "S3", "student"));

  console.log("── 9. the features page list and the overview");
  r = await call("GET", "/api/admin/features/flag/loyaltyV2", { t: T.A });
  const L = r.json?.data;
  const onRows = (L?.accounts || []).filter((a) => a.forced === "on");
  const offRows = (L?.accounts || []).filter((a) => a.forced === "off");
  check("list: forced on (sana, the brand) and forced off (the two undone by bulk), newest first, with names, university, who and why", r.status === 200 && L.total === 4 && onRows.length === 2 && offRows.length === 2
    && onRows[0].id === S && onRows[0].name === "sana" && onRows[0].university === "NED University" && onRows[0].setBy.name === "Ayesha Admin" && onRows[0].reason === "test student" && onRows[1].name === "Alpha Cafe"
    && offRows.every((a) => a.reason === "undo"), JSON.stringify(L?.accounts));
  check("…no e-mail or phone in the list", !/@test\.local|0300/.test(r.text));
  r = await call("GET", "/api/admin/features/flag/loyaltyV2?limit=1&offset=1", { t: T.A });
  check("…paged", r.json.data.accounts.length === 1 && r.json.data.accounts[0].id === L.accounts[1].id);
  r = await call("GET", "/api/admin/features/flag/metaEvents", { t: T.A });
  check("…non-grantable flag → 400", r.status === 400);
  r = await withEnvAsync({ FLAG_LOYALTY_V2: `ids:${X},${S}` }, () => call("GET", "/api/admin/features/flags", { t: T.A }));
  const lo = r.json?.data?.find((f) => f.flag === "loyaltyV2");
  check("overview: 7 grantable flags; Loyalty: 2 admin access, Railway '2 ids', railwayIdCount 2, not killed", r.json.data.length === 7 && lo.adminAccessCount === 2 && lo.railway === "2 ids" && lo.railwayIdCount === 2 && lo.killed === false, JSON.stringify(lo));
  check("…the overview carries no Railway id", !r.text.includes(X));

  console.log("── 10. refresh: rows written by another server process, failures");
  fake.seed(coll("FeatureAccess"), [{ _id: oid(), account: ids.E, flag: "careerTimeline", enabled: true, setBy: ids.A2, reason: "from another process", setAt: new Date() }]);
  check("not seen before a refresh", !on("careerTimeline", "E", "employee"));
  await access.load();
  check("seen after a refresh", on("careerTimeline", "E", "employee"));
  const realFind = FeatureAccess.find;
  FeatureAccess.find = () => { throw Object.assign(new Error("connection lost mongodb://user:secret@host"), { name: "MongoNetworkError" }); };
  const errs = []; const origErr = console.error; console.error = (...a) => errs.push(a.join(" "));
  const fr = await access.load();
  console.error = origErr; FeatureAccess.find = realFind;
  check("a failed refresh keeps the last set", fr.ok === false && on("careerTimeline", "E", "employee") && on("loyaltyV2", "B", "brand"));
  check("…and logs the error name only, never the message (no connection string)", errs.length === 1 && /could not refresh, keeping the last set \(MongoNetworkError\)/.test(errs[0]) && !/secret|mongodb:/.test(errs[0]), errs[0]);

  console.log("── 11. account deletion removes the rows");
  const deletion = reqS("./services/accountDeletion");
  let delErr = null;
  try { await deletion.deleteAccount(String(ids.S3), { actor: { type: "admin", adminId: String(ids.A) }, confirmName: "zara" }); } catch (e) { delErr = e.message; }
  check("deleting a student removes its feature access rows", !delErr && accessRows((x) => String(x.account) === String(ids.S3)).length === 0, delErr || "");
  await access.load();
  check("…and the next refresh drops it from memory", !on("loyaltyV2", "S3", "student"));

  console.log("── 12. static: only the admin route touches FeatureAccess");
  const fs = require("fs");
  const users = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if (f.isDirectory()) { if (!["node_modules", "tests", ".git", "chat-service"].includes(f.name)) walk(path.join(dir, f.name)); } else if (f.name.endsWith(".js") && /FeatureAccess|featureAccess/.test(fs.readFileSync(path.join(dir, f.name), "utf8"))) users.push(path.relative(SERVER, path.join(dir, f.name)).replace(/\\/g, "/")); } };
  walk(SERVER);
  const allowed = ["models/FeatureAccess.js", "models/FeatureDefault.js", "services/featureAccess.js", "routes/adminFeatures.routes.js", "server.js", "services/accountDeletion.js", "config/featureFlags.js", "scripts/loyaltyBackfill.js"];
  check("FeatureAccess is used only by its model, service, admin route, startup, account deletion, the loyalty backfill (loads it as startup does)", users.every((u) => allowed.includes(u)), users.join(", "));

  access.stop();
  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
