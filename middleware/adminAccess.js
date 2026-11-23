// middleware/adminAccess.js
// Plan Phase A (A-4): permissions on admin routes, without touching the routes' own checks.
//   permit("offers.manage")             a middleware: an admin caller needs the permission (services/adminAccess.js);
//                                       anyone else passes through to the route's own checks, exactly as before.
//                                       Tagged (fn.permission) so a test can find routes without one.
//   applyPermissions(router, map, file) puts permit(...) into each listed route right after sign-in, e.g.
//                                       { "GET /users/all": "students.view", "DELETE /users/:id": "students.delete" };
//                                       throws at startup when a listed route doesn't exist (a typo can't hide a route)
// A member's successful write (not GET) is logged in AdminActionLog with the permission used.
const access = require("../services/adminAccess");

const DENIED = (permission) => ({ code: "ADMIN_PERMISSION_REQUIRED", permission, message: "you don't have access to this. ask a super admin." });
const SUSPENDED = { code: "ADMIN_ACCESS_SUSPENDED", message: "your admin access is paused. ask a super admin." };

function permit(permission) {
  const fn = async function adminPermission(req, res, next) {
    let user = null;
    try { user = await access.callerOf(req); } catch { user = null; }
    if (!access.isAdminAccount(user)) return next(); // not an admin: the route's own checks decide, as before
    const where = `${req.method} ${req.baseUrl || ""}${req.route?.path || ""}`;
    const d = access.decide(user, permission, where);
    if (!d.allowed) return res.status(403).json(d.reason === "suspended" ? SUSPENDED : DENIED(permission));
    // owner: an admin reply never carries secrets, and documents / full contact details only with their permission
    const { safeRecord, optionsFor } = require("../utils/safeRecord");
    const opts = optionsFor(user, permission);
    const json = res.json.bind(res);
    res.json = (body) => json(safeRecord(body, opts));
    if (req.method !== "GET" && access.levelOf(user) === "member") {
      res.on("finish", () => {
        if (res.statusCode >= 400) return;
        require("../services/adminActionLog").recordSafe({
          admin: user._id, action: `member.${permission}`, targetType: "route",
          targetId: String(req.originalUrl || "").split("?")[0].slice(0, 64), after: { method: req.method, status: res.statusCode, shadow: d.reason === "shadow" },
          reason: `permission ${permission}`,
        });
      });
    }
    return next();
  };
  fn.permission = permission;
  return fn;
}

function applyPermissions(router, map, file = "routes") {
  const auth = require("./auth.middleware");
  for (const [key, value] of Object.entries(map)) {
    // { inline: "students.view" }: the handler checks it itself (an own-or-admin route); a tagged no-op marks it
    const inline = value && typeof value === "object" ? value.inline : null;
    const permission = inline || value;
    if (!require("../config/adminPermissions").KEYS.includes(permission)) throw new Error(`[admin-access] ${file}: unknown permission ${permission} for ${key}`);
    const [method, path] = key.split(" ");
    const layers = router.stack.filter((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
    if (!layers.length) throw new Error(`[admin-access] ${file}: no route ${key}`);
    for (const layer of layers) {
      const route = layer.route;
      if (route.stack.some((l) => l.handle.permission)) continue;
      const mw = inline ? Object.assign(function adminPermissionInline(req, res, next) { next(); }, { permission, inline: true }) : permit(permission);
      route[method.toLowerCase()](mw); // a proper layer, appended…
      const added = route.stack.pop(); // …then moved right after sign-in (or first, when the router signs in)
      // after sign-in: the shared auth middleware, or a route file's own (e.g. jobs.routes' authMiddleware)
      const at = route.stack.findIndex((l) => l.handle === auth || /^auth/i.test(l.handle.name || ""));
      route.stack.splice(at >= 0 ? at + 1 : 0, 0, added);
    }
  }
  return router;
}

module.exports = { permit, applyPermissions, DENIED, SUSPENDED };
