// routes/adminTeam.routes.js
// Phase A (A-6): the admin team & access page. Mounted at /api/admin/team (team.manage: super admins only) and, for
// every admin's own access and sessions, at /api/admin/me (adminMe below). Every change is logged in AdminActionLog
// with before / after. Safety rules: nobody changes their own access; the last super admin can't be demoted,
// suspended or removed; making or unmaking a super admin while another super admin exists waits for a second
// super admin's confirmation; a member never gets team.manage (only the super level has it).
//   GET  /                       members (every admin account), their level, template, permissions, status, last active
//   GET  /templates              built-in + saved templates     POST /templates { key?, label, permissions, basedOn? }
//   PUT  /templates/:key         save (a built-in key = replace it)   DELETE /templates/:key (saved only)
//   POST /invite                 { name, email, note?, template, permissions? } → a member + a 72-hour e-mail link
//   PUT  /:id/access             { template?, permissions, note? }  (a member's permissions; an admin today becomes a member)
//   POST /:id/level              { level: super | member, reason }  → applied, or a pending change for a second super
//   GET  /changes                pending changes   POST /changes/:id/confirm   POST /changes/:id/cancel
//   POST /:id/suspend { reason } POST /:id/restore   POST /:id/remove { reason }  (sessions end at once)
//   GET  /:id/activity           their AdminActionLog rows     GET /:id/sessions   POST /:id/sessions/end
//   GET  /shadow                 "would deny" log (shadow mode), grouped
const express = require("express");
const crypto = require("crypto");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const access = require("../services/adminAccess");
const sessions = require("../services/adminSessions");
const adminLog = require("../services/adminActionLog");
const P = require("../config/adminPermissions");

const router = express.Router();
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
const ok = (res, data) => res.json({ success: true, data });
const gate = (req, res, next) => (access.isAdminAccount(req.user) ? next() : fail(res, 403, "FORBIDDEN", "Admins only"));
router.use(auth, gate);
const log = (req, action, target, before, after, reason = "") => adminLog.recordSafe({ admin: req.user._id, action, targetType: "User", targetId: String(target), before, after, reason: String(reason).slice(0, 300), requestId: req.id });

const view = (u) => ({
  id: String(u._id), name: u.name || "", email: u.email || "",
  level: access.levelOf(u), template: u.adminAccess?.roleTemplate || null,
  permissions: access.permissionsOf(u), summary: P.describe(access.permissionsOf(u)),
  status: u.adminAccess?.status || "active", removed: !!u.adminAccess?.removedAt, note: u.adminAccess?.note || "",
  lastActiveAt: u.adminAccess?.lastActiveAt || null, invitedBy: u.adminAccess?.invitedBy ? String(u.adminAccess.invitedBy) : null,
  invitedAt: u.adminAccess?.invitedAt || null, createdAt: u.createdAt || null,
});
const loadAdmin = async (id) => (isId(id) ? User.findOne({ _id: id, role: "admin" }).select("name email role adminAccess createdAt").lean() : null);
async function superCount() {
  const admins = await User.find({ role: "admin" }).select("_id role adminAccess").lean();
  return admins.filter((u) => access.levelOf(u) === "super").length;
}
const cleanPermissions = (list) => P.expand(Array.isArray(list) ? list : []).filter((k) => k !== "team.manage");
async function templates() {
  const saved = await require("../models/AdminRoleTemplate").find({}).lean();
  const byKey = new Map(saved.map((t) => [t.key, t]));
  const builtIn = P.TEMPLATES.map((t) => (byKey.has(t.id) ? { key: t.id, label: byKey.get(t.id).label, permissions: P.expand(byKey.get(t.id).permissions), builtIn: true, changed: true } : { key: t.id, label: t.label, permissions: t.permissions, builtIn: true, changed: false, level: t.level || "member" }));
  const extra = saved.filter((t) => !P.TEMPLATES.some((b) => b.id === t.key)).map((t) => ({ key: t.key, label: t.label, permissions: P.expand(t.permissions), builtIn: false }));
  return [...builtIn, ...extra];
}
const notSelf = (req, res, id) => (String(id) === String(req.user._id) ? (fail(res, 400, "SELF", "you can't change your own access. ask another super admin."), false) : true);
async function guardLastSuper(res, target) {
  if (access.levelOf(target) === "super" && (await superCount()) <= 1) { fail(res, 400, "LAST_SUPER_ADMIN", "this is the last super admin: make someone else a super admin first."); return false; }
  return true;
}

router.get("/", async (req, res) => {
  const list = await User.find({ role: "admin" }).select("name email role adminAccess createdAt").sort({ createdAt: 1 }).lean();
  ok(res, list.map(view));
});

router.get("/templates", async (req, res) => ok(res, await templates()));
async function saveTemplate(req, res, key) {
  const label = String(req.body?.label || "").trim().slice(0, 60);
  if (!/^[a-z0-9_]{2,40}$/.test(key) || !label) return fail(res, 400, "BAD_TEMPLATE", "a template needs a key (a-z, 0-9, _) and a name.");
  const perms = cleanPermissions(req.body?.permissions);
  const T = require("../models/AdminRoleTemplate");
  const before = await T.findOne({ key }).lean();
  await T.updateOne({ key }, { $set: { label, permissions: perms, updatedBy: req.user._id } }, { upsert: true });
  await adminLog.recordSafe({ admin: req.user._id, action: "team.template.save", targetType: "AdminRoleTemplate", targetId: key, before: before ? { label: before.label, permissions: before.permissions } : null, after: { label, permissions: perms } });
  ok(res, (await templates()).find((t) => t.key === key));
}
router.post("/templates", (req, res) => saveTemplate(req, res, String(req.body?.key || "").trim().toLowerCase() || `custom_${Date.now().toString(36)}`));
router.put("/templates/:key", (req, res) => saveTemplate(req, res, String(req.params.key).toLowerCase()));
router.delete("/templates/:key", async (req, res) => {
  const key = String(req.params.key).toLowerCase();
  if (P.TEMPLATES.some((t) => t.id === key)) {
    const r = await require("../models/AdminRoleTemplate").deleteOne({ key }); // a built-in: back to its default
    return ok(res, { reset: (r.deletedCount || 0) > 0 });
  }
  const r = await require("../models/AdminRoleTemplate").deleteOne({ key });
  await adminLog.recordSafe({ admin: req.user._id, action: "team.template.delete", targetType: "AdminRoleTemplate", targetId: key, before: { key }, after: null });
  ok(res, { deleted: (r.deletedCount || 0) > 0 });
});

router.post("/invite", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, "BAD_INVITE", "a name and a valid e-mail are needed.");
  const tpl = (await templates()).find((t) => t.key === String(req.body?.template || ""));
  if (!tpl || tpl.level === "super") return fail(res, 400, "BAD_TEMPLATE", "pick a member template (super admins are made from the members list).");
  if (await User.exists({ email })) return fail(res, 409, "EMAIL_IN_USE", "this e-mail already has an account. to make it an admin, change its role (super admins only).");
  const permissions = req.body?.permissions ? cleanPermissions(req.body.permissions) : cleanPermissions(tpl.permissions);
  const bcrypt = require("bcryptjs");
  const now = new Date();
  const u = await User.create({
    name, email, role: "admin", status: "Verified", password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10),
    adminAccess: { level: "member", roleTemplate: tpl.key, permissions, status: "active", invitedBy: req.user._id, invitedAt: now, note: String(req.body?.note || "").slice(0, 120) },
  });
  const raw = crypto.randomBytes(32).toString("hex");
  await require("../models/AdminInvite").create({ user: u._id, tokenHash: crypto.createHash("sha256").update(raw).digest("hex"), invitedBy: req.user._id, expiresAt: new Date(now.getTime() + 72 * 3600e3) });
  const portal = String(process.env.PORTAL_URL || "https://gettdc.pk").replace(/\/$/, "");
  const link = `${portal}/admin/accept-invite?token=${raw}`;
  let sent = false;
  try {
    await require("../utils/mailer").sendMail({ to: email, subject: "you're invited to the tdc admin portal", html: `<p>hi ${name},</p><p>you've been invited to the tdc admin portal as <b>${tpl.label}</b>.</p><p><a href="${link}">set your password</a> (the link works for 72 hours).</p>` });
    sent = true;
  } catch (e) { console.error("[team] invite e-mail failed:", e.message); }
  await log(req, "team.invite", u._id, null, { email, template: tpl.key, permissions }, req.body?.note || "");
  ok(res, { member: view(u.toObject()), emailSent: sent });
});

router.put("/:id/access", async (req, res) => {
  if (!notSelf(req, res, req.params.id)) return;
  const u = await loadAdmin(req.params.id);
  if (!u) return fail(res, 404, "NOT_FOUND", "admin not found");
  if (access.levelOf(u) === "super") return fail(res, 400, "IS_SUPER", "a super admin has every permission: make them a member first.");
  const tpl = req.body?.template ? (await templates()).find((t) => t.key === String(req.body.template)) : null;
  if (req.body?.template && (!tpl || tpl.level === "super")) return fail(res, 400, "BAD_TEMPLATE", "unknown template");
  const permissions = cleanPermissions(req.body?.permissions ?? tpl?.permissions);
  const before = { level: access.levelOf(u), template: u.adminAccess?.roleTemplate || null, permissions: access.permissionsOf(u) };
  await User.updateOne({ _id: u._id }, { $set: { "adminAccess.level": "member", "adminAccess.permissions": permissions, "adminAccess.roleTemplate": tpl?.key || u.adminAccess?.roleTemplate || null, "adminAccess.note": String(req.body?.note ?? u.adminAccess?.note ?? "").slice(0, 120), "adminAccess.status": u.adminAccess?.status || "active" } });
  await log(req, "team.access", u._id, before, { level: "member", template: tpl?.key || before.template, permissions }, req.body?.reason || "");
  ok(res, view(await loadAdmin(u._id)));
});

async function applyLevel(req, target, level) {
  await User.updateOne({ _id: target._id }, { $set: level === "super" ? { "adminAccess.level": "super", "adminAccess.status": "active" } : { "adminAccess.level": "member", "adminAccess.permissions": access.permissionsOf(target).filter((k) => k !== "team.manage") } });
}
router.post("/:id/level", async (req, res) => {
  if (!notSelf(req, res, req.params.id)) return;
  const level = req.body?.level;
  if (!["super", "member"].includes(level)) return fail(res, 400, "BAD_LEVEL", "level: super | member");
  const u = await loadAdmin(req.params.id);
  if (!u) return fail(res, 404, "NOT_FOUND", "admin not found");
  if (level === "member" && !(await guardLastSuper(res, u))) return;
  const reason = String(req.body?.reason || "").trim();
  if ((await superCount()) > 1) {
    const ch = await require("../models/AdminAccessChange").create({ target: u._id, change: { level }, reason, requestedBy: req.user._id });
    await log(req, "team.level.request", u._id, { level: access.levelOf(u) }, { level, pending: String(ch._id) }, reason);
    return res.status(202).json({ success: true, data: { pending: true, changeId: String(ch._id), message: "waiting for another super admin to confirm." } });
  }
  await applyLevel(req, u, level);
  await log(req, "team.level", u._id, { level: access.levelOf(u) }, { level }, reason);
  ok(res, view(await loadAdmin(u._id)));
});
router.get("/changes", async (req, res) => {
  const rows = await require("../models/AdminAccessChange").find({ status: "pending" }).sort({ createdAt: -1 }).lean();
  ok(res, rows.map((c) => ({ id: String(c._id), target: String(c.target), change: c.change, reason: c.reason, requestedBy: String(c.requestedBy), at: c.createdAt })));
});
router.post("/changes/:id/confirm", async (req, res) => {
  const C = require("../models/AdminAccessChange");
  const c = isId(req.params.id) ? await C.findOne({ _id: req.params.id, status: "pending" }).lean() : null;
  if (!c) return fail(res, 404, "NOT_FOUND", "no pending change");
  if (String(c.requestedBy) === String(req.user._id)) return fail(res, 400, "SECOND_SUPER_NEEDED", "another super admin has to confirm this.");
  if (String(c.target) === String(req.user._id)) return fail(res, 400, "SELF", "you can't confirm a change to your own access.");
  const u = await loadAdmin(c.target);
  if (!u) return fail(res, 404, "NOT_FOUND", "admin not found");
  if (c.change.level === "member" && !(await guardLastSuper(res, u))) return;
  await applyLevel(req, u, c.change.level);
  await C.updateOne({ _id: c._id }, { $set: { status: "confirmed", decidedBy: req.user._id, decidedAt: new Date() } });
  await log(req, "team.level", u._id, { level: access.levelOf(u) }, { level: c.change.level, requestedBy: String(c.requestedBy) }, c.reason);
  ok(res, view(await loadAdmin(u._id)));
});
router.post("/changes/:id/cancel", async (req, res) => {
  const C = require("../models/AdminAccessChange");
  const r = isId(req.params.id) ? await C.updateOne({ _id: req.params.id, status: "pending" }, { $set: { status: "cancelled", decidedBy: req.user._id, decidedAt: new Date() } }) : { modifiedCount: 0 };
  ok(res, { cancelled: (r.modifiedCount || 0) > 0 });
});

async function setStatus(req, res, status, action, extra = {}) {
  if (!notSelf(req, res, req.params.id)) return;
  const u = await loadAdmin(req.params.id);
  if (!u) return fail(res, 404, "NOT_FOUND", "admin not found");
  const reason = String(req.body?.reason || "").trim();
  if (status === "suspended" && reason.length < 3) return fail(res, 400, "REASON_REQUIRED", "give a reason.");
  if (status === "suspended" && !(await guardLastSuper(res, u))) return;
  const set = { "adminAccess.status": status, ...extra };
  if (status === "suspended") set["adminAccess.suspendedReason"] = reason.slice(0, 300);
  if (!u.adminAccess) Object.assign(set, { "adminAccess.level": "member", "adminAccess.permissions": access.permissionsOf(u) }); // an admin today keeps what they had
  await User.updateOne({ _id: u._id }, { $set: set, ...(status === "active" ? { $unset: { "adminAccess.removedAt": "" } } : {}) });
  const ended = status === "suspended" ? await sessions.revokeAll(u._id, action === "team.remove" ? "removed" : "suspended") : 0;
  await log(req, action, u._id, { status: u.adminAccess?.status || "active" }, { status, sessionsEnded: ended }, reason);
  ok(res, view(await loadAdmin(u._id)));
}
router.post("/:id/suspend", (req, res) => setStatus(req, res, "suspended", "team.suspend"));
router.post("/:id/remove", (req, res) => setStatus(req, res, "suspended", "team.remove", { "adminAccess.removedAt": new Date() }));
router.post("/:id/restore", (req, res) => setStatus(req, res, "active", "team.restore"));

router.get("/:id/activity", async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, "NOT_FOUND", "admin not found");
  ok(res, (await adminLog.list({ adminId: req.params.id, limit: req.query.limit || 50 })).rows || []);
});
router.get("/:id/sessions", async (req, res) => (isId(req.params.id) ? ok(res, await sessions.history(req.params.id)) : fail(res, 404, "NOT_FOUND", "admin not found")));
router.post("/:id/sessions/end", async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, "NOT_FOUND", "admin not found");
  const n = await sessions.revokeAll(req.params.id, "by_super_admin");
  await log(req, "team.sessions.end", req.params.id, null, { ended: n });
  ok(res, { ended: n });
});

router.get("/shadow", async (req, res) => {
  const rows = await require("../models/AdminAccessShadow").find({}).sort({ at: -1 }).limit(2000).lean();
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.admin}|${r.permission}|${r.where}`;
    if (!groups.has(k)) groups.set(k, { admin: String(r.admin), permission: r.permission, where: r.where, count: 0, last: r.at });
    groups.get(k).count += 1;
  }
  ok(res, { enforcing: access.enforcing(), items: [...groups.values()] });
});

// every route above: team.manage (super admins only)
require("../middleware/adminAccess").applyPermissions(router, Object.fromEntries(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => [`${m.toUpperCase()} ${l.route.path}`, "team.manage"]))), "adminTeam.routes.js");

// ---------- /api/admin/me: an admin's own access and sessions (any admin whose access isn't paused) ----------
const adminMe = express.Router();
adminMe.use(auth, gate);
adminMe.get("/access", (req, res) => ok(res, {
  level: access.levelOf(req.user), permissions: access.permissionsOf(req.user), template: req.user.adminAccess?.roleTemplate || null,
  enforcing: access.enforcing(), sessions: sessions.enabled(), groups: P.GROUPS,
}));
adminMe.get("/sessions", async (req, res) => ok(res, await sessions.history(req.user._id)));
adminMe.post("/sessions/end", async (req, res) => ok(res, { ended: await sessions.revokeAll(req.user._id, "signed_out") }));
require("../middleware/adminAccess").applyPermissions(adminMe, { "GET /access": "self", "GET /sessions": "self", "POST /sessions/end": "self" }, "adminTeam.routes.js (me)");

module.exports = router;
module.exports.adminMe = adminMe;
