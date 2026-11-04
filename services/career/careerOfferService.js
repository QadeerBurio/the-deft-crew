// services/career/careerOfferService.js
// Offers and outcomes on the hiring timeline.
//   - The employer sends an offer with a deadline; the candidate accepts or declines; past the deadline
//     it can't be accepted.
//   - Verified hire = the candidate accepted the offer AND the employer confirms the hire. Only then does
//     the application show "hired" (old screens included) and a private "Hired via TDC" outcome exist,
//     with a 7-day dispute window. A candidate dispute (in the window) or an admin correction revokes it.
//   - "Interviewed via TDC": recorded when the employer records the interview as completed; revoked if the
//     candidate disputes that.
// Every action is one timeline event (careerTimelineService.append); the offer / outcome writes happen in
// the same transaction.
const mongoose = require("mongoose");
const CareerOffer = require("../../models/CareerOffer");
const CareerOutcome = require("../../models/CareerOutcome");
const timeline = require("./careerTimelineService");

const { CareerError } = timeline;
const DAY = 24 * 60 * 60 * 1000;

async function load(offerId, userId) {
  if (!timeline.isId(offerId)) throw new CareerError(400, "INVALID_ID", "Invalid offer id");
  const offer = await CareerOffer.findById(offerId).lean();
  if (!offer) throw new CareerError(404, "NOT_FOUND", "Offer not found");
  const ctx = await timeline.contextFor(offer.application, userId);
  return { offer, ctx };
}

async function send(ctx, body, idempotencyKey, now = new Date()) {
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the employer sends offers");
  const expiresAt = new Date(body.expiresAt);
  if (!body.expiresAt || Number.isNaN(expiresAt.getTime())) throw new CareerError(400, "INVALID_DATE", "expiresAt (the answer deadline) is required");
  if (expiresAt.getTime() < now.getTime() + 60 * 60 * 1000) throw new CareerError(400, "INVALID_DATE", "Give the candidate at least an hour to answer");
  if (expiresAt.getTime() > now.getTime() + 90 * DAY) throw new CareerError(400, "INVALID_DATE", "The deadline can be at most 90 days away");
  const offerId = new mongoose.Types.ObjectId();
  const title = String(body.title || ctx.job?.title || "").trim().slice(0, 200);
  const terms = String(body.terms || "").trim().slice(0, 2000);
  return timeline.append(ctx, {
    type: "OFFER_SENT",
    expectedVersion: body.version,
    idempotencyKey,
    source: "portal",
    metadata: { offerId: String(offerId), expiresAt, note: body.note },
    now,
    sideEffect: async (session) => {
      // an earlier offer whose deadline passed unanswered is closed as expired before the new one
      await CareerOffer.updateMany({ application: ctx.app._id, active: true, status: "sent", expiresAt: { $lt: now } }, { $set: { status: "expired", active: false } }, { session });
      await CareerOffer.create([{ _id: offerId, application: ctx.app._id, job: ctx.app.jobId, employer: ctx.employerId, candidate: ctx.candidateId, title, terms, offeredAt: now, expiresAt, status: "sent", active: true }], { session });
    },
  });
}

async function withdraw(offerId, userId, body, idempotencyKey, now = new Date()) {
  const { offer, ctx } = await load(offerId, userId);
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Decline the offer instead");
  return timeline.append(ctx, {
    type: "OFFER_WITHDRAWN", expectedVersion: body.version, idempotencyKey, source: "portal", metadata: { offerId: String(offer._id), note: body.note }, now,
    sideEffect: (session) => CareerOffer.updateOne({ _id: offer._id }, { $set: { status: "withdrawn", active: false } }, { session }),
  });
}

async function respond(offerId, userId, body, idempotencyKey, now = new Date()) {
  const { offer, ctx } = await load(offerId, userId);
  if (ctx.role !== "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the candidate answers an offer");
  if (!["accept", "decline"].includes(body.response)) throw new CareerError(400, "INVALID_RESPONSE", "response: accept or decline");
  if (offer.status === "sent" && new Date(offer.expiresAt) < now) throw new CareerError(409, "OFFER_EXPIRED", "This offer's deadline has passed; ask the employer for a new one");
  const accepted = body.response === "accept";
  const note = String(body.message || "").slice(0, 500);
  return timeline.append(ctx, {
    type: accepted ? "OFFER_ACCEPTED" : "OFFER_DECLINED", expectedVersion: body.version, idempotencyKey, source: "app", metadata: { offerId: String(offer._id), response: body.response, note }, now,
    sideEffect: (session) => CareerOffer.updateOne({ _id: offer._id }, { $set: { status: accepted ? "accepted" : "declined", active: accepted, respondedAt: now, responseNote: note } }, { session }),
  });
}

// the employer confirms the hire of a candidate who accepted: a verified hire
async function confirmHire(offerId, userId, body, idempotencyKey, now = new Date()) {
  const { offer, ctx } = await load(offerId, userId);
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the employer confirms a hire");
  return timeline.append(ctx, {
    type: "HIRE_CONFIRMED", expectedVersion: body.version, idempotencyKey, source: "portal", metadata: { offerId: String(offer._id), note: body.note }, now,
    sideEffect: async (session, ev) => {
      await CareerOffer.updateOne({ _id: offer._id }, { $set: { employerConfirmedAt: now, verificationStatus: "verified" } }, { session });
      await CareerOutcome.updateOne(
        { application: ctx.app._id, outcomeType: "hired" },
        {
          $set: {
            job: ctx.app.jobId, candidate: ctx.candidateId, employer: ctx.employerId, verificationLevel: "verified",
            employerConfirmedAt: now, candidateConfirmedAt: offer.respondedAt, disputeWindowEndsAt: new Date(now.getTime() + timeline.DISPUTE_DAYS * DAY),
            disputedAt: null, revokedAt: null, revokedReason: "", visibility: "private", auditEventId: ev._id,
          },
        },
        { upsert: true, session }
      );
    },
  });
}

// ---------- outcome writes driven by other events (same transaction as the event) ----------
timeline.registerSideEffect("INTERVIEW_COMPLETED", (session, ev, ctx) => CareerOutcome.updateOne(
  { application: ev.application, outcomeType: "interviewed" },
  { $set: { job: ev.job, candidate: ev.candidate, employer: ev.employer, verificationLevel: "employer-recorded", employerConfirmedAt: ev.occurredAt, revokedAt: null, revokedReason: "", auditEventId: ev._id }, $setOnInsert: { visibility: "private" } },
  { upsert: true, session }
));
timeline.registerSideEffect("INTERVIEW_DISPUTED", (session, ev) => CareerOutcome.updateOne(
  { application: ev.application, outcomeType: "interviewed" },
  { $set: { verificationLevel: "revoked", disputedAt: ev.occurredAt, revokedAt: ev.occurredAt, revokedReason: ev.metadata?.note || "disputed by the candidate", visibility: "private", auditEventId: ev._id } },
  { session }
));
const revokeHire = (who) => async (session, ev) => {
  await CareerOutcome.updateOne(
    { application: ev.application, outcomeType: "hired" },
    { $set: { verificationLevel: "revoked", ...(who === "candidate" ? { disputedAt: ev.occurredAt } : {}), revokedAt: ev.occurredAt, revokedReason: ev.metadata?.note || "", visibility: "private", auditEventId: ev._id } },
    { session }
  );
  await CareerOffer.updateMany({ application: ev.application, verificationStatus: "verified" }, { $set: { verificationStatus: "revoked" } }, { session });
};
timeline.registerSideEffect("HIRE_DISPUTED", revokeHire("candidate"));
timeline.registerSideEffect("HIRE_REVOKED", revokeHire("admin"));
// an admin rejected the candidate's dispute: the outcome is verified again (still private)
timeline.registerSideEffect("HIRE_RESTORED", async (session, ev) => {
  await CareerOutcome.updateOne(
    { application: ev.application, outcomeType: "hired" },
    { $set: { verificationLevel: "verified", revokedAt: null, revokedReason: "", disputeWindowEndsAt: ev.occurredAt, visibility: "private", auditEventId: ev._id } },
    { session }
  );
  await CareerOffer.updateMany({ application: ev.application, status: "accepted", verificationStatus: "revoked" }, { $set: { verificationStatus: "verified" } }, { session });
});
// a closed application: its open offer closes too
timeline.registerSideEffect("REJECTED", (session, ev) => CareerOffer.updateMany({ application: ev.application, status: "sent" }, { $set: { status: "withdrawn", active: false } }, { session }));
timeline.registerSideEffect("WITHDRAWN", (session, ev) => CareerOffer.updateMany({ application: ev.application, status: "sent" }, { $set: { status: "declined", active: false } }, { session }));

// ---------- views ----------
const view = (o, now = new Date()) => ({
  id: String(o._id),
  applicationId: String(o.application),
  title: o.title,
  terms: o.terms,
  offeredAt: o.offeredAt,
  expiresAt: o.expiresAt,
  status: o.status === "sent" && new Date(o.expiresAt) < now ? "expired" : o.status,
  respondedAt: o.respondedAt,
  employerConfirmedAt: o.employerConfirmedAt,
  verificationStatus: o.verificationStatus,
});
const latestFor = async (applicationId) => {
  const o = await CareerOffer.findOne({ application: applicationId }).sort({ createdAt: -1 }).lean();
  return o ? view(o) : null;
};
const outcomeView = (o, now = new Date()) => ({
  id: String(o._id),
  applicationId: String(o.application),
  jobId: String(o.job),
  outcomeType: o.outcomeType,
  label: o.outcomeType === "hired" ? "Hired via TDC" : "Interviewed via TDC",
  verificationLevel: o.verificationLevel,
  visibility: o.visibility,
  employerConfirmedAt: o.employerConfirmedAt,
  disputeWindowEndsAt: o.disputeWindowEndsAt,
  canDispute: o.outcomeType === "hired" && o.verificationLevel === "verified" && !!o.disputeWindowEndsAt && now <= new Date(o.disputeWindowEndsAt),
  revokedAt: o.revokedAt,
});

async function myOutcomes(userId) {
  return (await CareerOutcome.find({ candidate: userId }).sort({ createdAt: -1 }).limit(100).lean()).map((o) => outcomeView(o));
}

// the student chooses who sees a verified outcome; a revoked one stays private
async function setVisibility(outcomeId, userId, visibility) {
  if (!timeline.isId(outcomeId)) throw new CareerError(400, "INVALID_ID", "Invalid outcome id");
  if (!["private", "public"].includes(visibility)) throw new CareerError(400, "INVALID_VISIBILITY", "visibility: private or public");
  const o = await CareerOutcome.findOne({ _id: outcomeId, candidate: userId }).lean();
  if (!o) throw new CareerError(404, "NOT_FOUND", "Outcome not found");
  if (visibility === "public" && o.verificationLevel === "revoked") throw new CareerError(409, "REVOKED", "A revoked outcome can't be shown");
  const updated = await CareerOutcome.findOneAndUpdate({ _id: o._id }, { $set: { visibility } }, { new: true }).lean();
  return outcomeView(updated);
}

module.exports = { send, withdraw, respond, confirmHire, load, view, latestFor, myOutcomes, setVisibility, outcomeView };
