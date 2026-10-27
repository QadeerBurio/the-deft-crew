// Signup roles: public signup can create student, brand, traveler and employee accounts, never admin.
//   node tests/signup-roles/run.js [serverDir]
// Real auth routes and User model; only MongoDB (the in-memory layer from tests/hide-user-secrets/fake-mongo.js),
// e-mail, Expo and outgoing HTTP are replaced. No database, no network, no .env (run it from a folder without one).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of ["MONGO_URI", "MONGODB_URI"]) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
const mails = [];
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
  if (resolved.endsWith(path.join("utils", "mailer.js"))) {
    return { sendMail: async (m) => { mails.push(m); return { sent: true }; }, logMailerStatus: () => {}, mailProvider: "test" };
  }
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const express = reqS("express");
const User = reqS("./models/User");

const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json());
app.use("/api/auth", reqS("./routes/auth.routes"));

const results = [];
const check = (name, ok, detail = "") => { results.push({ ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

(async () => {
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const signup = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const pw = "Strong#Pass9";

  for (const [label, role] of [["admin", "admin"], ["Admin (case)", "Admin"], ["an unknown role", "superuser"]]) {
    const email = `${role.toLowerCase()}-try@test.local`;
    const r = await signup({ role, email, password: pw, fullName: "Someone" });
    const made = await User.findOne({ email }).lean();
    check(`signup as ${label} is refused`, r.status === 400 && r.json?.error === "Invalid role", `${r.status} ${r.json?.error || ""}`);
    check(`signup as ${label} creates no account`, !made);
  }
  const noRole = await signup({ email: "norole@test.local", password: pw, fullName: "No Role" });
  check("signup with no role is refused", noRole.status === 400);

  const cases = [
    ["student", { fullName: "Student New", universityName: "SZABIST", rollNo: "21K-1" }],
    ["brand", { brandName: "New Cafe" }],
    ["traveler", { fullName: "Trail Co" }],
    ["employee", { fullName: "Hiring Co" }],
  ];
  for (const [role, extra] of cases) {
    const email = `${role}-new@test.local`;
    const r = await signup({ role, email, password: pw, phone: "03001234567", city: "Karachi", ...extra });
    const made = await User.findOne({ email }).lean();
    check(`signup as ${role} still works`, r.status >= 200 && r.status < 300 && made?.role === role, `${r.status} role=${made?.role}`);
    check(`signup as ${role} is not marked Verified`, made && made.status !== "Verified", made?.status);
  }

  const admins = await User.find({ role: "admin" }).lean();
  check("no admin account exists after all signups", admins.length === 0, `${admins.length}`);

  server.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
