// Phase A: admin access levels and the shared permission list (services/adminAccess.js, config/adminPermissions.js)
//   levels: an admin without adminAccess (every admin today) = every permission except team.manage; SUPER_ADMIN_IDS or
//     adminAccess.level "super" = every permission; a member = exactly its list; suspended = nothing; not an admin = none
//   decide: shadow mode (default) allows a member without the permission and logs it once per hour; enforced refuses
//   the list: groups (safety has its own), templates use real keys, "area.*" expands, a plain-language summary
//   the portal's copy (src/portal/adminPermissions.js) is byte for byte the server's
//   node tests/admin-access/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["AdminAccessShadow"] });
const { check, oid, rows, reqS, SERVER } = h;
const access = reqS("./services/adminAccess");
const P = reqS("./config/adminPermissions");

(async () => {
  console.log("-- the list");
  check(`${P.KEYS.length} permissions, each once, each in a known group`, new Set(P.KEYS).size === P.KEYS.length && P.PERMISSIONS.every((p) => P.GROUPS.some((g) => g.id === p.group)));
  check("safety is its own group (owner): safety.view, safety.act, identity.reveal", P.GROUPS.some((g) => g.id === "safety") && ["safety.view", "safety.act", "identity.reveal"].every((k) => P.PERMISSIONS.find((p) => p.key === k).group === "safety"));
  check("every template uses real keys; core team lacks team.manage, identity.reveal, students.delete; viewer only views, no PII", P.TEMPLATES.every((t) => t.permissions.every((k) => P.KEYS.includes(k))) && !P.TEMPLATES.find((t) => t.id === "core_team").permissions.some((k) => ["team.manage", "identity.reveal", "students.delete"].includes(k)) && P.TEMPLATES.find((t) => t.id === "viewer").permissions.every((k) => /\.view$/.test(k) && k !== "pii.view"));
  check("'brands.*' expands to every brands permission; unknown keys dropped", JSON.stringify(P.expand(["brands.*", "nope.x"])) === JSON.stringify(["brands.view", "brands.approve"]));
  check("a plain-language summary", /^can see brands; approve brands\. can't see full phone numbers/.test(P.describe(["brands.view", "brands.approve"])), P.describe(["brands.view", "brands.approve"]));
  const portal = path.join(SERVER, "..", "edu-boost", "src", "portal", "adminPermissions.js");
  if (fs.existsSync(portal)) check("the portal's copy is byte for byte the server's", fs.readFileSync(portal).equals(fs.readFileSync(path.join(SERVER, "config", "adminPermissions.js"))));
  else console.log("SKIP  the portal copy (edu-boost not next to the server)");

  console.log("-- levels");
  const legacy = { _id: oid(), role: "admin" };
  const sup = { _id: oid(), role: "admin", adminAccess: { level: "super", status: "active" } };
  const member = { _id: oid(), role: "admin", adminAccess: { level: "member", permissions: ["brands.*", "dashboard.view"], status: "active" } };
  const paused = { _id: oid(), role: "admin", adminAccess: { level: "member", permissions: ["brands.view"], status: "suspended" } };
  const student = { _id: oid(), role: "student" };
  check("an admin today: legacy, every permission except team.manage", access.levelOf(legacy) === "legacy" && access.has(legacy, "students.delete") && !access.has(legacy, "team.manage") && access.permissionsOf(legacy).length === P.KEYS.length - 1);
  check("adminAccess.level super: everything incl. team.manage", access.levelOf(sup) === "super" && access.has(sup, "team.manage"));
  process.env.SUPER_ADMIN_IDS = String(legacy._id);
  check("SUPER_ADMIN_IDS (SEC-2): super", access.levelOf(legacy) === "super" && access.has(legacy, "team.manage"));
  delete process.env.SUPER_ADMIN_IDS;
  check("a member: exactly its list ('brands.*' written out)", access.levelOf(member) === "member" && access.has(member, "brands.approve") && !access.has(member, "students.view") && access.permissionsOf(member).length === 3);
  check("suspended: nothing, even its own permission", access.levelOf(paused) === "suspended" && !access.decide(paused, "brands.view").allowed);
  check("not an admin: no level, no permission (the route's own checks decide)", access.levelOf(student) === null && !access.has(student, "students.view") && access.decide(student, "students.view").reason === "not_admin");

  console.log("-- shadow and enforced");
  let d = access.decide(member, "students.view", "GET /api/admin/users/all");
  await new Promise((r) => setTimeout(r, 30));
  check("shadow (default): the member is allowed, reason 'shadow', logged", d.allowed && d.reason === "shadow" && rows("AdminAccessShadow").length === 1 && rows("AdminAccessShadow")[0].permission === "students.view");
  access.decide(member, "students.view", "GET /api/admin/users/all");
  await new Promise((r) => setTimeout(r, 30));
  check("…the same again within the hour: logged once", rows("AdminAccessShadow").length === 1);
  process.env.FLAG_ADMIN_RBAC_ENFORCE = "on";
  d = access.decide(member, "students.view", "x");
  check("enforced: refused (missing_permission); with the permission: allowed", !d.allowed && d.reason === "missing_permission" && access.decide(member, "brands.view").allowed);
  check("adminCan(req): the caller on req.user", access.adminCan({ user: member, method: "GET", path: "/x" }, "brands.view") && !access.adminCan({ user: member, method: "GET", path: "/x" }, "students.view") && !access.adminCan({ user: student }, "students.view"));
  delete process.env.FLAG_ADMIN_RBAC_ENFORCE;
  check("the flag: server only, off by default", reqS("./config/featureFlags").FLAGS.adminRbacEnforce.client === false && !access.enforcing());
  h.finish({ close() {} });
})().catch((e) => { console.error(e); process.exit(1); });
