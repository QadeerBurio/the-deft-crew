// services/career/retentionService.js
// Career data retention (docs/CAREER_TIMELINE.md, "Retention policy"). Two parts:
//
// 1. run(): hiring-timeline data of applications whose LAST timeline event is more than 2 years old is
//    anonymised, not deleted, so funnel counts stay right:
//      - events, interviews, offers, outcomes, outbox rows: candidate, employer, actor and recipient ids are
//        replaced by a random placeholder (one per person per run, stored nowhere, like account deletion),
//        notes / terms / reasons / meeting links / locations / candidate messages are cleared, outbox
//        payloads emptied; event types, times, stages and counts stay.
//      - an application with an outcome the student keeps PUBLIC is skipped for as long as it is public.
//      - each application is done in one transaction and marked (CareerRetentionMark), so it is never redone.
//    Approved Resume Studio versions older than 2 years that no live application still uses: the resume
//    content is removed (the hash stays, so it can never be served again), the student id replaced.
//    Snapshots sent with an application already expire on their own 2 years after sending (TTL index).
//    MODE: CAREER_RETENTION_MODE=apply writes; anything else (the default) is a DRY RUN: it counts what
//    would change and logs the counts only, writing nothing.
//
// 2. forDeletedStudent(): the account-deletion service (services/accountDeletion.js) calls this inside its
//    transaction, for a student deleting their account: career rows are anonymised the same way (with the
//    deletion's own placeholder id), their outcomes, notifications and Resume Studio data deleted.
const mongoose = require("mongoose");
const CareerApplicationEvent = require("../../models/CareerApplicationEvent");
const CareerInterview = require("../../models/CareerInterview");
const CareerOffer = require("../../models/CareerOffer");
const CareerOutcome = require("../../models/CareerOutcome");
const CareerNotificationOutbox = require("../../models/CareerNotificationOutbox");
const CareerRetentionMark = require("../../models/CareerRetentionMark");
const CareerResumeApprovedVersion = require("../../models/CareerResumeApprovedVersion");
const CareerApplicationResumeAttachment = require("../../models/CareerApplicationResumeAttachment");
const CareerResumeDraft = require("../../models/CareerResumeDraft");
const CareerResumeTailorJob = require("../../models/CareerResumeTailorJob");
const CareerResumeSourceConfirmation = require("../../models/CareerResumeSourceConfirmation");
const { withTransaction } = require("../../utils/transaction");

const RETAIN_DAYS = 730;
const DAY = 864e5;
// event metadata that says what happened, never who said what: everything else is cleared
const KEEP_META = ["offerId", "interviewId", "startsAt", "endsAt", "timezone", "mode", "expiresAt", "response", "outcome", "legacyStatus", "previousStartsAt"];
// the personal metadata keys an event can carry (cleared on account deletion)
const PERSONAL_META = ["note", "internalNote", "reason", "message", "location", "meetingLink"];

const applyMode = () => String(process.env.CAREER_RETENTION_MODE || "").trim().toLowerCase() === "apply";
const keepMeta = (m = {}) => Object.fromEntries(KEEP_META.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));

/** Applications whose last timeline event is before the cutoff and that aren't done yet (oldest ids first). */
async function eligible(cutoff, limit) {
  const old = await CareerApplicationEvent.distinct("application", { occurredAt: { $lt: cutoff } });
  if (!old.length) return [];
  const [recent, done] = await Promise.all([
    CareerApplicationEvent.distinct("application", { application: { $in: old }, occurredAt: { $gte: cutoff } }),
    CareerRetentionMark.distinct("application", { application: { $in: old } }),
  ]);
  const skip = new Set([...recent, ...done].map(String));
  return old.filter((id) => !skip.has(String(id))).sort((a, b) => String(a).localeCompare(String(b))).slice(0, limit);
}

/** Anonymise one application's career rows (inside a transaction when the server has them). */
async function anonymiseApplication(application, ghostOf, now) {
  const { result } = await withTransaction(async (session) => {
    const o = { session };
    const find = (Model) => Model.find({ application }).session(session).lean();
    const counts = { events: 0, interviews: 0, offers: 0, outcomes: 0, outbox: 0 };
    for (const e of await find(CareerApplicationEvent)) {
      await CareerApplicationEvent.updateOne({ _id: e._id }, { $set: { candidate: ghostOf(e.candidate), employer: e.employer ? ghostOf(e.employer) : null, actor: e.actor ? ghostOf(e.actor) : null, metadata: keepMeta(e.metadata) } }, o);
      counts.events += 1;
    }
    for (const iv of await find(CareerInterview)) {
      const responses = (iv.responses || []).map((r) => ({ response: r.response, at: r.at }));
      await CareerInterview.updateOne({ _id: iv._id }, { $set: { candidate: ghostOf(iv.candidate), employer: ghostOf(iv.employer), location: "", meetingLink: "", note: "", responses } }, o);
      counts.interviews += 1;
    }
    for (const of of await find(CareerOffer)) {
      await CareerOffer.updateOne({ _id: of._id }, { $set: { candidate: ghostOf(of.candidate), employer: ghostOf(of.employer), terms: "", responseNote: "" } }, o);
      counts.offers += 1;
    }
    for (const oc of await find(CareerOutcome)) {
      await CareerOutcome.updateOne({ _id: oc._id }, { $set: { candidate: ghostOf(oc.candidate), employer: ghostOf(oc.employer), revokedReason: "" } }, o);
      counts.outcomes += 1;
    }
    for (const ob of await find(CareerNotificationOutbox)) {
      await CareerNotificationOutbox.updateOne({ _id: ob._id }, { $set: { recipient: ghostOf(ob.recipient), payload: {}, lastError: "" } }, o);
      counts.outbox += 1;
    }
    await CareerRetentionMark.create([{ application, anonymisedAt: now, counts }], o);
    return counts;
  });
  return result;
}

/** Old approved versions no live application still uses */
async function oldVersions(cutoff, now, limit) {
  const list = await CareerResumeApprovedVersion.find({ approvedAt: { $lt: cutoff }, "contentSnapshot.anonymised": { $ne: true } }).select("_id userId").limit(limit * 2).lean();
  if (!list.length) return [];
  const inUse = new Set((await CareerApplicationResumeAttachment.distinct("versionId", { versionId: { $in: list.map((v) => v._id) }, retainUntil: { $gt: now } })).map(String));
  return list.filter((v) => !inUse.has(String(v._id))).slice(0, limit);
}

/**
 * One retention pass. Returns the counts; writes only in apply mode.
 *   { mode, cutoff, applications, skippedPublic, events, interviews, offers, outcomes, outbox, resumeVersions }
 */
async function run({ now = new Date(), apply = applyMode(), limit = 200 } = {}) {
  const cutoff = new Date(now.getTime() - RETAIN_DAYS * DAY);
  const candidates = await eligible(cutoff, limit);
  const publicApps = new Set((await CareerOutcome.distinct("application", { application: { $in: candidates }, visibility: "public" })).map(String));
  const apps = candidates.filter((id) => !publicApps.has(String(id)));
  const versions = await oldVersions(cutoff, now, limit);
  const out = { mode: apply ? "apply" : "dry-run", cutoff, applications: apps.length, skippedPublic: publicApps.size, events: 0, interviews: 0, offers: 0, outcomes: 0, outbox: 0, resumeVersions: versions.length };

  if (!apply) {
    const inApps = { application: { $in: apps } };
    [out.events, out.interviews, out.offers, out.outcomes, out.outbox] = await Promise.all(
      [CareerApplicationEvent, CareerInterview, CareerOffer, CareerOutcome, CareerNotificationOutbox].map((M) => (apps.length ? M.countDocuments(inApps) : 0))
    );
  } else {
    const ghosts = new Map();
    const ghostOf = (id) => {
      if (id == null) return id;
      const k = String(id);
      if (!ghosts.has(k)) ghosts.set(k, new mongoose.Types.ObjectId());
      return ghosts.get(k);
    };
    for (const application of apps) {
      try {
        const c = await anonymiseApplication(application, ghostOf, now);
        for (const k of Object.keys(c)) out[k] += c[k];
      } catch (err) {
        if (err?.code === 11000) continue; // another server marked it first
        out.errors = (out.errors || 0) + 1;
        console.error(`[career-retention] application ${application} failed: ${err.message}`);
      }
    }
    for (const v of versions) {
      await CareerResumeApprovedVersion.updateOne(
        { _id: v._id, "contentSnapshot.anonymised": { $ne: true } },
        { $set: { userId: ghostOf(v.userId), label: "", "target.title": "", contentSnapshot: { anonymised: true, at: now } } }
      );
    }
  }
  // counts only: never ids, names or content
  console.log(`[career-retention] ${out.mode}: ${out.applications} application(s) older than ${RETAIN_DAYS} days (events ${out.events}, interviews ${out.interviews}, offers ${out.offers}, outcomes ${out.outcomes}, notifications ${out.outbox}); ${out.skippedPublic} skipped (public outcome); ${out.resumeVersions} old resume version(s)${out.errors ? `; ${out.errors} failed` : ""}${out.mode === "dry-run" ? "; nothing written (CAREER_RETENTION_MODE=apply to write)" : ""}`);
  return out;
}

/**
 * Account deletion of a student (inside the deletion's transaction; its ghost id replaces theirs).
 * upd / del are the deletion service's counting helpers.
 */
async function forDeletedStudent({ id, ghost, upd, del }) {
  const unsetPersonal = Object.fromEntries(PERSONAL_META.map((k) => [`metadata.${k}`, ""]));
  await upd(CareerApplicationEvent, { candidate: id }, { $set: { candidate: ghost }, $unset: unsetPersonal }, "anonymised");
  await upd(CareerApplicationEvent, { actor: id }, { $set: { actor: ghost } }, "anonymised");
  await upd(CareerInterview, { candidate: id }, { $set: { candidate: ghost, location: "", meetingLink: "", note: "", responses: [] } }, "anonymised");
  await upd(CareerOffer, { candidate: id }, { $set: { candidate: ghost, terms: "", responseNote: "" } }, "anonymised");
  await del(CareerOutcome, { candidate: id });
  await del(CareerNotificationOutbox, { recipient: id });
  // ratings: the ones they wrote and the ones about them, and their reports
  const CareerRating = require("../../models/CareerRating");
  const mine = (await CareerRating.find({ $or: [{ rater: id }, { ratee: id }] }).select("_id").lean()).map((x) => x._id);
  await del(require("../../models/CareerRatingReport"), { $or: [{ rating: { $in: mine } }, { reporter: id }] });
  await del(CareerRating, { _id: { $in: mine } });
  await del(CareerApplicationResumeAttachment, { userId: id });
  await del(CareerResumeApprovedVersion, { userId: id });
  await del(CareerResumeDraft, { userId: id });
  await del(CareerResumeTailorJob, { userId: id });
  await del(CareerResumeSourceConfirmation, { userId: id });
  // candidate matching: the stored evidence quotes their resume
  await del(require("../../models/CareerMatchSnapshot"), { candidate: id });
}

module.exports = { run, forDeletedStudent, eligible, RETAIN_DAYS, KEEP_META, applyMode };
