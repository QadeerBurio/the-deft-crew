// routes/adminActions.routes.js — /api/admin/actions: the unified admin action log, read-only, admins only.
// Rows are written by the server (services/adminActionLog.js); there is no route that writes, edits or deletes.
//
//   GET /            ?adminId=&action=&targetType=&targetId=&from=&to=&limit=&before=   newest first, paged
//   GET /facets      the actions, target types and admins that appear in the log (for the filters)
// Replies: { success: true, data, requestId } or { success: false, error: { code, message }, requestId }.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const AdminActionLog = require("../models/AdminActionLog");
const log = require("../services/adminActionLog");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const ok = (req, res, data) => res.status(200).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });

// admins only, checked against the database (never the token alone)
async function requireAdmin(req, res, next) {
  try {
    if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
    const u = await User.findById(req.userId).select("role").lean();
    if (!u || u.role !== "admin") return fail(req, res, 403, "FORBIDDEN", "Admins only");
    next();
  } catch (err) {
    console.error("[admin-actions]", err);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
}

const adminNames = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.map(String))] }, role: "admin" }).select("name").lean()).map((u) => [String(u._id), u.name || "admin"]));
const view = (r, names) => ({
  id: String(r._id), at: r.at, admin: { id: String(r.admin), name: names.get(String(r.admin)) || "admin" },
  action: r.action, targetType: r.targetType, targetId: r.targetId, before: r.before ?? null, after: r.after ?? null, reason: r.reason || "",
});

router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const { adminId, action, targetType, targetId, from, to, limit, before } = req.query;
    const out = await log.list({ adminId, action, targetType, targetId, from, to, limit, before });
    const names = await adminNames(out.rows.map((r) => r.admin));
    ok(req, res, { rows: out.rows.map((r) => view(r, names)), next: out.next });
  } catch (err) {
    console.error("[admin-actions]", err);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

router.get("/facets", auth, requireAdmin, async (req, res) => {
  try {
    const [actions, targetTypes, admins] = await Promise.all([
      AdminActionLog.distinct("action"), AdminActionLog.distinct("targetType"), AdminActionLog.distinct("admin"),
    ]);
    const names = await adminNames(admins);
    ok(req, res, {
      actions: actions.sort(), targetTypes: targetTypes.sort(),
      admins: admins.map((id) => ({ id: String(id), name: names.get(String(id)) || "admin" })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    console.error("[admin-actions]", err);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

module.exports = router;
