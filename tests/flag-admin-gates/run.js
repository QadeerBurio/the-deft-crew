// Admin pages of the pilots (Surprise Box, hiring timeline, ratings, First Hire Free) are "set up" when the Railway
// value is set (and isn't the kill switch) OR any account has admin access to the flag (config/featureFlags.js
// pilotConfigured). Before, only the Railway value counted: removing FLAG_SURPLUS_BOXES hid the admin pages even with
// brands and students turned on from the admin portal.
//   node tests/flag-admin-gates/run.js [serverDir]
// Same harness as tests/admin-actions: real routes, models and services; fake MongoDB; no database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "SURPLUS_CODE_SECRET", "META_EVENTS_ENABLED"]) delete process.env[k];
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

// the startup warning for a missing pickup-code secret, captured
const errs = [];
const origErr = console.error;
console.error = (...a) => { errs.push(a.join(" ")); };

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
const flags = reqS("./config/featureFlags");
const surplusRoutes = reqS("./routes/surplus.routes");
const startupErrs = errs.splice(0);
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/surplus", surplusRoutes);
app.use("/api/career/ratings", reqS("./routes/careerRatings.routes"));
app.use("/api/career", reqS("./routes/careerTrial.routes"));
app.use("/api/career", reqS("./routes/career.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = { A: oid(), B: oid(), S: oid(), E: oid() };
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [user(ids.A, "admin", "admin"), user(ids.B, "brand", "alpha", { brandName: "Alpha", brandApprovalStatus: "approved" }), user(ids.S, "student", "sana"), user(ids.E, "employee", "hireco")]);
const tok = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, t) {
  return new Promise((resolve) => {
    const h = t ? { authorization: `Bearer ${t}` } : {};
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: { e: String(e) } }));
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  (" + detail + ")" : ""}`); };
const setEnv = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };

// one admin endpoint per pilot, and the flag behind it
const PILOTS = [
  { flag: "surplusBoxes", env: "FLAG_SURPLUS_BOXES", url: "/api/surplus/admin/cases", grantTo: "B" },
  { flag: "careerTimeline", env: "FLAG_CAREER_TIMELINE", url: "/api/career/admin/disputes", grantTo: "S" },
  { flag: "careerRatings", env: "FLAG_CAREER_RATINGS", url: "/api/career/ratings/admin/reports", grantTo: "E" },
  { flag: "employerFirstHireFree", env: "FLAG_EMPLOYER_FIRST_HIRE_FREE", url: "/api/career/admin/trials", grantTo: "E" },
];

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = tok("A", "admin");

  console.log("── 1. pilotConfigured: the old answer without admin access");
  for (const [v, want] of [[undefined, false], ["", false], ["off", false], ["false", false], ["0", false], ["no", false], ["\"off\"", false], ["on", true], ["ids:abc", true], ["roles:brand", true], ["25%", true], ["ids:", true], ["off;ids:abc", true], ["loyalty for alpha", true]]) {
    setEnv("FLAG_SURPLUS_BOXES", v);
    check(`FLAG_SURPLUS_BOXES=${v === undefined ? "(not set)" : JSON.stringify(v)} → ${want}`, flags.pilotConfigured("surplusBoxes") === want);
  }
  setEnv("FLAG_SURPLUS_BOXES", null);
  check("an unknown flag → false", flags.pilotConfigured("nope") === false);

  console.log("── 2. admin access counts as set up; the kill switch still wins");
  flags.setAdminAccess({ surplusBoxes: [String(ids.B)] });
  check("variable not set + one account with admin access → true", flags.pilotConfigured("surplusBoxes") === true);
  setEnv("FLAG_SURPLUS_BOXES", "off");
  check("kill switch + admin access → false", flags.pilotConfigured("surplusBoxes") === false);
  setEnv("FLAG_SURPLUS_BOXES", null);
  flags.setAdminAccess({});
  check("admin access removed → false again", flags.pilotConfigured("surplusBoxes") === false);
  flags.setAdminAccess({ loyaltyV2: [String(ids.B)] });
  check("admin access to another flag doesn't count", flags.pilotConfigured("surplusBoxes") === false);
  flags.setAdminAccess({});

  console.log("── 3. the admin routes of each pilot");
  for (const p of PILOTS) {
    setEnv(p.env, null); flags.setAdminAccess({});
    let r = await call("GET", p.url, T);
    check(`${p.flag}: not set, no admin access → 404`, r.status === 404, r.status);
    flags.setAdminAccess({ [p.flag]: [String(ids[p.grantTo])] });
    r = await call("GET", p.url, T);
    check(`${p.flag}: not set, admin access to one account → 200 (the admin page shows)`, r.status === 200, `${r.status} ${JSON.stringify(r.json?.error || "")}`);
    setEnv(p.env, "off");
    r = await call("GET", p.url, T);
    check(`${p.flag}: kill switch + admin access → 404`, r.status === 404, r.status);
    flags.setAdminAccess({});
    setEnv(p.env, "ids:");
    r = await call("GET", p.url, T);
    check(`${p.flag}: "ids:" (an empty list) → 200, as before`, r.status === 200, r.status);
    setEnv(p.env, "on");
    r = await call("GET", p.url, T);
    check(`${p.flag}: "on" → 200, as before`, r.status === 200, r.status);
    setEnv(p.env, null);
  }
  check("non-admins still can't use the admin routes (Surprise Box, brand with the flag on) → 403", (flags.setAdminAccess({ surplusBoxes: [String(ids.B)] }), (await call("GET", "/api/surplus/admin/cases", tok("B", "brand"))).status === 403));
  flags.setAdminAccess({});

  console.log("── 4. the pickup-code secret warning");
  check("at startup with nothing set: no warning", !startupErrs.some((l) => /pickup/i.test(l)), startupErrs.join(" | "));
  flags.setAdminAccess({ surplusBoxes: [String(ids.B)] });
  errs.length = 0;
  surplusRoutes.warnIfNoPickupSecret("after admin access loaded");
  check("set up only from the admin portal, no SURPLUS_CODE_SECRET: warned after admin access loads", errs.some((l) => /\[surplus\]/.test(l) && /after admin access loaded/.test(l)), errs.join(" | "));
  process.env.SURPLUS_CODE_SECRET = "test-only-surplus-code-secret-0123456789abcdef";
  errs.length = 0;
  surplusRoutes.warnIfNoPickupSecret("after admin access loaded");
  check("with the secret: no warning", errs.length === 0, errs.join(" | "));
  flags.setAdminAccess({});

  console.error = origErr;
  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error = origErr; console.error("FATAL", e); process.exit(1); });
