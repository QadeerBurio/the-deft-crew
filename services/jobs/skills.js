// services/jobs/skills.js
// A job's skills: short tags, the input of candidate matching (services/career/matchingService.js). Used by job
// create / update (routes/jobs.routes.js), the CSV import (services/jobs/csvJobImporter.js) and the read-only
// "skills to fix" report. The portal's tag input splits pasted text the same way (edu-boost src/portal/skillTags.js).
//   MAX_SKILLS 15, MAX_SKILL_LENGTH 40
//   splitSkillText(text)       pasted text → tags: split on commas, semicolons, new lines, " - " and bullets, never
//                              inside brackets ("Python (pandas, numpy)" stays one tag)
//   cleanSkills(input)         array (or legacy comma text) → { skills, errors }: trimmed, inner spaces collapsed,
//                              empty and repeated (any case) ones dropped; errors for > 15 or > 40 characters
//   skillProblems(skill)       why a stored skill looks broken: too long, unbalanced brackets
//   skillsMessage(errors)      one clear sentence for a 400 reply / a CSV row
const MAX_SKILLS = 15;
const MAX_SKILL_LENGTH = 40;

const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);
const BULLET = /^[\s]*(?:[•·▪◦●○■□➤►▶✓✔*]|-(?=\s)|\d+[.)](?=\s))\s*/;

const tidy = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/** Split pasted text into tags. Separators outside brackets: , ; new line, " - ", " | ", bullet starts. */
function splitSkillText(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const out = [];
  let cur = "";
  let depth = [];
  const push = () => { const t = tidy(cur.replace(BULLET, "")); if (t) out.push(t); cur = ""; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (OPEN[ch]) { depth.push(OPEN[ch]); cur += ch; continue; }
    if (CLOSE.has(ch)) { if (depth.length && depth[depth.length - 1] === ch) depth.pop(); cur += ch; continue; }
    if (depth.length) { cur += ch === "\n" ? " " : ch; continue; }
    if (ch === "," || ch === ";" || ch === "\n") { push(); continue; }
    // " - " and " | " between words; a bullet glyph starting a new item mid-line ("React • Node")
    if ((ch === "-" || ch === "|" || ch === "–" || ch === "—") && src[i - 1] === " " && src[i + 1] === " ") { push(); continue; }
    if (/[•·▪◦●]/.test(ch)) { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}

/** The brackets are balanced and in order: () [] {} */
function bracketsBalanced(s) {
  const stack = [];
  for (const ch of String(s)) {
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (CLOSE.has(ch)) { if (stack.pop() !== ch) return false; }
  }
  return stack.length === 0;
}

function skillProblems(skill) {
  const s = String(skill == null ? "" : skill);
  const out = [];
  if (tidy(s).length > MAX_SKILL_LENGTH) out.push(`over ${MAX_SKILL_LENGTH} characters (${tidy(s).length})`);
  if (!bracketsBalanced(s)) out.push("unbalanced brackets");
  return out;
}

/**
 * input: an array of skills (a string is accepted too: older clients sent "React, Node.js"; it's split like a paste).
 * → { skills, errors: [{ code: "TOO_MANY" | "TOO_LONG" | "NOT_A_LIST", ... }] }
 */
function cleanSkills(input) {
  if (input === undefined || input === null) return { skills: [], errors: [] };
  let list;
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = splitSkillText(input);
  else return { skills: [], errors: [{ code: "NOT_A_LIST" }] };
  const seen = new Set();
  const skills = [];
  for (const raw of list) {
    if (raw !== null && typeof raw === "object") return { skills: [], errors: [{ code: "NOT_A_LIST" }] };
    const t = tidy(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push(t);
  }
  const errors = [];
  const long = skills.filter((s) => s.length > MAX_SKILL_LENGTH);
  if (long.length) errors.push({ code: "TOO_LONG", skills: long });
  if (skills.length > MAX_SKILLS) errors.push({ code: "TOO_MANY", count: skills.length });
  return { skills, errors };
}

const short = (s) => (s.length > 50 ? `${s.slice(0, 47)}...` : s);
function skillsMessage(errors) {
  const parts = [];
  for (const e of errors || []) {
    if (e.code === "TOO_MANY") parts.push(`A job can list at most ${MAX_SKILLS} skills (this one has ${e.count}).`);
    if (e.code === "TOO_LONG") parts.push(`Each skill can be at most ${MAX_SKILL_LENGTH} characters: ${e.skills.map((s) => `"${short(s)}"`).join(", ")}. Split long text into separate skills.`);
    if (e.code === "NOT_A_LIST") parts.push("Skills must be a list of short tags.");
  }
  return parts.join(" ");
}

module.exports = { MAX_SKILLS, MAX_SKILL_LENGTH, splitSkillText, cleanSkills, skillProblems, bracketsBalanced, skillsMessage };
