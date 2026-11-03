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
    else fallback = r.error; // malformed twice, or the model failed: no suggestions, the student keeps their resume
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
    match: explainMatch(resume, facts, job, model),
    warnings: [...new Set(warnings)].slice(0, 20),
    fallback, // null when the model answered; else why there are no AI suggestions
  };
}

module.exports = { generateSuggestions, StudioError };
