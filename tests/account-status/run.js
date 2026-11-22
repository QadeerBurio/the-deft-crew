// Account status enforcement (upgrade/p0-safety, plan P0-6), on in-memory data:
//   flag accountStatusEnforce OFF (default): suspended / banned accounts work exactly as before (requests and login)
//   flag ON (FLAG_ACCOUNT_STATUS_ENFORCE=on):
//     - banned, or suspended with no expiry / a future expiry: signed-in requests → 401 ACCOUNT_BANNED /
//       ACCOUNT_SUSPENDED (the app's existing 401 handling signs out); login with the right password → 403 with the
//       reason in message and error; a wrong password still only says "Invalid password" (no status leak)
//     - a suspension whose expiry has passed: allowed
//     - admins (suspended or banned): never locked out
//     - active, deactivated, guests: unaffected
//     - /signup/verify-otp for an already-verified banned account: 403, no token
//     - req.user carries the same fields as before (no accountStatus added for routes)
//   scripts/count-account-status.js: read-only counts by role, expired suspensions apart, admins listed
//   node tests/account-status/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["OtpCode", "University"] });
const { SERVER, reqS, app, call, check, oid, user, token, fake, coll } = h;
const bcrypt = reqS("bcryptjs");
const PW = "pass-1234";
const HASH = bcrypt.hashSync(PW, 4);
const DAY = 864e5;

// a probe route: what req.user looks like after the auth middleware
const auth = reqS("./middleware/auth.middleware");
let seenUser = null;
app.get("/api/__probe", auth, (req, res) => { seenUser = req.user; res.json({ ok: true }); });

const ids = { act: oid(), sus: oid(), susExp: oid(), susFut: oid(), ban: oid(), deact: oid(), adminSus: oid(), adminBan: oid() };
const u = (id, role, name, extra) => ({ ...user(id, role, name, extra), password: HASH, emailVerified: true });
fake.seed(coll("User"), [
  u(ids.act, "student", "Active Student", { accountStatus: "active" }),
  u(ids.sus, "student", "Suspended Student", { accountStatus: "suspended", suspensionReason: "rule break" }),
  u(ids.susExp, "student", "Expired Suspension", { accountStatus: "suspended", suspensionExpiry: new Date(Date.now() - DAY) }),
  u(ids.susFut, "brand", "Suspended Brand", { accountStatus: "suspended", suspensionExpiry: new Date(Date.now() + 3 * DAY), brandName: "Suspended Brand" }),
  u(ids.ban, "student", "Banned Student", { accountStatus: "banned" }),
  u(ids.deact, "student", "Deactivated Student", { accountStatus: "deactivated" }),
  u(ids.adminSus, "admin", "Admin Suspended", { accountStatus: "suspended" }),
  u(ids.adminBan, "admin", "Admin Banned", { accountStatus: "banned" }),
]);
const roleOf = { act: "student", sus: "student", susExp: "student", susFut: "brand", ban: "student", deact: "student", adminSus: "admin", adminBan: "admin" };
const T = Object.fromEntries(Object.keys(ids).map((k) => [k, token(ids[k], roleOf[k])]));
const emailOf = (name) => `${name.replace(/ /g, "").toLowerCase()}@test.local`;
const NAMES = { act: "Active Student", sus: "Suspended Student", susExp: "Expired Suspension", susFut: "Suspended Brand", ban: "Banned Student", deact: "Deactivated Student", adminSus: "Admin Suspended", adminBan: "Admin Banned" };
const probe = (k) => call("GET", "/api/__probe", { tok: k ? T[k] : null });
const login = (k, pw = PW) => call("POST", "/api/auth/login", { body: { email: emailOf(NAMES[k]), password: pw }, headers: { "x-forwarded-for": `198.51.100.${Object.keys(ids).indexOf(k) + 1}` } });

(async () => {
  const server = h.start();
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;

  console.log("-- flag off (default): nothing changes");
  for (const k of Object.keys(ids)) {
    const r = await probe(k);
    check(`off: ${k} → request allowed`, r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  }
  for (const k of ["sus", "ban", "act"]) {
    const r = await login(k);
    check(`off: ${k} → login gives a token`, r.status === 200 && !!r.json?.token, `${r.status} ${r.text.slice(0, 120)}`);
  }
  await probe("act");
  const before = Object.keys(seenUser || {}).sort().join(",");

  console.log("-- flag on");
  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
  let r = await probe("sus");
  check("suspended, no expiry: request → 401 ACCOUNT_SUSPENDED", r.status === 401 && r.json?.code === "ACCOUNT_SUSPENDED", r.text);
  check("…the reason is in message and error (older apps read either)", /paused/.test(r.json?.message || "") && r.json?.error === r.json?.message && /rule break/.test(r.json?.message || ""), r.text);
  r = await probe("susFut");
  check("suspended brand, expiry in 3 days: 401 with the end date", r.status === 401 && r.json?.code === "ACCOUNT_SUSPENDED" && !!r.json?.until && /until \d{4}-\d{2}-\d{2}/.test(r.json.message), r.text);
  r = await probe("ban");
  check("banned: request → 401 ACCOUNT_BANNED", r.status === 401 && r.json?.code === "ACCOUNT_BANNED", r.text);
  r = await probe("susExp");
  check("suspension already over: allowed", r.status === 200, r.text);
  for (const k of ["act", "deact", "adminSus", "adminBan"]) {
    r = await probe(k);
    check(`${k}: allowed`, r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  }
  r = await probe(null);
  check("guest: allowed", r.status === 200, r.text);
  await probe("act");
  check("req.user has exactly the same fields as with the flag off", Object.keys(seenUser || {}).sort().join(",") === before, `${before} vs ${Object.keys(seenUser || {}).sort().join(",")}`);
  check("…and no accountStatus / suspension fields", !("accountStatus" in seenUser) && !("suspensionExpiry" in seenUser) && !("suspensionReason" in seenUser));

  r = await login("sus");
  check("login, suspended, right password → 403 ACCOUNT_SUSPENDED, no token", r.status === 403 && r.json?.code === "ACCOUNT_SUSPENDED" && !r.json?.token && /paused/.test(r.json?.message || ""), r.text);
  r = await login("ban");
  check("login, banned, right password → 403 ACCOUNT_BANNED, no token", r.status === 403 && r.json?.code === "ACCOUNT_BANNED" && !r.json?.token, r.text);
  r = await login("ban", "wrong-password");
  check("login, banned, wrong password → only 'Invalid password' (status not revealed)", r.status === 401 && !r.json?.code && !/closed|paused/.test(r.text), r.text);
  r = await login("susExp");
  check("login, suspension over → token", r.status === 200 && !!r.json?.token, r.text.slice(0, 120));
  r = await login("adminBan");
  check("login, banned admin → token (admins are never locked out)", r.status === 200 && !!r.json?.token, r.text.slice(0, 120));
  r = await login("act");
  check("login, active → token", r.status === 200 && !!r.json?.token);

  r = await call("POST", "/api/auth/signup/verify-otp", { body: { userId: String(ids.ban), otp: "123456" } });
  check("verify-otp for a verified banned account → 403, no token", r.status === 403 && r.json?.code === "ACCOUNT_BANNED" && !r.json?.token, r.text);
  r = await call("POST", "/api/auth/signup/verify-otp", { body: { userId: String(ids.act), otp: "123456" } });
  check("verify-otp for a verified active account → signs in as before", r.status === 200 && !!r.json?.token, r.text.slice(0, 120));

  // appeals (P4-1 follow-up): SAFETY_APPEAL_EMAIL goes into the locked replies; unset or invalid = no field
  r = await login("ban");
  check("no SAFETY_APPEAL_EMAIL: no appealEmail in the reply", r.status === 403 && !("appealEmail" in (r.json || {})));
  process.env.SAFETY_APPEAL_EMAIL = "safety@gettdc.pk";
  r = await login("ban");
  check("SAFETY_APPEAL_EMAIL set: login 403 carries appealEmail", r.status === 403 && r.json?.appealEmail === "safety@gettdc.pk", r.text);
  r = await probe("sus");
  check("…and the 401 on a request too", r.status === 401 && r.json?.appealEmail === "safety@gettdc.pk", r.text);
  process.env.SAFETY_APPEAL_EMAIL = "not an address";
  r = await login("ban");
  check("an invalid address is never sent", r.status === 403 && !("appealEmail" in (r.json || {})));
  delete process.env.SAFETY_APPEAL_EMAIL;

  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "off";
  r = await probe("ban");
  check("kill switch (off) → banned allowed again at once", r.status === 200);
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;

  console.log("-- scripts/count-account-status.js (read only)");
  const { count } = reqS("./scripts/count-account-status.js");
  const User = reqS("./models/User");
  const writes = [];
  const origSave = User.prototype.save; User.prototype.save = function () { writes.push("save"); return origSave.apply(this, arguments); };
  const c = await count(User);
  User.prototype.save = origSave;
  check("counts: 3 running suspensions (student, brand, admin), 1 expired, 2 banned (student, admin)", c.suspendedRunning === 3 && c.suspendedExpired === 1 && c.banned === 2, JSON.stringify(c));
  check("by role: student {suspended 1, expired 1, banned 1}, brand {suspended 1}, admin {suspended 1, banned 1}",
    c.byRole.student?.suspended === 1 && c.byRole.student?.suspendedExpired === 1 && c.byRole.student?.banned === 1 && c.byRole.brand?.suspended === 1 && c.byRole.admin?.suspended === 1 && c.byRole.admin?.banned === 1, JSON.stringify(c.byRole));
  check("would be locked out (admins excluded): 3", c.wouldBeLockedOut === 3, c.wouldBeLockedOut);
  check("admins listed by id and name only", c.admins.length === 2 && c.admins.every((a) => a.id && a.name && !("email" in a)), JSON.stringify(c.admins));
  check("deactivated counted for information only", c.infoOnly.deactivated === 1);
  check("it wrote nothing", writes.length === 0);
  const src = fs.readFileSync(path.join(SERVER, "scripts/count-account-status.js"), "utf8");
  check("the script has no write call", !/\.(save|updateOne|updateMany|deleteOne|deleteMany|insertMany|create|findOneAndUpdate|findByIdAndUpdate|bulkWrite)\(/.test(src));
  check("it never prints MONGO_URI or e-mails", !/console\.(log|error)\([^)]*(process\.env\.MONGO_URI|email)/.test(src));

  h.finish(server);
})();
