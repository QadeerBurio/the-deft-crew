// services/resumeChat.js
// Resume full fix (flags resumeV2 + resumeCoach): "build it by chatting", a real interview run on the server.
//   - one question at a time, section by section in the track's order (fresher: contact, target, education, projects,
//     skills, activities, then experience as optional; experienced: contact, target, experience first), covering every
//     section (contact, summary, skills, certifications, awards, languages too), "another project / role?" until the
//     minimums (utils/resumeRules resumeStrengthV2) are met, then the gap check, asking again until it passes
//   - follow-ups when an answer is thin: what did you do, which tools, any result or number (the coach's own questions
//     from services/resumeCoach bullets are used, never ignored)
//   - English, Urdu and Roman Urdu: each answer is first translated to English (triage), the fields are pulled from the
//     translation and checked against it, and the fact guard also checks the ORIGINAL answer: a number, name or employer
//     that isn't in what the student wrote is dropped. Nothing is ever saved from a raw sentence: when nothing can be
//     pulled out, the question is asked again. The resume is always written in English.
//   - a skip is only an answer that is entirely a skip ("no", "nothing", "skip", "nahi", "kuch nahi"); "nothing much but
//     I tutored…" is an answer. Empty, very long, off-topic or abusive: a polite redirect, nothing saved.
//   - every saved item is a card (section, entry id, lines) the app shows and the student can edit; "keep" writes to the
//     entry by its id, never by name. The conversation and the step are saved (ResumeCoachSession): reopening continues.
//   start(user, resumeId, { topic }) / say(user, resumeId, text) / keep(user, resumeId, { entryId, lines }) / next(...)
//     → { messages (new ones), all? , cards, suggestions, state, gaps, done }
const { askJson, coach, corpusOf } = require("./resumeCoach");
const { numbersIn } = require("./resumeStudio/validator");
const { resumeStrengthV2, trackOf } = require("../utils/resumeRules");

class ChatError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const str = (v, max = 600) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : []);
const MAX_ANSWER = 1500;

// ---------- input checks ----------
const SKIP_RE = /^\s*(no+|nope|nah|na|none|nothing|nothing yet|not yet|not really|skip|skip it|pass|n\/a|nahi+|nahin|nai|nhi|kuch nahi|kuch bhi nahi|koi nahi|abhi nahi|nahi hai|no thanks|no thank you)\s*[.!]*\s*$/i;
const YES_RE = /^\s*(yes|yeah|yep|yup|sure|ok|okay|haan|han|ji|ji haan|jee|of course)\s*[.!]*\s*$/i;
const ABUSE_RE = /\b(fuck\w*|shit\w*|bitch\w*|bastard|asshole|dick|cunt|whore|slut|chutiy\w*|bhen ?chod|bhenchod|madar ?chod|madarchod|gandu|harami|haramzad\w*|kutt[ae]y?|randi|bc|mc)\b/i;
const URDU_SCRIPT = /[؀-ۿݐ-ݿ]/;
const ROMAN_URDU = /\b(main|mein|mera|meri|mere|hai|hain|tha|thi|kiya|kia|kar|karta|karti|kartay|liya|diya|aur|ka|ki|ke|ko|se|par|bhi|hum|hamari|wala|wali|kaam|naukri|parhai|parha|parhta|seekha|banaya|banai|sath|saath)\b/i;
// Urdu / Arabic-Indic digits as Latin digits (so "۵۰" counts as "50" in the number guard)
const latinDigits = (t) => String(t || "").replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
const fold = (t) => latinDigits(t).toLowerCase().replace(/[^\p{L}\p{N}@.+#-]+/gu, " ").replace(/\s+/g, " ").trim();

// ---------- the AI helpers (each checked; with no AI the chat still works on the student's English) ----------
async function triage(text, question) {
  const looksEnglish = !URDU_SCRIPT.test(text) && !ROMAN_URDU.test(text);
  try {
    const out = await askJson("You read one chat answer a student gave to a resume question. Say what kind it is: \"answer\" (it answers or partly answers), \"question\" (they ask for help or an example), \"offtopic\" (unrelated to the question or to their resume), \"abusive\". Give the language (\"en\", \"ur\" for Urdu script, \"roman_ur\" for Urdu in Latin letters, or \"mixed\"). Translate it faithfully into plain English: keep every name, number and detail exactly, add nothing.",
      { question, answer: text, format: { kind: "answer", language: "en", english: "..." } }, 400);
    const kind = ["answer", "question", "offtopic", "abusive"].includes(out.kind) ? out.kind : "answer";
    const english = str(out.english, MAX_ANSWER) || (looksEnglish ? text : "");
    return { kind, language: str(out.language, 12) || (looksEnglish ? "en" : "mixed"), english };
  } catch (e) {
    return { kind: "answer", language: looksEnglish ? "en" : "mixed", english: looksEnglish ? text : "", aiDown: true };
  }
}

// the student said it: in the English text (or, for names and numbers, in the original answer too)
const saidIn = (text) => { const a = fold(text); return (v) => { const s = fold(v); if (!s) return false; return a.includes(s) || s.split(" ").filter((w) => w.length > 2).every((w) => a.includes(w)); }; };
// names / employers / schools: each proper name (a word written with a capital in the English and never in lower case
// there) must be in the student's ORIGINAL answer: a translation never adds an employer. Plain words ("my father's
// shop") come from the translation and are fine.
const nameIn = (original, english) => {
  const a = fold(original);
  const enTokens = new Set(String(english == null ? original : english).split(/[^\p{L}\p{N}'-]+/u).filter(Boolean));
  return (v) => {
    const raw = String(v || "").split(/\s+/).filter(Boolean);
    if (!raw.length) return false;
    return raw.every((w) => {
      const bare = w.replace(/[^\p{L}\p{N}&'-]/gu, "");
      if (bare.length < 2 || /^(the|and|of|at|in|for|pvt|ltd|my|a|an)$/i.test(bare)) return true;
      // a proper name: capitalised here, and the English never writes it in lower case
      const proper = /^\p{Lu}/u.test(bare) && !enTokens.has(bare.toLowerCase());
      return !proper || a.includes(fold(bare));
    });
  };
};
// numbers: each number in the value must be in the original answer (or earlier answers about this entry)
const numbersOk = (value, originals) => { const have = new Set([...numbersIn(latinDigits(originals.join(" ")))]); for (const n of numbersIn(latinDigits(value))) if (!have.has(n)) return false; return true; };

const ARRAY_FIELDS = new Set(["did", "tools", "achievements", "courses", "names", "issuers", "languages", "technical", "soft"]);
async function pull(fields, ask, english, original, nameFields = []) {
  if (!english) return {};
  let out = {};
  try {
    out = await askJson(`From a student's answer (already in English), ${ask} Copy their words; leave a field empty ("" or []) if they didn't say it. Never add anything.`,
      { answer: english, format: Object.fromEntries(fields.map((f) => [f, ARRAY_FIELDS.has(f) ? ["..."] : "..."])) }, 400);
  } catch (e) { out = {}; }
  const said = saidIn(english);
  const named = nameIn(original || english, english);
  const res = {};
  for (const f of fields) {
    const v = out[f];
    if (Array.isArray(v)) {
      const xs = v.map((x) => str(x, 160)).filter((x) => x && said(x) && numbersOk(x, [original, english]) && (!nameFields.includes(f) || named(x)));
      if (xs.length) res[f] = [...new Set(xs)].slice(0, 12);
    } else if (typeof v === "string" && str(v) && said(v) && numbersOk(v, [original, english]) && (!nameFields.includes(f) || named(v))) res[f] = str(v, 160);
  }
  return res;
}

// a bullet / summary the coach wrote: also checked against what the student ORIGINALLY wrote (numbers, names)
function keepOriginal(lines, originals, english) {
  const named = nameIn(originals.join(" "), english == null ? originals.join(" ") : english);
  return list(lines).filter((l) => {
    if (!numbersOk(l, originals)) return false;
    // capitalised words mid-sentence look like names: each must be in what the student wrote
    const caps = (l.match(/(?<=[a-z,;:]\s)[A-Z][a-zA-Z0-9&.'-]+/g) || []).filter((w) => !/^(I|A|An|The|And|Or|In|On|At|For|With|To|Of|By|As|From|Using|English|Urdu|Excel|Python|Java|JavaScript|React|Node|SQL|Figma|Canva|Word|PowerPoint|Instagram|Facebook|LinkedIn|Google|Microsoft|Office|AI)$/.test(w));
    return caps.every((w) => named(w) || nameIn(originals.join(" "))(w));
  });
}

// ---------- dates in an answer: "Jun 2024 – Aug 2024", "2022 to 2026", "still there" ----------
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function datesIn(text, original) {
  const t = latinDigits(text).toLowerCase();
  const found = [...t.matchAll(/\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d{2})\b/g)];
  const orig = latinDigits(original || text);
  const ds = found.filter((m) => orig.includes(m[2])).map((m) => new Date(Date.UTC(+m[2], m[1] ? MON[m[1].slice(0, 3)] : 0, 1)));
  const current = /\b(still|current|currently|present|now|ongoing|abhi|ab tak|jaari)\b/.test(t);
  const out = {};
  if (ds[0]) out.startDate = ds[0];
  if (ds[1]) out.endDate = ds[1];
  if (current) { out.current = true; delete out.endDate; }
  return out;
}

// ---------- the plan ----------
const PLAN = {
  fresher: ["contact", "target", "education", "projects", "skills", "activities", "experience", "certifications", "awards", "languages", "summary"],
  experienced: ["contact", "target", "experience", "education", "projects", "skills", "certifications", "awards", "languages", "summary"],
};
const ENTRY = {
  projects: { field: "projects", lines: "description", noun: "project", ask: "tell me about a project: a class, final-year or personal one. what was it called, and what did it do?", again: "what was the project called, or what did it do? (e.g. \"a weather app for my class\")" },
  experience: { field: "workExperience", lines: "achievements", noun: "role", ask: "where have you worked, interned, tutored or freelanced, and what was your role? (or say no)", again: "where was it, and what was your role? (e.g. \"intern at Daraz\" or \"tutor for O level maths\")" },
  activities: { field: "activities", lines: "bullets", noun: "activity", ask: "any society, club, team or volunteer role? tell me which one and your role in it (or say no).", again: "which society, club or team, and what was your role? (e.g. \"events lead, IEEE\")" },
};
const OPTIONAL = new Set(["certifications", "awards", "languages", "activities"]);
const QUESTIONS = {
  contact_name: "hi! let's build your resume together, one question at a time. first: what's your full name?",
  contact_email: "what email should employers use? (a firstname.lastname one is best)",
  contact_phone: "and your phone number? (e.g. 0300 1234567)",
  contact_city: "which city are you in?",
  contact_linkedin: "do you have a LinkedIn link? paste it, or say skip.",
  target: "what job or internship do you want next? (e.g. marketing intern, software engineer)",
  education_study: "what are you studying, and where? (e.g. \"BBA at IBA Karachi\")",
  education_years: "when did you start, and when do you finish (or expect to)? e.g. 2022 – 2026",
  education_grade: "your CGPA or marks so far? (or say skip)",
  education_extra: "one achievement from your degree (dean's list, a top grade, a prize), or 2–3 relevant courses?",
  dates: "when was it? e.g. \"Jun 2024 – Aug 2024\", or \"still doing it\" (or say skip)",
  did: "what did you do there? say it simply: what you handled, built or organised, and for whom.",
  did_project: "what did you build or do in it, and what does it do?",
  tools: "which tools, languages or software did you use? (e.g. Excel, Canva, React)",
  result: "any result or number? e.g. \"120 users\", \"grade A\", \"3 events\", \"30 customers a day\" (or say skip)",
  skills: "list your skills: technical ones, the tools / software you use, and soft skills. separate them with commas.",
  skills_more: "nice. a few more? any tools or soft skills (like teamwork or presenting)?",
  certifications: "any certificates or online courses you finished? the name and where from (or say no).",
  awards: "any awards, competitions, scholarships or dean's list? (or say no)",
  languages: "which languages do you speak, and how well? e.g. \"English (fluent), Urdu (native)\"",
};

// ---------- reading and writing the resume ----------
const Resume = () => require("../models/Resume");
const Session = () => require("../models/ResumeCoachSession");
const plainOf = (doc) => JSON.parse(JSON.stringify(doc.toObject ? doc.toObject() : doc));
function entryOf(doc, field, id) { return list(doc[field]).find((e) => String(e._id) === String(id)) || null; }
function cardOf(field, e) {
  if (!e) return null;
  const sec = { workExperience: "experience", projects: "projects", activities: "activities", volunteering: "volunteering", education: "education", certifications: "certifications", awards: "awards", languages: "languages", skills: "skills" }[field] || field;
  const title = field === "workExperience" ? [str(e.position), str(e.company)].filter(Boolean).join(" at ")
    : field === "projects" ? str(e.name) : field === "education" ? [str(e.degree), str(e.institution)].filter(Boolean).join(", ")
      : field === "certifications" ? str(e.name) : field === "awards" ? str(e.title) : field === "languages" ? str(e.name) : [str(e.role), str(e.organisation)].filter(Boolean).join(", ");
  const lines = field === "workExperience" ? list(e.achievements) : field === "activities" || field === "volunteering" ? list(e.bullets) : field === "projects" ? [str(e.description), list(e.technologies).length ? `tools: ${list(e.technologies).join(", ")}` : ""].filter(Boolean) : field === "education" ? [str(e.description)].filter(Boolean) : [];
  return { section: sec, field, entryId: e._id ? String(e._id) : null, title: title || sec, lines: lines.map((l) => str(l, 300)).filter(Boolean) };
}

// ---------- the interview ----------
function initialState(resume) {
  const track = trackOf(resume) === "fresher" ? "fresher" : "experienced";
  return { track, plan: PLAN[track], i: 0, topic: null, phase: null, entryId: null, field: null, facts: {}, originals: [], tries: 0, asked: 0, gapRound: 0 };
}
const firstMissingContact = (r) => {
  const pi = r.personalInfo || {};
  if (!str(pi.firstName)) return "name";
  if (!str(pi.email)) return "email";
  if (!str(pi.phone)) return "phone";
  if (!str(pi.city) && !str(pi.location)) return "city";
  if (!str(pi.linkedin) && !r._askedLinkedin) return "linkedin";
  return null;
};
const minimumMet = (resume, topic) => {
  const gaps = resumeStrengthV2(resume, null).gaps.filter((g) => g.section === ({ projects: "projects", experience: "experience" })[topic]);
  return gaps.filter((g) => g.key === "projects" || g.key === "experience").length === 0;
};

// the next question from where the state is; moves through the plan, skipping what is already there
function advance(st, resume, out) {
  for (let guard = 0; guard < 40; guard += 1) {
    if (st.topic === "gaps") {
      const gaps = resumeStrengthV2(resume, null).gaps.filter((g) => g.section !== "page");
      if (!gaps.length) { st.topic = "done"; st.phase = null; out.done = true; out.messages.push("your resume has what it needs. open the builder to check how full the page is, then pick a template."); return; }
      // still missing after many rounds (the student keeps skipping): say so honestly, never "done"
      if (st.gapRound > 3 * gaps.length + 2) { st.topic = "done"; st.phase = null; out.done = true; out.messages.push(`${gaps.length} ${gaps.length === 1 ? "thing is" : "things are"} still missing. open the builder: the checklist there shows each one with an example.`); return; }
      // one gap after another (a skipped one comes back after the others), never the same one twice in a row
      const g = gaps[st.gapRound % gaps.length];
      st.gapRound += 1;
      out.messages.push(`one thing left: ${g.text}.`);
      const fr = focusGap(st, resume, g, out);
      if (fr === true) return;
      if (fr === "advance") continue;
      st.topic = "done"; st.phase = null; out.done = true; out.messages.push("the rest is best done in the builder: open it to finish."); return;
    }
    if (!st.topic) {
      if (st.i >= st.plan.length) { st.topic = "gaps"; continue; }
      st.topic = st.plan[st.i]; st.phase = null; st.entryId = null; st.facts = {}; st.originals = []; st.tries = 0;
    }
    const t = st.topic;
    if (t === "contact") {
      const miss = firstMissingContact({ ...resume, _askedLinkedin: st.askedLinkedin });
      if (!miss) { nextTopic(st); continue; }
      st.phase = miss; out.messages.push(QUESTIONS[`contact_${miss}`]); return;
    }
    if (t === "target") {
      if (str(resume.targetJob && resume.targetJob.jobTitle) || str(list(resume.targetJobs)[0] && resume.targetJobs[0].jobTitle)) { nextTopic(st); continue; }
      st.phase = "ask"; out.messages.push(QUESTIONS.target); return;
    }
    if (t === "education") {
      const e = list(resume.education)[0];
      if (!e) { st.phase = "study"; out.messages.push(QUESTIONS.education_study); return; }
      st.entryId = String(e._id || "");
      if (!(e.startDate || e.endDate || e.current) && !st.askedYears) { st.phase = "years"; out.messages.push(QUESTIONS.education_years); return; }
      if (!str(e.grade) && !e.gpa && !st.askedGrade) { st.phase = "grade"; out.messages.push(QUESTIONS.education_grade); return; }
      const extra = str(e.description) || list(resume.coursework).length;
      if (!extra && !st.askedExtra) { st.phase = "extra"; out.messages.push(QUESTIONS.education_extra); return; }
      nextTopic(st); continue;
    }
    if (ENTRY[t]) {
      if (!st.phase) {
        // experience on the experienced track, projects always: the minimum decides whether to ask "another?"
        const have = list(resume[ENTRY[t].field]).length;
        if (have && !st.entryId && st.asked === 0 && minimumMet(resume, t)) { st.phase = "more"; out.messages.push(`you have ${have} ${have === 1 ? ENTRY[t].noun : `${ENTRY[t].noun === "activity" ? "activities" : `${ENTRY[t].noun}s`}`} already. another one? (or say no)`); return; }
        st.phase = "entry"; out.messages.push(have ? `let's add another ${ENTRY[t].noun}. ${ENTRY[t].ask.replace(/^tell me about a project: /, "")}` : ENTRY[t].ask); return;
      }
      return; // a phase is waiting for an answer
    }
    if (t === "skills") {
      const n = list(resume.skills).length;
      if (n >= 6 && list(resume.skills).some((s) => s.group)) { nextTopic(st); continue; }
      st.phase = n ? "more" : "list"; out.messages.push(n ? QUESTIONS.skills_more : QUESTIONS.skills); return;
    }
    if (t === "certifications" || t === "awards" || t === "languages") {
      const have = list(resume[t]).length;
      if (have) { nextTopic(st); continue; }
      st.phase = "ask"; out.messages.push(QUESTIONS[t]); return;
    }
    if (t === "summary") {
      if (str(resume.professionalSummary && resume.professionalSummary.summary).length >= 120) { nextTopic(st); continue; }
      st.phase = "write"; out.needSummary = true; return;
    }
    nextTopic(st);
  }
}
function nextTopic(st) { if (st.focus) st.focus = false; else if (st.topic !== "gaps" && st.topic !== "alt") st.i += 1; st.topic = null; st.phase = null; st.entryId = null; st.facts = {}; st.originals = []; st.tries = 0; st.asked = 0; }

// the gap check sends the chat to one gap ("help me write this"): the right topic and phase
function focusGap(st, resume, g, out) {
  const back = (topic, phase, msg, extra = {}) => { Object.assign(st, { topic, phase, facts: {}, originals: [], tries: 0, asked: 1, focus: true }, extra); if (msg) out.messages.push(msg); return true; };
  const byName = (field, name) => list(resume[field]).find((e) => [e.name, e.company, e.position, e.organisation, e.role].some((x) => str(x) && name && name.includes(str(x))));
  switch (g.key) {
    case "name": case "email": case "phone": case "city": Object.assign(st, { topic: "contact", phase: null, focus: true }); return "advance";
    case "summary": case "summary_role": return back("summary", "write", null, { rewrite: true }) && ((out.needSummary = true));
    case "education": return back("education", "study", QUESTIONS.education_study);
    case "education_degree": case "education_dates": { const e = list(resume.education)[0]; return back("education", g.key === "education_dates" ? "years" : "study", g.key === "education_dates" ? QUESTIONS.education_years : QUESTIONS.education_study, { entryId: e ? String(e._id) : null }); }
    case "education_extra": { const e = list(resume.education)[0]; return back("education", "extra", st.alt ? `no problem. ${require("../utils/resumeRules").ALTERNATIVES.education_extra} works too. which do you have?` : QUESTIONS.education_extra, { entryId: e ? String(e._id) : null }); }
    case "projects": return back("projects", "entry", ENTRY.projects.ask);
    case "experience": return back("experience", "entry", ENTRY.experience.ask);
    case "project_detail": { const p = byName("projects", g.entry); if (!p) return back("projects", "entry", ENTRY.projects.ask); return back("projects", list(p.technologies).length ? "result" : "tools", list(p.technologies).length ? QUESTIONS.result : QUESTIONS.tools, { entryId: String(p._id), field: "projects" }); }
    case "experience_bullets": case "experience_strong": case "experience_result": { const w = byName("workExperience", g.entry); if (!w) return back("experience", "entry", ENTRY.experience.ask); return back("experience", g.key === "experience_result" ? "result" : "did", g.key === "experience_result" ? QUESTIONS.result : QUESTIONS.did, { entryId: String(w._id), field: "workExperience", facts: { organisation: str(w.company), role: str(w.position) } }); }
    case "experience_dates": { const w = byName("workExperience", g.entry); return back("experience", "dates", QUESTIONS.dates, { entryId: w ? String(w._id) : null, field: "workExperience" }); }
    case "skills": return back("skills", list(resume.skills).length ? "more" : "list", list(resume.skills).length ? QUESTIONS.skills_more : QUESTIONS.skills);
    case "skills_groups": return back("skills", "more", "let's group your skills. which tools or software do you use, and which soft skills (teamwork, presenting…)?");
    case "skills_backed": return back("projects", "entry", "your skills need backing: a project or a job where you used them. tell me about one: what was it, and which skills did you use?");
    default: return false;
  }
}

// ---------- one answer ----------
async function handleAnswer(st, doc, text, original, out) {
  const r = plainOf(doc);
  const t = st.topic;
  const skip = SKIP_RE.test(original);
  const named = nameIn(original, text);
  st.originals.push(original);

  if (t === "contact") {
    if (skip) { if (st.phase === "linkedin") st.askedLinkedin = true; else out.messages.push("employers need this to reach you, so i'll ask again later."); if (st.phase !== "linkedin") st.contactSkipped = (st.contactSkipped || 0) + 1; if (st.contactSkipped > 1 || st.phase === "linkedin") { nextTopic(st); } return; }
    const pi = doc.personalInfo || (doc.personalInfo = {});
    if (st.phase === "email") { const m = original.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); if (!m) return askAgain(st, out, "that didn't look like an email. type it like name@example.com"); pi.email = m[0].toLowerCase(); }
    else if (st.phase === "phone") { const m = latinDigits(original).match(/\+?\d[\d\s-]{8,15}\d/); if (!m) return askAgain(st, out, "type the number with its digits, like 0300 1234567"); pi.phone = m[0].replace(/\s+/g, " ").trim(); }
    else if (st.phase === "linkedin") { const m = original.match(/(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/[^\s,]+/i); if (!m) return askAgain(st, out, "paste the link (linkedin.com/in/…), or say skip"); pi.linkedin = m[0]; st.askedLinkedin = true; }
    else if (st.phase === "name") { const f = await pull(["firstName", "lastName"], "pull out the student's first name and last name.", text, original, ["firstName", "lastName"]); if (!f.firstName) return askAgain(st, out, "what's your full name, in English letters?"); pi.firstName = f.firstName; pi.lastName = f.lastName || pi.lastName || ""; }
    else if (st.phase === "city") { const f = await pull(["city"], "pull out the city they live in.", text, original, ["city"]); if (!f.city) return askAgain(st, out, "which city? (e.g. Lahore)"); pi.city = f.city; }
    doc.markModified("personalInfo");
    st.phase = null; return;
  }
  if (t === "target") {
    if (skip) { nextTopic(st); return; }
    const f = await pull(["targetRole"], "pull out the job or internship the student wants next.", text, original);
    if (!f.targetRole) return askAgain(st, out, "which job or internship? one or two words is fine (e.g. \"HR intern\")");
    doc.set("targetJob.jobTitle", f.targetRole);
    doc.targetJobs = [{ jobTitle: f.targetRole }];
    out.cards.push({ section: "target", field: "targetJob", entryId: null, title: `aiming for: ${f.targetRole}`, lines: [] });
    nextTopic(st); return;
  }
  if (t === "education") {
    if (st.phase === "study") {
      if (skip) { out.messages.push("education is the first thing a recruiter checks, so we need it."); return askAgain(st, out, QUESTIONS.education_study); }
      const f = await pull(["programme", "university", "year"], "pull out the programme (degree / subject), the university or college, and the year or semester.", text, original, ["university"]);
      if (!f.programme && !f.university) return askAgain(st, out, "what is the degree, and which university or college? (e.g. \"BS Computer Science at FAST\")");
      const same = list(doc.education).find((e) => f.university && str(e.institution).toLowerCase() === f.university.toLowerCase());
      if (same) { if (!str(same.degree) && f.programme) same.degree = f.programme; st.entryId = String(same._id); }
      else { doc.education.push({ institution: f.university || "", degree: f.programme || "" }); st.entryId = String(doc.education[doc.education.length - 1]._id); } // no "current" unless they say so
      Object.assign(doc.education.find((e) => String(e._id) === st.entryId) || {}, datesIn(text, original));
      out.cards.push(cardOf("education", entryOf(doc, "education", st.entryId)));
      st.phase = null; return;
    }
    const e = entryOf(doc, "education", st.entryId) || list(doc.education)[0];
    if (!e) { st.phase = null; return; }
    if (st.phase === "years") { st.askedYears = true; if (skip) { st.phase = null; return; } const d = datesIn(text, original); if (!d.startDate && !d.endDate) return askAgain(st, out, "type the years, like \"2022 – 2026\""); Object.assign(e, d); if (d.endDate) e.current = false; st.phase = null; return; }
    if (st.phase === "grade") { st.askedGrade = true; if (skip) { st.phase = null; return; } const m = latinDigits(original).match(/\b\d(?:\.\d{1,2})?\s*(?:\/\s*\d(?:\.\d{1,2})?)?\b|\b\d{2,3}\s*%/); if (m) e.grade = m[0].replace(/\s+/g, ""); st.phase = null; return; }
    if (st.phase === "extra") {
      st.askedExtra = true;
      if (skip) { st.phase = null; return; }
      const f = await pull(["achievements", "courses"], "pull out achievements (awards, dean's list, top grades) and relevant course names.", text, original);
      if (!f.achievements && !f.courses) return askAgain(st, out, "name one achievement, or 2–3 courses from your degree (e.g. \"Marketing, Statistics\")");
      if (f.achievements) e.description = [str(e.description), ...f.achievements.map((a) => `- ${a.charAt(0).toUpperCase()}${a.slice(1)}`)].filter(Boolean).join("\n");
      if (f.courses) doc.coursework = [...new Set([...list(doc.coursework), ...f.courses])].slice(0, 12);
      out.cards.push(cardOf("education", e));
      st.phase = null; return;
    }
    st.phase = null; return;
  }
  if (ENTRY[t]) return entryAnswer(st, doc, text, original, out, skip, named);
  if (t === "skills") {
    if (skip) { nextTopic(st); return; }
    const f = await pull(["technical", "tools", "soft"], "sort the skills they list into technical skills, tools / software, and soft skills.", text, original);
    const add = [["technical", f.technical], ["tools", f.tools], ["soft", f.soft]].flatMap(([g, xs]) => list(xs).map((name) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), group: g, level: "" })));
    if (!add.length) return askAgain(st, out, "list them with commas, like \"Excel, Canva, teamwork\"");
    const have = new Set(list(doc.skills).map((s) => str(s.name).toLowerCase()));
    for (const s of add) if (!have.has(s.name.toLowerCase())) { doc.skills.push(s); have.add(s.name.toLowerCase()); }
    out.cards.push({ section: "skills", field: "skills", entryId: null, title: `${doc.skills.length} skills`, lines: [["technical", "technical"], ["tools", "tools"], ["soft", "soft skills"]].map(([g, l]) => { const xs = list(doc.skills).filter((s) => s.group === g).map((s) => s.name); return xs.length ? `${l}: ${xs.join(", ")}` : ""; }).filter(Boolean) });
    st.phase = list(doc.skills).length >= 6 ? null : "more";
    if (!st.phase) nextTopic(st); else if ((st.tries += 1) > 2) nextTopic(st); else { out.messages.push(`that's ${list(doc.skills).length}. ${QUESTIONS.skills_more}`); out.waiting = true; }
    return;
  }
  if (t === "certifications" || t === "awards" || t === "languages") {
    if (skip) { nextTopic(st); return; }
    if (t === "languages") {
      const f = await pull(["languages"], "list each language with how well they speak it, as \"Name (level)\".", text, original);
      const items = list(f.languages).map((x) => { const m = x.match(/^([^()]+?)\s*(?:\(([^)]+)\))?$/); return m ? { name: str(m[1], 40), proficiency: str(m[2] || "", 30) } : null; }).filter((x) => x && x.name);
      if (!items.length) return askAgain(st, out, "which languages? e.g. \"English (fluent), Urdu (native)\"");
      items.forEach((x) => doc.languages.push(x));
      out.cards.push({ section: "languages", field: "languages", entryId: null, title: "languages", lines: items.map((x) => (x.proficiency ? `${x.name} (${x.proficiency})` : x.name)) });
    } else {
      const f = await pull(["names", "issuers"], t === "awards" ? "list the award, competition or scholarship names, and who gave each." : "list the certificate or course names, and the platform or organisation for each.", text, original, ["issuers"]);
      if (!f.names) return askAgain(st, out, t === "awards" ? "what was it called? (e.g. \"Dean's list, Fall 2024\")" : "what's the course called, and where from? (e.g. \"Google Data Analytics, Coursera\")");
      f.names.forEach((n, i) => doc[t].push(t === "awards" ? { title: n, issuer: list(f.issuers)[i] || "" } : { name: n, organization: list(f.issuers)[i] || "" }));
      out.cards.push({ section: t, field: t, entryId: null, title: t, lines: f.names });
    }
    nextTopic(st); return;
  }
  if (t === "summary") { st.phase = "write"; out.needSummary = true; return; }
  nextTopic(st);
}

function askAgain(st, out, text) {
  st.tries += 1;
  if (st.tries > 2) { out.messages.push("let's leave that for now. we'll come back to it."); nextTopic(st); return; }
  out.messages.push(text);
  out.waiting = true;
}

async function entryAnswer(st, doc, text, original, out, skip, named) {
  const t = st.topic;
  const E = ENTRY[t];
  if (st.phase === "more") {
    if (skip) { nextTopic(st); return; }
    if (YES_RE.test(original)) { st.phase = "entry"; out.messages.push(E.again); out.waiting = true; return; }
    st.phase = "entry"; // the answer is the next entry itself
  }
  if (st.phase === "entry") {
    if (skip) {
      if (t === "projects" && !minimumMet(plainOf(doc), "projects")) { out.messages.push("projects matter most on a student resume, so we'll come back to this. a class assignment counts too."); }
      nextTopic(st); return;
    }
    const f = t === "projects"
      ? await pull(["name", "did", "tools"], "pull out the project's name (or a short description of what it was), what the student did in it, and any tools or technologies named.", text, original)
      : await pull(["organisation", "role", "did"], t === "experience" ? "pull out where the student worked / interned / tutored / freelanced (the organisation, platform or 'family business'), their role, and what they did." : "pull out the society / club / team / organisation name, the student's role in it, and what they did.", text, original, ["organisation"]);
    const title = t === "projects" ? f.name : f.organisation || f.role;
    if (!title) return askAgain(st, out, E.again);
    const entry = t === "projects" ? { name: f.name.charAt(0).toUpperCase() + f.name.slice(1), description: "", technologies: list(f.tools) }
      : t === "experience" ? { company: f.organisation || "", position: f.role || "", achievements: [], ...datesIn(text, original) } : { organisation: f.organisation || "", role: f.role || "", bullets: [], ...datesIn(text, original) };
    doc[E.field].push(entry);
    st.entryId = String(doc[E.field][doc[E.field].length - 1]._id);
    st.field = E.field;
    st.facts = { name: f.name || "", organisation: f.organisation || f.name || "", role: f.role || "", did: list(f.did), tools: list(f.tools) };
    st.asked += 1;
    out.cards.push(cardOf(E.field, entryOf(doc, E.field, st.entryId)));
    st.phase = t !== "projects" && !(entry.startDate || entry.current) ? "dates" : "did";
    if (st.phase === "did" && thin(st.facts.did)) { out.messages.push(t === "projects" ? QUESTIONS.did_project : QUESTIONS.did); out.waiting = true; return; }
    if (st.phase === "dates") { out.messages.push(QUESTIONS.dates); out.waiting = true; return; }
    return followUp(st, doc, out);
  }
  const e = entryOf(doc, st.field || E.field, st.entryId);
  if (!e) { nextTopic(st); return; }
  if (st.phase === "dates") {
    if (!skip) { const d = datesIn(text, original); if (!d.startDate && !d.current) return askAgain(st, out, "type it like \"Jun 2024 – Aug 2024\", or say skip"); Object.assign(e, d); }
    st.phase = "did";
    if (thin(st.facts.did)) { out.messages.push(QUESTIONS.did); out.waiting = true; return; }
    return followUp(st, doc, out);
  }
  if (st.phase === "did") {
    if (skip && thin(st.facts.did)) { out.messages.push("even one thing helps: what did you do most days?"); if ((st.tries += 1) > 1) { nextTopic(st); return; } out.waiting = true; return; }
    if (!skip) { const f = await pull(["did", "tools"], "list what the student did, as short phrases in their words, and any tools named.", text, original); st.facts.did = [...new Set([...list(st.facts.did), ...list(f.did)])]; st.facts.tools = [...new Set([...list(st.facts.tools), ...list(f.tools)])]; if (!list(f.did).length && thin(st.facts.did)) return askAgain(st, out, "say what you did in a few words, e.g. \"handled customers and kept the sales record\""); }
    if (t === "projects" && list(st.facts.tools).length) e.technologies = [...new Set([...list(e.technologies), ...st.facts.tools])];
    return followUp(st, doc, out);
  }
  if (st.phase === "tools") {
    if (!skip) { const f = await pull(["tools"], "list the tools, languages, software or platforms named.", text, original); if (!f.tools) return askAgain(st, out, "name them with commas, like \"Excel, Canva\" (or say skip)"); st.facts.tools = [...new Set([...list(st.facts.tools), ...f.tools])]; if (t === "projects") e.technologies = [...new Set([...list(e.technologies), ...f.tools])]; }
    st.askedTools = true;
    return followUp(st, doc, out);
  }
  if (st.phase === "result") {
    st.askedResult = true;
    if (!skip) { const f = await pull(["result"], "pull out the result, outcome or number they mention (how many, how much, what came of it).", text, original); if (f.result) st.facts.result = f.result; }
    return followUp(st, doc, out, true);
  }
  if (st.phase === "keep") { out.messages.push("keep the lines you like above, then tap \"next\"."); out.waiting = true; return; }
  nextTopic(st);
}
const thin = (did) => list(did).join(" ").split(/\s+/).filter(Boolean).length < 3;

// after the facts: tools (projects) → a result or number → the coach writes the lines (the student keeps them)
async function followUp(st, doc, out, afterResult = false) {
  const t = st.topic;
  if (t === "projects" && !list(st.facts.tools).length && !st.askedTools) { st.phase = "tools"; out.messages.push(QUESTIONS.tools); out.waiting = true; return; }
  const hasNumber = numbersIn(latinDigits([...list(st.facts.did), st.facts.result || ""].join(" "))).size > 0 || !!st.facts.result;
  if (!hasNumber && !st.askedResult && !afterResult) { st.phase = "result"; out.messages.push(QUESTIONS.result); out.waiting = true; return; }
  const section = { projects: "projects", experience: "workExperience", activities: "activities" }[t];
  let r = {};
  try { r = await coach({ action: "bullets", facts: { section, role: st.facts.role, organisation: st.facts.organisation || st.facts.name, did: [...list(st.facts.did), ...(t === "projects" && list(st.facts.tools).length ? [`used ${st.facts.tools.join(", ")}`] : [])], size: st.facts.result || "", proud: "" } }); } catch (e) { r = {}; }
  const lines = keepOriginal(list(r.suggestions), st.originals, [...list(st.facts.did), st.facts.organisation || "", st.facts.role || "", st.facts.name || "", st.facts.result || "", ...list(st.facts.tools)].join(" "));
  const q = list(r.questions).find((x) => x.key === "size");
  if (!lines.length) {
    if ((st.tries += 1) > 1) { out.messages.push("i couldn't write lines from that without guessing. you can add them in the builder."); return afterEntry(st, doc, out); }
    st.phase = "did"; out.messages.push("tell me a bit more about what you did, and i'll write it up."); out.waiting = true; return;
  }
  st.phase = "keep";
  out.suggestions = { kind: "bullets", section: t, field: st.field || ENTRY[t].field, entryId: st.entryId, items: lines };
  out.messages.push(q && !st.facts.result ? "here's how i'd write it. keep what's right. (a number would make it stronger: you can add one with edit.)" : "here's how i'd write it. keep what's right:");
  out.waiting = true;
}

// after one entry: another one until the minimum is met, then "another? (or say no)" once
function afterEntry(st, doc, out) {
  const t = st.topic;
  const met = t === "projects" ? minimumMet(plainOf(doc), "projects") : t === "experience" ? minimumMet(plainOf(doc), "experience") || trackOf(plainOf(doc)) === "fresher" : true;
  Object.assign(st, { phase: met ? "more" : "entry", entryId: null, field: null, facts: {}, originals: [], tries: 0, askedTools: false, askedResult: false });
  out.messages.push(met ? `another ${ENTRY[t].noun}? (or say no)` : `let's add one more ${ENTRY[t].noun}: freshers need at least 2. ${ENTRY[t].again}`);
  out.waiting = true;
}

// the summary: written from the student's own facts (coach summary, fact-checked), kept as one line
async function writeSummary(st, doc, out) {
  const r = plainOf(doc);
  const e = list(r.education)[0] || {};
  const role = str((r.targetJob && r.targetJob.jobTitle) || (list(r.targetJobs)[0] || {}).jobTitle);
  if (!role) { st.topic = "target"; st.phase = "ask"; out.messages.push(QUESTIONS.target); out.waiting = true; return; }
  const strengths = [...list(r.workExperience).flatMap((w) => list(w.achievements)), ...list(r.activities).flatMap((a) => list(a.bullets)), ...list(r.projects).map((p) => str(p.description))].filter(Boolean).slice(0, 6);
  let s = {};
  try { s = await coach({ action: "summary", facts: { programme: [str(e.degree), str(e.fieldOfStudy)].filter(Boolean).join(", "), university: str(e.institution), targetRole: role, strengths, skills: list(r.skills).map((x) => x.name) } }); } catch (err) { s = {}; }
  const items = keepOriginal(list(s.suggestions), [JSON.stringify(r)]).filter((x) => x.length >= 100);
  if (!items.length) { out.messages.push("i couldn't write a summary from what we have without guessing. tell me in a line or two what you're good at."); st.phase = "summary_facts"; out.waiting = true; return; }
  st.phase = "keep_summary";
  out.suggestions = { kind: "summary", section: "summary", field: "professionalSummary", entryId: null, items, single: true };
  out.messages.push("last one: your summary, written from your answers. keep the one that sounds like you:");
  out.waiting = true;
}

// ---------- the session ----------
async function load(userId, resumeId) {
  const doc = await Resume().findOne({ _id: resumeId, user: userId });
  if (!doc) throw new ChatError(404, "NOT_FOUND", "resume not found");
  let session = await Session().findOne({ user: userId, resume: resumeId });
  if (!session) session = await Session().create({ user: userId, resume: resumeId, messages: [], state: initialState(plainOf(doc)) });
  return { doc, session };
}
function publicState(st) { return { topic: st.topic, phase: st.phase, entryId: st.entryId || null, track: st.track }; }
async function finish(doc, session, st, out) {
  if (out.needSummary) { delete out.needSummary; await writeSummary(st, doc, out); }
  if (!out.waiting && !out.done && !out.suggestions) advance(st, plainOf(doc), out);
  if (out.needSummary) { delete out.needSummary; await writeSummary(st, doc, out); }
  doc.set("settings.gate", true); // made / edited with the gap check
  await doc.save();
  const now = new Date();
  const fresh = [...out.cards.filter(Boolean).map((c) => ({ from: "tdc", text: `added to ${c.section} ✓`, card: c, at: now })), ...out.messages.map((t) => ({ from: "tdc", text: t, at: now }))];
  session.messages = [...list(session.messages), ...fresh].slice(-300);
  session.state = { ...st, pending: out.suggestions || null };
  session.done = st.topic === "done";
  session.markModified("messages"); session.markModified("state");
  await session.save();
  const plain = plainOf(doc);
  return { messages: fresh, suggestions: out.suggestions || null, state: publicState(st), done: session.done, gaps: resumeStrengthV2(plain, null).gaps.filter((g) => g.section !== "page"), resume: plain };
}

/** open the chat (first question, or where it left off); topic: a gap key from the gap check ("help me write this"),
 *  alt: the student said "I really don't have this" for that gap (the coach offers the fresher alternative) */
async function start(userId, resumeId, { topic, alt } = {}) {
  const { doc, session } = await load(userId, resumeId);
  const st = { ...initialState(plainOf(doc)), ...(session.state || {}) };
  const out = { messages: [], cards: [], suggestions: null };
  if (topic) {
    const g = resumeStrengthV2(plainOf(doc), null).gaps.find((x) => x.key === topic) || { key: topic, text: topic };
    st.alt = !!alt;
    if (alt && ["experience", "projects"].includes(topic)) {
      Object.assign(st, { topic: "alt", phase: "which", facts: {}, originals: [], tries: 0 });
      out.messages.push(`no problem. ${require("../utils/resumeRules").ALTERNATIVES[topic]} all count. which one do you have? tell me about it.`);
      out.waiting = true;
    } else {
      const fr = focusGap(st, plainOf(doc), g, out);
      if (fr === true) out.waiting = !out.needSummary;
    }
  }
  if (!list(session.messages).length || topic) {
    const res = await finish(doc, session, st, out);
    return { ...res, all: session.messages };
  }
  const pending = (session.state || {}).pending || null;
  const plain = plainOf(doc);
  return { messages: [], all: session.messages, suggestions: pending, state: publicState(st), done: !!session.done, gaps: resumeStrengthV2(plain, null).gaps.filter((g) => g.section !== "page"), resume: plain };
}

// the alternative ("I don't have experience / projects"): the answer says which kind; it goes to that section
const ALT_SECTION = [[/\b(society|club|team|captain|volunteer|ngo|drive|class rep|cr\b|event)/i, "activities"], [/\b(freelanc|fiverr|upwork|family|shop|business|tuition|tutor|teach|part[- ]time|job|intern)/i, "experience"], [/\b(hackathon|competition|contest|olympiad|award|prize)/i, "projects"], [/\b(project|fyp|assignment|app|website|research|thesis)/i, "projects"]];

/** the student's answer (typed, or speak mode's text) */
async function say(userId, resumeId, raw) {
  const original = str(raw, 5000);
  const { doc, session } = await load(userId, resumeId);
  const st = { ...initialState(plainOf(doc)), ...(session.state || {}) };
  delete st.pending;
  const out = { messages: [], cards: [], suggestions: null };
  const lastQ = [...list(session.messages)].reverse().find((m) => m.from === "tdc" && !m.card);
  const question = lastQ ? lastQ.text : "";
  const me = { from: "me", text: original.slice(0, 1500), at: new Date() };
  session.messages = [...list(session.messages), me];
  const repeat = (prefix) => { out.messages.push(`${prefix}${question ? ` ${question}` : ""}`.trim()); out.waiting = true; };
  if (!original) repeat("type or say your answer, or say skip.");
  else if (original.length > MAX_ANSWER) repeat("that's a lot at once. tell me in a few lines and i'll take it from there.");
  else if (ABUSE_RE.test(original)) repeat("let's keep it friendly so i can help with your resume.");
  else if (st.phase === "keep" || st.phase === "keep_summary") { out.messages.push(st.phase === "keep" ? "keep the lines you like above, then tap \"next\" (or tell me what to change)." : "keep the summary you like above, then tap \"next\"."); out.waiting = true; out.suggestions = (session.state || {}).pending || null; }
  else {
    const tri = SKIP_RE.test(original) ? { kind: "answer", english: original } : await triage(original, question);
    if (tri.kind === "abusive") repeat("let's keep it friendly so i can help with your resume.");
    else if (tri.kind === "offtopic") repeat("i can only help with your resume here.");
    else if (tri.kind === "question") repeat(`good question. here's an example: ${exampleFor(st)}.`);
    else if (!tri.english && !SKIP_RE.test(original)) repeat("i couldn't read that. could you say it again, in English or Roman Urdu?");
    else if (st.topic === "alt") {
      const section = (ALT_SECTION.find(([re]) => re.test(tri.english)) || [null, "projects"])[1];
      Object.assign(st, { topic: section, phase: "entry", facts: {}, originals: [], tries: 0, asked: 1 });
      await entryAnswer(st, doc, tri.english, original, out, false, nameIn(original, tri.english));
    } else if (st.phase === "summary_facts") {
      st.facts.strengths = [tri.english]; st.phase = "write"; await writeSummary(st, doc, out);
    } else {
      if (!st.topic) advance(st, plainOf(doc), { messages: [], cards: [] });
      await handleAnswer(st, doc, tri.english || original, original, out);
    }
  }
  const res = await finish(doc, session, st, out);
  return { ...res, messages: res.messages };
}
function exampleFor(st) {
  const ex = { projects: "\"Campus Ride: a React Native app that matches students going the same way; I built the login\"", experience: "\"Tutor, 3 O level students, maths, after college\"", activities: "\"Marketing lead, Business Society: ran the Instagram\"", skills: "\"Excel, Canva, SQL, teamwork, presenting\"", education: "\"BBA at IBA Karachi, 2022 – 2026\"", target: "\"marketing intern\"" };
  return ex[st.topic] || "a short, plain answer is enough";
}

/** keep lines the coach wrote: written to the entry by its id (never by name); summary: the one kept */
async function keep(userId, resumeId, { entryId, lines, kind } = {}) {
  const { doc, session } = await load(userId, resumeId);
  const st = { ...initialState(plainOf(doc)), ...(session.state || {}) };
  const pending = st.pending || {};
  const kept = list(lines).map((l) => str(l, 400)).filter(Boolean).slice(0, 6);
  if (!kept.length) throw new ChatError(400, "NOTHING_KEPT", "pick a line to keep");
  const out = { messages: [], cards: [], suggestions: null };
  if ((kind || pending.kind) === "summary") {
    doc.set("professionalSummary.summary", kept[0]);
    out.cards.push({ section: "summary", field: "professionalSummary", entryId: null, title: "summary", lines: [kept[0]] });
    st.pending = null;
    nextTopic(st);
    delete st.pending;
    return finish(doc, session, st, out);
  }
  const field = pending.field || st.field;
  const id = entryId || pending.entryId;
  if (!field || !id) throw new ChatError(409, "NOTHING_PENDING", "there's nothing to keep right now");
  const e = entryOf(doc, field, id);
  if (!e) throw new ChatError(404, "ENTRY_GONE", "that entry isn't on your resume any more");
  if (field === "workExperience") e.achievements = [...list(e.achievements), ...kept];
  else if (field === "activities" || field === "volunteering") e.bullets = [...list(e.bullets), ...kept];
  else if (field === "projects") e.description = [str(e.description), ...kept].filter(Boolean).join("\n");
  doc.markModified(field);
  out.cards.push(cardOf(field, e));
  // the rest of the lines stay pending until "next"
  const left = list(pending.items).filter((x) => !kept.includes(x));
  out.suggestions = left.length ? { ...pending, items: left } : null;
  out.waiting = true;
  if (!left.length) { out.suggestions = null; delete out.waiting; afterEntry(st, doc, out); }
  return finish(doc, session, st, out);
}

/** "next question": done with the coach's lines (or the summary) */
async function next(userId, resumeId) {
  const { doc, session } = await load(userId, resumeId);
  const st = { ...initialState(plainOf(doc)), ...(session.state || {}) };
  const out = { messages: [], cards: [], suggestions: null };
  if (st.phase === "keep" && ENTRY[st.topic]) afterEntry(st, doc, out);
  else nextTopic(st);
  delete st.pending;
  return finish(doc, session, st, out);
}

module.exports = { start, say, keep, next, ChatError, SKIP_RE, ABUSE_RE, triage, datesIn, keepOriginal, nameIn, numbersOk, PLAN };
