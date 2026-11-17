// services/resumeImport — upload -> text -> AI (90 s limit) -> checked fields -> a report the app shows.
//   importResume({ buffer, fileName }) -> {
//     status: 'ok' | 'partial' | 'scan' | 'unsupported' | 'unreadable',
//     message,                       // plain sentence for the student
//     fields,                        // Resume model fields (only what is in the file)
//     report: { filled, sections: [{ key, label, status: filled|check|empty, count, step }], dropped, reason }
//   }
// If the AI fails or runs out of time the contact details found by plain pattern matching are kept and the
// status is 'partial': the student fills in the rest. Nothing is ever made up (normalize.js checks every value).
'use strict';
const { extractText } = require('./extract');
const { normalizeParsed } = require('./normalize');

const TIMEOUT_MS = 90000;
const MAX_TEXT = 24000;

let clientOverride = null;
function client() {
  if (clientOverride) return clientOverride;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 0 });
}

const SYSTEM = `You copy the contents of a resume into JSON. Copy text exactly as written in the resume.
Never add, guess, rewrite, summarise or improve anything. If something is not in the resume, use "" or [].
Dates: copy as "YYYY-MM", "YYYY" or "Present" (only the parts that are written).
Put each bullet point of a job in "bullets" as written. Anything that fits no field (hobbies, volunteering,
references, publications, extra notes) goes in "other" as written.
Return only this JSON object:
{
 "personal": { "fullName": "", "firstName": "", "lastName": "", "email": "", "phone": "", "city": "", "country": "", "linkedin": "", "github": "", "portfolio": "" },
 "title": "the job title written under the name, or empty",
 "summary": "the summary / objective / profile paragraph, or empty",
 "experience": [ { "company": "", "role": "", "location": "", "startDate": "", "endDate": "", "description": "", "bullets": [""] } ],
 "education": [ { "school": "", "degree": "", "field": "", "startDate": "", "endDate": "", "grade": "" } ],
 "skills": [""],
 "projects": [ { "name": "", "description": "", "bullets": [""], "technologies": [""], "url": "" } ],
 "certifications": [ { "name": "", "issuer": "", "date": "" } ],
 "languages": [ { "name": "", "level": "" } ],
 "achievements": [""],
 "other": [""]
}`;

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'IMPORT_TIMEOUT' })), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

async function aiParse(text, ms) {
  const c = client();
  if (!c) throw Object.assign(new Error('AI reading is not set up'), { code: 'IMPORT_NO_AI' });
  const completion = await withTimeout(c.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 6000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Resume:\n\n${text.slice(0, MAX_TEXT)}` }],
  }), ms);
  const content = completion && completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
  try { return JSON.parse(content || ''); } catch { throw Object.assign(new Error('AI reply was not valid JSON'), { code: 'IMPORT_BAD_JSON' }); }
}

// contact details by plain pattern matching: what survives when the AI can't help
function basics(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
  const phone = ((text.match(/(?:\+?\d[\d\s().-]{8,}\d)/) || [])[0] || '').trim();
  const linkedin = (text.match(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/[^\s,)]+/i) || [])[0] || '';
  const github = (text.match(/(?:https?:\/\/)?github\.com\/[^\s,)]+/i) || [])[0] || '';
  const nameLine = lines.slice(0, 3).find((l) => /^[\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*){1,3}$/u.test(l) && !/resume|curriculum|vitae|cv\b/i.test(l)) || '';
  const [firstName = '', ...rest] = nameLine.split(' ');
  return { personal: { firstName, lastName: rest.join(' '), email, phone, linkedin, github } };
}

const SECTIONS = [
  ['personal', 'contact details', 1], ['title', 'title', 1], ['summary', 'summary', 6], ['experience', 'experience', 3],
  ['education', 'education', 2], ['skills', 'skills', 7], ['projects', 'projects', 4], ['certifications', 'certifications', 5],
  ['languages', 'languages', 5], ['achievements', 'achievements', 5], ['other', 'other notes', 6],
];

function report(fields, dropped) {
  const f = fields;
  const pi = f.personalInfo;
  const info = {
    personal: { count: [pi.firstName, pi.email, pi.phone, pi.city].filter(Boolean).length, check: !(pi.firstName && (pi.email || pi.phone)) },
    title: { count: pi.title ? 1 : 0 },
    summary: { count: f.professionalSummary.summary ? 1 : 0 },
    experience: { count: f.workExperience.length, check: f.workExperience.some((w) => !(w.startDate || w.current) || !(w.company && w.position)) },
    education: { count: f.education.length, check: f.education.some((e) => !e.institution || !(e.startDate || e.endDate || e.current)) },
    skills: { count: f.skills.length },
    projects: { count: f.projects.length },
    certifications: { count: f.certifications.length },
    languages: { count: f.languages.length },
    achievements: { count: f.achievements.length },
    other: { count: f.otherNotes ? 1 : 0, check: !!f.otherNotes },
  };
  const sections = SECTIONS.map(([key, label, step]) => {
    const x = info[key];
    const status = x.count === 0 ? 'empty' : x.check ? 'check' : 'filled';
    return { key, label, step, count: x.count, status };
  });
  return { filled: sections.filter((x) => x.status !== 'empty').length, sections, dropped: dropped.length };
}

async function importResume({ buffer, fileName, timeoutMs = Number(process.env.RESUME_IMPORT_TIMEOUT_MS) || TIMEOUT_MS }) {
  const ex = await extractText(buffer, fileName);
  if (ex.kind === 'unsupported') {
    return { status: 'unsupported', message: 'this file type can\'t be read. please upload a PDF or a Word (.docx) file.' };
  }
  if (ex.kind === 'scan') {
    return { status: 'scan', message: 'this file looks like a scan, please type your details or upload a text PDF.' };
  }
  if (ex.kind === 'empty') {
    return { status: 'unreadable', message: 'we couldn\'t find any text in this file. please upload a text PDF or a Word (.docx) file, or type your details.' };
  }

  let raw;
  let reason = null;
  try {
    raw = await aiParse(ex.text, timeoutMs);
  } catch (e) {
    reason = e.code === 'IMPORT_TIMEOUT' ? 'timeout' : e.code === 'IMPORT_NO_AI' ? 'no_ai' : 'ai_error';
    console.warn(`[resume import] AI parse failed (${reason}): ${e.message}`);
    raw = basics(ex.text);
  }
  const { dropped, ...fields } = normalizeParsed(raw, ex.text);
  const rep = { ...report(fields, dropped), reason };
  const status = reason ? 'partial' : 'ok';
  const message = reason
    ? (reason === 'timeout' ? 'reading your resume took too long, so we only filled in your contact details. please check them and fill in the rest.'
      : 'we couldn\'t read all of your resume automatically, so we only filled in your contact details. please check them and fill in the rest.')
    : `we filled in ${rep.filled} section${rep.filled === 1 ? '' : 's'}, please check.`;
  return { status, message, fields, report: rep, pages: ex.pages };
}

module.exports = { importResume, _setClient: (c) => { clientOverride = c; }, SYSTEM };
