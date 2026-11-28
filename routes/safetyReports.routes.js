const express = require("express");
const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const auth = require("../middleware/auth.middleware");
const { has, levelOf } = require("../services/adminAccess");
const { SafetyReport, REASONS, TARGETS, STATUSES } = require("../models/SafetyReport");
const SafetyReportRate = require("../models/SafetyReportRate");
const { lockOf } = require("../services/accountStatus");
const User = require("../models/User");
const Post = require("../models/Post");
const Confession = require("../models/Confession");
const { Conversation, Message } = require("../models/Chat");

const intake = express.Router();
const moderation = express.Router();
const staleDecision = new Error("Safety report version changed");
const isId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch { fail(res, 500, "Could not complete the safety report request."); }
};
const priorityFor = (reason) => reason === "child_exploitation" ? 2 : reason === "child_grooming" ? 1 : 0;
const canModerate = (user, permission) => levelOf(user) !== "legacy" && has(user, permission);
const REPORT_WINDOW_MS = 15 * 60 * 1000;
async function countSubmission(reporter, now = Date.now()) {
  const window = Math.floor(now / REPORT_WINDOW_MS);
  const filter = { _id: `${reporter}:${window}` };
  const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * REPORT_WINDOW_MS) } };
  try {
    return await SafetyReportRate.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return SafetyReportRate.findOneAndUpdate(filter, update, { returnDocument: "after" }).lean();
  }
}
const requirePermission = (permission) => (req, res, next) => {
  if (!canModerate(req.user, permission)) return fail(res, 403, "Safety moderation access required.");
  next();
};

function parseReport(body) {
  const { reason, targetType = "General", targetId, parentId, submissionId } = body || {};
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const needsParent = ["Comment", "ConfessionComment", "Message"].includes(targetType);
  if (!REASONS.includes(reason) || !TARGETS.includes(targetType) || !description || description.length > 1000 ||
      reference.length > 200 || (body?.reference != null && typeof body.reference !== "string") ||
      typeof submissionId !== "string" || !/^[a-z0-9-]{16,100}$/i.test(submissionId)) return null;
  if ((targetType === "General" ? targetId != null : !isId(targetId)) ||
      (needsParent ? !isId(parentId) : parentId != null)) return null;
  return { reason, targetType, targetId: targetId?.toLowerCase(), parentId: parentId?.toLowerCase(), submissionId, description, reference };
}

async function checkTarget(report, user) {
  const { targetType, targetId, parentId } = report;
  switch (targetType) {
    case "General": return {};
    case "User": return await User.exists({ _id: targetId }) ? { subject: targetId } : null;
    case "Post": {
      const post = await Post.findById(targetId).select("author").lean();
      return post && { subject: post.author };
    }
    case "Comment": {
      const post = await Post.findOne({ _id: parentId, "comments._id": targetId }, { comments: { $elemMatch: { _id: targetId } } }).lean();
      return post?.comments?.[0] ? { subject: post.comments[0].user } : null;
    }
    case "Confession":
    case "ConfessionComment": {
      const confession = await Confession.findOne({ _id: parentId || targetId, ...Confession.LIVE })
        .select("+authorId university visibility comments._id comments.status comments.user").lean();
      if (!confession) return null;
      if (confession.visibility === "campus") {
        const reporter = await User.findById(user).select("university").lean();
        if (!reporter?.university || String(reporter.university) !== String(confession.university)) return null;
      }
      if (targetType === "Confession") return { subject: confession.authorId };
      const comment = confession.comments?.find((item) => String(item._id) === targetId && (!item.status || item.status === "live"));
      return comment ? { subject: comment.user } : null;
    }
    case "Conversation":
    case "Message": {
      const chat = await Conversation.findOne({ _id: parentId || targetId, participants: user }).select("participants").lean();
      if (!chat) return null;
      if (targetType === "Conversation") return { subject: chat.participants.find((id) => String(id) !== user) };
      const message = await Message.findOne({ _id: targetId, conversationId: chat._id }).select("sender").lean();
      return message && { subject: message.sender };
    }
    default: return null;
  }
}

intake.post("/reports", auth, (req, res, next) => {
  if (!isId(String(req.user?._id || ""))) return fail(res, 401, "Sign in to submit a report.");
  next();
}, handle(async (req, res) => {
  const input = parseReport(req.body);
  if (!input) return fail(res, 400, "Check the category, description and report reference.");
  const reporter = String(req.user._id);
  const { submissionId, ...data } = input;
  const reportId = createHash("sha256").update(JSON.stringify([reporter, submissionId, data])).digest("hex").slice(0, 24);
  if (await SafetyReport.exists({ _id: reportId, reporter })) return res.json({ success: true, reportId });
  const now = new Date();
  const usage = await countSubmission(reporter, now.getTime());
  if (usage.count > 20) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((usage.expiresAt - now) / 1000))));
    return fail(res, 429, "Too many reports. Please try again later.");
  }
  const target = await checkTarget(data, reporter);
  if (!target) return fail(res, 404, "The reported item is unavailable.");
  try {
    await SafetyReport.create({ _id: reportId, ...data, ...target, reporter, priority: priorityFor(data.reason),
      history: [{ actor: reporter, at: now, action: "submitted", status: "pending" }] });
  } catch (error) {
    if (error.code !== 11000 || !await SafetyReport.exists({ _id: reportId, reporter })) throw error;
  }
  res.status(201).json({ success: true, reportId });
}));

moderation.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, auth, requirePermission("safety.intake.view"));
moderation.get("/", handle(async (req, res) => {
  const filter = req.query.child === "true" ? { priority: { $gt: 0 } } : {};
  const status = STATUSES.includes(req.query.status) ? req.query.status : "pending";
  const [items, ...counts] = await Promise.all([
    SafetyReport.find({ ...filter, status }).select("reason targetType priority status assignedModerator createdAt updatedAt")
      .sort({ priority: -1, createdAt: -1 }).limit(100).lean(),
    ...STATUSES.map((value) => SafetyReport.countDocuments({ ...filter, status: value })),
  ]);
  res.json({ items, counts: Object.fromEntries(STATUSES.map((value, index) => [value, counts[index]])) });
}));

moderation.get("/:id", handle(async (req, res) => {
  const report = isId(req.params.id) && await SafetyReport.findById(req.params.id).select("-reporter -subject -history.actor").lean();
  if (!report) return fail(res, 404, "Report unavailable.");
  // The queue never fetches conversation contents or the concealed confession author.
  if (["Message", "Conversation"].includes(report.targetType)) {
    delete report.parentId;
    delete report.targetId;
  }
  res.json(report);
}));

moderation.patch("/:id", requirePermission("safety.intake.act"), handle(async (req, res) => {
  const { status, escalation, assign, version, action = "review" } = req.body || {};
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!isId(req.params.id) || !STATUSES.includes(status) || !["none", "planned", "reported"].includes(escalation) ||
      !["review", "restrict", "remove", "suspend", "ban"].includes(action) || !note || note.length > 1000 ||
      !Number.isSafeInteger(version) || version < 0 ||
      (assign != null && typeof assign !== "boolean")) return fail(res, 400, "Invalid moderation decision.");
  if (["suspend", "ban"].includes(action) && !canModerate(req.user, "students.suspend")) return fail(res, 403, "Account moderation access required.");
  const at = new Date();
  const result = await mongoose.connection.transaction(async (session) => {
    const report = await SafetyReport.findById(req.params.id).session(session);
    if (!report) return [404, "Report unavailable."];
    if (report.__v !== version) return [409, "The report changed. Reload it before saving."];
    if (escalation === "reported" && report.escalation !== "reported" && req.body.authorityConfirmed !== true) {
      return [400, "Confirm that an authorized responder completed the external report."];
    }
    if (!await applyAction(action, report, at, session)) return [409, "This action is unavailable for the reported target."];
    const write = await SafetyReport.updateOne({ _id: report._id, __v: version }, {
      $set: { status, escalation, resolutionNotes: note, resolvedAt: status === "resolved" ? at : null,
        ...(assign ? { assignedModerator: req.user._id } : {}) },
      $inc: { __v: 1 },
      $push: { history: { actor: req.user._id, at, action, status, escalation, note } },
    }, { session });
    if (!write.matchedCount) throw staleDecision;
    return { targetType: report.targetType, targetId: report.targetId, parentId: report.parentId };
  }).catch((error) => {
    if (error === staleDecision) return [409, "The report changed. Reload it before saving."];
    throw error;
  });
  if (Array.isArray(result)) return fail(res, ...result);
  if (action === "remove" && result.targetType === "Message") {
    req.app.get("io")?.to(String(result.parentId)).emit("message_deleted", {
      messageId: String(result.targetId), conversationId: String(result.parentId),
    });
  }
  res.json({ success: true });
}));

async function applyAction(action, report, now, session) {
  if (action === "review") return true;
  if (action === "ban" || action === "suspend") {
    if (!report.subject) return false;
    const banned = action === "ban";
    const subject = await User.findById(report.subject).select("role accountStatus").session(session).lean();
    if (!subject || !lockOf({ ...subject, accountStatus: banned ? "banned" : "suspended" }, now).locked) return false;
    const result = await User.updateOne({ _id: report.subject, role: { $ne: "admin" },
      ...(banned ? {} : { accountStatus: { $ne: "banned" } }) }, { $set: {
      accountStatus: banned ? "banned" : "suspended",
      suspensionExpiry: banned ? null : new Date(now.getTime() + 86400000),
      suspensionReason: "Safety moderation decision",
    } }, { session });
    return !!result.matchedCount;
  }
  const { targetType, targetId, parentId } = report;
  const status = action === "restrict" ? "hidden" : "removed";
  if (targetType === "Confession") return !!(await Confession.updateOne({ _id: targetId, status: { $ne: "removed" } },
    { $set: { status, statusAt: now, statusReason: "Safety moderation decision" } }, { session })).matchedCount;
  if (targetType === "ConfessionComment") return !!(await Confession.updateOne({ _id: parentId,
    comments: { $elemMatch: { _id: targetId, status: { $ne: "removed" } } } },
    { $set: { "comments.$.status": status } }, { session })).matchedCount;
  if (action !== "remove") return false;
  if (targetType === "Post") return !!(await Post.deleteOne({ _id: targetId }, { session })).deletedCount;
  if (targetType === "Comment") return !!(await Post.updateOne({ _id: parentId }, { $pull: { comments: { _id: targetId } } }, { session })).modifiedCount;
  if (targetType === "Message") {
    const deleted = await Message.deleteOne({ _id: targetId, conversationId: parentId }, { session });
    if (deleted.deletedCount) await Conversation.updateOne({ _id: parentId }, {
      $set: { lastMessage: "" },
      $unset: { lastMessageSender: 1, lastMessageType: 1, lastMessageTime: 1 },
    }, { session });
    return !!deleted.deletedCount;
  }
  return false;
}

module.exports = { intake, moderation, parseReport, priorityFor, checkTarget };
