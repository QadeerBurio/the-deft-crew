// services/resumeImport/normalize.js — the AI's JSON -> exactly the Resume model's fields, keeping only what is
// in the file. Every value is checked against the resume text: a value the text doesn't contain is dropped
// (counted in `dropped`), so nothing is invented. Text that has no section of its own goes to `otherNotes`.
'use strict';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const PRESENT = /^(present|current|now|ongoing|till date|to date|currently)$/i;

const s = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '');
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const fold = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}@.+]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => fold(t).split(' ').map((w) => w.replace(/^[.@+]+|[.@+]+$/g, '')).filter((w) => w.length >= 3);

function makeGround(sourceText) {
  const folded = ' ' + fold(sourceText) + ' ';
  const digits = String(sourceText || '').replace(/\D+/g, '');
  const vocab = new Set(words(sourceText));
  return {
    // a short value (name, company, school, skill, email): appears in the text as written
    has(v) { const f = fold(v); return !!f && folded.includes(' ' + f + ' ') || (!!f && f.length >= 4 && folded.includes(f)); },
    // a long value (summary, bullet): nearly all of its words are in the text
    mostly(v, share = 0.8) { const w = words(v); if (!w.length) return false; return w.filter((x) => vocab.has(x)).length / w.length >= share; },
    phone(v) { const d = String(v || '').replace(/\D+/g, ''); return d.length >= 7 && digits.includes(d.slice(-7)); },
    year(y) { return folded.includes(' ' + y + ' ') || folded.includes(String(y)); },
  };
}

// "2021-06", "Jun 2021", "06/2021", "2021" -> Date (UTC, 1st of month); "Present" -> { current }
function parseDate(v, g) {
  const t = s(v);
  if (!t) return {};
  if (PRESENT.test(t)) return { current: true };
  let m = t.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  let y; let mo = 0;
  if (m) { y = +m[1]; mo = +m[2] - 1; }
  else if ((m = t.match(/^(\d{1,2})[-/.](\d{4})$/))) { y = +m[2]; mo = +m[1] - 1; }
  else if ((m = t.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) { y = +m[2]; mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo == null) return {}; }
  else if ((m = t.match(/^(\d{4})$/))) { y = +m[1]; }
  else return {};
  if (!(y >= 1950 && y <= 2100) || !(mo >= 0 && mo <= 11)) return {};
  if (g && !g.year(y)) return {}; // a year the file doesn't mention is invented
  return { date: new Date(Date.UTC(y, mo, 1)) };
}

function dates(item, g) {
  const a = parseDate(item.startDate, g);
  const b = parseDate(item.endDate, g);
  const out = {};
  if (a.date) out.startDate = a.date;
  if (b.date) out.endDate = b.date;
  if (b.current || a.current || item.current === true) { out.current = true; delete out.endDate; }
  else out.current = false;
  return out;
}

const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function normalizeParsed(raw, sourceText) {
  const g = makeGround(sourceText);
  const dropped = [];
  const keep = (section, v, test) => { const val = s(v); if (!val) return ''; if (test(val)) return val; dropped.push(section); return ''; };
  const short = (section, v) => keep(section, v, (x) => g.has(x));
  const long = (section, v) => keep(section, v, (x) => g.mostly(x));
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.personal && typeof r.personal === 'object' ? r.personal : {};

  // ---- personal ----
  let first = short('personal', p.firstName);
  let last = short('personal', p.lastName);
  const full = short('personal', p.fullName);
  if (!first && full) { const parts = full.split(' '); first = parts[0]; last = parts.slice(1).join(' '); }
  const email = keep('personal', p.email, (x) => EMAIL_RE.test(x) && g.has(x)).toLowerCase();
  const phone = keep('personal', p.phone, (x) => g.phone(x));
  const link = (v) => keep('personal', v, (x) => URL_RE.test(x.replace(/^www\./i, '')) && g.has(x.replace(/^https?:\/\//i, '').replace(/\/$/, '')));
  const personalInfo = {
    firstName: first, lastName: last, email, phone,
    city: short('personal', p.city), country: short('personal', p.country),
    linkedin: link(p.linkedin), github: link(p.github), portfolio: link(p.portfolio || p.website),
    title: short('title', r.title),
  };
  personalInfo.location = [personalInfo.city, personalInfo.country].filter(Boolean).join(', ');

  // ---- sections ----
  const workExperience = arr(r.experience).map((w) => {
    if (!w || typeof w !== 'object') return null;
    const company = short('experience', w.company);
    const position = short('experience', w.role || w.position || w.title);
    // an entry whose company or role isn't in the file is not the student's: drop all of it
    if ((s(w.company) && !company) || (s(w.role || w.position || w.title) && !position) || (!company && !position)) return null;
    const achievements = arr(w.bullets || w.achievements).map((b) => long('experience', b)).filter(Boolean).slice(0, 12);
    return { company, position, location: short('experience', w.location), ...dates(w, g), description: long('experience', w.description), achievements };
  }).filter(Boolean);

  const education = arr(r.education).map((e) => {
    if (!e || typeof e !== 'object') return null;
    const institution = short('education', e.school || e.institution);
    const degree = short('education', e.degree);
    if ((s(e.school || e.institution) && !institution) || (s(e.degree) && !degree) || (!institution && !degree)) return null;
    const grade = short('education', e.grade || e.gpa);
    const gpaNum = Number((grade.match(/^(\d(?:\.\d{1,2})?)(?:\s*\/\s*\d(?:\.\d{1,2})?)?$/) || [])[1]);
    const out = { institution, degree, fieldOfStudy: short('education', e.field || e.fieldOfStudy), ...dates(e, g), grade, description: '' };
    if (gpaNum > 0 && gpaNum <= 5) out.gpa = gpaNum;
    return out;
  }).filter(Boolean);

  const seen = new Set();
  const skills = arr(r.skills).map((k) => (typeof k === 'string' ? k : k && k.name)).map((k) => short('skills', k))
    .filter((k) => k && k.length <= 60 && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()))
    .slice(0, 60).map((name) => ({ name, level: 'Intermediate', category: 'Technical' }));

  const projects = arr(r.projects).map((x) => {
    if (!x || typeof x !== 'object') return null;
    const name = short('projects', x.name);
    if (!name) return null;
    const bullets = arr(x.bullets).map((b) => long('projects', b)).filter(Boolean);
    const description = [long('projects', x.description), ...bullets].filter(Boolean).join('\n');
    return { name, description, technologies: arr(x.technologies).map((t) => short('projects', t)).filter(Boolean), ...dates(x, g), url: link(x.url), githubUrl: '' };
  }).filter(Boolean);

  const certifications = arr(r.certifications).map((c) => {
    const o = typeof c === 'string' ? { name: c } : c || {};
    const name = short('certifications', o.name);
    if (!name) return null;
    const d = parseDate(o.date || o.issueDate, g);
    return { name, organization: short('certifications', o.issuer || o.organization), ...(d.date ? { issueDate: d.date } : {}), credentialId: '', credentialUrl: link(o.url) };
  }).filter(Boolean);

  const languages = arr(r.languages).map((l) => {
    const o = typeof l === 'string' ? { name: l } : l || {};
    const name = short('languages', o.name);
    if (!name) return null;
    const level = short('languages', o.level || o.proficiency);
    return { name, proficiency: level || 'Intermediate' };
  }).filter(Boolean);

  const achievements = arr(r.achievements).map((a) => long('achievements', typeof a === 'string' ? a : a && (a.text || a.title))).filter(Boolean).slice(0, 20);
  const other = arr(r.other).map((o) => long('other', typeof o === 'string' ? o : o && (o.text || o.title))).filter(Boolean);
  const summary = long('summary', r.summary);

  return {
    personalInfo,
    professionalSummary: { title: personalInfo.title, summary },
    workExperience, education, skills, projects, certifications, languages, achievements,
    otherNotes: other.join('\n'),
    dropped,
  };
}

module.exports = { normalizeParsed, parseDate, makeGround, fold };
