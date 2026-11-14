// What the app sees for a student (fix/student-features): GET /api/app/flags/me applies the student defaults to a
// student with no rows (also an older account without a stored role, which used to land in the non-student set),
// forced off and the kill switch still win, the admin account view shows exactly what flags/me answers, the
// student's own feature routes accept an account without a stored role, and the loyalty empty state's list.
//   node tests/student-app-view/run.js [serverDir]
// Real routes and models; fake MongoDB; no network.
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
  const T = { A: tok("A", "admin"), S: tok("S", "student"), L: tok("L", "student"), LT: tok("L", undefined), E: tok("E", "employee"), B: tok("B", "brand") };
  const ALL = ["resumeStudioV2", "careerRatings", "loyaltyV2", "careerTimeline", "careerMatching", "surplusBoxes"];
  const flagsMe = async (t) => (await call("GET", "/api/app/flags/me", { t })).json || {};
  const setDefault = (flag, enabled) => call("PUT", `/api/admin/features/defaults/${flag}`, { t: T.A, body: { role: "student", enabled, reason: "every student, from the test" } });

  console.log("── 1. Railway FLAG_* unset, no rows: every student feature on by default (features-on-by-default)");
  await access.load();
  let me = await flagsMe(T.S);
  check("a student with no rows and no default rows: every student flag on", ALL.every((f) => me[f] === true), JSON.stringify(me));

  console.log("── 2. defaults on for every student (as in live admin)");
  for (const f of ALL) { const r = await setDefault(f, true); check(`default on: ${f}`, r.status === 200, r.status); }
  await access.load();
  me = await flagsMe(T.S);
  check("flags/me: a student with no rows gets every student flag true", ALL.every((f) => me[f] === true), JSON.stringify(me));
  const legacy = rows("User", (u) => same(u._id, ids.L))[0];
  check("(the legacy student's document really has no role field)", legacy && !("role" in legacy));
  me = await flagsMe(T.L);
  check("flags/me: an older student account with NO stored role also gets every flag true (it was in the non-student set)", ALL.every((f) => me[f] === true), JSON.stringify(me));
  me = await flagsMe(T.LT);
  check("…even when its token carries no role either", ALL.every((f) => me[f] === true), JSON.stringify(me));
  check("the non-student set holds only explicit non-student roles", flags.flagState("surplusBoxes", { id: String(ids.L), role: "student" }).source === "default" && flags.flagState("surplusBoxes", { id: String(ids.E), role: "student" }).source !== "default");
  me = await flagsMe(T.E);
  check("an employer gets no student default", me.surplusBoxes === false && me.loyaltyV2 === false, JSON.stringify(me));

  console.log("── 3. forced off beats the default; the kill switch beats everything");
  let r = await call("PUT", `/api/admin/features/account/${ids.S}/loyaltyV2`, { t: T.A, body: { state: "off", reason: "test: one student off" } });
  check("forced off for one student (admin)", r.status === 200, r.status);
  me = await flagsMe(T.S);
  check("flags/me: that flag false for that student, the others still true", me.loyaltyV2 === false && me.surplusBoxes === true, JSON.stringify(me));
  check("…and still true for other students", (await flagsMe(T.L)).loyaltyV2 === true);
  await withEnvAsync({ FLAG_SURPLUS_BOXES: "off" }, async () => {
    const m1 = await flagsMe(T.S), m2 = await flagsMe(T.L);
    check("kill switch (FLAG_SURPLUS_BOXES=off): false for every student despite the default", m1.surplusBoxes === false && m2.surplusBoxes === false);
  });
  await call("PUT", `/api/admin/features/account/${ids.S}/loyaltyV2`, { t: T.A, body: { state: "default", reason: "test: back to default" } });

  console.log("── 4. admin: what the app sees");
  r = await call("GET", `/api/admin/features/account/${ids.L}`, { t: T.A });
  const view = r.json?.data || r.json;
  check("account view of the legacy student: role student (not stored), its six flags listed", view?.account?.role === "student" && view.account.roleStored === false && ALL.every((f) => view.flags.some((x) => x.flag === f || x.key === f)), JSON.stringify(view?.account));
  const appSees = await flagsMe(T.L);
  check("appView = exactly what GET /api/app/flags/me answers that student now", view?.appView && JSON.stringify(view.appView.flags) === JSON.stringify(appSees) && !!view.appView.at, JSON.stringify(view?.appView));
  r = await call("GET", `/api/admin/features/account/${ids.L}`, { t: T.S });
  check("…admins only", r.status === 401 || r.status === 403, r.status);

  console.log("── 5. the student's own feature routes accept an account without a stored role");
  r = await call("GET", "/api/career/matching/recommended", { t: T.L });
  check("recommended jobs: answers (no resume yet) instead of 'Recommendations are for students'", r.status === 200 && (r.json?.data?.hasResume === false), `${r.status} ${JSON.stringify(r.json?.error || r.json?.data?.hasResume)}`);
  r = await call("GET", "/api/loyalty/me/credits", { t: T.L });
  check("loyalty visits: allowed (was 403 'not allowed for your account')", r.status === 200 && r.json?.data?.enabled === true, r.status);

  console.log("── 6. loyalty: brands running a program now (for the app's empty state)");
  r = await call("GET", "/api/loyalty/programs/active", { t: T.S });
  check("the brand's Loyalty is on by default and it runs an active program: listed with its name", r.status === 200 && r.json?.data?.enabled === true && r.json.data.programs.length === 1 && r.json.data.programs[0].brandName === "Alpha Cafe", JSON.stringify(r.json?.data));
  await call("PUT", `/api/admin/features/account/${ids.B}/loyaltyV2`, { t: T.A, body: { state: "off", reason: "test: this brand off" } });
  r = await call("GET", "/api/loyalty/programs/active", { t: T.S });
  check("the brand switched off: zero programs ('no loyalty programs near you yet')", r.json?.data?.enabled === true && r.json.data.programs.length === 0, JSON.stringify(r.json?.data));
  await call("PUT", `/api/admin/features/account/${ids.S}/loyaltyV2`, { t: T.A, body: { state: "off", reason: "test: off again" } });
  r = await call("GET", "/api/loyalty/programs/active", { t: T.S });
  check("the student's loyalty off: enabled false, no list", r.json?.data?.enabled === false && r.json.data.programs.length === 0);
  r = await call("GET", "/api/loyalty/programs/active", { t: T.B });
  check("brands can't call it", r.status === 403, r.status);

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
