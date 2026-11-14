// services/career/recommendations.js
// Job recommendations for students with FLAG_CAREER_MATCHING, from the skill-evidence matcher
// (services/career/matchingService.js, docs/MATCHING_FAIRNESS.md): open jobs scored against the student's latest
// resume, never reading name, gender, photo, age, university, city or contact details. No embeddings, no location,
// no behaviour. Every recommendation surface uses it for students in the pilot (careers hub, Resume dashboard,
// Enhance Career, the job feed's order); students outside the pilot keep the older engines unchanged.
//
//   inPilot(userId)                         FLAG_CAREER_MATCHING for this student
//   recommend(userId, { resumeId, limit, minScore, all })
//       → { hasResume, recommendations: [job + matchPercentage, matchedSkills, matchReasons, explanation, match] }
//     A recommendation: score >= minScore (default 60) and no mandatory criterion "not met". all: true scores every
//     open job instead (the feed's order: highest estimate first, "insufficient" last, nothing hidden).
//   matchJobFor(userId, job)                one job (job details "your match"): { hasResume, match } with the matched
//                                           skills and where the resume shows them, the missing ones, the mandatory
//                                           criteria and a one-line summary; match null without a resume.
//
// Results are cached in memory per (job version, resume version) fingerprint, 30 minutes, at most 20,000 entries:
// a change to the job or the resume gives a new fingerprint and a fresh score (no database cache, no
// CareerMatchSnapshot change).
const mongoose = require("mongoose");
const Job = require("../../models/Job");
const Resume = require("../../models/Resume");
const JobApplication = require("../../models/JobApplication");
const matching = require("./matchingService");
const { isEnabled } = require("../../config/featureFlags");

const { roleOf } = require("../../utils/userRole");
const DEFAULT_MIN_SCORE = 60;
const MAX_JOBS = 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 20000;
const cache = new Map(); // `${jobFp}:${profileFp}` -> { at, result }

const inPilot = (userId) => !!userId && isEnabled("careerMatching", { id: String(userId), role: "student" });
/** a student (role from the database) with FLAG_CAREER_MATCHING: the older engines' routes switch to this one */
async function isPilotStudent(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return false;
  if (!inPilot(userId)) return false;
  const u = await require("../../models/User").findById(userId).select("role").lean();
  return roleOf(u) === "student"; // a missing role is a student
}

function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = compute();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  cache.set(key, { at: Date.now(), result });
  return result;
}
const clearCache = () => cache.clear();

// a short, readable reason per matched skill: where the resume shows it
const reasonOf = (m) => {
  const e = (m.evidence || [])[0];
  return e?.text ? `${m.skill}: "${String(e.text).slice(0, 90)}${String(e.text).length > 90 ? "…" : ""}"` : `${m.skill}: in your resume`;
};

/** the student's resume: the one asked for (their own), else the primary, else the latest */
async function resumeOf(userId, resumeId = null) {
  if (resumeId) return mongoose.Types.ObjectId.isValid(String(resumeId)) ? Resume.findOne({ _id: resumeId, user: userId }).lean() : null;
  return (await Resume.findOne({ user: userId, isPrimary: true }).lean()) || Resume.findOne({ user: userId }).sort({ updatedAt: -1 }).lean();
}

async function recommend(userId, { resumeId = null, limit = 10, minScore = DEFAULT_MIN_SCORE, all = false, isExternal = null, now = new Date() } = {}) {
  const resume = await resumeOf(userId, resumeId);
  if (!resume) return { hasResume: false, recommendations: [] };
  const profile = matching.profileOf({ resume });
  const profileFp = matching.profileFingerprint(profile);
  const applied = new Set((await JobApplication.find({ userId }).select("jobId").lean()).map((a) => String(a.jobId)));
  const jobs = await Job.find({
    active: true,
    ...(isExternal === null ? {} : { isExternal }),
    $or: [{ applicationDeadline: null }, { applicationDeadline: { $exists: false } }, { applicationDeadline: { $gt: now } }],
  }).select("-email").sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
  const out = [];
  for (const job of jobs) {
    if (applied.has(String(job._id))) continue;
    const m = cached(`${matching.jobFingerprint(job)}:${profileFp}`, () => matching.match(job, profile));
    const score = m.relevance.score;
    const notMet = m.mandatorySummary.notMet > 0;
    if (!all && (score == null || score < minScore || notMet)) continue;
    out.push({
      ...job,
      matchPercentage: score ?? 0,
      isRecommended: score != null && score >= minScore && !notMet,
      matchedSkills: m.skills.matched.map((s) => s.skill),
      missingSkills: m.skills.missing.map((s) => s.skill),
      matchReasons: m.skills.matched.slice(0, 4).map(reasonOf),
      explanation: {
        matchPercentage: score ?? 0,
        highlights: [m.relevance.label],
        matchedSkills: m.skills.matched.map((s) => s.skill).slice(0, 8),
        missingSkills: m.skills.missing.map((s) => s.skill).slice(0, 8),
        matchedRequiredSkillsCount: m.skills.matched.length,
        totalRequiredSkillsCount: m.skills.matched.length + m.skills.missing.length + m.skills.unknown.length,
        matchedProjects: [], matchedExperience: [], matchedEducation: [], matchedLocation: [],
      },
      match: { modelVersion: m.modelVersion, score, insufficient: m.relevance.insufficient, label: m.relevance.label, mandatorySummary: m.mandatorySummary, skills: m.skills },
      engine: matching.MODEL_VERSION,
    });
  }
  // highest estimate first; "insufficient" last; ties: newest first (the order they came in)
  out.sort((a, b) => (b.match.score ?? -1) - (a.match.score ?? -1));
  return { hasResume: true, recommendations: limit ? out.slice(0, limit) : out };
}

/** the student's match for one job (their primary resume, else the latest); job needs skills, requirements,
 *  minExperience, education, title */
async function matchJobFor(userId, job) {
  const resume = await resumeOf(userId);
  if (!resume) return { hasResume: false, match: null };
  const profile = matching.profileOf({ resume });
  const m = cached(`${matching.jobFingerprint(job)}:${matching.profileFingerprint(profile)}`, () => matching.match(job, profile));
  const score = m.relevance.score;
  return {
    hasResume: true,
    match: {
      modelVersion: m.modelVersion,
      score,
      quality: matching.qualityOf(score),
      insufficient: m.relevance.insufficient,
      label: m.relevance.label,
      summary: matching.summaryLine(m),
      matched: m.skills.matched.map((s) => ({ skill: s.skill, evidence: (s.evidence || []).map((e) => e.text).filter(Boolean).slice(0, 2) })),
      missing: m.skills.missing.map((s) => s.skill),
      unknown: m.skills.unknown.map((s) => s.skill),
      mandatory: m.mandatory,
      mandatorySummary: m.mandatorySummary,
    },
  };
}

module.exports = { inPilot, isPilotStudent, recommend, matchJobFor, clearCache, DEFAULT_MIN_SCORE, CACHE_TTL_MS };
