// routes/confessionSafety.routes.js
// Confession safety routes for students (plan P4-1 / P4-1b), mounted at /api/social next to social.routes.js. Only
// for a signed-in student with the confessionSafety flag on; for everyone else they answer 404, as if they didn't
// exist (flag off = exactly as before).
//   POST   /confessions/:id/report                          { reason, description?, evidence? }
//   POST   /confessions/comment/:postId/:commentId/report   { reason, description?, evidence? }
//   POST   /confessions/:id/mute-author · DELETE (unmute)   "don't show me posts from this person" (never says who)
//   POST   /confessions/rules/accept                        the rules were shown and accepted (stored once)
//   GET    /confessions/safety/me                           rules accepted?, ban / reporting pause, helplines, reasons
// Reports: one per student per item. With evidence (the exact words, found in the post) the item is hidden at once
// and re-checked: confirmed → removed + a strike for the author ("action taken"); not confirmed → back, unless enough
// other students reported it ("no rule broken"; a false-report mark for the reporter). Without evidence: hidden once
// the report threshold (admin setting, default 3) is reached. The author's id is never returned.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const Confession = require("../models/Confession");
const Report = require("../models/Report");
const User = require("../models/User");
const flags = require("../config/featureFlags");
const check = require("../services/confessionCheck");
const strikes = require("../services/confessionStrikes");
const alerts = require("../services/safetyAlerts");
const settings = require("../services/safetySettings");
const { perUser } = require("../utils/userRateLimit");
const observe = require("../services/safetyObserve");
const images = require("../services/confessionImages");

const router = express.Router();
const REASONS = Report.schema.path("reason").enumValues;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const guest = (req) => !!req.isGuest || req.userId === "guest-user";
const meOf = (req) => String(req.user?._id || req.userId || "");
const notFound = (res) => res.status(404).json({ error: "Not found", message: "Not found" });
const err = (res, status, code, message) => res.status(status).json({ code, error: message, message });

// signed in, not a guest, flag on; otherwise the route doesn't exist
const gate = (req, res, next) => {
  if (guest(req) || !flags.isEnabled("confessionSafety", { id: meOf(req), role: req.userRole })) return notFound(res);
  next();
};
const limit = perUser("confession_report");


const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// the reporter's quote must be words that are really in the post (at least 3 characters)
const quoteIn = (quote, text) => { const q = norm(quote); return q.length >= 3 && norm(text).includes(q); };
const canSee = (req, c) => {
  if (!c || !Confession.isLive(c)) return false;
  if (c.visibility !== "campus") return true;
  const mine = String(req.user?.university?._id || req.user?.university || "");
  return !!mine && mine === String(c.university?._id || c.university || "");
};

async function report(req, res, { confessionId, commentId = null }) {
  const { reason, description = "", evidence = "" } = req.body || {};
  if (!REASONS.includes(reason)) return err(res, 400, "BAD_REASON", "pick a reason for your report.");
  if (!isId(confessionId) || (commentId && !isId(commentId))) return notFound(res);
  const me = await User.findById(meOf(req)).select("reportingBlockedUntil").lean();
  if (me?.reportingBlockedUntil && new Date(me.reportingBlockedUntil) > new Date()) {
    return err(res, 403, "REPORTING_PAUSED", "reporting is paused on your account for now, because several of your reports didn't hold up.");
  }
  const c = await Confession.findById(confessionId).select("+authorId +reportedBy text image university visibility status comments").lean();
  if (!canSee(req, c)) return notFound(res);
  const cm = commentId ? (c.comments || []).find((x) => String(x._id) === String(commentId)) : null;
  if (commentId && (!cm || !Confession.isLive(cm))) return notFound(res);
  const authorId = cm ? cm.user : c.authorId;
  if (String(authorId) === meOf(req)) return err(res, 400, "OWN_POST", "you can't report your own post.");
  const text = cm ? cm.text : c.text;
  if (evidence && !quoteIn(evidence, text)) return err(res, 400, "EVIDENCE_NOT_FOUND", "highlight words that are in the post.");

  const dup = await Report.findOne({ reporterId: meOf(req), contentType: "Confession", contentId: c._id, ...(commentId ? { commentId } : { commentId: { $exists: false } }) }).lean();
  if (dup) return err(res, 409, "ALREADY_REPORTED", "you've already reported this.");

  const rep = await Report.create({
    reporterId: meOf(req), reportedUserId: authorId, contentType: "Confession", contentId: c._id, ...(commentId ? { commentId } : {}),
    reason, description: String(description).slice(0, 500), ...(evidence ? { evidenceQuote: String(evidence).slice(0, 500) } : {}), status: "pending",
  });
  // unique reporters for this item
  const reporters = await Report.find({ contentType: "Confession", contentId: c._id, ...(commentId ? { commentId } : { commentId: { $exists: false } }) }).select("reporterId").lean();
  const unique = new Set(reporters.map((x) => String(x.reporterId))).size;
  const s = await settings.get();

  const setItem = async (status, why) => {
    if (cm) {
      const doc = await Confession.findById(c._id);
      const sub = doc.comments.find((x) => String(x._id) === String(commentId));
      sub.status = status; sub.reportCount = unique;
      await doc.save();
    } else {
      await Confession.updateOne({ _id: c._id }, { $set: { status, statusReason: why, statusAt: new Date(), reportCount: unique }, $addToSet: { reportedBy: new mongoose.Types.ObjectId(meOf(req)) } });
    }
  };
  const count = async () => {
    if (cm) { const doc = await Confession.findById(c._id); const sub = doc.comments.find((x) => String(x._id) === String(commentId)); sub.reportCount = unique; await doc.save(); }
    else await Confession.updateOne({ _id: c._id }, { $set: { reportCount: unique }, $addToSet: { reportedBy: new mongoose.Types.ObjectId(meOf(req)) } });
  };

  // self-harm: not a rule break; the item stays, admins are told at once
  if (reason === "Self Harm Risk") {
    await count();
    setImmediate(() => alerts.send("self_harm", { userId: authorId, reason: "a student reported a self-harm risk", content: text, evidence, contentType: cm ? "ConfessionComment" : "Confession", contentId: String(cm ? cm._id : c._id), withActions: false }));
    return res.status(201).json({ success: true, reportId: rep._id, outcome: "under_review", message: "thank you. our team has been told." });
  }

  // admin mode "observe": the report is stored and re-checked, and what would have happened is logged; nothing is
  // hidden, removed or struck. "off": stored for the admin Safety page only.
  if (s.mode !== "enforce") {
    await count();
    if (s.mode === "observe") {
      setImmediate(() => observe.observeReport({ reportId: rep._id, confessionId: c._id, commentId, userId: authorId, text, evidence, universityId: c.university, uniqueReporters: unique, threshold: s.reportThreshold }));
    }
    return res.status(201).json({ success: true, reportId: rep._id, outcome: "received", message: "thank you. we'll look at it." });
  }

  if (evidence) {
    await setItem("hidden", "report_with_evidence");
    const r = await check.recheck({ text: evidence, universityId: c.university });
    const confirmedRules = r.confirmed;
    if (confirmedRules) {
      await setItem("removed", `confirmed: ${r.reasons.join(", ")}`);
      if (!cm && c.image) setImmediate(() => images.deleteImage(c.image, "confession removed after a confirmed report"));
      const severe = r.severe || s.suspendOnSingleEvidenceReport;
      const st = await strikes.addStrike(authorId, { reason: `report confirmed: ${r.reasons.join(", ")}`, ref: String(rep._id), severe, content: text, evidence, contentId: String(c._id) });
      await Report.updateOne({ _id: rep._id }, { $set: { status: "resolved", actionTaken: st.action === "suspended" ? "user_suspended" : "content_removed", resolvedAt: new Date(), recheck: { confirmed: true, reasons: r.reasons, at: new Date() } } });
      return res.status(201).json({ success: true, reportId: rep._id, outcome: "action_taken", message: "thank you. action taken." });
    }
    if (!r.aiOk) {
      // the re-check couldn't run: stays hidden, the report waits on the admin Safety page
      await Report.updateOne({ _id: rep._id }, { $set: { status: "under_review", recheck: { confirmed: false, reasons: ["check_unavailable"], at: new Date() } } });
      return res.status(201).json({ success: true, reportId: rep._id, outcome: "under_review", message: "thank you. it's hidden while we check it." });
    }
    if (unique >= s.reportThreshold) {
      await Report.updateOne({ _id: rep._id }, { $set: { status: "under_review", recheck: { confirmed: false, reasons: [], at: new Date() } } });
      return res.status(201).json({ success: true, reportId: rep._id, outcome: "under_review", message: "thank you. it's hidden while we check it." });
    }
    await setItem("live", "report_not_confirmed");
    await Report.updateOne({ _id: rep._id }, { $set: { status: "rejected", falseReport: true, resolvedAt: new Date(), recheck: { confirmed: false, reasons: [], at: new Date() } } });
    await strikes.markFalseReport(meOf(req));
    return res.status(201).json({ success: true, reportId: rep._id, outcome: "no_rule_broken", message: "thank you. we checked it and no rule was broken." });
  }

  if (unique >= s.reportThreshold) {
    await setItem("hidden", "report_threshold");
    return res.status(201).json({ success: true, reportId: rep._id, outcome: "under_review", message: "thank you. it's hidden while we check it." });
  }
  await count();
  res.status(201).json({ success: true, reportId: rep._id, outcome: "received", message: "thank you. we'll look at it." });
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(`[confession-safety] ${req.method} ${req.route?.path} failed: ${e.name}`);
    res.status(500).json({ error: "Something went wrong", message: "Something went wrong" });
  }
};

router.post("/confessions/:id/report", auth, gate, limit, wrap((req, res) => report(req, res, { confessionId: req.params.id })));
router.post("/confessions/comment/:postId/:commentId/report", auth, gate, limit, wrap((req, res) => report(req, res, { confessionId: req.params.postId, commentId: req.params.commentId })));

// POST /confessions/precheck { text } (P4-1 follow-up): the text check before the app uploads an image, so a post
// that needs an edit never leaves an unused image behind. Only "ok" or "edit" (+ reasons): holds and self-harm are
// decided by the real post. Nothing is stored and no strike or ban counts. Mode observe / off: always "ok".
const precheckLimit = perUser("confession_precheck");
router.post("/confessions/precheck", auth, gate, precheckLimit, wrap(async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 2000);
  const s = await settings.get();
  if (s.mode !== "enforce" || !text.trim()) return res.json({ verdict: "ok", reasons: [], mode: s.mode });
  const r = await check.check({ text, universityId: req.user?.university?._id || req.user?.university || null });
  res.json(r.verdict === "edit" ? { verdict: "edit", reasons: r.reasons, mode: s.mode } : { verdict: "ok", reasons: [], mode: s.mode });
}));

const mute = (on) => wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const c = await Confession.findById(req.params.id).select("+authorId university visibility status").lean();
  if (!canSee(req, c)) return notFound(res);
  if (String(c.authorId) === meOf(req)) return err(res, 400, "OWN_POST", "that's your own post.");
  await User.updateOne({ _id: meOf(req) }, on ? { $addToSet: { mutedConfessionAuthors: c.authorId } } : { $pull: { mutedConfessionAuthors: c.authorId } });
  res.json({ success: true, muted: on, message: on ? "you won't see posts from this person." : "you'll see posts from this person again." });
});
router.post("/confessions/:id/mute-author", auth, gate, mute(true));
router.delete("/confessions/:id/mute-author", auth, gate, mute(false));

router.post("/confessions/rules/accept", auth, gate, wrap(async (req, res) => {
  const me = await User.findById(meOf(req)).select("confessionRulesAcceptedAt").lean();
  const at = me?.confessionRulesAcceptedAt || new Date();
  if (!me?.confessionRulesAcceptedAt) await User.updateOne({ _id: meOf(req) }, { $set: { confessionRulesAcceptedAt: at } });
  res.json({ success: true, acceptedAt: at });
}));

router.get("/confessions/safety/me", auth, gate, wrap(async (req, res) => {
  const me = await User.findById(meOf(req)).select("confessionRulesAcceptedAt confessionBanUntil reportingBlockedUntil").lean();
  const s = await settings.get();
  const future = (d) => (d && new Date(d) > new Date() ? d : null);
  res.set("Cache-Control", "private, no-store");
  res.json({
    rulesAcceptedAt: me?.confessionRulesAcceptedAt || null,
    bannedUntil: future(me?.confessionBanUntil),
    reportingPausedUntil: future(me?.reportingBlockedUntil),
    helplines: s.helplines,
    reasons: REASONS.filter((r) => !["Fake Account", "Misinformation"].includes(r)),
  });
}));

module.exports = router;
