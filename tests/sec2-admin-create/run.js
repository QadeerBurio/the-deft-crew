// SEC-2 (owner): creating or promoting an admin through the API only for accounts in SUPER_ADMIN_IDS (empty = nobody)
//   POST /api/admin/users/create { role: "admin" }: listed → 201; not listed → 403 SUPER_ADMIN_REQUIRED, nothing made;
//     an empty list → refused for everyone; "Admin" (any case) counts
//   PUT /api/admin/users/role/:id: to admin, or changing an admin's role → the same rule; other roles as before
//   every attempt (allowed or refused) in AdminActionLog; other roles (brand, employee…) work for any admin
//   the create reply: the same shape, without the fields the User schema hides (push tokens, ID cards, webhook secret)
//   scripts/count-admins.js: read only; ids, created, last active, listed or not
//   node tests/sec2-admin-create/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/admin", "./routes/admin.routes"]], models: ["AdminActionLog", "EngagementProfile"] });
const { call, check, oid, user, token, fake, coll, rows, reqS, SERVER } = h;

const OWNER = oid(); const ADM = oid(); const S = oid(); const OTHER_ADMIN = oid();
fake.seed(coll("User"), [user(OWNER, "admin", "Owner Admin"), user(ADM, "admin", "Second Admin"), user(S, "student", "Sana Malik"), user(OTHER_ADMIN, "admin", "Third Admin")]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: ADM, stats: { lastActiveAt: new Date("2026-11-20T10:00:00Z") } }]);
const T = { owner: token(OWNER, "admin"), adm: token(ADM, "admin"), s: token(S, "student") };
const logs = (action) => rows("AdminActionLog", (r) => r.action === action);
const roleOf = (id) => rows("User", (u) => String(u._id) === String(id))[0]?.role;
const body = (email, role) => ({ name: "New Person", email, password: "Strong#Pass9", role });

(async () => {
  const server = h.start();
  console.log("-- SUPER_ADMIN_IDS empty: nobody");
  let r = await call("POST", "/api/admin/users/create", { tok: T.owner, body: body("a1@test.local", "admin") });
  check("create an admin with an empty list: 403 SUPER_ADMIN_REQUIRED, nothing made", r.status === 403 && r.json.code === "SUPER_ADMIN_REQUIRED" && !rows("User", (u) => u.email === "a1@test.local").length, r.text);
  check("…logged as refused (empty list)", logs("admin.create").length === 1 && /empty/.test(logs("admin.create")[0].reason) && String(logs("admin.create")[0].admin) === String(OWNER));
  r = await call("PUT", `/api/admin/users/role/${S}`, { tok: T.owner, body: { role: "admin" } });
  check("promote a student with an empty list: 403, still a student, logged", r.status === 403 && roleOf(S) === "student" && logs("admin.promote").length === 1);

  console.log("-- the owner listed");
  process.env.SUPER_ADMIN_IDS = ` "${OWNER}" `;
  r = await call("POST", "/api/admin/users/create", { tok: T.adm, body: body("a2@test.local", "admin") });
  check("escalation: an admin not on the list can't create an admin (403, nothing made)", r.status === 403 && !rows("User", (u) => u.email === "a2@test.local").length);
  r = await call("POST", "/api/admin/users/create", { tok: T.adm, body: body("a3@test.local", "Admin") });
  check("…not with 'Admin' either", r.status === 403 && !rows("User", (u) => u.email === "a3@test.local").length);
  r = await call("PUT", `/api/admin/users/role/${S}`, { tok: T.adm, body: { role: "admin" } });
  check("escalation: …nor promote a student to admin", r.status === 403 && roleOf(S) === "student");
  r = await call("PUT", `/api/admin/users/role/${OTHER_ADMIN}`, { tok: T.adm, body: { role: "student" } });
  check("…nor demote another admin", r.status === 403 && roleOf(OTHER_ADMIN) === "admin" && logs("admin.demote").length === 1);
  r = await call("POST", "/api/admin/users/create", { tok: T.owner, body: body("a4@test.local", "Admin") });
  const made = rows("User", (u) => u.email === "a4@test.local")[0];
  check("the owner (listed) creates an admin: 201, role admin", r.status === 201 && made?.role === "admin", r.text);
  check("…logged as allowed with the new account's id", logs("admin.create").some((l) => /allowed/.test(l.reason) && l.targetId === String(made?._id)));
  r = await call("PUT", `/api/admin/users/role/${S}`, { tok: T.owner, body: { role: "admin" } });
  check("the owner promotes a student: 200, now admin, logged before/after", r.status === 200 && roleOf(S) === "admin" && logs("admin.promote").some((l) => /allowed/.test(l.reason) && l.before.role === "student" && l.after.role === "admin"));

  console.log("-- other roles as before");
  r = await call("POST", "/api/admin/users/create", { tok: T.adm, body: body("b1@test.local", "brand") });
  check("the create reply keeps its shape (message, user with name / email / role) without the hidden fields", r.status === 201 && r.json.message === "User created successfully" && r.json.user.email === "b1@test.local" && r.json.user.role === "brand" && !("pushTokens" in r.json.user) && !("webhookSecret" in r.json.user) && !("password" in r.json.user), r.text.slice(0, 200));
  check("any admin creates a brand: 201, not logged as an admin action", r.status === 201 && rows("User", (u) => u.email === "b1@test.local")[0]?.role === "brand" && !logs("admin.create").some((l) => l.targetId === String(rows("User", (u) => u.email === "b1@test.local")[0]._id)));
  r = await call("POST", "/api/admin/users/create", { tok: T.adm, body: { name: "E", email: "e1@test.local", password: "Strong#Pass9" } });
  check("…no role → employee, as before", r.status === 201 && rows("User", (u) => u.email === "e1@test.local")[0]?.role === "employee");
  const B = rows("User", (u) => u.email === "b1@test.local")[0]._id;
  r = await call("PUT", `/api/admin/users/role/${B}`, { tok: T.adm, body: { role: "employee" } });
  check("any admin changes brand → employee", r.status === 200 && roleOf(B) === "employee");
  r = await call("PUT", `/api/admin/users/role/${B}`, { tok: T.adm, body: { role: "boss" } });
  check("an invalid role: 400, as before", r.status === 400);
  r = await call("POST", "/api/admin/users/create", { tok: T.s, body: body("x@test.local", "admin") });
  check("a student: 403 (not an admin), as before", r.status === 403 && !rows("User", (u) => u.email === "x@test.local").length);
  process.env.SUPER_ADMIN_IDS = "not-an-id, ;";
  r = await call("POST", "/api/admin/users/create", { tok: T.owner, body: body("a5@test.local", "admin") });
  check("a list without a valid id counts as empty: refused", r.status === 403);
  delete process.env.SUPER_ADMIN_IDS;

  console.log("-- scripts/count-admins.js");
  const before = JSON.stringify([rows("User"), rows("EngagementProfile")]);
  const { count } = reqS("./scripts/count-admins");
  const c = await count({ User: reqS("./models/User"), EngagementProfile: reqS("./models/EngagementProfile") }, new Set([String(OWNER).toLowerCase()]));
  const adm = c.admins.find((a) => a.id === String(ADM));
  check("counts every admin (4 now: 3 seeded + the owner's new one + the promoted student = 5)", c.total === 5, String(c.total));
  check("…created dates, last active when known, the listed one marked", adm.lastActiveAt && c.admins.find((a) => a.id === String(OWNER)).superAdmin === true && adm.superAdmin === false && c.admins.every((a) => a.createdAt));
  check("…wrote nothing", JSON.stringify([rows("User"), rows("EngagementProfile")]) === before);
  const src = fs.readFileSync(path.join(SERVER, "scripts", "count-admins.js"), "utf8");
  check("…read only, refuses without MONGO_URI, never prints names / e-mails", !/\.(save|create|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\(/.test(src) && /Refusing to run: MONGO_URI is not set/.test(src) && !/select\([^)]*(name|email|phone)/.test(src));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
