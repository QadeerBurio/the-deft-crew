// services/resumeWriter.js
// r7, plan P3-9 (flags resumeV2 + resumeWriter): "Cover letter from resume + job (reuse the Studio pipeline), LinkedIn
// headline/about generator. No translation: English only."
//   coverLetter(resume, { jobTitle, company, jobDescription }) → { paragraphs: [3 or 4], ai: true } | { paragraphs: [], ai: false, message }
//   linkedin(resume) → { headline, about: [2 or 3 paragraphs], ai: true } | { headline: null, about: [], ai: false, message }
// Nothing is invented: every paragraph is checked with the Resume Studio validator (services/resumeStudio/validator.js)
// against the student's own resume (+ the job the student typed, for the letter). Anything that adds a number, date,
// link, e-mail, name, tool or claim they didn't give is dropped (flags logged, never the text). First person is fine
// here (a letter and an "about" are written as "I"). Too little left, or the AI unavailable → { ai: false, message } and
// nothing written (the app says "try again"; never a made-up letter), like resume feedback without the AI. The greeting and sign-off are not written by the AI (the renderer adds
// them from the company typed and the student's name).
const { checkText } = require("./resumeStudio/validator");
const { contentOf } = require("./resumeFeedback");

let client = null;
const ai = () => {
  if (client) return client;
  const OpenAI = require("openai");
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
};
const model = () => process.env.OPENAI_MODEL || "gpt-4o-mini";
class WriterError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

const str = (v, max = 400) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : []);
const stringsIn = (v) => (v == null ? [] : typeof v === "object" ? Object.values(v).flatMap(stringsIn) : [String(v)]);
const RULES = [
  "Use ONLY the facts given. Never add a number, percentage, amount, date, tool, technology, employer, organisation,",
  "title, award, link or result that is not in the facts. If the facts have no number, write no number.",
  "English only. Plain, warm, specific words; no cliches, no exaggeration.",
].join(" ");

async function askJson(system, user, maxTokens) {
  const completion = await ai().chat.completions.create({
    model: model(),
    messages: [{ role: "system", content: `${system} ${RULES} Reply with JSON only.` }, { role: "user", content: JSON.stringify(user) }],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  try { return JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { return {}; }
}

// keep what the facts support (first person allowed; length checked here), drop and log the rest
function keepSupported(texts, corpus, { max, jobTerms = "", action }) {
  const kept = [];
  for (const raw of texts) {
    const t = str(raw, max + 200);
    if (!t || t.length > max) { if (t) console.warn(`[resume-writer] ${action}: dropped (too long)`); continue; }
    const r = checkText(t, "", corpus, { kind: "summary", jobTerms });
    const bad = r.riskFlags.filter((f) => f.flag !== "first_person" && f.flag !== "much_longer");
    if (!bad.length) kept.push(t);
    else console.warn(`[resume-writer] ${action}: dropped (${bad.map((f) => f.flag).join(",")})`);
  }
  return kept;
}

const NEED_MORE = "add a bit more to your resume first (a project, an activity or your education), then try again.";
const BUSY = "the writer is busy right now. try again in a minute.";
const hasContent = (facts) => !!(facts.workExperience.length || facts.projects.length || facts.education.length || facts.activities.length || facts.volunteering.length);

async function coverLetter(resume, job = {}, deps = {}) {
  const ask = deps.askJson || askJson;
  const facts = contentOf(resume);
  const target = { jobTitle: str(job.jobTitle, 120), company: str(job.company, 120), jobDescription: str(job.jobDescription, 3000) };
  if (!target.jobTitle || !target.company) throw new WriterError(400, "NEED_JOB", "add the job title and the company.");
  if (!hasContent(facts)) throw new WriterError(400, "NEED_MORE", NEED_MORE);
  let out;
  try {
    out = await ask(
      "Write the body of a cover letter for a student applying to the job below, from their resume. 3 short paragraphs (4 at most), first person: why this role and company (only from what the job says), what in the resume fits (name real entries), and a short close asking for an interview. Each paragraph under 90 words. No greeting and no sign-off (they are added separately).",
      { resume: facts, job: target, format: { paragraphs: ["...", "...", "..."] } },
      900,
    );
  } catch (e) {
    console.warn("[resume-writer] cover letter: AI unavailable:", e.message);
    return { paragraphs: [], ai: false, message: BUSY };
  }
  const corpus = [...stringsIn(facts), target.jobTitle, target.company, target.jobDescription].join("\n");
  const jobTerms = [target.jobTitle, target.company, target.jobDescription].join("\n");
  const paragraphs = keepSupported(list(out?.paragraphs).slice(0, 4), corpus, { max: 700, jobTerms, action: "cover-letter" });
  if (paragraphs.length < 2) return { paragraphs: [], ai: false, message: BUSY };
  return { paragraphs, ai: true };
}

async function linkedin(resume, deps = {}) {
  const ask = deps.askJson || askJson;
  const facts = contentOf(resume);
  if (!hasContent(facts)) throw new WriterError(400, "NEED_MORE", NEED_MORE);
  let out;
  try {
    out = await ask(
      "Write a LinkedIn headline and an About section for a student, from their resume. Headline: under 200 characters, what they study or do and what they're aiming for (only from the facts), separated with ' | '. About: 2 or 3 short paragraphs in first person, under 80 words each.",
      { resume: facts, format: { headline: "...", about: ["...", "..."] } },
      800,
    );
  } catch (e) {
    console.warn("[resume-writer] linkedin: AI unavailable:", e.message);
    return { headline: null, about: [], ai: false, message: BUSY };
  }
  const corpus = stringsIn(facts).join("\n");
  const [headline] = keepSupported([out?.headline], corpus, { max: 220, action: "linkedin-headline" });
  const about = keepSupported(list(out?.about).slice(0, 3), corpus, { max: 650, action: "linkedin-about" });
  if (!headline && !about.length) return { headline: null, about: [], ai: false, message: BUSY };
  return { headline: headline || null, about, ai: true };
}

module.exports = { coverLetter, linkedin, WriterError, NEED_MORE, BUSY, _setClient: (c) => { client = c; } };
