// services/superAdmin.js
// SEC-2 (owner): who may create or promote an admin through the API. Only the accounts listed in SUPER_ADMIN_IDS
// (comma / space separated user ids). Empty or unset → nobody (fail closed). Every attempt, allowed or refused, is
// logged in AdminActionLog. Other roles (brand, employee, student, traveler) are unaffected: any admin, as before.
// Phase A replaces this list with adminAccess.level = 'super'.
const adminLog = require("./adminActionLog");

const unquote = (s) => String(s).trim().replace(/^["'“”‘’\s]+/, "").replace(/["'“”‘’\s]+$/, "");
/** The listed ids (never logged) */
function ids() {
  return new Set(unquote(process.env.SUPER_ADMIN_IDS || "").split(/[\s,;]+/).map(unquote).filter((x) => /^[0-9a-f]{24}$/i.test(x)).map((x) => x.toLowerCase()));
}
const isSuperAdmin = (userId) => !!userId && ids().has(String(userId).toLowerCase());
/** Phase A: may this account create / promote / demote admins? A super admin: SUPER_ADMIN_IDS or adminAccess.level super */
async function canManageAdmins(userId) {
  if (isSuperAdmin(userId)) return true;
  if (!/^[0-9a-f]{24}$/i.test(String(userId || ""))) return false;
  const u = await require("../models/User").findById(userId).select("role adminAccess").lean();
  return require("./adminAccess").levelOf(u) === "super";
}

/**
 * Log an attempt to create / promote / demote an admin. entry: { req, action, targetId, before, after, allowed }
 * Never throws (a failed log line never blocks the decision; it is printed instead).
 */
async function logAttempt({ req, action, targetId, before = null, after = null, allowed }) {
  await adminLog.recordSafe({
    admin: req.userId,
    action,
    targetType: "User",
    targetId: String(targetId || "new"),
    before,
    after,
    reason: allowed ? "allowed: a super admin" : (ids().size ? "refused: not listed in SUPER_ADMIN_IDS" : "refused: SUPER_ADMIN_IDS is empty (nobody may create admins)"),
  });
}

const REFUSED = { code: "SUPER_ADMIN_REQUIRED", message: "only a super admin can create, promote or demote admin accounts." };

module.exports = { ids, isSuperAdmin, canManageAdmins, logAttempt, REFUSED };
