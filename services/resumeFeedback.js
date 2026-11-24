// services/resumeFeedback.js
// P3d (plan P3-7, flags resumeV2 + resumeFeedback): recruiter-style feedback on one resume.
//   1. the rules (instant, always): strong points from what the resume really has, weak points found in its own text,
//      and the improvements from utils/resumeRules (each with the builder step to fix it)
//   2. one AI pass (English only), cached per content hash (services: models/ResumeFeedback): up to 3 strong points,
//      3 weak points and 3 improvements, each checked against the resume's own text with the Resume Studio validator
//      (anything that adds a number, date, tool, employer or claim the resume doesn't have is dropped). A missing result
//      may only be asked about as a question (owner P3d #5): "did this save time or money? if yes, add it". Never a
//      number. When the AI is unavailable the rules alone come back (never a failed screen).
//   feedback(resume, { userId }) → { strong: [{ text, source }], weak: [...], improvements: [{ text, stepKey, source }],
//                                    ai: true | false, cached: true | false, contentHash }
const crypto = require("crypto");
const { resumeStrength, trackOf } = require("../utils/resumeRules");

const str = (v, max = 600) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const STEP_KEYS = ["personal", "education", "experience", "projects", "certifications", "summary", "skills", "activities", "volunteering", "awards", "languages"];
const RESULT_QUESTION = "did this save time or money? if yes, add it.";

// what the AI and the cache look at: the resume's words, never its design (template, colours, public page, photo)
function contentOf(r = {}) {
  const pi = r.personalInfo || {};
  return {
    personalInfo: { firstName: pi.firstName, lastName: pi.lastName, title: pi.title, email: pi.email, phone: pi.phone, city: pi.city, linkedin: pi.linkedin, github: pi.github, portfolio: pi.portfolio },
    summary: r.professionalSummary?.summary || "",
    workExperience: list(r.workExperience).map((w) => ({ position: w.position, company: w.company, startDate: w.startDate, endDate: w.endDate, current: w.current, description: w.description, achievements: w.achievements })),
    education: list(r.education).map((e) => ({ institution: e.institution, degree: e.degree, fieldOfStudy: e.fieldOfStudy, startDate: e.startDate, endDate: e.endDate, grade: e.grade, gpa: e.gpa })),
    projects: list(r.projects).map((p) => ({ name: p.name, description: p.description, technologies: p.technologies })),
    activities: list(r.activities).map((a) => ({ role: a.role, organisation: a.organisation, description: a.description, bullets: a.bullets })),
    volunteering: list(r.volunteering).map((a) => ({ role: a.role, organisation: a.organisation, description: a.description, bullets: a.bullets })),
    awards: list(r.awards).map((a) => ({ title: a.title, issuer: a.issuer })),
    skills: list(r.skills).map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean),
    certifications: list(r.certifications).map((c) => ({ name: c.name, organization: c.organization })),
    languages: list(r.languages).map((l) => ({ name: l.name, proficiency: l.proficiency })),
    coursework: list(r.coursework),
    targetRole: r.targetJob?.jobTitle || "",
    track: trackOf(r),
  };
}
const contentHash = (r) => crypto.createHash("sha256").update(JSON.stringify(contentOf(r))).digest("hex");

// every line a recruiter reads under an entry
function bulletsOf(r) {
  const out = [];
  const add = (section, owner, text) => { for (const t of String(text || "").split(/\n+/)) { const l = str(t.replace(/^[-•*▪◦]\s*/, ""), 400); if (l) out.push({ section, owner, text: l }); } };
  for (const w of list(r.workExperience)) { add("experience", w.position || w.company, w.description); for (const a of list(w.achievements)) add("experience", w.position || w.company, a); }
  for (const p of list(r.projects)) add("projects", p.name, p.description);
  for (const k of ["activities", "volunteering"]) for (const a of list(r[k])) { add(k, a.role || a.organisation, a.description); for (const b of list(a.bullets)) add(k, a.role || a.organisation, b); }
  return out;
}

const WEAK_OPENERS = /^(responsible for|worked on|helped( with)?|assisted( with)?|involved in|participated in|duties included|tasked with)\b/i;

/** the rules part: instant, the same for everyone */
function rulesFeedback(r = {}) {
  const strong = [];
  const weak = [];
  const s = (text) => strong.push({ text, source: "rules" });
  const w = (text, stepKey) => weak.push({ text, stepKey, source: "rules" });
  const edu = list(r.education).filter((e) => str(e.institution) && str(e.degree));
  if (edu.length && edu.every((e) => e.endDate || e.current)) s("your education is complete, with dates.");
  const projects = list(r.projects).filter((p) => str(p.name) && str(p.description));
  if (projects.length) s(`${plural(projects.length, "project shows", "projects show")} what you built and did.`);
  const roles = [...list(r.activities), ...list(r.volunteering)].filter((a) => str(a.role) || str(a.organisation));
  if (roles.length) s("activities and volunteering show initiative beyond class.");
  const work = list(r.workExperience).filter((x) => str(x.company) || str(x.position));
  if (work.length) s(`${plural(work.length, "role", "roles")} of real work experience.`);
  const skills = list(r.skills);
  if (skills.length >= 6) s(`a solid list of ${skills.length} skills.`);
  if (str(r.professionalSummary?.summary)) s("a summary that says who you are.");

  const bullets = bulletsOf(r);
  const weakOpeners = bullets.filter((b) => WEAK_OPENERS.test(b.text));
  if (weakOpeners.length) w(`${plural(weakOpeners.length, "line starts", "lines start")} with "${weakOpeners[0].text.split(/\s+/).slice(0, 2).join(" ").toLowerCase()}…": start with what you did (built, led, organised).`, weakOpeners[0].section);
  const long = bullets.filter((b) => b.text.split(/\s+/).length > 30);
  if (long.length) w(`${plural(long.length, "line is", "lines are")} longer than 30 words: recruiters skim, so split or shorten ${long.length === 1 ? "it" : "them"}.`, long[0].section);
  const summaryWords = str(r.professionalSummary?.summary).split(/\s+/).filter(Boolean).length;
  if (summaryWords > 80) w(`the summary is ${summaryWords} words: 2–3 lines read best.`, "summary");
  const noResult = bullets.filter((b) => b.section !== "projects" && !/\d/.test(b.text));
  const resultLines = bullets.filter((b) => b.section !== "projects");
  if (resultLines.length && noResult.length === resultLines.length && work.length) w(`no line shows a result yet. for one of them: ${RESULT_QUESTION}`, "experience");

  const improvements = (resumeStrength(r).missing || []).slice(0, 6).map((m) => ({ text: m.text, stepKey: m.stepKey || null, points: m.points, source: "rules" }));
  return { strong, weak, improvements };
}

// the AI part: suggestions grounded in the resume's own text
const SECTION_TO_STEP = Object.fromEntries(STEP_KEYS.map((k) => [k, k]));
SECTION_TO_STEP.contact = "personal"; SECTION_TO_STEP.header = "personal"; SECTION_TO_STEP.work = "experience";
// every string in the resume content, however deep (the validator's corpus)
const stringsIn = (v) => (v == null ? [] : typeof v === "object" ? Object.values(v).flatMap(stringsIn) : [String(v)]);
const ASKS_FOR_NUMBER = /\b(quantif\w*|metrics?|numbers?|percent\w*|figures?)\b|%/i;

async function aiFeedback(r, deps) {
  const facts = contentOf(r);
  const out = await deps.askJson(
    "You are a recruiter giving a student honest feedback on their resume. Reply with up to 3 strong points, up to 3 weak points and up to 3 improvements, each one short sentence in lowercase, specific to this resume. Each improvement names the section it belongs to (education, experience, projects, activities, volunteering, skills, summary, awards, certifications, languages, personal). Never suggest a specific number or result. If a line has no result, you may only ask the question: \"" + RESULT_QUESTION + "\"",
    { resume: facts, format: { strong: ["..."], weak: ["..."], improvements: [{ text: "...", section: "projects" }] } },
    700,
  );
  const corpus = [...stringsIn(facts), RESULT_QUESTION, ...STEP_KEYS].join("\n");
  // up to 6 candidates each are checked; the first 3 that pass are kept
  const clean = (arr, kind, keep = () => true) => deps.guard(list(arr).map((x) => (typeof x === "string" ? x : x?.text)).filter((t) => t && keep(t)).slice(0, 6), corpus, kind, `feedback-${kind}`).kept.slice(0, 3);
  const strong = clean(out.strong, "condense").map((text) => ({ text, source: "ai" }));
  const weak = clean(out.weak, "condense").map((text) => ({ text, source: "ai" }));
  const sections = new Map(list(out.improvements).map((x) => [str(typeof x === "string" ? x : x?.text), String(x?.section || "").toLowerCase()]));
  const improvements = clean(out.improvements, "condense", (text) => !ASKS_FOR_NUMBER.test(text) || /\?/.test(text)) // a result only as a question (owner #5)
    .map((text) => ({ text, stepKey: SECTION_TO_STEP[sections.get(text)] || null, source: "ai" }));
  return { strong, weak, improvements };
}

async function feedback(resume, { userId, deps = {} } = {}) {
  const coach = deps.coach || require("./resumeCoach");
  const Model = deps.Model || require("../models/ResumeFeedback");
  const rules = rulesFeedback(resume);
  const hash = contentHash(resume);
  let ai = null;
  let cached = false;
  const hit = await Model.findOne({ resume: resume._id, contentHash: hash }).lean().catch(() => null);
  if (hit && hit.ai) { ai = hit.ai; cached = true; }
  else {
    try {
      ai = await aiFeedback(resume, { askJson: coach.askJson, guard: coach.guard, corpusOf: coach.corpusOf });
      await Model.updateOne({ resume: resume._id, contentHash: hash }, { $setOnInsert: { user: userId, resume: resume._id, contentHash: hash, ai, createdAt: new Date() } }, { upsert: true }).catch(() => {});
    } catch (e) {
      console.warn("[resume-feedback] AI unavailable:", e.message);
      ai = null;
    }
  }
  // the AI's points after the rules', without repeating the same sentence
  const merge = (a, b) => { const seen = new Set(a.map((x) => x.text.toLowerCase())); return [...a, ...b.filter((x) => !seen.has(x.text.toLowerCase()))]; };
  return {
    strong: merge(rules.strong, ai?.strong || []),
    weak: merge(rules.weak, ai?.weak || []),
    improvements: merge(rules.improvements, ai?.improvements || []),
    ai: !!ai,
    cached,
    contentHash: hash,
  };
}

module.exports = { feedback, rulesFeedback, contentHash, contentOf, RESULT_QUESTION };
