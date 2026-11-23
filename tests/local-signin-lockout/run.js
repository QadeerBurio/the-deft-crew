// Suspended / banned accounts on the two route files with their own sign-in (owner, Phase A sign-off): jobs.routes.js
// and auth.routes.js now apply the same rule as middleware/auth.middleware.js (plan P0-6, flag accountStatusEnforce).
//   flag off: everyone signs in as before (a suspended account too)
//   flag on: a running suspension → 401 ACCOUNT_SUSPENDED, a ban → 401 ACCOUNT_BANNED (the reason, the appeal
//   address); an expired suspension, an active account and an admin pass
//   node tests/local-signin-lockout/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]] });
const { call, check, oid, user, token, fake, coll } = h;

const E = oid(); const ES = oid(); const EB = oid(); const EX = oid(); const A = oid(); const SS = oid();
fake.seed(coll("User"), [
  user(E, "employee", "Emp Active", { companyName: "Hire Co" }),
  user(ES, "employee", "Emp Paused", { companyName: "Hire Co", accountStatus: "suspended", suspensionExpiry: new Date(Date.now() + 86400e3), suspensionReason: "spam jobs" }),
  user(EB, "employee", "Emp Banned", { companyName: "Hire Co", accountStatus: "banned", suspensionReason: "fake company" }),
  user(EX, "employee", "Emp Expired", { companyName: "Hire Co", accountStatus: "suspended", suspensionExpiry: new Date(Date.now() - 86400e3) }),
  user(A, "admin", "Ada Admin", { accountStatus: "banned" }),
  user(SS, "student", "Stu Paused", { accountStatus: "suspended", suspensionExpiry: new Date(Date.now() + 86400e3), suspensionReason: "rules" }),
]);
const T = Object.fromEntries(Object.entries({ E, ES, EB, EX, A, SS }).map(([k, id]) => [k, token(id, k.startsWith("A") ? "admin" : k === "SS" ? "student" : "employee")]));
const jobs = (tok) => call("GET", "/api/jobs/stats", { tok });
const me = (id, tok) => call("GET", `/api/auth/${id}`, { tok });

(async () => {
  const server = h.start();
  console.log("-- flag off (as before)");
  check("jobs.routes: a suspended employer signs in as before", (await jobs(T.ES)).status === 200);
  check("auth.routes: a suspended student reads their own profile as before", (await me(SS, T.SS)).status === 200);

  console.log("-- flag on");
  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
  let r = await jobs(T.ES);
  check("jobs.routes: a running suspension → 401 ACCOUNT_SUSPENDED with the reason", r.status === 401 && r.json.code === "ACCOUNT_SUSPENDED" && /spam jobs/.test(JSON.stringify(r.json)), r.text);
  r = await jobs(T.EB);
  check("jobs.routes: a ban → 401 ACCOUNT_BANNED", r.status === 401 && r.json.code === "ACCOUNT_BANNED", r.text);
  check("jobs.routes: an expired suspension, an active account, an admin (even marked banned) pass", (await jobs(T.EX)).status === 200 && (await jobs(T.E)).status === 200 && (await jobs(T.A)).status !== 401);
  r = await me(SS, T.SS);
  check("auth.routes' own sign-in: a running suspension → 401 ACCOUNT_SUSPENDED", r.status === 401 && r.json.code === "ACCOUNT_SUSPENDED", r.text);
  check("auth.routes: an active account passes", (await me(E, T.E)).status === 200);
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;
  check("flag off again: as before", (await jobs(T.ES)).status === 200);
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
