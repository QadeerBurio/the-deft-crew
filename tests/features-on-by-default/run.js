// Every feature on by default for the roles that can use it (feat/features-on-by-default): students, brands and
// employers with no rows get every listed feature; admins and travelers none; a missing role is a student; a caller
// can't borrow a role; forced off and the kill switch still win; turning a role's default off affects that role only
// (logged); the admin overview shows the default per role; "what the app sees" = flags/me for every role.
//   node tests/features-on-by-default/run.js [serverDir]
// Real routes and models; fake MongoDB; no network.
const fs = require("fs");
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
for (const m of ["User", "University", "FeatureAccess", "FeatureDefault", "AdminActionLog", "LoyaltyLedger", "LoyaltyProgram", "SurplusOrder", "Resume", "Job", "JobApplication"]) { try { reqS(`./models/${m}`); } catch {} }
const flags = reqS("./config/featureFlags");
const access = reqS("./services/featureAccess");
const FeatureAccess = reqS("./models/FeatureAccess");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api", access.waitReady);
app.use("/api/admin/features", reqS("./routes/adminFeatures.routes"));
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));
app.use("/api/loyalty", reqS("./routes/loyalty.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["B", "B2", "S", "S2", "S3", "E", "T", "A", "A2", "U", "FORMER", "L"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("University"), [{ _id: ids.U, name: "NED University" }]);
fake.seed(coll("User"), [
  user(ids.B, "brand", "alpha", { brandName: "Alpha Cafe", brandApprovalStatus: "approved" }), user(ids.B2, "brand", "beta", { brandName: "Beta" }),
  user(ids.S, "student", "sana", { university: ids.U }), user(ids.S2, "student", "taha"), user(ids.S3, "student", "zara"),
  user(ids.E, "employee", "hireco"), user(ids.T, "traveler", "tariq"), user(ids.A, "admin", "Ayesha Admin"), user(ids.A2, "admin", "Bilal Admin"),
  user(ids.FORMER, "brand", "former-admin"), // a token still says admin, the database says brand
]);
// an older student account: saved before the role field existed (no "role" key in the database)
{ const legacy = user(ids.L, "student", "old-student"); delete legacy.role; fake.seed(coll("User"), [legacy]); }
// Alpha Cafe runs an active loyalty program (the brand's own Loyalty switch decides whether students see it)
fake.seed(coll("LoyaltyProgram"), [{ _id: oid(), brand: ids.B, name: "Alpha regulars", status: "active", mode: "tiers", version: 1, tiers: [{ minVisit: 1, maxVisit: null, discountPct: 10, name: "regular" }], createdAt: new Date(), updatedAt: new Date() }]);
const same = (a, b) => String(a) === String(b);
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
  const T = { A: tok("A", "admin"), S: tok("S", "student"), L: tok("L", "student"), B: tok("B", "brand"), E: tok("E", "employee"), T: tok("T", "traveler") };
  const STUDENT = ["resumeStudioV2", "careerRatings", "loyaltyV2", "careerTimeline", "careerMatching", "surplusBoxes"];
  const BRAND = ["loyaltyV2", "surplusBoxes"];
  const EMPLOYER = ["careerTimeline", "careerMatching", "careerRatings", "employerFirstHireFree"];
  const ALL = [...new Set([...STUDENT, ...BRAND, ...EMPLOYER])];
  const flagsMe = async (t) => (await call("GET", "/api/app/flags/me", { t })).json || {};
  const onlyThese = (me, list) => ALL.every((f) => me[f] === list.includes(f));

  console.log("── 1. no rows, Railway FLAG_* unset: every listed feature on for its role");
  await access.load();
  let me = await flagsMe(T.S);
  check("student: the six student features on", onlyThese(me, STUDENT), JSON.stringify(me));
  me = await flagsMe(T.L);
  check("an older student account without a stored role: the same six (a missing role is a student)", onlyThese(me, STUDENT), JSON.stringify(me));
  me = await flagsMe(T.B);
  check("brand: Loyalty and Surprise Box on, nothing else", onlyThese(me, BRAND), JSON.stringify(me));
  me = await flagsMe(T.E);
  check("employer: hiring timeline, matching, ratings, First Hire Free on, nothing else", onlyThese(me, EMPLOYER), JSON.stringify(me));
  me = await flagsMe(T.A);
  check("admin: none", ALL.every((f) => me[f] === false), JSON.stringify(me));
  me = await flagsMe(T.T);
  check("traveler: none", ALL.every((f) => me[f] === false), JSON.stringify(me));
  check("a caller can't borrow a role: an admin asked about as 'employee', an employer as 'student', a student as 'brand' → no default",
    !flags.isEnabled("careerMatching", { id: String(ids.A), role: "employee" }) && !flags.isEnabled("surplusBoxes", { id: String(ids.E), role: "student" }) && !flags.isEnabled("loyaltyV2", { id: String(ids.S), role: "brand" }));
  check("startup line: every role's defaults, no ids", flags.describeDefaults() === "[flags] defaults: student {resumeStudioV2 on, careerRatings on, loyaltyV2 on, careerTimeline on, careerMatching on, surplusBoxes on}, brand {loyaltyV2 on, surplusBoxes on}, employee {careerTimeline on, careerMatching on, careerRatings on, employerFirstHireFree on}" && ![ids.S, ids.B, ids.E].some((id) => flags.describeDefaults().includes(String(id))), flags.describeDefaults());
  check("admin pages for these features are shown (a feature on by default is set up)", ["surplusBoxes", "loyaltyV2", "careerTimeline", "careerRatings", "employerFirstHireFree"].every((f) => flags.pilotConfigured(f)));
  check("production never switches the built-in default off (only the pilot test suites do)", !/setBuiltInDefaults\(/.test(fs.readFileSync(path.join(SERVER, "server.js"), "utf8") + fs.readFileSync(path.join(SERVER, "services/featureAccess.js"), "utf8")));

  console.log("── 2. forced off beats the default; the kill switch beats everything");
  let r = await call("PUT", `/api/admin/features/account/${ids.B}/surplusBoxes`, { t: T.A, body: { state: "off", reason: "test: brand paused" } });
  check("forced off for one brand (admin, logged)", r.status === 200 && logRows((l) => l.action === "feature.revoke" && String(l.targetId) === String(ids.B)).length === 1, r.status);
  me = await flagsMe(T.B);
  check("…that brand: Surprise Box off, Loyalty still on", me.surplusBoxes === false && me.loyaltyV2 === true, JSON.stringify(me));
  check("…another brand still has it", flags.isEnabled("surplusBoxes", { id: String(ids.B2), role: "brand" }));
  r = await call("PUT", `/api/admin/features/account/${ids.E}/careerMatching`, { t: T.A, body: { state: "off", reason: "test: employer paused" } });
  check("forced off for one employer: off for them", (await flagsMe(T.E)).careerMatching === false);
  await withEnvAsync({ FLAG_CAREER_MATCHING: "off" }, async () => {
    const s = await flagsMe(T.S), e = await flagsMe(T.E);
    check("kill switch FLAG_CAREER_MATCHING=off: off for students and employers despite the defaults", s.careerMatching === false && e.careerMatching === false);
  });
  await withEnvAsync({ FLAG_LOYALTY_V2: "off" }, async () => {
    r = await call("PUT", `/api/admin/features/account/${ids.S}/loyaltyV2`, { t: T.A, body: { state: "on", reason: "test: forced on under the kill switch" } });
    check("…even forced on loses to the kill switch", (await flagsMe(T.S)).loyaltyV2 === false);
  });
  await call("PUT", `/api/admin/features/account/${ids.S}/loyaltyV2`, { t: T.A, body: { state: "default", reason: "test: back" } });
  await call("PUT", `/api/admin/features/account/${ids.B}/surplusBoxes`, { t: T.A, body: { state: "default", reason: "test: back" } });
  await call("PUT", `/api/admin/features/account/${ids.E}/careerMatching`, { t: T.A, body: { state: "default", reason: "test: back" } });
  check("reset to default: on again", (await flagsMe(T.B)).surplusBoxes === true && (await flagsMe(T.E)).careerMatching === true);

  console.log("── 3. turning a role's default off: that role only");
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.A, body: { role: "brand", enabled: false } });
  check("no reason → 400", r.status === 400, r.status);
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.A, body: { role: "brand", enabled: false, reason: "brands: loyalty paused" } });
  check("brand default off → 200, changed (before: on by default), a row stored", r.status === 200 && r.json?.data?.changed === true && r.json.data.before === true && r.json.data.after === false
    && defaultRows((d) => d.flag === "loyaltyV2" && d.role === "brand" && d.enabled === false).length === 1, r.text);
  const lg = logRows((l) => l.action === "feature.default" && l.targetId === "loyaltyV2:brand");
  check("…logged as feature.default with the reason", lg.length === 1 && lg[0].reason === "brands: loyalty paused" && lg[0].after.enabled === false);
  me = await flagsMe(T.B);
  check("…brands: Loyalty off (Surprise Box still on)", me.loyaltyV2 === false && me.surplusBoxes === true, JSON.stringify(me));
  check("…students keep Loyalty", (await flagsMe(T.S)).loyaltyV2 === true);
  r = await call("PUT", "/api/admin/features/defaults/careerMatching", { t: T.A, body: { role: "employee", enabled: false, reason: "employers: matching paused" } });
  check("employer default off: employers off, students still on", r.status === 200 && (await flagsMe(T.E)).careerMatching === false && (await flagsMe(T.S)).careerMatching === true);
  r = await call("PUT", "/api/admin/features/defaults/surplusBoxes", { t: T.A, body: { role: "student", enabled: false, reason: "students: boxes paused" } });
  check("student default off: students off, brands still on", r.status === 200 && (await flagsMe(T.S)).surplusBoxes === false && (await flagsMe(T.B)).surplusBoxes === true);
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.A, body: { role: "employee", enabled: false, reason: "x" } });
  check("a role without that feature → 400 BAD_FLAG", r.status === 400 && r.json?.error?.code === "BAD_FLAG");
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.A, body: { role: "traveler", enabled: false, reason: "x" } });
  check("admins / travelers have no defaults → 400 BAD_ROLE", r.status === 400 && r.json?.error?.code === "BAD_ROLE");
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.S, body: { role: "brand", enabled: true, reason: "me" } });
  check("…admins only", r.status === 401 || r.status === 403, r.status);
  r = await call("GET", "/api/admin/features/flags", { t: T.A });
  const ov = (r.json?.data || []).find((x) => x.flag === "loyaltyV2");
  check("features overview: Loyalty's default per role (student on, built-in; brand off, set with its reason)", ov?.defaults?.student?.enabled === true && ov.defaults.student.set === false && ov.defaults.brand?.enabled === false && ov.defaults.brand.set === true && ov.defaults.brand.reason === "brands: loyalty paused" && !("employee" in ov.defaults), JSON.stringify(ov?.defaults));
  r = await call("PUT", "/api/admin/features/defaults/loyaltyV2", { t: T.A, body: { role: "brand", enabled: true, reason: "brands: loyalty back" } });
  check("brand default on again: brands on", r.status === 200 && (await flagsMe(T.B)).loyaltyV2 === true);

  console.log("── 4. admin 'what the app sees' = flags/me, for every role");
  for (const [who, t] of [["S", T.S], ["L", T.L], ["B", T.B], ["E", T.E], ["A", T.A], ["T", T.T]]) {
    const v = (await call("GET", `/api/admin/features/account/${ids[who]}`, { t: T.A })).json?.data;
    const app = await flagsMe(t);
    check(`${who === "L" ? "student without a stored role" : v?.account?.role}: appView = what flags/me answers`, v?.appView && JSON.stringify(v.appView.flags) === JSON.stringify(app), JSON.stringify({ appView: v?.appView?.flags, app }));
  }
  const bv = (await call("GET", `/api/admin/features/account/${ids.B}`, { t: T.A })).json?.data;
  const bl = bv?.flags?.find((x) => x.flag === "loyaltyV2");
  check("the brand's features tab: Loyalty 'default (on)' from the brand default", bl?.defaultForRole === true && bl.source === "default" && bl.effective === true, JSON.stringify(bl));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
