// services/resumeCoach.js
// Plan P3-4 / P3-4b (flags resumeV2 + resumeCoach): "we write it, you confirm it". The student gives facts (mostly by
// tapping chips); tdc writes. Nothing is ever invented: every AI suggestion is checked against the student's own facts
// with the Resume Studio validator (services/resumeStudio/validator.js) and only "ok" ones are returned; anything that
// adds a number, date, link, name, tool or claim the student didn't give is dropped and logged (flags only, never the
// student's text) so the prompts can be improved. When facts are missing, a question comes back instead of a guess.
//   coach({ action, facts })   bullets | summary | stronger | skills | extract | fit
//     → { suggestions: [...], usedFacts: [...], questions: [{ key, text }], dropped }
//   check({ field, text, current, role }) → { issues: [{ code, message, fix? }] }   live checks for one field
//   autofix(resume) → { changes: [{ rule, path, before, after }], patch }   P3-4b §5, previewed by the app (owner #12)
//   transcribe(buffer, mime) → { text }   speak mode (flag resumeSpeak), never stored
// English only (owner). Model: OPENAI_MODEL (default gpt-4o-mini); speech: OPENAI_TRANSCRIBE_MODEL (default whisper-1).
const crypto = require("crypto");
const { checkText, numbersIn } = require("./resumeStudio/validator");
const { SYNONYM_MAP } = require("../utils/skillNormalizer");

let client = null;
const ai = () => {
  if (client) return client;
  const OpenAI = require("openai");
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
};
const model = () => process.env.OPENAI_MODEL || "gpt-4o-mini";
class CoachError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

const str = (v, max = 400) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const list = (v, n = 12, max = 200) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
const RULES = [
  "Use ONLY the facts given. Never add a number, percentage, amount, date, tool, technology, employer, organisation,",
  "title, award or result that is not in the facts. If the facts have no number, write no number.",
  "No first person (no I, me, my). English only. Plain words a recruiter reads in seconds.",
].join(" ");

async function askJson(system, user, maxTokens = 500) {
  const completion = await ai().chat.completions.create({
    model: model(),
    messages: [{ role: "system", content: `${system} ${RULES} Reply with JSON only.` }, { role: "user", content: JSON.stringify(user) }],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    temperature: 0.4,
  });
  try { return JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { return {}; }
}

// the guardrail: keep what the student's facts support, drop (and log) the rest
function guard(candidates, corpus, kind, action) {
  const kept = [];
  let dropped = 0;
  for (const c of candidates) {
    const t = str(c, 600);
    if (!t) continue;
    const r = checkText(t, "", corpus, { kind });
    if (r.status === "ok" && !r.riskFlags.some((f) => f.flag === "first_person")) kept.push(t);
    else { dropped += 1; console.warn(`[resume-coach] ${action}: suggestion dropped (${r.riskFlags.map((f) => f.flag).join(",") || r.status})`); }
  }
  return { kept, dropped };
}
const corpusOf = (...parts) => parts.flat(3).map((x) => (x == null ? "" : typeof x === "object" ? Object.values(x).join(" ") : String(x))).join("\n");

// ---------- actions ----------
async function bullets(f) {
  const facts = { role: str(f.role, 120), organisation: str(f.organisation, 120), did: list(f.did, 8, 160), size: str(f.size, 60), proud: str(f.proud, 240), current: !!f.current, section: str(f.section, 30) };
  if (!facts.did.length && !facts.proud) return { suggestions: [], usedFacts: [], questions: [{ key: "did", text: "what did you do there? tap any that fit." }] };
  const out = await askJson("Write 2 or 3 resume bullets for one entry from a student's answers. Start each bullet with an action verb (past tense for finished roles, present tense when current). One line each, under 20 words.", { ...facts, format: { bullets: ["..."] } });
  const { kept, dropped } = guard(list(out.bullets, 6, 300), corpusOf(facts), "condense", "bullets");
  const questions = !facts.size && kept.length ? [{ key: "size", text: "roughly how many people or how big was it? (skip if you're not sure)" }] : [];
  return { suggestions: kept.slice(0, 3), usedFacts: [...facts.did, facts.size, facts.proud].filter(Boolean), questions, dropped };
}

async function summary(f) {
  const facts = { programme: str(f.programme, 120), university: str(f.university, 120), year: str(f.year, 40), targetRole: str(f.targetRole, 100), strengths: list(f.strengths, 8, 200), skills: list(f.skills, 12, 60) };
  if (!facts.targetRole) return { suggestions: [], usedFacts: [], questions: [{ key: "targetRole", text: "what job do you want? pick one." }] };
  if (!facts.programme && !facts.strengths.length && !facts.skills.length) return { suggestions: [], usedFacts: [], questions: [{ key: "programme", text: "what are you studying?" }] };
  const out = await askJson("Write 3 different resume summaries for a student, 2 or 3 short sentences each, aimed at the target role, from the facts.", { ...facts, format: { summaries: ["...", "...", "..."] } });
  const { kept, dropped } = guard(list(out.summaries, 4, 700), corpusOf(facts), "summary", "summary");
  return { suggestions: kept.slice(0, 3), usedFacts: [facts.programme, facts.university, facts.targetRole, ...facts.strengths].filter(Boolean), questions: [], dropped };
}

async function stronger(f) {
  const facts = { bullet: str(f.bullet, 300), role: str(f.role, 120), organisation: str(f.organisation, 120), size: str(f.size, 60), result: str(f.result, 200), current: !!f.current };
  if (!facts.bullet) throw new CoachError(400, "BULLET_REQUIRED", "pick a line to make stronger");
  const out = await askJson("Rewrite one resume bullet so it is stronger: an action verb first, specific, concise. Keep every fact; add none.", { ...facts, format: { bullet: "..." } });
  const { kept, dropped } = guard([out.bullet], corpusOf(facts), "condense", "stronger");
  const hasNumber = numbersIn(facts.bullet).size > 0 || !!facts.size;
  const questions = hasNumber ? [] : [{ key: "size", text: "roughly how many people came or took part? a number makes this line stronger (skip if you're not sure)." }];
  return { suggestions: kept, usedFacts: [facts.bullet, facts.size, facts.result].filter(Boolean), questions, dropped };
}

// soft skills, each linked to where the student showed it (never just claimed)
const SOFT = [
  ["leadership", /\b(lead|led|leader|head|president|captain|chair|coordinat|in charge|managed|class rep|cr)\b/i],
  ["communication", /\b(present|speak|spoke|host|debat|wrote|writing|social media|content|teach|taught|tutor|mc)\b/i],
  ["teamwork", /\b(team|member|together|volunteer|group|committee|society|club)\b/i],
  ["organisation", /\b(organi[sz]|event|plan|schedul|arrang)\b/i],
  ["problem solving", /\b(fix|solv|built|build|debug|design|project|hackathon|competition)\b/i],
  ["time management", /\b(part-time|while studying|deadline|freelanc|job|shift)\b/i],
];
function softSkills(entries) {
  const out = [];
  for (const [skill, re] of SOFT) {
    const where = entries.find((e) => re.test(e.text));
    if (where) out.push({ skill, where: where.label });
  }
  return out;
}
async function skills(f) {
  const current = list(f.current, 40, 60);
  const entries = [
    ...(Array.isArray(f.projects) ? f.projects : []).map((p) => ({ label: str(p?.name, 80), text: corpusOf(p) })),
    ...(Array.isArray(f.activities) ? f.activities : []).map((a) => ({ label: str(a?.organisation || a?.role, 80), text: corpusOf(a) })),
    ...(Array.isArray(f.experience) ? f.experience : []).map((w) => ({ label: str(w?.company || w?.position, 80), text: corpusOf(w) })),
  ].filter((e) => e.label);
  const soft = softSkills(entries).filter((s) => !current.some((c) => c.toLowerCase() === s.skill));
  const programme = str(f.programme, 120);
  const targetRole = str(f.targetRole, 100);
  let hard = [];
  if (programme || targetRole || entries.length) {
    const out = await askJson("Suggest up to 10 hard skills a student could list, based on their programme, target role and what their projects and activities mention. These are suggestions the student confirms one by one.", { programme, targetRole, projects: entries.map((e) => e.text).slice(0, 8), have: current, format: { skills: ["..."] } });
    const have = new Set(current.map((c) => c.toLowerCase()));
    hard = list(out.skills, 12, 60).filter((s) => !have.has(s.toLowerCase())).slice(0, 10);
  }
  return { suggestions: hard, soft, usedFacts: [programme, targetRole].filter(Boolean), questions: programme || targetRole ? [] : [{ key: "programme", text: "what are you studying? we'll suggest skills that fit." }] };
}

// chat mode: pull the structured fields out of one answer; a value is kept only if the student said it
const EXTRACT = {
  study: { fields: ["programme", "university", "year"], ask: "Pull out the programme (degree / subject), the university or college, and the year or semester." },
  society: { fields: ["organisation", "role"], ask: "Pull out the society / club / team name and the student's role in it." },
  did: { fields: ["did"], ask: "List what the student did, as short phrases in their words." },
  work: { fields: ["organisation", "role"], ask: "Pull out where the student worked or interned and their role." },
  project: { fields: ["name", "did"], ask: "Pull out the project's name (or what it was) and what the student did." },
  target: { fields: ["targetRole"], ask: "Pull out the job or internship the student wants." },
};
const saidIn = (answer) => { const a = answer.toLowerCase(); return (v) => { const s = str(v, 160); if (!s) return false; return a.includes(s.toLowerCase()) || s.toLowerCase().split(/\s+/).filter((w) => w.length > 2).every((w) => a.includes(w)); }; };
async function extract(f) {
  const key = str(f.question, 20);
  const answer = str(f.answer, 1000);
  const spec = EXTRACT[key];
  if (!spec) throw new CoachError(400, "BAD_QUESTION", "unknown question");
  if (!answer) return { suggestions: [], usedFacts: [], questions: [], fields: {} };
  const out = await askJson(`From a student's answer, ${spec.ask} Copy the student's words; leave a field empty if it isn't said.`, { answer, format: Object.fromEntries(spec.fields.map((x) => [x, x === "did" ? ["..."] : "..."])) }, 300);
  const said = saidIn(answer);
  const fields = {};
  for (const fld of spec.fields) {
    if (fld === "did") { const v = list(out.did, 6, 160).filter(said); if (v.length) fields.did = v; }
    else if (said(out[fld])) fields[fld] = str(out[fld], 160);
  }
  return { suggestions: [], usedFacts: [answer], questions: [], fields };
}

// fit on one page (deterministic): trim to 3 lines per entry, the longest lines first, shown before / after
const LINE = 95;
function fit(f) {
  const resume = f.resume || {};
  const changes = [];
  for (const sec of ["workExperience", "activities", "volunteering"]) {
    (Array.isArray(resume[sec]) ? resume[sec] : []).forEach((e, i) => {
      const key = sec === "workExperience" ? "achievements" : "bullets";
      const lines = (Array.isArray(e?.[key]) ? e[key] : []).map((x) => str(x, 600)).filter(Boolean);
      if (lines.length <= 3) return;
      const keep = [...lines].map((t, j) => ({ t, j, weight: (numbersIn(t).size ? 0 : 1000) + t.length })).sort((a, b) => a.weight - b.weight).slice(0, 3).sort((a, b) => a.j - b.j).map((x) => x.t);
      changes.push({ path: `${sec}[${i}].${key}`, before: lines, after: keep, linesSaved: lines.filter((t) => !keep.includes(t)).reduce((a, t) => a + Math.ceil(t.length / LINE), 0) });
    });
  }
  return { suggestions: changes, usedFacts: [], questions: [] };
}

const ACTIONS = { bullets, summary, stronger, skills, extract, fit };
async function coach({ action, facts } = {}) {
  const fn = ACTIONS[action];
  if (!fn) throw new CoachError(400, "BAD_ACTION", "action: bullets | summary | stronger | skills | extract | fit");
  return fn(facts && typeof facts === "object" ? facts : {});
}

// ---------- live checks (P3-4b §4) ----------
const VERBS = new Set("achieved,analysed,analyzed,arranged,assisted,built,coached,collaborated,collected,completed,conducted,coordinated,created,delivered,designed,developed,drafted,edited,engaged,established,evaluated,executed,facilitated,filmed,founded,gathered,guided,handled,helped,hosted,identified,implemented,improved,increased,initiated,interviewed,introduced,launched,led,maintained,managed,marketed,mentored,moderated,monitored,negotiated,operated,organised,organized,painted,performed,photographed,planned,prepared,presented,produced,programmed,promoted,raised,recruited,represented,researched,resolved,reviewed,ran,scheduled,served,set,shot,sold,solved,started,streamlined,supervised,supported,taught,tested,trained,translated,tutored,volunteered,won,wrote,answered,cooked,cleaned,drove,packed,delivered,donated,captained,competed,debated,directed,co-organised,co-organized,co-founded,co-led".split(","));
const PRESENT = { organise: "organised", organize: "organized", lead: "led", manage: "managed", build: "built", create: "created", teach: "taught", run: "ran", write: "wrote", help: "helped", design: "designed", develop: "developed", plan: "planned", host: "hosted", sell: "sold", handle: "handled", coordinate: "coordinated", support: "supported", tutor: "tutored", present: "presented" };
const PRESENT_OF = Object.fromEntries(Object.entries(PRESENT).map(([a, b]) => [b, a]));
const VAGUE = ["hardworking", "hard working", "hard-working", "team player", "passionate", "go-getter", "self-motivated", "detail-oriented", "detail oriented", "quick learner", "dynamic", "result-oriented", "results-driven"];
const firstWord = (t) => (str(t).match(/^[A-Za-z-]+/) || [""])[0].toLowerCase();
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

const spellCache = new Map(); // sha256(text) → [{ word, suggestion }]
async function spelling(text) {
  const key = crypto.createHash("sha256").update(text).digest("hex");
  if (spellCache.has(key)) return spellCache.get(key);
  let found = [];
  try {
    const out = await askJson("Find spelling mistakes in this English resume text. Ignore names, places, brands and technical terms. Return {\"mistakes\":[{\"word\":\"...\",\"suggestion\":\"...\"}]} (empty if none).", { text }, 200);
    const words = new Set(text.toLowerCase().match(/[a-z']+/g) || []);
    found = (Array.isArray(out.mistakes) ? out.mistakes : []).map((m) => ({ word: str(m?.word, 40), suggestion: str(m?.suggestion, 40) })).filter((m) => m.word && m.suggestion && words.has(m.word.toLowerCase()) && m.word.toLowerCase() !== m.suggestion.toLowerCase()).slice(0, 5);
  } catch (e) {
    console.warn("[resume-coach] spelling check unavailable:", e.message);
    return [];
  }
  if (spellCache.size > 2000) spellCache.delete(spellCache.keys().next().value);
  spellCache.set(key, found);
  return found;
}

async function check({ field, text, current, spell = true } = {}) {
  const t = str(text, 1000);
  const issues = [];
  const add = (code, message, fix) => issues.push(fix != null ? { code, message, fix } : { code, message });
  if (field === "email") {
    if (t && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && /(cute|cutie|princess|prince|baby|angel|xox|sexy|lover|hot|king|queen|boss|devil|\d{4,})/i.test(t.split("@")[0])) add("informal_email", "use a firstname.lastname email for job applications.");
    return { issues };
  }
  if (field === "phone") {
    const d = t.replace(/[^\d+]/g, "");
    if (/^03\d{9}$/.test(d)) add("phone_format", "write it as +92 so it works for every employer.", `+92 ${d.slice(1, 4)} ${d.slice(4)}`);
    else if (/^923\d{9}$/.test(d)) add("phone_format", "write it as +92 so it works for every employer.", `+92 ${d.slice(2, 5)} ${d.slice(5)}`);
    return { issues };
  }
  if (field === "linkedin") {
    if (!t) add("no_linkedin", "add your LinkedIn: most recruiters check it.");
    return { issues };
  }
  if (!t) return { issues };
  if (/^(i|my|me)\b/i.test(t)) add("first_person", "start with what you did, not \"I\" or \"my\".", cap(t.replace(/^(i|my|me)\s+/i, "")));
  if (field === "bullet") {
    const w = firstWord(t.replace(/^(i|my|me)\s+/i, ""));
    if (current && VERBS.has(w) && PRESENT_OF[w]) add("tense", "you still do this, so use the present tense.", cap(t.replace(new RegExp(`^${w}`, "i"), PRESENT_OF[w])));
    else if (!current && PRESENT[w]) add("tense", "this has finished, so use the past tense.", cap(t.replace(new RegExp(`^${w}`, "i"), PRESENT[w])));
    else if (w && !VERBS.has(w) && !PRESENT[w] && !/ed$/.test(w)) add("no_verb", "start with a verb like organised, built or led.");
    if (t.length > 190) add("too_long", "keep it to 2 lines: recruiters skim.");
  }
  const vague = VAGUE.filter((v) => t.toLowerCase().includes(v));
  if (vague.length) add("vague", `"${vague[0]}" says little on its own: show it with an example instead.`);
  if (spell && t.length >= 15 && (field === "bullet" || field === "summary")) {
    // the fix keeps the word's capital letter ("Recieved" → "Received")
    for (const m of await spelling(t)) add("spelling", `"${m.word}" → "${m.suggestion}"`, t.replace(new RegExp(`\\b${m.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), (hit) => (/^[A-Z]/.test(hit) ? cap(m.suggestion) : m.suggestion)));
  }
  return { issues };
}

// ---------- auto-fixes (P3-4b §5; owner #12: on the server, previewed in the app) ----------
const SECTIONS = ["workExperience", "education", "projects", "activities", "volunteering", "certifications", "awards"];
const dateOf = (e) => { const d = e?.current ? Date.now() + 1 : new Date(e?.endDate || e?.startDate || e?.issueDate || e?.date || 0).getTime(); return Number.isFinite(d) ? d : 0; };
const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/g, (m, a, b) => (["of", "and", "in", "for", "the", "at", "&"].includes(m) ? m : a.toUpperCase() + b));
const shouty = (s) => s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s);
const flat = (s) => s.length > 3 && s === s.toLowerCase() && /[a-z]/.test(s);
const JUNK_LINE = /references (are )?available (up)?on request|^\s*(curriculum vitae|cv|resume|résumé)\s*$/i;

function autofix(resume = {}) {
  const r = JSON.parse(JSON.stringify(resume || {}));
  const changes = [];
  const touched = new Set();
  const change = (rule, path, before, after, section) => { changes.push({ rule, path, before, after }); touched.add(section); };

  // reverse-chronological order in each section
  for (const sec of SECTIONS) {
    const items = Array.isArray(r[sec]) ? r[sec] : [];
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => dateOf(b) - dateOf(a));
    if (sorted.some((x, i) => x !== items[i]) && items.every((x) => dateOf(x) > 0)) { change("order", sec, items.map((x) => x.position || x.institution || x.name || x.role || x.title || ""), sorted.map((x) => x.position || x.institution || x.name || x.role || x.title || ""), sec); r[sec] = sorted; }
  }
  // capitalisation: titles, organisations, schools written all lower or all caps; skills by their known names
  const fields = { workExperience: ["position", "company"], education: ["institution", "degree"], activities: ["role", "organisation"], volunteering: ["role", "organisation"], projects: ["name"] };
  for (const [sec, keys] of Object.entries(fields)) {
    (Array.isArray(r[sec]) ? r[sec] : []).forEach((e, i) => keys.forEach((k) => {
      const v = String(e?.[k] || "");
      if (flat(v) || shouty(v)) { const nv = titleCase(v.toLowerCase()); if (nv !== v) { change("capitals", `${sec}[${i}].${k}`, v, nv, sec); e[k] = nv; } }
    }));
  }
  (Array.isArray(r.skills) ? r.skills : []).forEach((s, i) => {
    const name = String(typeof s === "string" ? s : s?.name || "");
    const canon = SYNONYM_MAP[name.toLowerCase().trim()];
    if (canon && canon !== name && canon.toLowerCase() === name.toLowerCase().trim()) { change("capitals", `skills[${i}]`, name, canon, "skills"); if (typeof s === "string") r.skills[i] = canon; else s.name = canon; }
  });
  // bullets: the same ending everywhere (the way most of them end), trimmed spaces, empty and junk lines removed
  const bulletLists = [];
  for (const sec of ["workExperience", "activities", "volunteering"]) (Array.isArray(r[sec]) ? r[sec] : []).forEach((e, i) => { const k = sec === "workExperience" ? "achievements" : "bullets"; if (Array.isArray(e?.[k])) bulletLists.push([sec, i, k, e]); });
  const all = bulletLists.flatMap(([, , k, e]) => e[k]).map((b) => String(b || "").trim()).filter(Boolean);
  const withDot = all.filter((b) => /\.$/.test(b)).length;
  const dot = all.length && withDot * 2 > all.length;
  for (const [sec, i, k, e] of bulletLists) {
    const before = e[k];
    const after = before.map((b) => String(b || "").replace(/\s+/g, " ").trim()).filter((b) => b && !JUNK_LINE.test(b)).map((b) => (dot ? (/[.!?]$/.test(b) ? b : `${b}.`) : b.replace(/\.$/, "")));
    if (JSON.stringify(after) !== JSON.stringify(before)) { change("bullets", `${sec}[${i}].${k}`, before, after, sec); e[k] = after; }
  }
  // remove "references available upon request" and "CV" / "Resume" as a title; the full home address (the city stays)
  const pi = r.personalInfo || {};
  if (pi.title && JUNK_LINE.test(pi.title)) { change("title", "personalInfo.title", pi.title, "", "personalInfo"); pi.title = ""; }
  if (str(pi.address)) { change("address", "personalInfo.address", pi.address, "", "personalInfo"); pi.address = ""; }
  const sum = r.professionalSummary?.summary;
  if (typeof sum === "string") {
    const ns = sum.replace(/references (are )?available (up)?on request\.?/ig, "").replace(/\s+/g, " ").trim();
    if (ns !== sum) { change("summary", "professionalSummary.summary", sum, ns, "professionalSummary"); r.professionalSummary.summary = ns; }
  }
  // empty entries
  for (const sec of SECTIONS) {
    const items = Array.isArray(r[sec]) ? r[sec] : [];
    const kept = items.filter((e) => Object.entries(e || {}).some(([k, v]) => k !== "_id" && k !== "current" && (Array.isArray(v) ? v.length : str(v))));
    if (kept.length !== items.length) { change("empty", sec, items.length, kept.length, sec); r[sec] = kept; }
  }
  const patch = {};
  for (const s of touched) patch[s] = r[s];
  return { changes, patch };
}

// ---------- speak mode (flag resumeSpeak) ----------
async function transcribe(buffer, mime = "audio/m4a") {
  if (!buffer?.length) throw new CoachError(400, "NO_AUDIO", "nothing was recorded. hold the button and talk.");
  const { toFile } = require("openai");
  const file = await toFile(buffer, /wav/.test(mime) ? "answer.wav" : /webm/.test(mime) ? "answer.webm" : "answer.m4a", { type: mime });
  const r = await ai().audio.transcriptions.create({ file, model: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1", language: "en" });
  return { text: str(r?.text, 2000) };
}

module.exports = { coach, check, autofix, transcribe, softSkills, CoachError, VERBS, _setClient: (c) => { client = c; }, _spellCache: spellCache };
