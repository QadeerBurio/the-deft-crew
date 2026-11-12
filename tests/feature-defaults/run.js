// Student feature defaults (feat/feature-defaults): models/FeatureDefault.js, config/featureFlags.js, services/featureAccess.js,
// /api/admin/features. The order: kill switch > the account's row (forced on / OFF) > the default for its role (students
// only, checked against the account itself) > Railway rules > off. Reset to default, admin-only routes, the admin log,
// caching and refresh, the startup lines (no ids), old Railway formats with no defaults.
//   node tests/feature-defaults/run.js [serverDir]
// Same harness as tests/feature-access: real routes, models and services; fake MongoDB; no database, network or .env.
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

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "University", "FeatureAccess", "FeatureDefault", "AdminActionLog", "LoyaltyLedger", "SurplusOrder"]) reqS(`./models/${m}`);
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
const state = (flag, who, role) => flags.flagState(flag, { id: String(ids[who] || who), role });
const defaultRows = (f = () => true) => rows("FeatureDefault", f);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { A: tok("A", "admin"), B: tok("B", "brand"), S: tok("S", "student"), S2: tok("S2", "student"), E: tok("E", "employee"), FORMER: tok("FORMER", "admin") };
  const S = String(ids.S), S2 = String(ids.S2), E = String(ids.E), B = String(ids.B), A = String(ids.A), X = String(oid());

  console.log("── 1. no defaults set: old Railway formats unchanged");
  await access.load();
  check("nothing set: off for everyone", !on("loyaltyV2", "S", "student") && !on("loyaltyV2", "B", "brand"));
  check("ids list (quoted, line breaks)", withEnv({ FLAG_LOYALTY_V2: `"ids:${S}\n${B}"` }, () => on("loyaltyV2", "S", "student") && on("loyaltyV2", "B", "brand") && !on("loyaltyV2", X, "student")));
  check("roles / % / on", withEnv({ FLAG_LOYALTY_V2: "roles:brand" }, () => on("loyaltyV2", "B", "brand") && !on("loyaltyV2", "S", "student"))
    && withEnv({ FLAG_LOYALTY_V2: "100%" }, () => on("loyaltyV2", "S", "student")) && withEnv({ FLAG_LOYALTY_V2: "on" }, () => on("loyaltyV2", "S", "student")));
  check("off;ids:X is on for X (not a kill switch)", withEnv({ FLAG_LOYALTY_V2: `off;ids:${S}` }, () => on("loyaltyV2", "S", "student") && !flags.isKilled("loyaltyV2")));
  check("the state says which step decided (railway)", state("loyaltyV2", "S", "student").source === "railway" && state("loyaltyV2", "S", "student").studentDefault === null && state("loyaltyV2", "S", "student").forced === null);
  check("startup line: every defaultable flag 'not set' (no ids)", flags.describeDefaults() === "[flags] student defaults: resumeStudioV2 not set, careerRatings not set, loyaltyV2 not set, careerTimeline not set, careerMatching not set, surplusBoxes not set", flags.describeDefaults());

  console.log("── 2. the student default (admin portal)");
  let r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { body: { role: "student", enabled: true }, t: T.A });
  check("no reason → 400 REASON", r.status === 400 && r.json?.error?.code === "REASON");
  r = await call("PUT", "/api/admin/features/defaults/employerFirstHireFree", { body: { enabled: true, reason: "try" }, t: T.A });
  check("First Hire Free has no student default → 400 BAD_FLAG", r.status === 400 && r.json?.error?.code === "BAD_FLAG");
  r = await call("PUT", "/api/admin/features/defaults/metaEvents", { body: { enabled: true, reason: "try" }, t: T.A });
  check("a non-grantable flag → 400", r.status === 400);
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { body: { role: "employee", enabled: true, reason: "try" }, t: T.A });
  check("a default for employers → 400 BAD_ROLE (students only)", r.status === 400 && r.json?.error?.code === "BAD_ROLE");
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { body: { role: "student", enabled: true, reason: "launch loyalty for every student" }, t: T.A });
  check("on for every student → 200, changed, the row stored", r.status === 200 && r.json.data.changed === true && r.json.data.before === null && r.json.data.after === true
    && defaultRows((d) => d.flag === "loyaltyV2" && d.role === "student" && d.enabled === true && String(d.setBy) === A && d.reason === "launch loyalty for every student").length === 1, r.text);
  const dl = logRows((l) => l.action === "feature.default");
  check("…logged as feature.default with before / after and the reason", dl.length === 1 && dl[0].targetType === "FeatureDefault" && dl[0].targetId === "loyaltyV2:student" && dl[0].before.enabled === null && dl[0].after.enabled === true && dl[0].reason === "launch loyalty for every student");
  check("…at once on this server: every student on", on("loyaltyV2", "S", "student") && on("loyaltyV2", "S2", "student") && on("loyaltyV2", X, "student") && state("loyaltyV2", "S", "student").source === "default");
  check("…not employers, brands or admins", !on("loyaltyV2", "B", "brand") && !on("loyaltyV2", "E", "employee") && !on("loyaltyV2", "A", "admin") && !on("loyaltyV2", "S"));
  check("…not an employer / brand / admin a caller calls a 'student' (the account's own role decides)", !on("loyaltyV2", "E", "student") && !on("loyaltyV2", "B", "student") && !on("loyaltyV2", "A", "student"));
  check("…the app's flags for a student say on", (await call("GET", "/api/app/flags/me", { t: T.S })).json?.loyaltyV2 === true);
  check("…and for an employer, off", (await call("GET", "/api/app/flags/me", { t: T.E })).json?.loyaltyV2 === false);
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { body: { enabled: true, reason: "again" }, t: T.A });
  check("setting the same again: unchanged, no new log row", r.json?.data?.changed === false && logRows((l) => l.action === "feature.default").length === 1);
  check("startup line: 'loyaltyV2 on'", /loyaltyV2 on/.test(flags.describeDefaults()) && /careerMatching not set/.test(flags.describeDefaults()));
  check("the default beats Railway rules for students (a default 'on' turns on students the Railway list doesn't name)", withEnv({ FLAG_LOYALTY_V2: `ids:${B}` }, () => on("loyaltyV2", "S2", "student") && on("loyaltyV2", "B", "brand")));
  check("pilot set up (admin pages shown) while every student has it", flags.pilotConfigured("loyaltyV2"));

  console.log("── 3. an admin 'off' beats the student default and the Railway roles / ids");
  r = await call("PUT", `/api/admin/features/account/${S}/loyaltyV2`, { body: { state: "off", reason: "abuse report" }, t: T.A });
  check("forced off → 200, changed, a row with enabled false", r.status === 200 && r.json.data.changed === true && r.json.data.before === null && r.json.data.after === false && accessRows((a) => String(a.account) === S && a.flag === "loyaltyV2" && a.enabled === false).length === 1, r.text);
  check("…logged as feature.revoke (before: no row)", logRows((l) => l.action === "feature.revoke" && l.targetId === S).some((l) => l.before.enabled === null && l.after.enabled === false && l.reason === "abuse report"));
  check("…off for her though every student is on by default", !on("loyaltyV2", "S", "student") && on("loyaltyV2", "S2", "student") && state("loyaltyV2", "S", "student").source === "account");
  check("…off though the Railway list names her", withEnv({ FLAG_LOYALTY_V2: `ids:${S}` }, () => !on("loyaltyV2", "S", "student")));
  check("…off though a Railway role / 'on' / 100% covers her", withEnv({ FLAG_LOYALTY_V2: "roles:student" }, () => !on("loyaltyV2", "S", "student")) && withEnv({ FLAG_LOYALTY_V2: "on" }, () => !on("loyaltyV2", "S", "student")) && withEnv({ FLAG_LOYALTY_V2: "100%" }, () => !on("loyaltyV2", "S", "student")));
  check("…the app's flags for her say off", (await call("GET", "/api/app/flags/me", { t: T.S })).json?.loyaltyV2 === false);
  check("an admin off for an employer beats the Railway list too (same order for every account)", (await call("PUT", `/api/admin/features/account/${E}/careerTimeline`, { body: { state: "off", reason: "paused" }, t: T.A })).status === 200
    && withEnv({ FLAG_CAREER_TIMELINE: `ids:${E}` }, () => !on("careerTimeline", "E", "employee")));
  r = await call("GET", `/api/admin/features/account/${S}`, { t: T.A });
  const lf = r.json?.data?.flags?.find((f) => f.flag === "loyaltyV2");
  check("account view: forced off, the student default (on) shown, source account", lf && lf.forced === "off" && lf.defaultForRole === true && lf.effective === false && lf.source === "account" && lf.lastChange?.reason === "abuse report", JSON.stringify(lf));
  r = await call("PUT", `/api/admin/features/account/${S2}/careerMatching`, { body: { state: "on", reason: "pilot tester" }, t: T.A });
  check("forced on (state 'on') works, and { enabled: true } still does", r.status === 200 && on("careerMatching", "S2", "student")
    && (await call("PUT", `/api/admin/features/account/${S2}/careerRatings`, { body: { enabled: true, reason: "pilot tester" }, t: T.A })).status === 200 && on("careerRatings", "S2", "student"));

  console.log("── 4. reset to default removes the account row");
  r = await call("PUT", `/api/admin/features/account/${S}/loyaltyV2`, { body: { state: "default", reason: "report resolved" }, t: T.A });
  check("reset → 200, changed, the row is gone", r.status === 200 && r.json.data.changed === true && r.json.data.before === false && r.json.data.after === null && accessRows((a) => String(a.account) === S && a.flag === "loyaltyV2").length === 0, r.text);
  check("…logged as feature.reset with the reason", logRows((l) => l.action === "feature.reset" && l.targetId === S).some((l) => l.before.enabled === false && l.after.enabled === null && l.reason === "report resolved"));
  check("…she follows the student default again (on)", on("loyaltyV2", "S", "student") && state("loyaltyV2", "S", "student").source === "default");
  r = await call("PUT", `/api/admin/features/account/${S}/loyaltyV2`, { body: { state: "default", reason: "again" }, t: T.A });
  check("reset with no row: unchanged, nothing logged", r.json?.data?.changed === false && logRows((l) => l.action === "feature.reset" && l.targetId === S).length === 1);
  r = await call("PUT", `/api/admin/features/account/${S}/loyaltyV2`, { body: { state: "maybe", reason: "x y z" }, t: T.A });
  check("an unknown state → 400 BAD_STATE", r.status === 400 && r.json?.error?.code === "BAD_STATE");
  r = await call("POST", "/api/admin/features/bulk", { body: { flag: "careerMatching", state: "default", accountIds: [S2], reason: "end of pilot" }, t: T.A });
  check("bulk reset to default", r.status === 200 && r.json.data.changed.length === 1 && accessRows((a) => String(a.account) === S2 && a.flag === "careerMatching").length === 0);

  console.log("── 5. the kill switch beats everything");
  await call("PUT", `/api/admin/features/account/${S2}/loyaltyV2`, { body: { state: "on", reason: "force" }, t: T.A });
  check("kill switch: off for a forced-on student, the default-on students, a Railway-listed account", withEnv({ FLAG_LOYALTY_V2: "off" }, () => !on("loyaltyV2", "S2", "student") && !on("loyaltyV2", "S", "student") && !on("loyaltyV2", "B", "brand") && state("loyaltyV2", "S2", "student").source === "kill" && flags.isKilled("loyaltyV2")));
  check("…'false' / '0' / 'no' too", ["false", "0", "no", " OFF "].every((v) => withEnv({ FLAG_LOYALTY_V2: v }, () => !on("loyaltyV2", "S2", "student"))));
  check("…and the pages count it off", withEnv({ FLAG_LOYALTY_V2: "off" }, () => !flags.pilotConfigured("loyaltyV2")));
  r = await withEnvAsync({ FLAG_LOYALTY_V2: "off" }, () => call("GET", `/api/admin/features/account/${S2}`, { t: T.A }));
  check("account view under the kill switch: killed, source kill, still shows forced on", r.json?.data?.flags?.find((f) => f.flag === "loyaltyV2")?.killed === true && r.json.data.flags.find((f) => f.flag === "loyaltyV2").source === "kill" && r.json.data.flags.find((f) => f.flag === "loyaltyV2").forced === "on");

  console.log("── 6. a default 'off' and the overview");
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { body: { enabled: false, reason: "pause loyalty" }, t: T.A });
  check("default off → students off (Railway ids too), forced-on student still on", r.json?.data?.changed === true && !on("loyaltyV2", "S", "student") && withEnv({ FLAG_LOYALTY_V2: `ids:${S}` }, () => !on("loyaltyV2", "S", "student")) && on("loyaltyV2", "S2", "student"));
  check("…brands keep the Railway rules (no default for them)", withEnv({ FLAG_LOYALTY_V2: `ids:${B}` }, () => on("loyaltyV2", "B", "brand")));
  r = await call("GET", "/api/admin/features/flags", { t: T.A });
  const lo = r.json?.data?.find((f) => f.flag === "loyaltyV2");
  const fh = r.json?.data?.find((f) => f.flag === "employerFirstHireFree");
  check("overview: the default (off), who set it and why; forced on / off counts", lo?.studentDefaultable === true && lo.studentDefault?.enabled === false && lo.studentDefault.reason === "pause loyalty" && lo.studentDefault.setBy?.name === "Ayesha Admin" && lo.adminAccessCount === 1 && lo.forcedOffCount === 0, JSON.stringify(lo));
  check("…First Hire Free: no student default", fh?.studentDefaultable === false && fh.studentDefault === null);
  check("…counts only: no account id in the overview", !r.text.includes(S) && !r.text.includes(S2) && !r.text.includes(E));

  console.log("── 7. admins only; nobody changes their own features");
  for (const [who, t] of [["a student", T.S], ["an employer", T.E], ["a brand", T.B], ["an old admin token (now a brand)", T.FORMER]]) {
    const a = await call("PUT", "/api/admin/features/defaults/careerMatching", { body: { enabled: true, reason: "me me me" }, t });
    const b = await call("PUT", `/api/admin/features/account/${who === "a student" ? S : who === "an employer" ? E : B}/careerMatching`, { body: { state: "on", reason: "me me me" }, t });
    const c = await call("GET", "/api/admin/features/flags", { t });
    check(`${who}: 403 on the default, the account switch and the overview`, a.status === 403 && [403, 400].includes(b.status) && b.status === 403 && c.status === 403, `${a.status} ${b.status} ${c.status}`);
  }
  check("…nothing was written by them", defaultRows((d) => d.flag === "careerMatching").length === 0 && !accessRows((x) => x.flag === "careerMatching" && String(x.setBy) !== A).length);
  r = await call("PUT", "/api/admin/features/defaults/careerMatching", { body: { enabled: true, reason: "x x x" } });
  check("no login: 401", r.status === 401);

  console.log("── 8. caching and refresh (another server process)");
  // another process: rows written directly, this process sees them after its 30 s refresh (load())
  fake.seed(coll("FeatureDefault"), [{ _id: oid(), flag: "surplusBoxes", role: "student", enabled: true, setBy: ids.A, reason: "from another server", setAt: new Date() }]);
  fake.seed(coll("FeatureAccess"), [{ _id: oid(), account: ids.S3, flag: "surplusBoxes", enabled: false, setBy: ids.A, reason: "from another server", setAt: new Date() }]);
  check("before the refresh: not seen yet (in memory)", !on("surplusBoxes", "S", "student"));
  await access.load();
  check("after the refresh: the default and the forced off apply", on("surplusBoxes", "S", "student") && !on("surplusBoxes", "S3", "student"));
  // a new employer created on another process: after the refresh the default never applies to it
  const NEW = oid();
  fake.seed(coll("User"), [user(NEW, "employee", "newco")]);
  await access.load();
  check("…a new non-student account is known after the refresh (no default for it as 'student')", !on("surplusBoxes", NEW, "student"));
  const LATE = String(oid());
  const before = on("surplusBoxes", LATE, "student");
  flags.markAccountRole(LATE, "brand");
  check("…markAccountRole marks one at once (an unknown id called 'student' gets the default; once marked a brand, it doesn't)", before === true && !on("surplusBoxes", LATE, "student"));
  // a failed refresh keeps the last good copy
  const realFind = reqS("./models/FeatureDefault").find;
  reqS("./models/FeatureDefault").find = () => { throw Object.assign(new Error("connection lost"), { name: "MongoNetworkError" }); };
  const errs = []; const ce = console.error; console.error = (m) => errs.push(String(m));
  const lr2 = await access.load();
  console.error = ce; reqS("./models/FeatureDefault").find = realFind;
  check("a failed refresh keeps the last copy and logs no secret", lr2.ok === false && on("surplusBoxes", "S", "student") && errs.some((e) => /could not refresh, keeping the last set \(MongoNetworkError\)/.test(e)), errs.join(" | "));
  // the refresh timer
  const refreshed = [];
  const realLoad = access.load;
  check("start() logs the three lines (counts only, no ids)", await (async () => {
    const logs = []; const cl = console.log; console.log = (m) => logs.push(String(m));
    await access.start({ intervalMs: 60_000 }); access.stop();
    console.log = cl;
    const joined = logs.join("\n");
    return logs.some((l) => /^\[flags\] admin access: /.test(l)) && logs.some((l) => /^\[flags\] forced off: /.test(l)) && logs.some((l) => /^\[flags\] student defaults: .*loyaltyV2 off.*surplusBoxes on/.test(l)) && ![S, S2, String(ids.S3), E].some((id) => joined.includes(id));
  })());
  const User = reqS("./models/User");
  const fresh = new User({ name: "fresh co", email: "freshco@test.local", phone: "03001234568", role: "employee", password: "x".repeat(12) });
  let savedOk = true; try { await fresh.save(); } catch { savedOk = false; }
  check("a new employer saved on this server is known at once (before any refresh)", savedOk && !on("surplusBoxes", String(fresh._id), "student"));
  check("isEnabled stays synchronous (no promise)", typeof flags.isEnabled("loyaltyV2", { id: S, role: "student" }) === "boolean");
  void refreshed; void realLoad;

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
