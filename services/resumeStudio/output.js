// services/resumeStudio/output.js
// Strict parsing of the model's JSON (handoff PART B 6.3). Anything outside the schema is dropped; fact
// ids the model made up are dropped; field paths must be ones we offered. A reply that isn't valid JSON
// (or isn't an object) is "malformed": the caller retries once, then falls back to no suggestions.

const TEXT_PATH = /^(professionalSummary\.summary|workExperience\[\d+\]\.description|workExperience\[\d+\]\.achievements\[\d+\]|projects\[\d+\]\.description|education\[\d+\]\.description)$/;
const ORDER_PATH = /^order\.(skills|projects|workExperience\[\d+\]\.achievements)$/;
const MAX_SUGGESTIONS = 60;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function stripFences(raw) {
  const t = String(raw || "").trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

/**
 * @param raw the model's reply text
 * @param ctx { editablePaths: Set, factIds: Set }
 * @returns { ok: true, value } | { ok: false, error }
 */
function parseModelOutput(raw, ctx) {
  let obj;
  try {
    obj = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, error: "malformed_json" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "not_an_object" };
  const warnings = [];
  const knownFacts = (ids) => {
    const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
    const ok = list.filter((x) => ctx.factIds.has(x));
    if (ok.length < list.length) warnings.push("the model cited fact ids that don't exist; they were ignored");
    return ok;
  };
  const suggestions = [];
  for (const s of (Array.isArray(obj.suggestions) ? obj.suggestions : []).slice(0, MAX_SUGGESTIONS)) {
    if (!s || typeof s !== "object") continue;
    const fieldPath = str(s.fieldPath, 120);
    const isText = TEXT_PATH.test(fieldPath) && ctx.editablePaths.has(fieldPath);
    const isOrder = ORDER_PATH.test(fieldPath);
    if (!isText && !isOrder) {
      warnings.push(`ignored a change to a field that can't be tailored (${fieldPath || "none"})`);
      continue;
    }
    suggestions.push({
      kind: isOrder ? "reorder" : "reword",
      fieldPath,
      original: str(s.original, 4000),
      proposed: str(s.proposed, 1500),
      reason: str(s.reason, 300),
      sourceFactIds: knownFacts(s.sourceFactIds),
    });
  }
  const matchedRequirements = (Array.isArray(obj.matchedRequirements) ? obj.matchedRequirements : []).slice(0, 60)
    .filter((m) => m && typeof m.requirement === "string")
    .map((m) => ({ requirement: str(m.requirement, 200), supportingFactIds: knownFacts(m.supportingFactIds) }));
  const missingRequirements = (Array.isArray(obj.missingRequirements) ? obj.missingRequirements : []).slice(0, 60)
    .filter((m) => m && typeof m.requirement === "string")
    .map((m) => ({ requirement: str(m.requirement, 200), classification: m.classification === "unknown" ? "unknown" : "missing", coachingNote: str(m.coachingNote, 300) }));
  for (const w of (Array.isArray(obj.warnings) ? obj.warnings : []).slice(0, 30)) if (typeof w === "string") warnings.push(w.slice(0, 300));
  return { ok: true, value: { suggestions, matchedRequirements, missingRequirements, warnings } };
}

module.exports = { parseModelOutput, TEXT_PATH, ORDER_PATH, stripFences };
