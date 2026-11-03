// services/resumeStudio/match.js
// Match explanation (handoff PART B 7): for each job requirement, "matched" (with the candidate facts
// that show it), "missing" (nothing in the resume mentions it) or "unknown" (we can't tell from the
// resume, e.g. years of experience). No probability, no score, no hiring prediction.
// Skills come from skillGapService's raw path (the student's own skills, not AI-extracted ones).
const { flattenCandidateSkills } = require("../skillGapService");
const { normalizeSkill } = require("../../utils/skillNormalizer");
const { skillTermsIn } = require("./jobRequirements");

const key = (s) => String(normalizeSkill(s) || s || "").toLowerCase().trim();

/**
 * @param resume the source Resume (lean)
 * @param facts VerifiedResumeFacts
 * @param job { requirements: [{ requirement, kind }] }
 * @param model optional model output { missingRequirements: [{ requirement, coachingNote }] } for notes
 */
function explainMatch(resume, facts, job, model = null) {
  const own = flattenCandidateSkills({ skills: resume.skills || [] }).map((s) => key(s.name)); // raw only
  const factSkills = facts.map((f) => ({ factId: f.factId, terms: new Set(skillTermsIn(f.value).map(key)) }));
  const notes = new Map((model?.missingRequirements || []).filter((m) => m.coachingNote).map((m) => [key(m.requirement), m.coachingNote]));
  const out = { matched: [], missing: [], unknown: [] };
  for (const r of job.requirements || []) {
    if (r.kind !== "skill") {
      out.unknown.push({ requirement: r.requirement, kind: r.kind, note: "We can't tell this from your resume. If it applies to you, make sure your resume says so." });
      continue;
    }
    const k = key(r.requirement);
    const evidence = facts.filter((f) => f.type === "skill" && key(f.value) === k).map((f) => f.factId);
    for (const fs of factSkills) if (fs.terms.has(k) && !evidence.includes(fs.factId)) evidence.push(fs.factId);
    if (evidence.length || own.includes(k)) out.matched.push({ requirement: r.requirement, kind: "skill", evidenceFactIds: evidence.slice(0, 6) });
    else out.missing.push({ requirement: r.requirement, kind: "skill", coachingNote: notes.get(k) || "Not in your resume. Only add it if you really have this skill, e.g. from a course or project." });
  }
  return out;
}

module.exports = { explainMatch };
