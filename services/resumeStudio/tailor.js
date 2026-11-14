// services/resumeStudio/tailor.js
// One tailoring pass, with no database: verified facts + job -> model -> strict parse -> deterministic
// checks -> suggestions with a status each, plus the match explanation. The worker stores the result
// as a CareerResumeDraft. Nothing here changes a resume.
const contract = require("./contract");
const { buildVerifiedFacts } = require("./facts");
const { parseModelOutput } = require("./output");
const { checkSuggestion, corpusOf } = require("./validator");
const { explainMatch } = require("./match");
const ai = require("./ai");
const matching = require("../career/matchingService");

// the job's skills (its requirements of kind "skill"), as the matcher reads them
const jobSkillsOf = (job) => [...new Set((job.requirements || []).filter((r) => r.kind === "skill").map((r) => String(r.requirement || "").trim()).filter(Boolean))];

/**
 * Skills the job asks for that the resume already SHOWS in experience / projects / certifications but doesn't list
 * under skills: they go into the skills section in the job's wording (e.g. "React.js" in a project → "React").
 * Never a skill without evidence in the resume. [{ skill, evidence: [{ path, text }] }]
 */
function surfacedSkills(content, job) {
  const skills = jobSkillsOf(job);
  if (!skills.length) return [];
  const m = matching.match({ skills, requirements: [] }, matching.profileOf({ content }));
  return (m.skills?.matched || [])
    .filter((s) => (s.evidence || []).length && !(s.evidence || []).some((e) => /^skills\[/.test(e.path)))
    .map((s) => ({ skill: s.skill, evidence: (s.evidence || []).filter((e) => e.path && !/^skills\[/.test(e.path)).slice(0, 2) }));
}

class StudioError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param resume source Resume (lean)
 * @param confirmation the student's confirmation of an uploaded resume's revision, or null
 * @param job output of jobRequirements.requirementsFor
 */
async function generateSuggestions({ resume, confirmation = null, job }) {
  const built = buildVerifiedFacts(resume, confirmation);
  if (!built.verified) throw new StudioError("SOURCE_UNVERIFIED", "Please check and confirm the details read from your uploaded resume first.");
  const { facts, content, editable, revisionHash } = built;
  const warnings = (job.injectionFlags || []).length ? ["Some lines in the job description looked like instructions to the AI and were ignored."] : [];

  let model = null;
  let fallback = null;
  if (!ai.available()) fallback = "no_model";
  else if (!editable.length) fallback = "nothing_to_tailor";
  else {
    const ctx = { editablePaths: new Set(editable.map((e) => e.fieldPath)), factIds: new Set(facts.map((f) => f.factId)) };
    const r = await ai.completeJson(contract.buildMessages({ facts, editable, job }), (text) => parseModelOutput(text, ctx));
    if (r.ok) model = r.value;
    // the model failed, timed out, was cut off or answered badly twice: nothing is saved (no half-empty draft);
    // the student is told and can try again
    else if (r.error === "model_timeout") throw new StudioError("AI_TIMEOUT", "Tailoring took too long. Please try again.");
    else throw new StudioError("AI_FAILED", "Tailoring didn't work this time. Please try again.");
  }

  const corpus = corpusOf(facts);
  const seen = new Set();
  const suggestions = [];
  for (const s of model?.suggestions || []) {
    if (seen.has(s.fieldPath)) continue;
    seen.add(s.fieldPath);
    if (s.kind === "reword" && s.proposed.trim() === s.original.trim()) continue;
    const check = checkSuggestion(s, { content, corpus });
    suggestions.push({ suggestionId: `s${suggestions.length + 1}`, ...s, status: check.status, riskFlags: check.riskFlags });
  }
  for (const w of model?.warnings || []) warnings.push(w);

  return {
    promptVersion: contract.PROMPT_VERSION,
    sourceRevisionHash: revisionHash,
    provenance: built.provenance,
    sourceContent: content,
    facts,
    suggestions,
    match: { ...explainMatch(resume, facts, job, model), jobSkills: jobSkillsOf(job), surfaced: surfacedSkills(content, job), confirmedSkills: [] },
    warnings: [...new Set(warnings)].slice(0, 20),
    fallback, // null when the model answered; else why there are no AI suggestions
  };
}

module.exports = { generateSuggestions, StudioError, surfacedSkills, jobSkillsOf };
