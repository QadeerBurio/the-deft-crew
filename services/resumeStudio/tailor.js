// services/resumeStudio/tailor.js
// One tailoring pass, with no database: verified facts + job -> model -> strict parse -> deterministic
// checks -> suggestions with a status each, plus the match explanation. The worker stores the result
// as a CareerResumeDraft. Nothing here changes a resume.
// v3: the model rewrites for the job (headline, summary, bullets, order, one-line versions); when it leaves
// an order unchanged, entries, skills and sections are still ordered by how much of the job they show
// (deterministic, from the job's keywords), so the most relevant comes first.
const contract = require("./contract");
const { buildVerifiedFacts } = require("./facts");
const { parseModelOutput } = require("./output");
const { checkSuggestion, corpusOf, defaultSectionOrder, SECTION_LIST, entryText, getAt, condenseTarget } = require("./validator");
const { explainMatch } = require("./match");
const { coverage, relevanceOf } = require("./keywords");
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

// ---------- length and relevance ----------
const monthsOf = (w) => {
  const a = /^(\d{4})-(\d{2})$/.exec(w.startDate || "");
  const b = w.current ? [null, String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, "0")] : /^(\d{4})-(\d{2})$/.exec(w.endDate || "");
  if (!a || !b) return 3;
  return Math.max(1, (Number(b[1]) - Number(a[1])) * 12 + Number(b[2]) - Number(a[2]));
};
/** 1 page for students with little experience (under 2 years of roles), else at most 2 */
const pageBudgetOf = (content) => ((content.workExperience || []).reduce((n, w) => n + monthsOf(w), 0) < 24 ? 1 : 2);
/** about how many A4 pages a content fills (ATS Classic: ~95 characters a line, ~52 lines a page) */
function estimatePages(content) {
  const c = content || {};
  const lines = (t) => Math.max(1, Math.ceil(String(t || "").length / 95));
  let n = 4 + (c.professionalSummary?.summary ? 2 + lines(c.professionalSummary.summary) : 0);
  const sectionHead = 2;
  if ((c.workExperience || []).length) n += sectionHead + c.workExperience.reduce((s, w) => s + 2 + (w.description ? lines(w.description) : 0) + (w.achievements || []).reduce((x, a) => x + lines(a), 0) + 0.3, 0);
  if ((c.projects || []).length) n += sectionHead + c.projects.reduce((s, p) => s + 2 + (p.description ? lines(p.description) : 0), 0);
  if ((c.education || []).length) n += sectionHead + c.education.reduce((s, e) => s + 2 + (e.description ? lines(e.description) : 0), 0);
  if ((c.skills || []).length) n += sectionHead + lines(c.skills.map((s) => s.name).join(", "));
  if ((c.certifications || []).length) n += sectionHead + c.certifications.length;
  if ((c.languages || []).length) n += sectionHead + 1;
  return Math.max(1, Math.round((n / 52) * 10) / 10);
}

const isIdentity = (order) => order.every((x, i) => x === i);
// indexes of a list sorted by relevance to the job (most first; ties keep the resume's order)
function relevanceOrder(list, textOf, keywords) {
  const scored = list.map((x, i) => ({ i, s: relevanceOf(textOf(x), keywords) }));
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.i);
}

/** order suggestions the model didn't make: entries, skills and sections by relevance to the job's keywords */
function relevanceSuggestions(content, job, made) {
  const keywords = job.keywords || [];
  if (!keywords.length) return [];
  const out = [];
  const add = (fieldPath, order, reason) => {
    if (made.has(fieldPath) || !order.length || (Array.isArray(order) && order.every((x, i) => x === i))) return;
    out.push({ kind: "reorder", fieldPath, original: "", proposed: JSON.stringify(order), reason, sourceFactIds: [] });
  };
  add("order.workExperience", relevanceOrder(content.workExperience, (w) => [w.position, w.description, ...w.achievements].join(" "), keywords), "the experience closest to this job first");
  add("order.projects", relevanceOrder(content.projects, (p) => [p.name, p.description, ...p.technologies].join(" "), keywords), "the projects closest to this job first");
  add("order.education", relevanceOrder(content.education, (e) => [e.degree, e.fieldOfStudy, e.description].join(" "), keywords), "the education closest to this job first");
  // the job's skills first (skills the resume lists; added ones are placed first anyway)
  add("order.skills", relevanceOrder(content.skills, (s) => s.name, keywords), "the skills this job asks for first");
  content.workExperience.forEach((w, i) => {
    if (w.achievements.length > 1) add(`order.workExperience[${i}].achievements`, relevanceOrder(w.achievements, (a) => a, keywords), "the points that matter for this job first");
  });
  // sections: experience vs projects by how much of the job each shows (education keeps its place)
  const sections = defaultSectionOrder(content);
  const weight = (name) => (content[SECTION_LIST[name]] || []).reduce((n, e) => n + relevanceOf(typeof e === "object" ? entryText(e) + " " + (e.name || e.position || e.degree || "") + " " + (e.technologies || []).join(" ") : e, keywords), 0);
  if (sections.includes("experience") && sections.includes("projects")) {
    const want = weight("projects") > weight("experience") ? ["projects", "experience"] : ["experience", "projects"];
    const rest = sections.filter((x) => !want.includes(x));
    const next = [...want, ...rest.filter((x) => x === "skills"), ...rest.filter((x) => x !== "skills")];
    if (next.join() !== sections.join()) out.push({ kind: "reorder", fieldPath: "order.sections", original: "", proposed: JSON.stringify(next), reason: "the strongest section for this job first", sourceFactIds: [] });
  }
  return out;
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
  const sections = defaultSectionOrder(content);
  const pageBudget = pageBudgetOf(content);
  const entries = {
    workExperience: content.workExperience.map((w, i) => `${i}: ${w.position} at ${w.company}`),
    projects: content.projects.map((p, i) => `${i}: ${p.name}`),
    education: content.education.map((e, i) => `${i}: ${e.degree}, ${e.institution}`),
  };

  let model = null;
  let fallback = null;
  if (!ai.available()) fallback = "no_model";
  else if (!editable.length) fallback = "nothing_to_tailor";
  else {
    const ctx = { editablePaths: new Set(editable.map((e) => e.fieldPath)), factIds: new Set(facts.map((f) => f.factId)) };
    const r = await ai.completeJson(contract.buildMessages({ facts, editable, job, sections, pageBudget, entries }), (text) => parseModelOutput(text, ctx));
    if (r.ok) model = r.value;
    // the model failed, timed out, was cut off or answered badly twice: nothing is saved (no half-empty draft);
    // the student is told and can try again
    else if (r.error === "model_timeout") throw new StudioError("AI_TIMEOUT", "Tailoring took too long. Please try again.");
    else throw new StudioError("AI_FAILED", "Tailoring didn't work this time. Please try again.");
  }

  const corpus = corpusOf(facts);
  const jobCtx = { title: job.title || "", terms: [job.title, ...(job.keywords || []).map((k) => k.term)].filter(Boolean).join("\n") };
  const seen = new Set();
  const suggestions = [];
  const push = (s) => {
    if (seen.has(s.fieldPath)) return;
    seen.add(s.fieldPath);
    // a one-line version shows what it replaces
    if (s.kind === "condense") s = { ...s, original: entryText(getAt(content, condenseTarget(s.fieldPath))) };
    if (s.kind === "reword" && s.proposed.trim() === s.original.trim()) return;
    if (s.kind === "reorder") { try { if (isIdentity(JSON.parse(s.proposed))) return; } catch {} }
    const check = checkSuggestion(s, { content, corpus, job: jobCtx });
    suggestions.push({ suggestionId: `s${suggestions.length + 1}`, ...s, status: check.status, riskFlags: check.riskFlags });
  };
  for (const s of model?.suggestions || []) push(s);
  // the model's answer counts: deterministic orders only fill in what it left out
  // (only when the model tailored something: no suggestions means the resume stays exactly as the student wrote it)
  if (model && (model.suggestions || []).length) for (const s of relevanceSuggestions(content, job, seen)) push(s);
  for (const w of model?.warnings || []) warnings.push(w);

  return {
    promptVersion: contract.PROMPT_VERSION,
    sourceRevisionHash: revisionHash,
    provenance: built.provenance,
    sourceContent: content,
    facts,
    suggestions,
    match: {
      ...explainMatch(resume, facts, job, model),
      jobSkills: jobSkillsOf(job),
      surfaced: surfacedSkills(content, job),
      confirmedSkills: [],
      keywords: (job.keywords || []).slice(0, 24),
      pageBudget,
    },
    warnings: [...new Set(warnings)].slice(0, 20),
    fallback, // null when the model answered; else why there are no AI suggestions
  };
}

module.exports = { generateSuggestions, StudioError, surfacedSkills, jobSkillsOf, estimatePages, pageBudgetOf, relevanceSuggestions, coverage };
