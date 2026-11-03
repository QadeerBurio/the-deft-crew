// services/resumeStudio/validator.js
// Deterministic fact checks (handoff PART B 6.4). A suggestion, an edit, or a whole resume version is
// compared with the candidate's verified facts:
//   - numbers / percentages, dates, skills, organisation-like names, links and e-mails in the new text
//     must already be in the original text or in the candidate's facts
//   - names, employers, titles, schools, certificates, dates, locations, links and contact details can't
//     change at all; entries can't be added or dropped (only reordered)
// Outcome per change: "ok", "needs_user_confirmation" (a new claim: shown, never inserted until the
// student explicitly confirms it is true) or "blocked" (can't be applied). Runs at generation, on every
// edit, and again at approval. It can't prove every meaning; it removes the unsupported additions we can
// detect, and the student reviews every change.
const { skillTermsIn } = require("./jobRequirements");

const NUMBER_RE = /(?<![A-Za-z])(\d+(?:[.,]\d+)*)(\s?(?:%|percent|x|k|m|million|thousand|hours?|days?|weeks?|months?|years?|users?|customers?|students?|people|members?))?/gi;
const YEAR_RE = /\b(19|20)\d{2}\b/g;
const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\s+(19|20)\d{2}\b/gi;
const LINK_RE = /\b(https?:\/\/\S+|www\.\S+|[a-z0-9-]+\.(com|pk|org|net|io|dev|app)(\/\S*)?)\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// capitalised word runs that look like names of organisations, products, schools (not sentence starts)
const PROPER_RE = /(?<=[a-z,;:]\s)([A-Z][a-zA-Z0-9&.'-]*(?:\s+(?:of|and|&|for|the|[A-Z][a-zA-Z0-9&.'-]*))*)/g;
const COMMON_CAPS = new Set(["I", "A", "An", "The", "And", "Or", "In", "On", "At", "For", "With", "To", "Of", "By", "As", "From", "Using", "Through", "Developed", "Built", "Designed", "Led", "Managed", "Created", "Implemented", "Worked", "Collaborated", "Improved", "Delivered", "Supported", "Maintained", "Wrote", "Tested", "Contributed", "Student", "Final", "Team", "Project", "Projects", "Application", "App", "Web", "Mobile", "University", "College", "School", "Course", "Coursework", "Academic", "Intern", "Internship", "Volunteer", "Pakistan", "Karachi", "Lahore", "Islamabad", "English", "Urdu", "API", "APIs", "UI", "UX", "CV"]);

// words that claim seniority, responsibility or recognition: new ones need the student's confirmation
const CLAIM_WORDS = ["led", "lead", "leading", "headed", "managed", "managing", "supervised", "mentored", "coached", "trained", "owned", "spearheaded", "architected", "directed", "oversaw", "founded", "co-founded", "promoted", "award", "awarded", "award-winning", "winner", "won", "ranked", "top", "published", "patent", "certified", "senior", "expert", "principal", "chief", "head", "team of", "end-to-end", "single-handedly", "revenue", "profit", "clients", "customers"];
const claimRe = (w) => new RegExp(`(^|[^a-z-])${w}([^a-z-]|$)`, "i"); // words are plain letters, spaces and hyphens
const CLAIM_RES = CLAIM_WORDS.map((w) => [w, claimRe(w)]);

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// whole numbers as tokens ("5,000" = "5000"); a percentage only matches the same percentage
const numbersIn = (t) => {
  const out = new Set();
  for (const m of String(t || "").matchAll(NUMBER_RE)) {
    const n = m[1].replace(/,/g, "");
    if (/^(19|20)\d{2}$/.test(n)) continue; // years are checked as dates
    out.add(/^\s?(%|percent)$/i.test(m[2] || "") ? `${n}%` : n);
  }
  return out;
};
const yearsIn = (t) => new Set(String(t || "").match(YEAR_RE) || []);
const monthYearsIn = (t) => new Set((String(t || "").match(MONTH_RE) || []).map(norm));
const linksIn = (t) => new Set((String(t || "").match(LINK_RE) || []).map(norm));
const emailsIn = (t) => new Set((String(t || "").match(EMAIL_RE) || []).map(norm));
const properIn = (t) => {
  const out = new Set();
  for (const m of String(t || "").matchAll(PROPER_RE)) {
    const phrase = m[1].trim().replace(/[.,;:]+$/, "");
    const words = phrase.split(/\s+/).filter((w) => !COMMON_CAPS.has(w));
    if (words.length) out.add(phrase);
  }
  return out;
};
const missingFrom = (set, corpusLower) => [...set].filter((x) => !corpusLower.includes(norm(x)));

/**
 * Check a new text against what supports it.
 * @param proposed the new text
 * @param original the text it replaces ("" for none)
 * @param corpus all the candidate's fact texts (+ claims the student confirmed), as one string
 * @returns { status, riskFlags: [{ flag, values }] }
 */
function checkText(proposed, original, corpus) {
  const support = norm(`${original}\n${corpus}`);
  const flags = [];
  const add = (flag, values) => { if (values.length) flags.push({ flag, values: values.slice(0, 8) }); };
  const knownNumbers = numbersIn(support);
  add("new_number", [...numbersIn(proposed)].filter((n) => !knownNumbers.has(n)));
  add("new_date", [...missingFrom(yearsIn(proposed), support), ...missingFrom(monthYearsIn(proposed), support)]);
  const knownSkills = new Set(skillTermsIn(support).map(norm));
  add("new_skill", skillTermsIn(proposed).filter((s) => !knownSkills.has(norm(s)) && !support.includes(norm(s))));
  add("new_link", missingFrom(linksIn(proposed), support));
  add("new_email", missingFrom(emailsIn(proposed), support));
  add("new_name", missingFrom(properIn(proposed), support).filter((p) => !skillTermsIn(p).length));
  add("new_claim", CLAIM_RES.filter(([, re]) => re.test(proposed) && !re.test(support)).map(([w]) => w));
  if (String(proposed).length > Math.max(120, String(original).length * 2.5)) flags.push({ flag: "much_longer", values: [] });
  const blocking = flags.some((f) => ["new_date", "new_link", "new_email"].includes(f.flag));
  const status = blocking ? "blocked" : flags.length ? "needs_user_confirmation" : "ok";
  return { status, riskFlags: flags };
}

// ---------- paths into the content ----------
function getAt(content, path) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  return parts.reduce((o, k) => (o == null ? undefined : o[k]), content);
}
function setAt(content, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let o = content;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
const listForOrder = (content, path) => getAt(content, path.replace(/^order\./, ""));

/**
 * One suggestion from the model, against the source content and facts.
 * @returns { status, riskFlags, reason? }
 */
function checkSuggestion(s, { content, corpus }) {
  if (s.kind === "reorder") {
    const list = listForOrder(content, s.fieldPath);
    let order;
    try { order = JSON.parse(s.proposed); } catch { order = null; }
    const n = Array.isArray(list) ? list.length : -1;
    const isPermutation = Array.isArray(order) && order.length === n && new Set(order).size === n && order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
    return isPermutation ? { status: "ok", riskFlags: [] } : { status: "blocked", riskFlags: [{ flag: "not_a_reorder", values: [] }] };
  }
  const current = getAt(content, s.fieldPath);
  if (typeof current !== "string") return { status: "blocked", riskFlags: [{ flag: "unknown_field", values: [s.fieldPath] }] };
  if (norm(current) !== norm(s.original)) return { status: "blocked", riskFlags: [{ flag: "original_mismatch", values: [] }] };
  if (!s.proposed.trim()) return { status: "blocked", riskFlags: [{ flag: "empties_field", values: [] }] };
  const r = checkText(s.proposed, current, corpus);
  if (!s.sourceFactIds?.length && r.status === "ok" && norm(s.proposed) !== norm(current)) {
    r.riskFlags.push({ flag: "no_evidence", values: [] });
    r.status = "needs_user_confirmation";
  }
  return r;
}

const IDENTITY_FIELDS = {
  workExperience: ["company", "position", "location", "startDate", "endDate", "current"],
  education: ["institution", "degree", "fieldOfStudy", "startDate", "endDate", "current", "gpa"],
  projects: ["name", "startDate", "endDate", "url", "githubUrl", "technologies"],
  certifications: ["name", "organization", "issueDate", "credentialUrl"],
  languages: ["name", "proficiency"],
};

// every item of `final` must be an item of `source` (same identity), in any order; nothing added or dropped
function sameItems(source, final, fields) {
  if (source.length !== final.length) return false;
  const key = (x) => JSON.stringify(fields.map((f) => x[f]));
  const a = source.map(key).sort();
  const b = final.map(key).sort();
  return a.every((k, i) => k === b[i]);
}

/**
 * A whole version, at approval: identity unchanged, nothing added or dropped, every changed text checked.
 * @param confirmedClaims texts the student explicitly confirmed (accepted "needs confirmation" changes / edits)
 * @returns { ok, errors: [{ fieldPath, riskFlags }] }
 */
function checkVersion(source, final, corpus, confirmedClaims = []) {
  const errors = [];
  const err = (fieldPath, riskFlags) => errors.push({ fieldPath, riskFlags });
  if (JSON.stringify(source.personalInfo) !== JSON.stringify(final.personalInfo)) err("personalInfo", [{ flag: "identity_changed", values: [] }]);
  const skillKey = (s) => norm(s.name);
  if (JSON.stringify(source.skills.map(skillKey).sort()) !== JSON.stringify(final.skills.map(skillKey).sort())) err("skills", [{ flag: "skills_changed", values: [] }]);
  for (const [list, fields] of Object.entries(IDENTITY_FIELDS)) {
    if (!sameItems(source[list] || [], final[list] || [], fields)) err(list, [{ flag: "entries_changed", values: [] }]);
  }
  const support = `${corpus}\n${confirmedClaims.join("\n")}`;
  const texts = (c) => {
    const out = [["professionalSummary.summary", c.professionalSummary.summary]];
    c.workExperience.forEach((w, i) => { out.push([`workExperience[${i}].description`, w.description]); w.achievements.forEach((a, j) => out.push([`workExperience[${i}].achievements[${j}]`, a])); });
    c.projects.forEach((p, i) => out.push([`projects[${i}].description`, p.description]));
    c.education.forEach((e, i) => out.push([`education[${i}].description`, e.description]));
    return out;
  };
  const sourceTexts = new Set(texts(source).map(([, t]) => norm(t)));
  for (const [fieldPath, text] of texts(final)) {
    if (!text || sourceTexts.has(norm(text))) continue; // unchanged (possibly moved)
    const r = checkText(text, "", support);
    if (r.status !== "ok") err(fieldPath, r.riskFlags);
  }
  return { ok: errors.length === 0, errors };
}

// all fact texts as one corpus
const corpusOf = (facts) => facts.map((f) => f.value).join("\n");

module.exports = { checkText, checkSuggestion, checkVersion, corpusOf, getAt, setAt, listForOrder, numbersIn };
