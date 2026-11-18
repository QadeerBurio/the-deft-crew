// services/resumeStudio/keywords.js
// The job's keywords, for every kind of job (not only tech): the skill terms the matcher knows, plus duty and tool
// phrases from a dictionary of common student job areas (HR, marketing, sales, finance, operations, support,
// design, software). Used to steer the tailoring, to order entries by relevance and to show the student
// "keywords covered N of M". A keyword is relevance context only, never evidence about the candidate.
//   extractKeywords(title, text) -> [{ term, kind: "skill" | "duty" }]   (at most 24, in the job's wording)
//   coverage(keywords, content)  -> { covered: [term], missing: [term], total }
//   relevanceOf(text, keywords)  -> number of keywords a text shows
'use strict';

const PHRASES = [
  // HR / recruitment
  "talent acquisition", "recruitment", "recruiting", "screening", "screen cvs", "shortlisting", "shortlist candidates", "interviews", "interview scheduling",
  "hiring managers", "onboarding", "employee records", "hr databases", "hr operations", "payroll", "employer branding", "campus recruitment", "job postings",
  "employee engagement", "training", "attendance", "confidentiality", "labour law", "performance management", "compensation", "benefits",
  // marketing / communication
  "social media", "content creation", "content calendar", "campaigns", "digital marketing", "engagement", "reach", "analytics", "market research",
  "brand activations", "branding", "copywriting", "seo", "email marketing", "google analytics", "meta business suite", "instagram", "facebook", "tiktok",
  "linkedin", "youtube", "canva", "adobe", "photoshop", "illustrator", "influencers", "agencies", "insights", "reporting", "written communication", "presentations",
  // sales / support / business
  "customer service", "customer support", "client relations", "lead generation", "sales targets", "crm", "negotiation", "stakeholders", "data entry",
  "ms excel", "excel", "ms office", "powerpoint", "budgeting", "forecasting", "financial analysis", "accounting", "bookkeeping", "invoicing", "inventory",
  "supply chain", "procurement", "logistics", "operations", "project management", "event management", "events", "coordination", "scheduling", "documentation",
  "research", "problem solving", "teamwork", "communication", "organisational skills", "attention to detail", "time management", "leadership",
  // software
  "front-end", "frontend", "back-end", "backend", "full stack", "rest apis", "rest api", "apis", "databases", "unit tests", "integration tests", "testing",
  "code reviews", "version control", "responsive", "web applications", "mobile apps", "deployment", "ci/cd", "cloud", "debugging", "agile", "scrum",
];
const STOP = new Set(["and", "or", "the", "a", "an", "of", "to", "in", "on", "for", "with", "our", "your", "we", "you", "will", "be", "is", "are", "as", "at", "by"]);

const fold = (t) => String(t || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+#./ -]+/g, " ").replace(/\s+/g, " ");
// the same word in another form: plural, -ing, -ed, British/US spelling
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "").replace(/is(e|ing|ed)?$/, "iz").replace(/our$/, "or");
const stemsOf = (t) => fold(t).split(/[\s/-]+/).map((w) => w.replace(/^[.]+|[.]+$/g, "")).filter((w) => w && !STOP.has(w)).map(stem);

/** does a text show this keyword (all its words, in any form)? */
function shows(textStems, term) {
  const need = stemsOf(term);
  return need.length > 0 && need.every((w) => textStems.has(w));
}

function extractKeywords(title, text, skillTerms = []) {
  const body = fold(`${title}\n${text}`);
  const out = [];
  const seen = new Set();
  const add = (term, kind) => {
    const k = stemsOf(term).join(" ");
    if (!k || seen.has(k)) return;
    // a phrase already covered by a longer one ("excel" inside "ms excel") isn't counted twice
    for (const s of seen) if (` ${s} `.includes(` ${k} `) || ` ${k} `.includes(` ${s} `)) return;
    seen.add(k);
    out.push({ term, kind });
  };
  for (const s of skillTerms) add(s, "skill");
  // longest phrases first, in the job's own wording when it appears
  for (const p of [...PHRASES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=$|[^a-z0-9])`, "i");
    const m = re.exec(`${title}\n${text}`);
    if (m && body.includes(fold(p).trim())) add(m[0].replace(/^[^A-Za-z0-9]/, "").trim(), "duty");
  }
  return out.slice(0, 24);
}

function contentText(content) {
  const c = content || {};
  return [
    c.personalInfo?.title, c.professionalSummary?.summary,
    ...(c.workExperience || []).flatMap((w) => [w.position, w.company, w.description, ...(w.achievements || [])]),
    ...(c.projects || []).flatMap((p) => [p.name, p.description, ...(p.technologies || [])]),
    ...(c.education || []).flatMap((e) => [e.degree, e.fieldOfStudy, e.institution, e.description]),
    ...(c.skills || []).map((s) => s.name), ...(c.certifications || []).map((x) => x.name),
  ].filter(Boolean).join("\n");
}

function coverage(keywords, content) {
  const st = new Set(stemsOf(contentText(content)));
  const covered = [];
  const missing = [];
  for (const k of keywords || []) (shows(st, k.term) ? covered : missing).push(k.term);
  return { covered, missing, total: (keywords || []).length };
}

function relevanceOf(text, keywords) {
  const st = new Set(stemsOf(text));
  return (keywords || []).filter((k) => shows(st, k.term)).length;
}

module.exports = { extractKeywords, coverage, relevanceOf, contentText, stemsOf, PHRASES };
