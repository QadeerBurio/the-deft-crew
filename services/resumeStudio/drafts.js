// services/resumeStudio/drafts.js
// Reviewing and approving a tailored draft (Resume Studio):
//   - decide: accept / reject / edit / undo suggestions. A "needs confirmation" change (a claim we
//     couldn't find in the resume) is only accepted when the student says it is true; a blocked one
//     can only be rejected; an edit is checked like a suggestion. Sent with the draft's revision:
//     a stale revision gets 409, so two devices can't overwrite each other.
//   - approve: two confirmations, every suggestion decided, the source resume unchanged since the draft
//     (else 409 SOURCE_CHANGED), and the whole version checked again. Creates one immutable version
//     per draft; a repeated approve returns the same version.
// Nothing here creates or changes a Resume, so drafts and versions never count toward the resume limit.
const Resume = require("../../models/Resume");
const CareerResumeDraft = require("../../models/CareerResumeDraft");
const CareerResumeApprovedVersion = require("../../models/CareerResumeApprovedVersion");
const { StudioError } = require("./tailor");
const { revisionHashOf, hashContent } = require("./facts");
const { checkText, checkVersion, corpusOf, getAt, setAt, listForOrder } = require("./validator");
const { RENDERER_VERSION } = require("./renderer");

const clone = (x) => JSON.parse(JSON.stringify(x));

// is this suggestion's change in the final content?
function applied(s) {
  if (s.decision === "accepted") return s.status === "ok" || (s.status === "needs_user_confirmation" && s.confirmedTrue);
  if (s.decision === "edited") return s.editStatus === "ok" || (s.editStatus === "needs_user_confirmation" && s.confirmedTrue);
  return false;
}

/** The draft's content with the applied decisions: rewords first (original indexes), then reorders. */
function contentWithDecisions(draft) {
  const content = clone(draft.sourceContent);
  const used = (draft.suggestions || []).filter(applied);
  for (const s of used.filter((x) => x.kind === "reword")) {
    if (typeof getAt(content, s.fieldPath) === "string") setAt(content, s.fieldPath, s.decision === "edited" ? s.editedText : s.proposed);
  }
  for (const s of used.filter((x) => x.kind === "reorder")) {
    const list = listForOrder(content, s.fieldPath);
    const order = JSON.parse(s.proposed);
    if (Array.isArray(list) && order.length === list.length) setAt(content, s.fieldPath.replace(/^order\./, ""), order.map((i) => list[i]));
  }
  return content;
}

// claims the student explicitly confirmed as true (they count as support at approval)
const confirmedClaims = (draft) => (draft.suggestions || []).filter((s) => applied(s) && s.confirmedTrue).map((s) => (s.decision === "edited" ? s.editedText : s.proposed));

/** What the student sees: no scores, no hiring predictions, no internals. */
function studentView(draft) {
  const d = draft.toObject ? draft.toObject() : draft;
  return {
    id: String(d._id),
    resumeId: String(d.resumeId),
    status: d.status,
    revision: d.revision,
    target: { kind: d.target?.kind, jobId: d.target?.jobId ? String(d.target.jobId) : null, title: d.target?.title || "" },
    provenance: d.provenance,
    suggestions: (d.suggestions || []).map((s) => ({
      suggestionId: s.suggestionId, kind: s.kind, fieldPath: s.fieldPath, original: s.original, proposed: s.proposed, reason: s.reason,
      sourceFactIds: s.sourceFactIds, status: s.status, riskFlags: s.riskFlags, decision: s.decision, editedText: s.editedText,
      editStatus: s.editStatus || null, editRiskFlags: s.editRiskFlags || [], confirmedTrue: !!s.confirmedTrue,
    })),
    facts: (d.facts || []).map((f) => ({ factId: f.factId, type: f.type, value: f.value })),
    match: d.match || { matched: [], missing: [], unknown: [] },
    warnings: d.warnings || [],
    aiSuggestions: d.fallback ? "insufficient_information" : "available",
    fallback: d.fallback || null,
    content: contentWithDecisions(d),
    unresolved: (d.suggestions || []).filter((s) => s.decision === "pending").length,
    approvedVersionId: d.approvedVersionId ? String(d.approvedVersionId) : null,
    expiresAt: d.expiresAt || null,
    createdAt: d.createdAt,
  };
}

const DECISIONS = ["accepted", "rejected", "edited", "pending"];

/**
 * @param userId owner
 * @param draftId
 * @param body { revision, decisions: [{ suggestionId, decision, editedText?, confirmTrue? }] }
 */
async function decide(userId, draftId, body) {
  const draft = await CareerResumeDraft.findOne({ _id: draftId, userId }).lean();
  if (!draft) throw new StudioError("NOT_FOUND", "Draft not found");
  if (draft.status !== "open") throw new StudioError("ALREADY_APPROVED", "This draft is already approved. Start a new tailoring to make changes.");
  if (Number(body?.revision) !== draft.revision) throw Object.assign(new StudioError("STALE_REVISION", "This draft changed on another device. Reload it and try again."), { current: draft.revision });
  const list = Array.isArray(body?.decisions) ? body.decisions.slice(0, 100) : [];
  if (!list.length) throw new StudioError("NO_DECISIONS", "Nothing to change");
  const corpus = corpusOf(draft.facts || []);
  const suggestions = clone(draft.suggestions);
  for (const d of list) {
    const s = suggestions.find((x) => x.suggestionId === d?.suggestionId);
    if (!s) throw new StudioError("UNKNOWN_SUGGESTION", "That suggestion doesn't exist");
    if (!DECISIONS.includes(d.decision)) throw new StudioError("INVALID_DECISION", "decision must be accepted, rejected, edited or pending");
    const confirmTrue = d.confirmTrue === true;
    if (s.status === "blocked" && !["rejected", "pending"].includes(d.decision)) {
      throw Object.assign(new StudioError("BLOCKED_SUGGESTION", "This change can't be used: it adds details that aren't in your resume."), { suggestionId: s.suggestionId, riskFlags: s.riskFlags });
    }
    if (d.decision === "accepted" && s.status === "needs_user_confirmation" && !confirmTrue) {
      throw Object.assign(new StudioError("CONFIRMATION_REQUIRED", "This change says something that isn't in your resume. Accept it only if it is true."), { suggestionId: s.suggestionId, riskFlags: s.riskFlags });
    }
    s.decision = d.decision;
    s.confirmedTrue = false;
    s.editedText = "";
    s.editStatus = "";
    s.editRiskFlags = [];
    if (d.decision === "edited") {
      if (s.kind !== "reword") throw new StudioError("INVALID_DECISION", "A reorder can be accepted or rejected, not edited");
      const text = String(d.editedText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
      if (!text) throw new StudioError("EMPTY_EDIT", "Your edit is empty");
      const r = checkText(text, s.original, corpus);
      if (r.status === "blocked") throw Object.assign(new StudioError("EDIT_BLOCKED", "Your edit adds a date, link or e-mail that isn't in your resume. Change it in your resume first."), { suggestionId: s.suggestionId, riskFlags: r.riskFlags });
      if (r.status === "needs_user_confirmation" && !confirmTrue) throw Object.assign(new StudioError("CONFIRMATION_REQUIRED", "Your edit says something that isn't in your resume. Save it only if it is true."), { suggestionId: s.suggestionId, riskFlags: r.riskFlags });
      Object.assign(s, { editedText: text, editStatus: r.status, editRiskFlags: r.riskFlags });
    }
    if (confirmTrue && (d.decision === "accepted" || d.decision === "edited")) s.confirmedTrue = true;
  }
  const updated = await CareerResumeDraft.findOneAndUpdate(
    { _id: draft._id, userId, status: "open", revision: draft.revision },
    { $set: { suggestions }, $inc: { revision: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!updated) throw new StudioError("STALE_REVISION", "This draft changed on another device. Reload it and try again.");
  return updated;
}

/**
 * @param body { revision, confirmAccurate: true, confirmReviewed: true, label? }
 * @returns { version, created }
 */
async function approve(userId, draftId, body) {
  const draft = await CareerResumeDraft.findOne({ _id: draftId, userId }).lean();
  if (!draft) throw new StudioError("NOT_FOUND", "Draft not found");
  if (draft.approvedVersionId) {
    const existing = await CareerResumeApprovedVersion.findById(draft.approvedVersionId).lean();
    if (existing) return { version: existing, created: false };
  }
  const already = await CareerResumeApprovedVersion.findOne({ draftId: draft._id, userId }).lean();
  if (already) return { version: already, created: false };
  if (body?.confirmAccurate !== true || body?.confirmReviewed !== true) {
    throw new StudioError("CONFIRMATIONS_REQUIRED", "Please confirm that everything in this resume is true and that you reviewed every change.");
  }
  if (Number(body?.revision) !== draft.revision) throw Object.assign(new StudioError("STALE_REVISION", "This draft changed on another device. Reload it and try again."), { current: draft.revision });
  const pending = (draft.suggestions || []).filter((s) => s.decision === "pending").length;
  if (pending) throw Object.assign(new StudioError("UNRESOLVED", `Please accept or reject the remaining ${pending} change${pending === 1 ? "" : "s"}.`), { pending });
  const resume = await Resume.findOne({ _id: draft.resumeId, user: userId }).lean();
  if (!resume || revisionHashOf(resume) !== draft.sourceRevisionHash) {
    throw new StudioError("SOURCE_CHANGED", "Your resume changed after this draft was made. Please tailor it again.");
  }
  const final = contentWithDecisions(draft);
  const check = checkVersion(draft.sourceContent, final, corpusOf(draft.facts || []), confirmedClaims(draft));
  if (!check.ok) throw Object.assign(new StudioError("VALIDATION_FAILED", "Some changes add details that aren't in your resume."), { errors: check.errors });
  const label = String(body?.label || draft.target?.title || "Tailored resume").replace(/\s+/g, " ").trim().slice(0, 80);
  let version;
  let created = true;
  try {
    version = (await CareerResumeApprovedVersion.create({
      userId, sourceResumeId: draft.resumeId, draftId: draft._id, label,
      target: { kind: draft.target?.kind || "", jobId: draft.target?.jobId || null, title: draft.target?.title || "" },
      contentSnapshot: final, contentHash: hashContent(final), rendererVersion: RENDERER_VERSION, promptVersion: draft.promptVersion,
    })).toObject();
  } catch (e) {
    if (e?.code !== 11000) throw e;
    version = await CareerResumeApprovedVersion.findOne({ draftId: draft._id }).lean(); // a simultaneous approve won
    created = false;
  }
  await CareerResumeDraft.updateOne({ _id: draft._id }, { $set: { status: "approved", approvedVersionId: version._id, expiresAt: null } });
  return { version, created };
}

/** Version metadata the owner (and, for an attached one, the employer) sees */
const versionView = (v) => ({
  id: String(v._id), label: v.label, target: { kind: v.target?.kind || "", jobId: v.target?.jobId ? String(v.target.jobId) : null, title: v.target?.title || "" },
  contentHash: v.contentHash, templateId: v.templateId, rendererVersion: v.rendererVersion, approvedAt: v.approvedAt,
  usedInApplication: !!v.usedInApplication, retainUntil: v.retainUntil || null, deletable: !v.usedInApplication,
});

module.exports = { decide, approve, studentView, versionView, contentWithDecisions, applied };
