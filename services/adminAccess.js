// services/adminAccess.js
// Plan Phase A: what an admin account may do. Every admin keeps User.role "admin"; the optional User.adminAccess
// narrows it. Levels:
//   super   SUPER_ADMIN_IDS (SEC-2) or adminAccess.level "super": every permission, incl. team.manage
//   legacy  an admin without adminAccess (every admin today): every permission except team.manage (owner: making
//           admins stays with the listed / explicit super admins; nobody loses anything else)
//   member  adminAccess.level "member": exactly adminAccess.permissions (config/adminPermissions.js)
//   suspended  adminAccess.status "suspended": nothing (always enforced: only a super admin sets it)
// Shadow mode (flag adminRbacEnforce off, the default): a member without the permission is still allowed and the
// "would deny" is logged (AdminAccessShadow, 30 days) for review; on: refused (403 ADMIN_PERMISSION_REQUIRED).
const perms = require("../config/adminPermissions");

const ADMIN_ROLE = "admin";
/** Is this account an admin account (the role, nothing about its permissions)? For checks on a target account. */
const isAdminAccount = (user) => !!user && user.role === ADMIN_ROLE;

function superIds() {
  try { return require("./superAdmin").ids(); } catch { return new Set(); }
}

/** "super" | "legacy" | "member" | "suspended" | null (not an admin) */
function levelOf(user) {
  if (!isAdminAccount(user)) return null;
  const a = user.adminAccess;
  if (a && a.status === "suspended") return "suspended";
  if (superIds().has(String(user._id || user.id || "").toLowerCase())) return "super";
  if (!a || !a.level) return "legacy";
  return a.level === "super" ? "super" : "member";
}

/** The account's permissions, written out */
function permissionsOf(user) {
  const level = levelOf(user);
  if (level === "super") return perms.KEYS.slice();
  if (level === "legacy") return perms.KEYS.filter((k) => k !== "team.manage");
  if (level === "member") return perms.expand(user.adminAccess.permissions || []);
  return [];
}

function has(user, permission) {
  const level = levelOf(user);
  if (level === "super") return true;
  if (level === "legacy") return permission !== "team.manage";
  if (level === "member") return permissionsOf(user).includes(permission);
  return false;
}

const enforcing = () => require("../config/featureFlags").isEnabled("adminRbacEnforce", null);

// shadow log: one row per admin + permission + route per hour (memory dedupe)
const seen = new Map();
function logShadow(user, permission, where) {
  const key = `${user._id}|${permission}|${where}`;
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < 60 * 60 * 1000) return;
  seen.set(key, now);
  console.warn(`[admin-access] shadow: would deny ${permission} for admin ${String(user._id).slice(-6)} on ${where}`);
  Promise.resolve()
    .then(() => require("../models/AdminAccessShadow").create({ admin: user._id, permission, where: String(where).slice(0, 120) }))
    .catch((e) => console.warn("[admin-access] shadow log failed:", e.message));
}

/**
 * May this admin use this permission here? → { allowed, reason }  (not an admin: { allowed: false, reason: "not_admin" })
 * Shadow mode: a member without it is allowed (reason "shadow") and logged.
 */
function decide(user, permission, where = "") {
  const level = levelOf(user);
  if (!level) return { allowed: false, reason: "not_admin" };
  if (level === "suspended") return { allowed: false, reason: "suspended" };
  if (has(user, permission)) return { allowed: true, reason: level };
  if (!enforcing()) { logShadow(user, permission, where); return { allowed: true, reason: "shadow" }; }
  return { allowed: false, reason: "missing_permission" };
}

/** Is the caller an admin with this permission (shadow: allowed + logged)? For admin powers inside a handler. */
function adminCan(req, permission) {
  const user = req.user && req.user.role ? req.user : (req.userRole === ADMIN_ROLE ? { _id: req.userId, role: ADMIN_ROLE } : null);
  if (!isAdminAccount(user)) return false;
  return decide(user, permission, `${req.method} ${req.baseUrl || ""}${req.route?.path || req.path || ""}`).allowed;
}

/** The same for a user record a handler already loaded (it must carry role and adminAccess) */
function adminAllowed(user, permission, where = "") {
  return isAdminAccount(user) && decide(user, permission, where).allowed;
}

/** Is this account id an admin with this permission? Loads role + adminAccess itself (never trusts a narrow select). */
async function allowedFor(userId, permission, where = "") {
  const id = String(userId || "");
  if (!/^[0-9a-f]{24}$/i.test(id)) return false;
  const u = await require("../models/User").findById(id).select("role adminAccess").lean();
  return adminAllowed(u, permission, where);
}

/** The caller (role + adminAccess), from req.user when it has them, else from the database. null: signed out */
async function callerOf(req) {
  if (req.user && req.user.role && ("adminAccess" in req.user || req.user.role !== ADMIN_ROLE || typeof req.user.get === "function")) return req.user;
  const id = String(req.userId || "");
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  return require("../models/User").findById(id).select("role adminAccess").lean();
}

module.exports = { ADMIN_ROLE, isAdminAccount, levelOf, permissionsOf, has, decide, adminCan, adminAllowed, allowedFor, callerOf, enforcing, _test: { seen } };
