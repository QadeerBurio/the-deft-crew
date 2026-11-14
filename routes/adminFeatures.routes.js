// routes/adminFeatures.routes.js — /api/admin/features: turn features on per account (brand, employer, student)
// from the admin portal. Admins only, checked against the database (never the token alone). Every change needs a
// reason and is written to AdminActionLog (feature.grant / feature.revoke / feature.reset / feature.default) in the
// same transaction as the row. No other route writes FeatureAccess or FeatureDefault, so no brand, employer or student
// can change its own features.
//
//   GET /flags                    grantable flags: label, roles, Railway state (counts only), forced on / off counts,
//                                 the student default (on / off / not set, who and why) for the flags that have one
//   GET /account/:id              per flag for one account: { killed, forced, studentDefault, defaultForRole,
//                                 fromRailway, source, effective, lastChange } (a brand: + how many students have it)
//   PUT /account/:id/:flag        { state: "on" | "off" | "default", reason }   forced on, forced off, or reset to
//                                 default (the row removed); { enabled: true / false } still works (= on / off)
//   PUT /defaults/:flag           { role: "student" | "brand" | "employee", enabled, reason }   the default for every
//                                 account of that role (on unless turned off; FeatureDefault;
//                                 resumeStudioV2, careerRatings, loyaltyV2, careerTimeline, careerMatching, surplusBoxes)
//   POST /bulk                    { flag, state | enabled, accountIds (max 500), reason }   → { changed, unchanged, skipped }
//   GET /flag/:flag               ?offset=&limit=   every account with admin access, newest first
// Replies: { success: true, data, requestId } or { success: false, error: { code, message }, requestId }.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const access = require("../services/featureAccess");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const ok = (req, res, data) => res.status(200).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });

async function requireAdmin(req, res, next) {
  try {
    if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
    const u = await User.findById(req.userId).select("role").lean();
    if (!u || u.role !== "admin") return fail(req, res, 403, "FORBIDDEN", "Admins only");
    next();
  } catch (err) {
    console.error("[admin-features]", err.message);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
}

const handle = (fn) => async (req, res) => {
  try {
    ok(req, res, await fn(req));
  } catch (err) {
    if (err instanceof access.FeatureAccessError) return fail(req, res, err.status, err.code, err.message);
    console.error("[admin-features]", err.message);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

router.use(auth, requireAdmin);

router.get("/flags", handle(async () => access.flagsOverview()));

router.get("/account/:id", handle(async (req) => access.accountView(req.params.id)));

router.put("/account/:id/:flag", handle(async (req) => access.setAccess({
  adminId: req.userId, accountId: req.params.id, flag: req.params.flag,
  state: req.body?.state, enabled: req.body?.enabled, reason: req.body?.reason, requestId: req.id,
})));

router.put("/defaults/:flag", handle(async (req) => access.setDefault({
  adminId: req.userId, flag: req.params.flag, role: req.body?.role ?? "student",
  enabled: req.body?.enabled, reason: req.body?.reason, requestId: req.id,
})));

router.post("/bulk", handle(async (req) => access.bulk({
  adminId: req.userId, accountIds: req.body?.accountIds, flag: req.body?.flag,
  state: req.body?.state, enabled: req.body?.enabled, reason: req.body?.reason, requestId: req.id,
})));

router.get("/flag/:flag", handle(async (req) => access.listFlag(req.params.flag, { offset: req.query.offset, limit: req.query.limit })));

module.exports = router;
