// routes/adminResumeSettings.routes.js — admin: resume settings (owner, 25 Nov 2026), mounted at /api/admin/resume-settings
//   GET /   → { ok, data: { hiddenTemplates, templates: [all ids] } }
//   PUT /   { hiddenTemplates: [ids], reason? } → the same; logged in the admin actions log
// Hiding a template takes it out of the app's gallery (no app update); a resume already using it keeps rendering.
const express = require("express");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminMiddleware");
const settings = require("../services/resumeSettings");
const actionLog = require("../services/adminActionLog");
const { TEMPLATE_IDS, LIBRARY_IDS } = require("../config/resumeTemplates");

const router = express.Router();
router.use(auth, adminOnly);
const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });
// the five shown today + the library (the older aliases aren't offered in the gallery)
const OFFERED = ["modern_ats", "stanford", "jakes", "faang", "rezi", ...LIBRARY_IDS];

router.get("/", async (req, res) => {
  try { ok(res, { ...(await settings.get()), templates: OFFERED.filter((id) => TEMPLATE_IDS.includes(id)) }); }
  catch (e) { fail(res, 500, "SERVER_ERROR", "Something went wrong"); }
});

router.put("/", async (req, res) => {
  try {
    const before = await settings.get();
    const after = await settings.save({ hiddenTemplates: req.body?.hiddenTemplates }, req.user._id);
    await actionLog.recordSafe({ admin: req.user._id, action: "resume.settings.update", targetType: "ResumeSettings", targetId: "resume", before: { hiddenTemplates: before.hiddenTemplates }, after: { hiddenTemplates: after.hiddenTemplates }, reason: String(req.body?.reason || "").slice(0, 300), requestId: req.id });
    ok(res, { ...after, templates: OFFERED.filter((id) => TEMPLATE_IDS.includes(id)) });
  } catch (e) {
    if (e.status === 400) return fail(res, 400, "BAD_SETTINGS", e.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

// Phase A: the permission each admin route needs (shadow mode until adminRbacEnforce)
require("../middleware/adminAccess").applyPermissions(router, {
  "GET /": "features.manage",
  "PUT /": "features.manage",
}, "adminResumeSettings.routes.js");

module.exports = router;
