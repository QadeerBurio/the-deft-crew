// services/career/matchingService.js
// Employer candidate matching (FLAG_CAREER_MATCHING): decision support for one application at a time.
//
//   1. Mandatory criteria, shown separately (met / not met / unknown): the job's minimum experience, its
//      education level, and requirement lines that say "must / required / mandatory / at least".
//   2. Weighted relevance as evidence: each skill the job lists is "matched" (with the resume text that shows
//      it), "missing" (the resume has content but no sign of it) or "unknown" (the resume has too little to
//      tell). The estimate is the share of the job's listed skills the resume shows evidence of (0-100), or
//      "insufficient information" when the job lists no skills or the resume is empty.
//
// Deterministic and explainable: no model call, no embeddings (they read the whole resume text, including
// where someone lives and studied). The skill list reuses skillGapService.flattenCandidateSkills and the
// resume text reuses Resume Studio's contentOf. NEVER inputs: name, gender, photo, age, university name,
// city or any location, e-mail, phone, links, company names. They are removed before matching (profileOf),
// so they can't change a score; tests/career-matching proves it (docs/MATCHING_FAIRNESS.md).
//
// Never: an automatic rejection, a hidden candidate, a "probability of hire". Experience is a mandatory
// criterion only, never part of the relevance estimate, so a fresher with the same skills scores the same.
// Every result is stored as a CareerMatchSnapshot (model version, fingerprints, evidence, time); it is
// recomputed when the candidate's resume or the job changes (new fingerprint), never otherwise.
const crypto = require("crypto");
const { contentOf, canonical } = require("../resumeStudio/facts");
const { flattenCandidateSkills } = require("../skillGapService");

const MODEL_VERSION = "skill-evidence-1";
const FORMULA = "estimate = 100 x (job skills with evidence in the resume) / (skills the job lists); experience and education are mandatory criteria, not part of the estimate";

// ---------- normalising skill names ----------
const ALIASES = {
  js: "javascript", "java script": "javascript", ecmascript: "javascript",
  ts: "typescript",
  node: "node.js", nodejs: "node.js", "node js": "node.js",
  reactjs: "react", "react.js": "react", "react js": "react",
  "react native": "react native", "react-native": "react native",
  vuejs: "vue", "vue.js": "vue", angularjs: "angular", "angular.js": "angular",
  nextjs: "next.js", "next js": "next.js", expressjs: "express", "express.js": "express",
  py: "python", golang: "go", "c sharp": "c#", csharp: "c#", "c plus plus": "c++", cpp: "c++",
  postgres: "postgresql", "postgre sql": "postgresql", mongo: "mongodb", "mongo db": "mongodb",
  mssql: "sql server", "ms sql": "sql server", "ms excel": "excel", "microsoft excel": "excel",
  "ms word": "word", "microsoft word": "word", "power bi": "power bi", powerbi: "power bi",
  "amazon web services": "aws", gcp: "google cloud", "google cloud platform": "google cloud",
  k8s: "kubernetes", "ml": "machine learning", "ai": "artificial intelligence",
  "ui/ux": "ui ux", "ux/ui": "ui ux", "ui ux design": "ui ux", photoshop: "adobe photoshop",
};
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const canon = (s) => ALIASES[norm(s)] || norm(s);
// every spelling that means the same skill
const VARIANTS = new Map();
for (const [alias, c] of Object.entries(ALIASES)) VARIANTS.set(c, [...(VARIANTS.get(c) || [c]), alias]);
const variantsOf = (c) => [...new Set(VARIANTS.get(c) || [c])];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a whole-term match: "java" never matches "javascript", "c" never matches inside a word
// (a dot counts as part of a term: "js" never matches inside "Node.js", "react" never inside "react.js")
const termRe = (term) => new RegExp(`(^|[^a-z0-9+#.])${escape(term)}(?![a-z0-9+#]|\\.[a-z0-9])`, "i");

// ---------- the candidate's profile, without identity ----------
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
/**
 * What matching may read, and nothing else.
 *   { resume }   a Resume document: its content (contentOf) plus its AI-extracted skill list (skillGapService)
 *   { content }  a Resume Studio approved snapshot (already in contentOf's shape)
 */
function profileOf({ resume = null, content = null } = {}) {
  content = content || contentOf(resume || {});
  const skills = [];
  (content.skills || []).forEach((s, i) => { if (clean(s.name)) skills.push({ name: clean(s.name), path: `skills[${i}]` }); });
  if (resume?.careerProfile) {
    for (const s of flattenCandidateSkills(resume)) if (s.source === "ai" && clean(s.name)) skills.push({ name: clean(s.name), path: "careerProfile.extractedSkills" });
  }
  const texts = [];
  const add = (path, text) => { if (clean(text)) texts.push({ path, text: clean(text) }); };
  add("personalInfo.title", content.personalInfo?.title);
  add("professionalSummary.summary", content.professionalSummary?.summary);
  (content.workExperience || []).forEach((w, i) => {
    add(`workExperience[${i}].position`, w.position); // the company and its location are left out
    add(`workExperience[${i}].description`, w.description);
    (w.achievements || []).forEach((a, j) => add(`workExperience[${i}].achievements[${j}]`, a));
  });
  (content.projects || []).forEach((p, i) => {
    add(`projects[${i}].name`, p.name);
    add(`projects[${i}].description`, p.description);
    (p.technologies || []).forEach((t, j) => add(`projects[${i}].technologies[${j}]`, t));
  });
  (content.certifications || []).forEach((c, i) => add(`certifications[${i}].name`, c.name));
  // dates only (no company, no place): for the minimum-experience criterion
  const periods = (content.workExperience || []).map((w) => ({ start: clean(w.startDate), end: w.current ? "present" : clean(w.endDate) }));
  // degree and field only (never the institution): for the education criterion
  const degrees = (content.education || []).map((e) => ({ degree: clean(e.degree), field: clean(e.fieldOfStudy), current: !!e.current }));
  return { skills, texts, periods, degrees };
}

// ---------- mandatory criteria ----------
const LEVEL = { "High School": 1, "Associate Degree": 2, "Bachelor's Degree": 3, "Master's Degree": 4, PhD: 5 };
function degreeLevel(d) {
  const t = norm(`${d.degree} ${d.field}`);
  if (/\b(ph\.?d|doctorate|doctor of)\b/.test(t)) return 5;
  if (/\b(master|ms|msc|m\.sc|mba|ma|m\.a|mphil|m\.phil|me|mcs|mit)\b/.test(t)) return 4;
  if (/\b(bachelor|bs|bsc|b\.sc|be|b\.e|ba|b\.a|bba|bcs|bscs|bsit|btech|b\.tech|bcom|b\.com|mbbs|llb|pharm\.?d)\b/.test(t)) return 3;
  if (/\b(associate|diploma|dae)\b/.test(t)) return 2;
  if (/\b(intermediate|fsc|f\.sc|fa|ics|i\.com|a level|a-level|o level|o-level|matric|ssc|hssc|high school)\b/.test(t)) return 1;
  return null;
}
const monthsBetween = (a, b) => Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
const asDate = (s, now) => (s === "present" ? now : /^\d{4}(-\d{2})?/.test(s) ? new Date(`${s.length === 4 ? `${s}-01` : s.slice(0, 7)}-01T00:00:00Z`) : null);
/** total months of work, overlapping periods counted once; null if any period has no readable dates */
function experienceMonths(periods, now = new Date()) {
  const spans = [];
  for (const p of periods) {
    const a = asDate(p.start, now), b = asDate(p.end || "", now);
    if (!a || !b) return null;
    spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0, cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) { if (cur) total += monthsBetween(cur[0], cur[1]); cur = [a, b]; } else if (b > cur[1]) cur[1] = b;
  }
  if (cur) total += monthsBetween(cur[0], cur[1]);
  return total;
}
const MUST = /\b(must|required|requirement|mandatory|minimum|at least|essential)\b/i;

function mandatoryCriteria(job, profile, skillStatus, { statedYears = null, now = new Date() } = {}) {
  const out = [];
  const minYears = Number(job.minExperience) || 0;
  if (minYears > 0) {
    const crit = `at least ${minYears} year${minYears === 1 ? "" : "s"} of work experience`;
    if (!profile.periods.length) {
      if (statedYears != null && statedYears >= minYears) out.push({ criterion: crit, status: "met", evidence: `${statedYears} years stated in the application (not in the resume)` });
      else out.push({ criterion: crit, status: "not_met", evidence: "the resume lists no work experience" });
    } else {
      const months = experienceMonths(profile.periods, now);
      if (months == null) out.push({ criterion: crit, status: "unknown", evidence: "some work dates are missing in the resume" });
      else {
        const years = Math.floor((months / 12) * 10) / 10;
        out.push({ criterion: crit, status: years >= minYears ? "met" : "not_met", evidence: `about ${years} years from the dates in the resume` });
      }
    }
  }
  const need = LEVEL[job.education];
  if (need && need > 1) {
    const crit = `education: ${job.education}`;
    const levels = profile.degrees.map((d) => ({ d, level: degreeLevel(d) }));
    const done = levels.filter((x) => x.level != null && !x.d.current).map((x) => x.level);
    const best = done.length ? Math.max(...done) : null;
    if (best != null && best >= need) out.push({ criterion: crit, status: "met", evidence: levels.find((x) => x.level === best && !x.d.current).d.degree });
    else if (levels.some((x) => x.d.current && x.level != null && x.level >= need)) out.push({ criterion: crit, status: "unknown", evidence: "the degree is still in progress" });
    else if (best != null) out.push({ criterion: crit, status: "not_met", evidence: `highest completed: ${levels.find((x) => x.level === best).d.degree}` });
    else out.push({ criterion: crit, status: "unknown", evidence: profile.degrees.length ? "the degree level isn't clear from the resume" : "the resume lists no education" });
  }
  // free-text requirement lines: "met" only with evidence of a listed skill they name; never "not met" from text
  for (const line of job.requirements || []) {
    if (!MUST.test(line)) continue;
    const named = skillStatus.filter((s) => termRe(norm(s.skill)).test(norm(line)) || variantsOf(canon(s.skill)).some((v) => termRe(v).test(norm(line))));
    const hit = named.find((s) => s.status === "matched");
    out.push({ criterion: clean(line).slice(0, 200), status: hit ? "met" : "unknown", evidence: hit ? `${hit.skill}: ${hit.evidence[0]?.text || ""}` : "check this yourself: it can't be read reliably from the resume" });
  }
  return out;
}

// ---------- relevance: the job's skills, with evidence ----------
const snippet = (text, re) => {
  const m = re.exec(text);
  if (!m) return text.slice(0, 120);
  const at = m.index + m[1].length;
  const from = Math.max(0, at - 50);
  return `${from ? "…" : ""}${text.slice(from, at + 70)}${at + 70 < text.length ? "…" : ""}`;
};
function skillEvidence(jobSkill, profile) {
  const c = canon(jobSkill);
  const variants = variantsOf(c);
  const evidence = [];
  for (const s of profile.skills) if (canon(s.name) === c || variants.includes(norm(s.name))) evidence.push({ path: s.path, text: s.name });
  for (const t of profile.texts) {
    const v = variants.find((x) => termRe(x).test(t.text));
    if (v) evidence.push({ path: t.path, text: snippet(t.text, termRe(v)) });
  }
  // one line per place, at most 3 shown
  const seen = new Set();
  return evidence.filter((e) => (seen.has(e.path) ? false : seen.add(e.path))).slice(0, 3);
}
const sparse = (p) => !p.skills.length && p.texts.reduce((n, t) => n + t.text.length, 0) < 40;

/**
 * The match for one job and one profile. Pure: same inputs, same result (the fairness tests rely on it).
 *   job: { title, skills[], requirements[], minExperience, education }; profile: profileOf(...)
 */
function match(job, profile, opts = {}) {
  const jobSkills = [...new Map((job.skills || []).map((s) => clean(s)).filter(Boolean).map((s) => [canon(s), s])).values()];
  const empty = sparse(profile);
  const skillStatus = jobSkills.map((skill) => {
    const evidence = skillEvidence(skill, profile);
    return { skill, status: evidence.length ? "matched" : empty ? "unknown" : "missing", evidence };
  });
  const matched = skillStatus.filter((s) => s.status === "matched");
  const insufficient = !jobSkills.length ? "the job lists no skills" : empty ? "the resume has too little information" : null;
  const score = insufficient ? null : Math.round((100 * matched.length) / jobSkills.length);
  const mandatory = mandatoryCriteria(job, profile, skillStatus, opts);
  const count = (st) => mandatory.filter((m) => m.status === st).length;
  return {
    modelVersion: MODEL_VERSION,
    relevance: { score, insufficient, label: insufficient ? `insufficient information: ${insufficient}` : `estimate: evidence for ${matched.length} of ${jobSkills.length} listed skills`, formula: FORMULA },
    mandatory,
    mandatorySummary: { met: count("met"), notMet: count("not_met"), unknown: count("unknown") },
    skills: {
      matched: matched.map(({ skill, evidence }) => ({ skill, evidence })),
      missing: skillStatus.filter((s) => s.status === "missing").map(({ skill }) => ({ skill, evidence: [{ path: "", text: "not found in the resume's skills, projects or experience" }] })),
      unknown: skillStatus.filter((s) => s.status === "unknown").map(({ skill }) => ({ skill, evidence: [{ path: "", text: "the resume has too little information to tell" }] })),
    },
    evidenceSummary: `${matched.length} matched, ${skillStatus.filter((s) => s.status === "missing").length} missing, ${skillStatus.filter((s) => s.status === "unknown").length} unknown of ${jobSkills.length} skills; mandatory: ${count("met")} met, ${count("not_met")} not met, ${count("unknown")} unknown`,
  };
}

// ---------- match quality per job (a summary for the employer, never a decision) ----------
// strong: the resume shows evidence for at least 70% of the job's listed skills; medium: 40-69%; weak: under 40%;
// insufficient: no estimate (the job lists no skills or the resume is too thin). Mandatory criteria are shown
// separately and don't change the band, like the estimate itself.
const QUALITY = { strong: 70, medium: 40 };
const qualityOf = (score) => (score == null ? "insufficient" : score >= QUALITY.strong ? "strong" : score >= QUALITY.medium ? "medium" : "weak");
/** rows: [{ match: null | { score } }] → { strong, medium, weak, insufficient, outsidePilot, total, thresholds } */
function qualitySummary(rows) {
  const out = { strong: 0, medium: 0, weak: 0, insufficient: 0, outsidePilot: 0, total: rows.length, thresholds: { ...QUALITY } };
  for (const r of rows) {
    if (!r.match) out.outsidePilot += 1;
    else out[qualityOf(r.match.score)] += 1;
  }
  return out;
}

const sha = (v) => crypto.createHash("sha256").update(canonical(v)).digest("hex");
const jobFingerprint = (job) => sha({ v: MODEL_VERSION, title: clean(job.title), skills: (job.skills || []).map(clean), requirements: (job.requirements || []).map(clean), minExperience: Number(job.minExperience) || 0, education: job.education || "" });
const profileFingerprint = (profile, statedYears = null) => sha({ v: MODEL_VERSION, profile, statedYears });

module.exports = { MODEL_VERSION, FORMULA, profileOf, match, mandatoryCriteria, experienceMonths, degreeLevel, canon, termRe, jobFingerprint, profileFingerprint, QUALITY, qualityOf, qualitySummary };
