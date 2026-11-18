// services/resumeStudio/jobRequirements.js
// A job's requirements, from a TDC job or a pasted description: normalised, hashed and cached by the
// description hash (utils/cache: Redis when configured, else memory), so the same text is processed once.
// Requirements are relevance context only, never evidence about the candidate.
const crypto = require("crypto");
const cache = require("../../utils/cache");
const { normalizeSkill, SYNONYM_MAP } = require("../../utils/skillNormalizer");
const injection = require("./injection");
const { extractKeywords } = require("./keywords");

const TTL_SECONDS = 7 * 24 * 3600;

const normalizeText = (t) => String(t || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const hashOf = (t) => crypto.createHash("sha256").update(normalizeText(t).toLowerCase()).digest("hex");

// skill words we can recognise in free text: the normaliser's dictionary plus a few common extras
const EXTRA_TERMS = ["Figma", "Excel", "Power BI", "Tableau", "Jira", "Agile", "Scrum", "REST", "GraphQL", "Redux", "Next.js", "Tailwind", "Firebase", "Expo", "Swift", "Kotlin", "Flutter", "Dart", "PHP", "Laravel", "Django", "Flask", "Spring", "Docker", "Kubernetes", "AWS", "Azure", "GCP", "Linux", "Git", "SQL", "MySQL", "PostgreSQL", "MongoDB", "Redis", "Kafka", "Terraform", "Jest", "Cypress", "Selenium", "Photoshop", "Illustrator", "SEO", "Salesforce", "SAP", "AutoCAD", "MATLAB", "R", "Pandas", "NumPy", "TensorFlow", "PyTorch", "Machine Learning", "Data Analysis", "Communication", "Leadership", "Teamwork"];
const SKILL_TERMS = Array.from(new Set([...Object.values(SYNONYM_MAP), ...EXTRA_TERMS]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRegex = (term) => new RegExp(`(^|[^A-Za-z0-9+#.])${escapeRe(term)}(?=$|[^A-Za-z0-9+#])`, term.length <= 2 ? "" : "i");

// skill terms mentioned in a text (canonical names)
function skillTermsIn(text) {
  const t = String(text || "");
  const found = new Set();
  for (const term of SKILL_TERMS) if (termRegex(term).test(t)) found.add(normalizeSkill(term) || term);
  // aliases ("js", "reactjs", "node") map to their canonical name
  for (const [alias, canonical] of Object.entries(SYNONYM_MAP)) if (alias.length > 2 && termRegex(alias).test(t)) found.add(canonical);
  return [...found];
}

// non-skill requirements we can recognise: years of experience, degrees, certificates
function otherRequirementsIn(text) {
  const out = [];
  const t = String(text || "");
  const years = t.match(/\b(\d{1,2})\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}/i);
  if (years) out.push({ requirement: years[0].trim(), kind: "experience" });
  // a degree: the words, or the short forms written in capitals (BS / MS / BBA), never "MS Excel" / "MS Office"
  const DEGREE = /\b(bachelor'?s?|master'?s?|mba|phd|degree)\b|\b(BS|BSc|BBA|BE|MS|MSc)\b(?!\s*(Excel|Office|Word|Teams|PowerPoint|Access|Project|SQL))/;
  const line = t.split("\n").find((l) => DEGREE.test(l.replace(/\b(bachelor|master|mba|phd|degree)\b/gi, (w) => w.toLowerCase())) || /\b(bachelor|master|mba|phd|degree)\b/i.test(l));
  if (line) out.push({ requirement: line.replace(/^[\s\-*•]+/, "").trim().slice(0, 90), kind: "education" });
  return out;
}

/** { hash, title, company, excerpt, requirements: [{ requirement, kind }], skills, keywords: [{ term, kind }], injectionFlags } */
async function requirementsFor({ title = "", description = "", company = "" }) {
  const scanned = injection.scan(String(description).slice(0, injection.MAX_JOB_CHARS));
  const text = normalizeText(scanned.text);
  const hash = hashOf(`${title}\n${text}`);
  const key = `career:resume:jobreq:v2:${hash}`; // v2: with keywords
  const withCompany = (o) => ({ ...o, company: String(company || "").replace(/\s+/g, " ").trim().slice(0, 120) });
  try {
    const hit = await cache.get(key);
    if (hit) return { ...withCompany(JSON.parse(hit)), cached: true };
  } catch {}
  const skills = skillTermsIn(`${title}\n${text}`);
  const requirements = [...skills.map((s) => ({ requirement: s, kind: "skill" })), ...otherRequirementsIn(text)];
  const keywords = extractKeywords(title, text, skills);
  const out = { hash, title: String(title).slice(0, 200), excerpt: text.slice(0, 3500), requirements, skills, keywords, injectionFlags: scanned.flagged };
  try { await cache.set(key, JSON.stringify(out), TTL_SECONDS); } catch {}
  return { ...withCompany(out), cached: false };
}

module.exports = { requirementsFor, skillTermsIn, hashOf, normalizeText, SKILL_TERMS };
