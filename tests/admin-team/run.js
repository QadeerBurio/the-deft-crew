// Phase A: team & access (A-6), an admin's own access (A-7) and admin sessions (A-8).
//   /api/admin/me/access: level, permissions, groups for any admin; a paused member → 403 ADMIN_ACCESS_SUSPENDED
//   /api/admin/team: super admins only, always (team.manage is never shadowed: an admin today gets 403)
//   invite → a member with the template's permissions (never team.manage) + a 72-hour link; accept-invite sets the
//     password once; access edits; nobody edits themselves; levels: one super applies directly, two → a pending change
//     another super confirms; the last super can't be demoted or suspended; suspend ends sessions and pauses access;
//     restore; remove; activity; templates; shadow log; every change in AdminActionLog
//   sessions (adminSessionsV1): off → admins sign in as today; on → a new device gets a code, a known device a token,
//     12 hours idle ends it, a token without a session or a revoked one is refused (also on jobs.routes' own sign-in),
//     students unaffected; history; sign out everywhere
//   node tests/admin-team/run.js [serverDir]
const crypto = require("crypto");
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/admin/team", "./routes/adminTeam.routes"], ["/api/admin/me", "./routes/adminMe.routes"], ["/api/auth", "./routes/auth.routes"], ["/api/admin", "./routes/admin.routes"]],
  models: ["AdminInvite", "AdminRoleTemplate", "AdminAccessChange", "AdminAccessShadow", "AdminActionLog", "AdminSession", "OtpCode"],
});
const { call, check, oid, user, token, fake, coll, rows, reqS } = h;
const bcrypt = reqS("bcryptjs");
const PW = "Admin#Pass9";
const hashPw = bcrypt.hashSync(PW, 4);

const SUP = oid(); const SUP2 = oid(); const LEG = oid(); const MEM = oid(); const STU = oid();
fake.seed(coll("User"), [
  user(SUP, "admin", "Sara Super", { password: hashPw }),
  user(SUP2, "admin", "Sam Second", { password: hashPw }),
  user(LEG, "admin", "Leo Legacy", { password: hashPw }),
  user(MEM, "admin", "Mia Member", { password: hashPw, adminAccess: { level: "member", roleTemplate: "brand_partnerships", permissions: ["brands.view", "brands.approve"], status: "active" } }),
  user(STU, "student", "Stu Dent", { password: hashPw, emailVerified: true }),
]);
process.env.SUPER_ADMIN_IDS = String(SUP);
const T = { SUP: token(SUP, "admin"), SUP2: token(SUP2, "admin"), LEG: token(LEG, "admin"), MEM: token(MEM, "admin"), STU: token(STU, "student") };
const logs = (action) => rows("AdminActionLog", (r) => r.action === action);
const acc = (id) => rows("User", (u) => String(u._id) === String(id))[0]?.adminAccess || null;

(async () => {
  const server = h.start();
  console.log("-- my access");
  let r = await call("GET", "/api/admin/me/access", { tok: T.MEM });
  check("a member: level member, its permissions, the groups (safety its own)", r.status === 200 && r.json.data.level === "member" && JSON.stringify(r.json.data.permissions) === '["brands.view","brands.approve"]' && r.json.data.groups.some((g) => g.id === "safety"), r.text.slice(0, 200));
  r = await call("GET", "/api/admin/me/access", { tok: T.LEG });
  check("an admin today: legacy, everything but team.manage", r.json.data.level === "legacy" && !r.json.data.permissions.includes("team.manage") && r.json.data.permissions.length === 39);
  r = await call("GET", "/api/admin/me/access", { tok: T.STU });
  check("a student: 403", r.status === 403);

  console.log("-- the team page: super admins only, never shadowed");
  r = await call("GET", "/api/admin/team", { tok: T.LEG });
  check("an admin today (no team.manage): 403 even in shadow mode", r.status === 403 && r.json.code === "ADMIN_PERMISSION_REQUIRED");
  r = await call("GET", "/api/admin/team", { tok: T.SUP });
  check("the super admin: every admin account with level and summary", r.status === 200 && r.json.data.length === 4 && r.json.data.find((m) => m.id === String(SUP)).level === "super" && r.json.data.find((m) => m.id === String(MEM)).summary.startsWith("can "));

  console.log("-- invite");
  r = await call("POST", "/api/admin/team/invite", { tok: T.SUP, body: { name: "Nia New", email: "nia@test.local", template: "employer_success", permissions: ["employers.view", "team.manage"], note: "employer success" } });
  const nia = rows("User", (u) => u.email === "nia@test.local")[0];
  check("invite: an admin member with the given permissions, team.manage dropped", r.status === 200 && nia?.role === "admin" && nia.adminAccess.level === "member" && JSON.stringify(nia.adminAccess.permissions) === '["employers.view"]' && String(nia.adminAccess.invitedBy) === String(SUP), r.text.slice(0, 200));
  check("…a 72-hour invitation (hash only) and a log row", rows("AdminInvite").length === 1 && rows("AdminInvite")[0].tokenHash.length === 64 && logs("team.invite").length === 1);
  r = await call("POST", "/api/admin/team/invite", { tok: T.SUP, body: { name: "Dup", email: "stu@test.local".replace("stu", "studdent"), template: "super" } });
  check("a super template can't be invited (supers are made from the list)", r.status === 400);
  r = await call("POST", "/api/admin/team/invite", { tok: T.SUP, body: { name: "Again", email: rows("User", (u) => String(u._id) === String(STU))[0].email, template: "viewer" } });
  check("an e-mail that has an account: 409 (no silent promotion)", r.status === 409);
  const raw = crypto.randomBytes(32).toString("hex");
  fake.STORE.get(coll("AdminInvite"))[0].tokenHash = crypto.createHash("sha256").update(raw).digest("hex"); // the e-mailed token
  r = await call("POST", "/api/auth/admin/accept-invite", { body: { token: raw, password: "short" } });
  check("accept: a short password refused", r.status === 400);
  r = await call("POST", "/api/auth/admin/accept-invite", { body: { token: raw, password: "Nia#Pass99" } });
  const niaNow = rows("User", (u) => u.email === "nia@test.local")[0];
  check("accept: the password is set, the invitation used", r.status === 200 && bcrypt.compareSync("Nia#Pass99", niaNow.password) && !!rows("AdminInvite")[0].usedAt);
  r = await call("POST", "/api/auth/admin/accept-invite", { body: { token: raw, password: "Other#Pass99" } });
  check("…a second use: refused", r.status === 400);

  console.log("-- access, levels, safety rules");
  r = await call("PUT", `/api/admin/team/${MEM}/access`, { tok: T.SUP, body: { permissions: ["brands.*", "team.manage", "offers.manage"] } });
  check("edit a member: brands.* written out, team.manage dropped, logged with before / after", r.status === 200 && JSON.stringify(acc(MEM).permissions) === '["brands.view","brands.approve","offers.manage"]' && logs("team.access").some((l) => l.before.permissions.length === 2 && l.after.permissions.length === 3));
  r = await call("PUT", `/api/admin/team/${LEG}/access`, { tok: T.SUP, body: { template: "viewer" } });
  check("an admin today becomes a member with a template", r.status === 200 && acc(LEG).level === "member" && acc(LEG).roleTemplate === "viewer" && acc(LEG).permissions.every((k) => /\.view$/.test(k)));
  r = await call("PUT", `/api/admin/team/${SUP}/access`, { tok: T.SUP, body: { permissions: [] } });
  check("nobody edits their own access", r.status === 400 && r.json.code === "SELF");
  r = await call("POST", `/api/admin/team/${SUP}/level`, { tok: T.SUP, body: { level: "member" } });
  check("…nor their own level", r.status === 400 && r.json.code === "SELF");
  r = await call("POST", `/api/admin/team/${SUP2}/level`, { tok: T.SUP, body: { level: "super", reason: "co-founder" } });
  check("one super: making a second super applies at once", r.status === 200 && acc(SUP2).level === "super");
  r = await call("POST", `/api/admin/team/${MEM}/level`, { tok: T.SUP, body: { level: "super", reason: "lead" } });
  const pending = rows("AdminAccessChange")[0];
  check("two supers: a new super waits for another super (202)", r.status === 202 && pending?.status === "pending" && acc(MEM).level === "member");
  r = await call("POST", `/api/admin/team/changes/${pending._id}/confirm`, { tok: T.SUP });
  check("…the requester can't confirm their own request", r.status === 400 && r.json.code === "SECOND_SUPER_NEEDED");
  r = await call("POST", `/api/admin/team/changes/${pending._id}/cancel`, { tok: T.SUP2 });
  check("…the second super cancels it: nothing changes", r.json.data.cancelled === true && acc(MEM).level === "member");
  r = await call("POST", `/api/admin/team/${SUP2}/level`, { tok: T.SUP, body: { level: "member", reason: "step back" } });
  const ch2 = rows("AdminAccessChange", (c) => c.status === "pending")[0];
  r = await call("POST", `/api/admin/team/changes/${ch2._id}/confirm`, { tok: T.SUP2 });
  check("the target can't confirm a change to themselves", r.status === 400 && r.json.code === "SELF");
  await call("POST", `/api/admin/team/changes/${ch2._id}/cancel`, { tok: T.SUP });
  delete process.env.SUPER_ADMIN_IDS; // SUP2 is now the only explicit super (SUP was super through the list)
  r = await call("POST", `/api/admin/team/${SUP2}/suspend`, { tok: T.SUP2, body: { reason: "test" } });
  check("…and can't suspend themselves", r.status === 400);
  process.env.SUPER_ADMIN_IDS = String(SUP);

  console.log("-- suspend, restore, remove");
  r = await call("POST", `/api/admin/team/${MEM}/suspend`, { tok: T.SUP, body: {} });
  check("suspend needs a reason", r.status === 400);
  r = await call("POST", `/api/admin/team/${MEM}/suspend`, { tok: T.SUP, body: { reason: "left the brand team" } });
  check("suspended: status, reason, logged", r.status === 200 && acc(MEM).status === "suspended" && acc(MEM).suspendedReason === "left the brand team" && logs("team.suspend").length === 1);
  r = await call("GET", "/api/brand-approval/stats", { tok: T.MEM });
  r = await call("GET", "/api/admin/me/access", { tok: T.MEM });
  check("…their next request: 403 ADMIN_ACCESS_SUSPENDED", r.status === 403 && r.json.code === "ADMIN_ACCESS_SUSPENDED");
  r = await call("POST", `/api/admin/team/${MEM}/restore`, { tok: T.SUP });
  check("restore: active again", r.status === 200 && acc(MEM).status === "active");
  r = await call("POST", `/api/admin/team/${LEG}/remove`, { tok: T.SUP, body: { reason: "left tdc" } });
  check("remove: paused for good, marked removed", r.status === 200 && acc(LEG).status === "suspended" && !!acc(LEG).removedAt);
  r = await call("GET", `/api/admin/team/${SUP}/activity`, { tok: T.SUP });
  check("activity: the super admin's own log rows", r.status === 200 && r.json.data.length >= 6 && r.json.data.every((x) => String(x.admin) === String(SUP)));
  r = await call("POST", "/api/admin/team/templates", { tok: T.SUP, body: { key: "campus_lead", label: "campus lead", permissions: ["students.view", "events.manage", "team.manage"] } });
  check("a new template (team.manage dropped)", r.status === 200 && r.json.data.key === "campus_lead" && JSON.stringify(r.json.data.permissions) === '["students.view","events.manage"]');
  r = await call("GET", "/api/admin/team/templates", { tok: T.SUP });
  check("templates: the 9 built-in + the new one", r.json.data.length === 10);
  r = await call("GET", "/api/admin/team/shadow", { tok: T.SUP });
  check("the shadow log endpoint answers (enforcing false)", r.status === 200 && r.json.data.enforcing === false && Array.isArray(r.json.data.items));

  console.log("-- sessions (adminSessionsV1)");
  const sess = reqS("./services/adminSessions");
  const login = (email, device) => call("POST", "/api/auth/login", { body: { email, password: PW, ...(device ? { deviceId: device } : {}) } }); // the portal sends it in the body
  const supEmail = rows("User", (u) => String(u._id) === String(SUP))[0].email;
  r = await login(supEmail, "device-aaaaaaaaaaaaaaaa");
  check("flag off: an admin signs in as today (a token, no code)", r.status === 200 && !!r.json.token && !r.json.requiresAdminCode);
  const oldToken = r.json.token;
  process.env.FLAG_ADMIN_SESSIONS_V1 = "on";
  r = await call("GET", "/api/admin/me/access", { tok: oldToken });
  check("flag on: a token from before (no session) → 401 ADMIN_SESSION_REQUIRED", r.status === 401 && r.json.code === "ADMIN_SESSION_REQUIRED");
  r = await login(supEmail, "device-aaaaaaaaaaaaaaaa");
  check("a new device: no token, a code e-mailed", r.status === 200 && r.json.requiresAdminCode === true && !r.json.token && /••@/.test(r.json.email));
  const sid = r.json.sessionId;
  fake.STORE.get(coll("OtpCode")).find((o) => o.purpose === "admin-login").codeHash = sess._test.hash(`otp:${sid}:123456`);
  r = await call("POST", "/api/auth/admin/verify-code", { body: { sessionId: sid, code: "654321" } });
  check("a wrong code: 400, tries counted", r.status === 400 && /tries left/.test(r.json.message));
  r = await call("POST", "/api/auth/admin/verify-code", { body: { sessionId: sid, code: "123456" } });
  const tok1 = r.json.token;
  check("the right code: a token with the session id", r.status === 200 && !!tok1 && JSON.parse(Buffer.from(tok1.split(".")[1], "base64")).sid === sid);
  r = await call("GET", "/api/admin/me/access", { tok: tok1 });
  check("…it works", r.status === 200);
  r = await call("GET", "/api/jobs/admin/skills-report", { tok: oldToken });
  check("…a route file's own sign-in (jobs) refuses the session-less token too", r.status === 401 && r.json.code === "ADMIN_SESSION_REQUIRED");
  r = await login(supEmail, "device-aaaaaaaaaaaaaaaa");
  check("the same device again: a token at once (known for 30 days)", r.status === 200 && !!r.json.token && !r.json.requiresAdminCode);
  const tok2 = r.json.token;
  const s2 = JSON.parse(Buffer.from(tok2.split(".")[1], "base64")).sid;
  fake.STORE.get(coll("AdminSession")).find((s) => String(s._id) === s2).lastSeenAt = new Date(Date.now() - 13 * 3600e3);
  r = await call("GET", "/api/admin/me/access", { tok: tok2 });
  check("13 hours without activity: 401 ADMIN_SESSION_IDLE, and the session is ended", r.status === 401 && r.json.code === "ADMIN_SESSION_IDLE" && !!fake.STORE.get(coll("AdminSession")).find((s) => String(s._id) === s2).revokedAt);
  r = await call("GET", "/api/admin/me/sessions", { tok: tok1 });
  check("login history: the sessions, newest first, no hashes", r.status === 200 && r.json.data.length >= 2 && !JSON.stringify(r.json.data).match(/deviceHash|ipHash/) && r.json.data.some((x) => x.endedBecause === "idle"), r.text.slice(0, 400));
  r = await call("POST", "/api/admin/me/sessions/end", { tok: tok1 });
  r = await call("GET", "/api/admin/me/access", { tok: tok1 });
  check("sign out everywhere: this token too → 401 ADMIN_SESSION_ENDED", r.status === 401 && r.json.code === "ADMIN_SESSION_ENDED");
  const stuEmail = rows("User", (u) => String(u._id) === String(STU))[0].email;
  r = await login(stuEmail, "device-aaaaaaaaaaaaaaaa");
  check("a student signs in as before (no code, no session)", r.status === 200 && !!r.json.token && !r.json.requiresAdminCode);
  delete process.env.FLAG_ADMIN_SESSIONS_V1;
  r = await call("GET", "/api/admin/me/access", { tok: oldToken });
  check("flag off again: the old token works as before", r.status === 200);
  delete process.env.SUPER_ADMIN_IDS;
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
