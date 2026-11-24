// routes/resumeFinish.routes.js
// P3d, mounted at /api/resume before routes/resume.routes.js (new paths only; nothing there changes). Each feature needs
// resumeV2 + its own flag for the signed-in student; off: 404, as if absent.
//   POST /:id/feedback   → feedback (services/resumeFeedback.js)            flag resumeFeedback, shared limit resume_ai
//   GET  /verified-facts → { facts: [{ kind, text, url? }] } (services/verifiedFacts.js)   flag resumeVerified
//   GET  /:id/public-page, PUT /:id/public-page { on?, showPhone?, showEmail? }, POST /:id/public-page/new-link
//        → { on, url, selfUrl, showPhone, showEmail, views }      flag resumePublicPage (the page itself: routes/publicResume)
const express = require("express");
const auth = require("../middleware/auth.middleware");
const { perUser } = require("../utils/userRateLimit");
const { isEnabled } = require("../config/featureFlags");

const router = express.Router();
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message, error: message });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const on = (name, req) => isEnabled(name, { id: String(req.userId), role: req.userRole || "student" });
const gate = (...names) => (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(res, 401, "SIGN_IN", "sign in first");
  return names.every((n) => on(n, req)) ? next() : fail(res, 404, "NOT_FOUND", "not found");
};
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error("[resume-finish]", e.message);
    return fail(res, 500, "SERVER_ERROR", "something went wrong. try again in a moment.");
  }
};
const ownResume = async (req, select) => {
  if (!isId(req.params.id)) return null;
  const q = require("../models/Resume").findOne({ _id: req.params.id, user: req.userId });
  if (select) q.select(select);
  return q.lean();
};

// ---------- "verified by tdc" (the student's own facts; the line shows on a resume only when settings.verifiedLine) ----------
router.get("/verified-facts", auth, gate("resumeV2", "resumeVerified"), handle(async (req, res) => {
  ok(res, { facts: await require("../services/verifiedFacts").factsFor(req.userId) });
}));

// ---------- public resume page (owner #1): the student's own controls ----------
// on: the page exists only while on (a link is made the first time); showPhone / showEmail: off until chosen;
// new-link: a new link, the old one stops working at once; views: only for the student
const PAGE = ["resumeV2", "resumePublicPage"];
const pageView = (r) => {
  const pub = require("../services/publicResume");
  const p = r?.publicPage || {};
  const on = p.on === true && !!p.slug;
  return { on, url: on ? pub.pageUrl(p.slug) : null, selfUrl: on && p.selfKey ? `${pub.pageUrl(p.slug)}?k=${p.selfKey}` : null, showPhone: p.showPhone === true, showEmail: p.showEmail === true, views: Math.max(0, Number(p.views) || 0) };
};
const PAGE_FIELDS = "+publicPage.slug +publicPage.selfKey";
async function setPage(req, set) {
  const Resume = require("../models/Resume");
  const pub = require("../services/publicResume");
  for (let i = 0; i < 3; i++) {
    const s = { ...set, "publicPage.updatedAt": new Date() };
    if (s["publicPage.slug"] === true) s["publicPage.slug"] = pub.newSlug();
    try {
      await Resume.updateOne({ _id: req.params.id, user: req.userId }, { $set: s });
      return;
    } catch (e) { if (e?.code !== 11000) throw e; } // the same link twice (practically never): another one
  }
  throw new Error("could not make a link");
}
router.get("/:id/public-page", auth, gate(...PAGE), handle(async (req, res) => {
  const r = await ownResume(req, PAGE_FIELDS);
  if (!r) return fail(res, 404, "NOT_FOUND", "resume not found");
  ok(res, pageView(r));
}));
router.put("/:id/public-page", auth, gate(...PAGE), handle(async (req, res) => {
  const r = await ownResume(req, PAGE_FIELDS);
  if (!r) return fail(res, 404, "NOT_FOUND", "resume not found");
  const b = req.body || {};
  const set = {};
  for (const k of ["on", "showPhone", "showEmail"]) if (typeof b[k] === "boolean") set[`publicPage.${k}`] = b[k];
  if (set["publicPage.on"] === true && !r.publicPage?.slug) { set["publicPage.slug"] = true; set["publicPage.selfKey"] = require("crypto").randomBytes(24).toString("base64url"); }
  if (Object.keys(set).length) await setPage(req, set);
  ok(res, pageView(await ownResume(req, PAGE_FIELDS)));
}));
router.post("/:id/public-page/new-link", auth, gate(...PAGE), handle(async (req, res) => {
  const r = await ownResume(req, PAGE_FIELDS);
  if (!r) return fail(res, 404, "NOT_FOUND", "resume not found");
  if (!r.publicPage?.slug) return fail(res, 409, "NO_PAGE", "turn your page on first");
  await setPage(req, { "publicPage.slug": true });
  ok(res, pageView(await ownResume(req, PAGE_FIELDS)));
}));

// ---------- P3-7 feedback ----------
router.post("/:id/feedback", auth, gate("resumeV2", "resumeFeedback"), perUser("resume_ai"), handle(async (req, res) => {
  const resume = await ownResume(req);
  if (!resume) return fail(res, 404, "NOT_FOUND", "resume not found");
  ok(res, await require("../services/resumeFeedback").feedback(resume, { userId: req.userId }));
}));

module.exports = router;
