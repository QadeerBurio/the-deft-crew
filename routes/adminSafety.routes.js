// routes/adminSafety.routes.js
// The admin Safety log (plan P4-7), mounted at /api/admin/safety (admins only). There is no daily reviewing: this is
// the record behind the safety e-mails and the place to change an automatic decision. It reads the Report collection
// for ALL content (posts, post comments, users, confessions, confession comments) plus held confessions / comments.
//   GET  /queue?tab=held|reported|resolved&limit=50     newest first (self-harm reports first in "reported")
//   POST /:reportId/resolve    { action, note }          approve | remove | warn | suspend24h | suspend7d | ban
//   POST /confession/:id/resolve { action, note, commentId? }   a held / hidden item without a report: approve | remove
//   POST /:reportId/author     { reason }                who wrote it (required reason; every reveal logged)
//   GET  /settings · PUT /settings                       report threshold, banned words, helplines, single-report rule
// Authors are shown by an anonymous reference (the same one the safety e-mail uses), never by name, unless revealed.
// Every write is in AdminActionLog. The older /api/social/admin/reports routes are untouched.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminMiddleware");
const Report = require("../models/Report");
const Confession = require("../models/Confession");
const Post = require("../models/Post");
const User = require("../models/User");
const actionLog = require("../services/adminActionLog");
const { authorRef } = require("../services/safetyAlerts");
const safetySettings = require("../services/safetySettings");
const createNotification = require("../utils/notificationHelper");

const router = express.Router();
router.use(auth, adminOnly);

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const OPEN = ["pending", "under_review"];
const DONE = ["resolved", "rejected"];
const H = 3600e3;
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const ref = (id) => (id ? authorRef(String(id)) : null);
const textOf = (x) => String(x || "").slice(0, 2000);

// what the report is about: text, image, status, author (as a reference)
async function contentOf(r) {
  try {
    if (r.contentType === "Confession" && r.contentId) {
      const c = await Confession.findById(r.contentId).select("+authorId text image status statusReason reportCount comments createdAt").lean();
      if (!c) return { gone: true };
      if (r.commentId) {
        const cm = (c.comments || []).find((x) => String(x._id) === String(r.commentId));
        if (!cm) return { gone: true };
        return { kind: "confession_comment", confessionId: String(c._id), commentId: String(cm._id), text: textOf(cm.text), status: cm.status || "live", reportCount: cm.reportCount || 0, author: ref(cm.user), authorId: cm.user };
      }
      return { kind: "confession", confessionId: String(c._id), text: textOf(c.text), image: c.image || "", status: c.status || "live", statusReason: c.statusReason || null, reportCount: c.reportCount || 0, author: ref(c.authorId), authorId: c.authorId };
    }
    if (r.contentType === "Post" && r.contentId) {
      const p = await Post.findById(r.contentId).select("content text image images author").lean();
      if (!p) return { gone: true };
      return { kind: "post", postId: String(p._id), text: textOf(p.content || p.text), image: p.image || (p.images || [])[0] || "", author: ref(p.author), authorId: p.author };
    }
    if (r.contentType === "Comment" && r.contentId) {
      const p = await Post.findOne({ "comments._id": r.contentId }).select("comments").lean();
      const cm = p && (p.comments || []).find((x) => String(x._id) === String(r.contentId));
      if (!cm) return { gone: true };
      return { kind: "post_comment", postId: String(p._id), commentId: String(cm._id), text: textOf(cm.text || cm.content), author: ref(cm.user || cm.author), authorId: cm.user || cm.author };
    }
    if (r.contentType === "User") return { kind: "user", author: ref(r.reportedUserId || r.contentId), authorId: r.reportedUserId || r.contentId };
  } catch (e) {
    console.warn(`[admin-safety] content not read (${e.name})`);
  }
  return { gone: true };
}

const reportRow = async (r) => {
  const c = await contentOf(r);
  const { authorId, ...content } = c; // never the account id in the queue
  return {
    id: String(r._id), contentType: r.contentType, reason: r.reason, description: r.description || "", evidence: r.evidenceQuote || "",
    status: r.status, actionTaken: r.actionTaken || null, recheck: r.recheck || null, falseReport: !!r.falseReport,
    reporter: ref(r.reporterId), createdAt: r.createdAt, resolvedAt: r.resolvedAt || null, content,
  };
};

router.get("/queue", async (req, res) => {
  try {
    const tab = ["held", "reported", "resolved"].includes(req.query.tab) ? req.query.tab : "reported";
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    if (tab === "held") {
      const list = await Confession.find({ $or: [{ status: { $in: ["pending", "hidden"] } }, { "comments.status": { $in: ["pending", "hidden"] } }] })
        .select("+authorId text image status statusReason reportCount comments createdAt").sort({ createdAt: -1 }).limit(limit).lean();
      const items = [];
      for (const c of list) {
        if (["pending", "hidden"].includes(c.status)) items.push({ kind: "confession", confessionId: String(c._id), text: textOf(c.text), image: c.image || "", status: c.status, statusReason: c.statusReason || null, reportCount: c.reportCount || 0, author: ref(c.authorId), createdAt: c.createdAt });
        for (const cm of c.comments || []) {
          if (["pending", "hidden"].includes(cm.status)) items.push({ kind: "confession_comment", confessionId: String(c._id), commentId: String(cm._id), text: textOf(cm.text), status: cm.status, reportCount: cm.reportCount || 0, author: ref(cm.user), createdAt: cm.createdAt });
        }
      }
      // self-harm holds first
      items.sort((a, b) => (b.statusReason === "self_harm_signal") - (a.statusReason === "self_harm_signal") || new Date(b.createdAt) - new Date(a.createdAt));
      return ok(res, { tab, items });
    }
    const reports = await Report.find({ status: { $in: tab === "reported" ? OPEN : DONE } }).sort({ createdAt: -1 }).limit(limit).lean();
    const items = [];
    for (const r of reports) items.push(await reportRow(r));
    if (tab === "reported") items.sort((a, b) => (b.reason === "Self Harm Risk") - (a.reason === "Self Harm Risk") || new Date(b.createdAt) - new Date(a.createdAt));
    ok(res, { tab, items });
  } catch (e) {
    console.error(`[admin-safety] queue failed: ${e.name}`);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

// set a confession's / confession comment's status
async function setStatus(confessionId, commentId, status, reason) {
  if (commentId) {
    const c = await Confession.findById(confessionId);
    const cm = c && c.comments.id ? c.comments.id(commentId) : c && c.comments.find((x) => String(x._id) === String(commentId));
    if (!cm) return false;
    cm.status = status;
    await c.save();
    return true;
  }
  const r = await Confession.updateOne({ _id: confessionId }, { $set: { status, statusReason: reason, statusAt: new Date() } });
  return (r.matchedCount ?? r.n ?? 1) > 0;
}

async function accountAction(userId, action, note, adminId) {
  if (!userId) return null;
  const u = await User.findById(userId).select("role accountStatus confessionBanUntil").lean();
  if (!u) return null;
  if (u.role === "admin" && ["suspend24h", "suspend7d", "ban"].includes(action)) return "admin_not_changed";
  if (action === "warn") {
    try { await createNotification(userId, adminId, "alert", "one of your posts broke tdc's community rules. please read the guidelines before posting again.", null); } catch (e) { /* the decision stands */ }
    return "warned";
  }
  if (action === "suspend24h" || action === "suspend7d") {
    const until = new Date(Date.now() + (action === "suspend24h" ? 24 : 168) * H);
    await User.updateOne({ _id: userId }, { $set: { accountStatus: "suspended", suspensionExpiry: until, suspensionReason: String(note || "community rules").slice(0, 200), confessionBanUntil: until } });
    return "suspended";
  }
  if (action === "ban") {
    await User.updateOne({ _id: userId }, { $set: { accountStatus: "banned", suspensionReason: String(note || "community rules").slice(0, 200) } });
    return "banned";
  }
  return null;
}

const ACTIONS = ["approve", "remove", "warn", "suspend24h", "suspend7d", "ban"];
const TAKEN = { approve: "none", remove: "content_removed", warn: "warning", suspend24h: "user_suspended", suspend7d: "user_suspended", ban: "user_banned" };

router.post("/:reportId/resolve", async (req, res) => {
  try {
    const { action, note = "" } = req.body || {};
    if (!ACTIONS.includes(action)) return fail(res, 400, "BAD_ACTION", `action: ${ACTIONS.join(" | ")}`);
    if (!isId(req.params.reportId)) return fail(res, 404, "NOT_FOUND", "Report not found");
    const r = await Report.findById(req.params.reportId).lean();
    if (!r) return fail(res, 404, "NOT_FOUND", "Report not found");
    const c = await contentOf(r);
    const before = { reportStatus: r.status, contentStatus: c.status || null };
    let contentStatus = c.status || null;
    if (c.kind === "confession" || c.kind === "confession_comment") {
      if (action === "approve") { await setStatus(c.confessionId, c.commentId, "live", "approved by admin"); contentStatus = "live"; }
      else if (action !== "warn") { await setStatus(c.confessionId, c.commentId, "removed", "removed by admin"); contentStatus = "removed"; }
    } else if (action === "remove" || (["suspend24h", "suspend7d", "ban"].includes(action) && c.kind !== "user")) {
      // posts keep the older admin route's behaviour: removed = deleted
      if (c.kind === "post") await Post.deleteOne({ _id: c.postId });
      if (c.kind === "post_comment") await Post.updateOne({ _id: c.postId }, { $pull: { comments: { _id: c.commentId } } });
      contentStatus = "removed";
    }
    const account = action === "approve" || action === "remove" ? null : await accountAction(c.authorId, action, note, req.user._id);
    await Report.updateOne({ _id: r._id }, { $set: { status: action === "approve" ? "rejected" : "resolved", actionTaken: TAKEN[action], adminNotes: String(note).slice(0, 1000), resolvedAt: new Date(), resolvedBy: req.user._id } });
    await actionLog.recordSafe({ admin: req.user._id, action: `safety.report.${action}`, targetType: "Report", targetId: String(r._id), before, after: { reportStatus: action === "approve" ? "rejected" : "resolved", contentStatus, account }, reason: String(note).slice(0, 300), requestId: req.id });
    ok(res, { id: String(r._id), action, contentStatus, account });
  } catch (e) {
    console.error(`[admin-safety] resolve failed: ${e.name}`);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

router.post("/confession/:id/resolve", async (req, res) => {
  try {
    const { action, note = "", commentId = null } = req.body || {};
    if (!["approve", "remove"].includes(action)) return fail(res, 400, "BAD_ACTION", "action: approve | remove");
    if (!isId(req.params.id) || (commentId && !isId(commentId))) return fail(res, 404, "NOT_FOUND", "Confession not found");
    const c = await Confession.findById(req.params.id).select("status comments").lean();
    if (!c) return fail(res, 404, "NOT_FOUND", "Confession not found");
    const prev = commentId ? (c.comments || []).find((x) => String(x._id) === String(commentId))?.status || null : c.status || null;
    const status = action === "approve" ? "live" : "removed";
    const done = await setStatus(req.params.id, commentId, status, action === "approve" ? "approved by admin" : "removed by admin");
    if (!done) return fail(res, 404, "NOT_FOUND", "Comment not found");
    await actionLog.recordSafe({ admin: req.user._id, action: `safety.held.${action}`, targetType: commentId ? "ConfessionComment" : "Confession", targetId: String(commentId || req.params.id), before: { status: prev }, after: { status }, reason: String(note).slice(0, 300), requestId: req.id });
    ok(res, { id: req.params.id, commentId, status });
  } catch (e) {
    console.error(`[admin-safety] held resolve failed: ${e.name}`);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

// who wrote it: a required reason, every reveal logged (plan: role-gated in Phase A; for now every admin)
router.post("/:reportId/author", async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5) return fail(res, 400, "REASON_REQUIRED", "Give a reason (at least 5 characters). Every reveal is logged.");
    if (!isId(req.params.reportId)) return fail(res, 404, "NOT_FOUND", "Report not found");
    const r = await Report.findById(req.params.reportId).lean();
    if (!r) return fail(res, 404, "NOT_FOUND", "Report not found");
    const c = await contentOf(r);
    if (!c.authorId) return fail(res, 404, "NOT_FOUND", "No author for this report");
    const u = await User.findById(c.authorId).select("name role university universityName accountStatus").lean();
    await actionLog.recordSafe({ admin: req.user._id, action: "safety.identity.reveal", targetType: "Report", targetId: String(r._id), before: null, after: { author: ref(c.authorId) }, reason: reason.slice(0, 300), requestId: req.id });
    ok(res, { author: ref(c.authorId), account: u ? { id: String(u._id), name: u.name || "", role: u.role || "student", university: u.universityName || "", accountStatus: u.accountStatus || "active" } : null });
  } catch (e) {
    console.error(`[admin-safety] reveal failed: ${e.name}`);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

router.get("/settings", async (req, res) => {
  try { ok(res, await safetySettings.get()); } catch (e) { fail(res, 500, "SERVER_ERROR", "Something went wrong"); }
});

router.put("/settings", async (req, res) => {
  try {
    const before = await safetySettings.get();
    const after = await safetySettings.save(req.body || {}, req.user._id);
    await actionLog.recordSafe({ admin: req.user._id, action: "safety.settings.update", targetType: "SafetySettings", targetId: "confessions", before: { reportThreshold: before.reportThreshold, bannedWords: before.bannedWords.length, helplines: before.helplines.length, suspendOnSingleEvidenceReport: before.suspendOnSingleEvidenceReport }, after: { reportThreshold: after.reportThreshold, bannedWords: after.bannedWords.length, helplines: after.helplines.length, suspendOnSingleEvidenceReport: after.suspendOnSingleEvidenceReport }, reason: String(req.body?.reason || "").slice(0, 300), requestId: req.id });
    ok(res, after);
  } catch (e) {
    console.error(`[admin-safety] settings failed: ${e.name}`);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

module.exports = router;
