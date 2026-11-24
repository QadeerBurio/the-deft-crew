// utils/resumeRender.js — the resume renderer the app and the server share, byte for byte
// (app: app/src/utils/resumeRender.js, server: utils/resumeRender.js; tests in both repos check they are identical).
// The app prints the PDF from it (expo-print); the server renders the public resume page (P3d) with it, so the web page
// looks like the PDF. Pure: no imports, no I/O. Fonts are added by the caller as @font-face text (opts.fontCss).
//   renderResumeHTML(resume, templateId, customStyles?, _isPrinting?, opts?) -> full HTML document
//   TEMPLATES (the five), LIBRARY (P3c templates as config), templateOf(id), canonicalTemplate(id), customise()
//   PALETTES, FONT_PAIRS, SIZES, DENSITY, MARGINS, HEADING_STYLES, SECTION_KEYS, MODEL_DEFAULT_COLOURS
// One renderer, single-column ATS-friendly layouts: real text (no tables, no columns), A4 with page margins on every
// page, an entry never split across two pages. Every optional theme key renders nothing when absent, so the five
// older looks render exactly as before (app tests/app/resume-templates.test.js: 395 frozen outputs).
//   theme keys (all optional): accent / heading / text (default colours), second (headings in a second colour),
//   band (the header on a colour band), nameAccent, h2x ("bar-left" | "caps-spaced" | "thin-rule" | "smallcaps-rule"
//   | "underline-accent" | "short-rule"), dateAccent, subPlain, margin ("12mm 13mm"), order (section order), headings ({ key: title }),
//   skillSep (" · "), h2ls (heading letter-spacing for the "plain" style)
'use strict';

// ---------- customisation data (P3-6): 12 palettes (text contrast >= 4.5:1 on white), 8 OFL font pairs ----------
const PALETTES = Object.freeze([
  { id: 'navy', name: 'Navy', accent: '#1E3A8A', heading: '#0F172A', text: '#334155' },
  { id: 'ink', name: 'Ink', accent: '#111111', heading: '#111111', text: '#222222' },
  { id: 'teal', name: 'Teal', accent: '#0F766E', heading: '#0F172A', text: '#1F2937' },
  { id: 'forest', name: 'Forest', accent: '#15803D', heading: '#0F172A', text: '#1F2937' },
  { id: 'ocean', name: 'Ocean', accent: '#0369A1', heading: '#0C1A2B', text: '#1E293B' },
  { id: 'royal', name: 'Royal', accent: '#2563EB', heading: '#0F172A', text: '#1E293B' },
  { id: 'plum', name: 'Plum', accent: '#6D28D9', heading: '#111827', text: '#1F2937' },
  { id: 'berry', name: 'Berry', accent: '#BE185D', heading: '#111827', text: '#1F2937' },
  { id: 'burgundy', name: 'Burgundy', accent: '#7F1D1D', heading: '#111111', text: '#222222' },
  { id: 'rust', name: 'Rust', accent: '#C2410C', heading: '#111827', text: '#1F2937' },
  { id: 'olive', name: 'Olive', accent: '#4D7C0F', heading: '#1A2E05', text: '#1F2937' },
  { id: 'slate', name: 'Slate', accent: '#475569', heading: '#0F172A', text: '#334155' },
]);

const FALLBACK_SANS = "'Helvetica Neue', Helvetica, Arial, 'Noto Sans', 'Noto Naskh Arabic', sans-serif";
const FALLBACK_SERIF = "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Naskh Arabic', serif";
const stack = (family, serif) => `'${family}', ${serif ? FALLBACK_SERIF : FALLBACK_SANS}`;

const FONT_PAIRS = Object.freeze([
  { id: 'inter', name: 'Inter', head: stack('Inter'), body: stack('Inter') },
  { id: 'lora_source', name: 'Lora + Source Sans', head: stack('Lora', true), body: stack('Source Sans 3') },
  { id: 'merriweather_lato', name: 'Merriweather + Lato', head: stack('Merriweather', true), body: stack('Lato') },
  { id: 'dmserif_dmsans', name: 'DM Serif + DM Sans', head: stack('DM Serif Display', true), body: stack('DM Sans') },
  { id: 'poppins_opensans', name: 'Poppins + Open Sans', head: stack('Poppins'), body: stack('Open Sans') },
  { id: 'plex', name: 'IBM Plex Serif + Sans', head: stack('IBM Plex Serif', true), body: stack('IBM Plex Sans') },
  { id: 'bitter_roboto', name: 'Bitter + Roboto', head: stack('Bitter', true), body: stack('Roboto') },
  { id: 'noto', name: 'Noto Sans (+ Urdu script)', head: stack('Noto Sans'), body: stack('Noto Sans') },
]);

const SIZES = Object.freeze({ S: -0.5, M: 0, L: 0.5 });
const DENSITY = Object.freeze({ compact: { gap: 0.75, line: 0.95 }, normal: { gap: 1, line: 1 }, airy: { gap: 1.3, line: 1.06 } });
const MARGINS = Object.freeze({ narrow: '10mm 11mm', wide: '18mm 19mm' });
const HEADING_STYLES = Object.freeze({ rule: 'thin-rule', bar: 'bar-left', underline: 'underline-accent', none: 'none' });
const SECTION_KEYS = Object.freeze(['summary', 'experience', 'education', 'projects', 'activities', 'volunteering', 'skills', 'awards', 'certifications', 'languages', 'achievements']);
const MODEL_DEFAULT_COLOURS = Object.freeze({ accentColor: '#1E3A8A', headingColor: '#0F172A', textColor: '#334155' });

// ---------- the P3c library: templates as config (layout + theme) ----------
const DM = "'DM Sans', 'Helvetica Neue', Helvetica, Arial, 'Noto Sans', 'Noto Naskh Arabic', sans-serif";
const OUTFIT = "'Outfit', 'DM Sans', 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Naskh Arabic', sans-serif";
const LIB_SERIF = "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Naskh Arabic', serif";
// a little tighter than the five (10 pt, 1.35): a typical fresher fits on one A4 page by default (plan P3-6 §4)
const BASE = { body: DM, head: DM, size: 10, line: 1.35, nameSize: 22, align: 'left', h2: 'plain', gap: 8 };

// a student leads with education, projects and activities; experience (optional) last
const FRESHER_ORDER = ['education', 'projects', 'activities', 'volunteering', 'skills', 'awards', 'certifications', 'languages', 'experience'];

// ats: what the ATS test (app tests/app/resume-ats.test.js) finds on the real PDF ('safe' | 'design')
const LIBRARY = [
  // ---------- Fresher & Student ----------
  {
    id: 'campus', name: 'Campus', collection: 'fresher', ats: 'safe', description: 'a colour band for your name, clean sections',
    look: { ...BASE, head: OUTFIT, band: true, h2x: 'caps-spaced', accent: '#0F766E', heading: '#0F172A', text: '#1F2937', order: FRESHER_ORDER, skillSep: ' · ' },
  },
  {
    id: 'first_step', name: 'First Step', collection: 'fresher', ats: 'safe', description: 'centred and calm, serif headings',
    look: { ...BASE, head: LIB_SERIF, nameSize: 24, align: 'center', h2: 'full-rule', accent: '#1E3A8A', heading: '#111827', text: '#1F2937', order: FRESHER_ORDER },
  },
  {
    id: 'fresh_start', name: 'Fresh Start', collection: 'fresher', ats: 'safe', description: 'bold name, a coloured bar on each heading',
    look: { ...BASE, head: OUTFIT, nameSize: 25, h2x: 'bar-left', accent: '#C2410C', heading: '#111827', text: '#1F2937', order: FRESHER_ORDER, nameAccent: false },
  },
  {
    id: 'society_leader', name: 'Society Leader', collection: 'fresher', ats: 'safe', description: 'leadership and activities right after education',
    look: { ...BASE, head: OUTFIT, nameAccent: true, h2x: 'underline-accent', accent: '#6D28D9', heading: '#111827', text: '#1F2937',
      order: ['education', 'activities', 'volunteering', 'projects', 'skills', 'awards', 'certifications', 'languages', 'experience'] },
  },
  {
    id: 'project_first', name: 'Project First', collection: 'fresher', ats: 'safe', description: 'projects on top, for builders and makers',
    look: { ...BASE, h2x: 'thin-rule', dateAccent: true, accent: '#2563EB', heading: '#0F172A', text: '#1E293B', skillSep: ' · ',
      order: ['projects', 'education', 'skills', 'activities', 'volunteering', 'awards', 'certifications', 'languages', 'experience'] },
  },
  {
    id: 'internship_ready', name: 'Internship Ready', collection: 'fresher', ats: 'safe', description: 'compact, education and skills up front',
    look: { ...BASE, size: 9.5, line: 1.3, nameSize: 20, gap: 7, margin: '12mm 13mm', h2: 'accent-rule', accent: '#15803D', heading: '#0F172A', text: '#1F2937', subPlain: true,
      order: ['education', 'skills', 'projects', 'activities', 'volunteering', 'experience', 'awards', 'certifications', 'languages'] },
  },
  {
    id: 'scholar', name: 'Scholar', collection: 'fresher', ats: 'safe', description: 'academic: education, awards and research first',
    // owner: distinct from Harvard: a short burgundy line under letter-spaced headings, the name in burgundy
    look: { ...BASE, body: LIB_SERIF, head: LIB_SERIF, nameSize: 22, align: 'center', h2x: 'short-rule', nameAccent: true, accent: '#7F1D1D', heading: '#111111', text: '#222222',
      order: ['education', 'awards', 'projects', 'activities', 'volunteering', 'skills', 'languages', 'certifications', 'experience'],
      headings: { projects: 'Research & Projects', awards: 'Honours & Awards' } },
  },
  // ---------- ATS Pro ----------
  {
    id: 'harvard', name: 'Harvard', collection: 'ats', ats: 'safe', description: 'the classic: serif, centred, ruled headings',
    look: { ...BASE, body: LIB_SERIF, head: LIB_SERIF, size: 10, line: 1.32, nameSize: 20, align: 'center', h2x: 'smallcaps-rule', accent: '#111111', heading: '#111111', text: '#111111', subPlain: false },
  },
  {
    id: 'clean_line', name: 'Clean Line', collection: 'ats', ats: 'safe', description: 'minimal sans, thin lines, lots of air',
    look: { ...BASE, line: 1.36, gap: 8, nameSize: 22, h2x: 'thin-rule', accent: '#0F172A', heading: '#0F172A', text: '#334155', second: '#94A3B8', subPlain: true },
  },
  {
    id: 'two_tone', name: 'Two-tone', collection: 'ats', ats: 'safe', description: 'name and headings in two calm colours',
    look: { ...BASE, head: OUTFIT, nameAccent: true, second: '#0E7490', h2x: 'thin-rule', accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', dateAccent: true },
  },
];

// ---------- the renderer ----------
const TEMPLATES = [
  { id: 'modern_ats', name: 'Modern', description: 'clean sans-serif, coloured headings' },
  { id: 'stanford', name: 'Classic', description: 'serif, centred name, ruled headings' },
  { id: 'jakes', name: 'Compact', description: 'tight spacing, fits more on one page' },
  { id: 'rezi', name: 'Minimal', description: 'black and white, no colour at all' },
  { id: 'faang', name: 'Executive', description: 'serif headings, bold name bar' },
];

const LEGACY = { modern: 'modern_ats', classic: 'stanford', creative: 'modern_ats', canva: 'modern_ats', flowcv: 'modern_ats', reactive: 'jakes', minimal: 'rezi', professional: 'faang' };
const canonicalTemplate = (id) => (TEMPLATES.some((t) => t.id === id) ? id : LEGACY[id] || 'modern_ats');
// the template for an id: a library template (P3c) by its own id, else one of the five (old ids map as before)
const templateOf = (id) => {
  const t = LIBRARY.find((x) => x.id === id);
  if (t) return { id: t.id, look: t.look };
  const c = canonicalTemplate(id);
  return { id: c, look: LOOKS[c] };
};

const SANS = "'Helvetica Neue', Helvetica, Arial, 'Noto Sans', 'Noto Naskh Arabic', sans-serif";
const SERIF = "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Naskh Arabic', serif";

// the five looks: only type, size, colour and heading style differ
const LOOKS = {
  modern_ats: { body: SANS, head: SANS, size: 10.5, line: 1.4, nameSize: 22, align: 'left', h2: 'accent-rule', gap: 10 },
  stanford: { body: SERIF, head: SERIF, size: 10.5, line: 1.38, nameSize: 22, align: 'center', h2: 'full-rule', gap: 10 },
  jakes: { body: SANS, head: SANS, size: 9.5, line: 1.3, nameSize: 19, align: 'center', h2: 'full-rule', gap: 7 },
  // h2ls: heading letter-spacing (owner OK, P3c): 0.08em came out of the PDF as "E D U C A T I O N"; 0.05em reads as one word
  rezi: { body: SANS, head: SANS, size: 10.5, line: 1.4, nameSize: 21, align: 'left', h2: 'plain', gap: 10, mono: true, h2ls: '0.05em' },
  faang: { body: SANS, head: SERIF, size: 10.5, line: 1.4, nameSize: 23, align: 'left', h2: 'accent-rule', gap: 10, nameBar: true },
};

const getDisplayLocation = (resume) => {
  if (!resume) return '';
  const pi = resume.personalInfo || {};
  if (typeof pi.location === 'string' && pi.location.trim()) return pi.location.trim();
  const parts = [pi.city, pi.state, pi.country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  if (typeof resume.targetJob?.location === 'string' && resume.targetJob.location.trim()) return resume.targetJob.location.trim();
  return '';
};

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v : []);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO dates from the server -> "Jun 2023"; what the student typed ("Jun 2023", "2021") stays as typed
const formatDate = (d) => {
  const t = str(d);
  if (!t) return '';
  const m = t.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T.*)?$/);
  if (m) return t.length > 7 && m[2] === '01' && m[3] === '01' && /T00:00:00/.test(t) ? m[1] : `${MONTHS[+m[2] - 1] || ''} ${m[1]}`.trim();
  return t;
};
const formatDateRange = (start, end, current) => {
  const a = formatDate(start);
  const b = current ? 'Present' : formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a || b || '';
};

const link = (u) => {
  const t = str(u);
  if (!t) return '';
  const href = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return `<a href="${esc(href)}">${esc(t.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a>`;
};

// P3-6 customisation: dates as 01/2026, links as short labels (the defaults above are unchanged)
const BASE_HELPERS = { formatDate, formatDateRange, link };
const formatDateMM = (d) => {
  const t = str(d);
  const m = t.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T.*)?$/);
  if (!m) return t;
  return t.length > 7 && m[2] === '01' && m[3] === '01' && /T00:00:00/.test(t) ? m[1] : `${m[2]}/${m[1]}`;
};
const SHORT_LABEL = [[/linkedin\.com/i, 'LinkedIn'], [/github\.com/i, 'GitHub'], [/behance\.net/i, 'Behance'], [/dribbble\.com/i, 'Dribbble']];
const shortLink = (u) => {
  const t = str(u);
  if (!t) return '';
  const href = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const label = (SHORT_LABEL.find(([re]) => re.test(t)) || [null, 'Portfolio'])[1];
  return `<a href="${esc(href)}">${label}</a>`;
};
// hidden sections: a copy of the resume without them (the section code stays the same)
const HIDE = { summary: (r) => ({ ...r, professionalSummary: { ...(r.professionalSummary || {}), summary: '' } }), experience: (r) => ({ ...r, workExperience: [] }), education: (r) => ({ ...r, education: [], coursework: [] }), projects: (r) => ({ ...r, projects: [] }), skills: (r) => ({ ...r, skills: [] }), certifications: (r) => ({ ...r, certifications: [] }), languages: (r) => ({ ...r, languages: [] }), activities: (r) => ({ ...r, activities: [] }), volunteering: (r) => ({ ...r, volunteering: [] }), awards: (r) => ({ ...r, awards: [] }), achievements: (r) => ({ ...r, achievements: [] }) };

// a description: lines starting with -, • or * become bullets, other lines stay paragraphs
const lines = (text, extra = []) => {
  const all = [...str(text).split(/\n+/), ...list(extra)].map(str).filter(Boolean);
  const bullets = [];
  const paras = [];
  for (const l of all) {
    if (/^[-•*▪◦]\s*/.test(l) || extra.includes(l)) bullets.push(l.replace(/^[-•*▪◦]\s*/, ''));
    else paras.push(l);
  }
  return paras.map((p) => `<p dir="auto">${esc(p)}</p>`).join('') + (bullets.length ? `<ul>${bullets.map((b) => `<li dir="auto">${esc(b)}</li>`).join('')}</ul>` : '');
};

const entry = (title, sub, date, body) => `
  <div class="entry">
    <div class="row"><span class="t" dir="auto">${title}</span>${date ? `<span class="d">${esc(date)}</span>` : ''}</div>
    ${sub ? `<div class="sub" dir="auto">${sub}</div>` : ''}
    ${body || ''}
  </div>`;

const section = (title, inner) => (inner ? `<section><h2>${esc(title)}</h2>${inner}</section>` : '');

function body(resume, look = {}) {
  let r = resume || {};
  for (const k of look.hidden || []) if (HIDE[k]) r = HIDE[k](r);
  if (look.sectionOrder && !Array.isArray(r.sectionOrder)) r = { ...r, sectionOrder: look.sectionOrder };
  const formatDate = look.dateFormat === 'mm/yyyy' ? formatDateMM : BASE_HELPERS.formatDate;
  const formatDateRange = look.dateFormat === 'mm/yyyy' ? (a0, b0, cur) => { const a = formatDate(a0); const b = cur ? 'Present' : formatDate(b0); return a && b ? `${a} – ${b}` : a || b || ''; } : BASE_HELPERS.formatDateRange;
  const link = look.linkStyle === 'short' ? shortLink : BASE_HELPERS.link;
  const H = (k, d) => (look.headings && look.headings[k]) || d;
  const pi = r.personalInfo || {};
  const name = [str(pi.firstName), str(pi.lastName)].filter(Boolean).join(' ');
  const title = str(pi.title) || str(r.professionalSummary?.title);
  const contact = [esc(getDisplayLocation(r)), esc(str(pi.phone)), str(pi.email) ? `<a href="mailto:${esc(str(pi.email))}">${esc(str(pi.email))}</a>` : '', link(pi.linkedin), link(pi.github), link(pi.portfolio)].filter(Boolean);

  const work = list(r.workExperience).filter((w) => w && (str(w.company) || str(w.position))).map((w) => entry(
    esc(str(w.position) || str(w.company)),
    esc([str(w.position) ? str(w.company) : '', str(w.location)].filter(Boolean).join(' · ')),
    formatDateRange(w.startDate, w.endDate, w.current),
    lines(w.description, list(w.achievements)),
  )).join('');

  const edu = list(r.education).filter((e) => e && (str(e.institution) || str(e.degree))).map((e) => {
    const degree = [str(e.degree), str(e.fieldOfStudy)].filter(Boolean).join(', ');
    const grade = str(e.grade) || (e.gpa ? `GPA ${e.gpa}` : '');
    return entry(esc(str(e.institution) || degree), esc([str(e.institution) ? degree : '', grade].filter(Boolean).join(' · ')), formatDateRange(e.startDate, e.endDate, e.current), lines(e.description));
  }).join('');

  const projects = list(r.projects).filter((p) => p && str(p.name)).map((p) => entry(
    esc(str(p.name)) + (str(p.url) ? ` · ${link(p.url)}` : '') + (str(p.githubUrl) ? ` · ${link(p.githubUrl)}` : ''),
    esc(list(p.technologies).map(str).filter(Boolean).join(', ')),
    formatDateRange(p.startDate, p.endDate, false),
    lines(p.description),
  )).join('');

  const skills = list(r.skills).map((s) => str(typeof s === 'string' ? s : s?.name)).filter(Boolean);
  const certs = list(r.certifications).filter((c) => c && str(c.name)).map((c) => entry(esc(str(c.name)), esc(str(c.organization)), formatDate(c.issueDate), str(c.credentialUrl) ? `<p>${link(c.credentialUrl)}</p>` : '')).join('');
  const langs = list(r.languages).filter((l) => l && str(l.name)).map((l) => esc(str(l.name)) + (str(l.proficiency) ? ` (${esc(str(l.proficiency))})` : ''));
  const achievements = list(r.achievements).map(str).filter(Boolean);
  // P3-3: societies / clubs / leadership and volunteering (same shape), awards, relevant coursework
  const roleEntries = (items) => list(items).filter((a) => a && (str(a.organisation) || str(a.role))).map((a) => entry(
    esc(str(a.role) || str(a.organisation)),
    esc(str(a.role) ? str(a.organisation) : ''),
    formatDateRange(a.startDate, a.endDate, a.current),
    lines(a.description, list(a.bullets)),
  )).join('');
  const activities = roleEntries(r.activities);
  const volunteering = roleEntries(r.volunteering);
  const awards = list(r.awards).filter((a) => a && str(a.title)).map((a) => entry(esc(str(a.title)), esc(str(a.issuer)), formatDate(a.date), str(a.note) ? `<p dir="auto">${esc(str(a.note))}</p>` : '')).join('');
  const coursework = list(r.coursework).map(str).filter(Boolean);
  const eduWithCourses = edu + (coursework.length ? `<p class="coursework" dir="auto">Relevant coursework: ${coursework.map(esc).join(', ')}</p>` : '');
  const summary = str(r.professionalSummary?.summary);

  const workFirst = work.length > 0;
  return `
  <header>${look.photoUrl ? `<img class="photo" src="${esc(look.photoUrl)}" alt="">` : ''}
    <h1 dir="auto">${esc(name || 'Your name')}</h1>
    ${title ? `<div class="title" dir="auto">${esc(title)}</div>` : ''}
    ${contact.length ? `<div class="contact">${contact.join('<span class="sep"> | </span>')}</div>` : ''}
  </header>
  ${section(H('summary', 'Summary'), summary ? `<p dir="auto">${esc(summary)}</p>` : '')}
  ${ordered(r, workFirst, {
    experience: section(H('experience', 'Experience'), work),
    education: section(H('education', 'Education'), eduWithCourses),
    projects: section(H('projects', 'Projects'), projects),
    skills: section(H('skills', 'Skills'), skills.length ? `<p class="skills" dir="auto">${skills.map(esc).join(look.skillSep || ', ')}</p>` : ''),
    certifications: section(H('certifications', 'Certifications'), certs),
    languages: section(H('languages', 'Languages'), langs.length ? `<p dir="auto">${langs.join(', ')}</p>` : ''),
    activities: section(H('activities', 'Leadership & Activities'), activities),
    volunteering: section(H('volunteering', 'Volunteering'), volunteering),
    awards: section(H('awards', 'Awards'), awards),
  }, look.order)}
  ${section(H('achievements', 'Achievements'), achievements.length ? `<ul>${achievements.map((a) => `<li dir="auto">${esc(a)}</li>`).join('')}</ul>` : '')}
  ${section('Additional information', str(r.otherNotes) ? lines(r.otherNotes) : '')}`;
}

// the sections in the order a tailored version chose (sectionOrder), else experience first when there is some
function ordered(r, workFirst, html, themeOrder) {
  const chosen = Array.isArray(r.sectionOrder) ? r.sectionOrder.filter((k) => k in html) : [];
  // P3-3: the fresher track leads with what a student has; experience (optional) goes last. The new sections are
  // empty strings on every older resume, so their order there changes nothing.
  const fresher = r.settings?.track === 'fresher';
  const fallback = Array.isArray(themeOrder) ? themeOrder : fresher
    ? ['education', 'projects', 'activities', 'volunteering', 'skills', 'awards', 'certifications', 'languages', 'experience']
    : [...(workFirst ? ['experience', 'education', 'projects', 'skills', 'certifications', 'languages'] : ['education', 'experience', 'projects', 'skills', 'certifications', 'languages']), 'activities', 'volunteering', 'awards'];
  const order = [...chosen, ...fallback.filter((k) => !chosen.includes(k))];
  return order.map((k) => html[k]).join('');
}

function css(look, styles) {
  const accent = look.mono ? '#111111' : str(styles.accentColor) || look.accent || '#1E3A8A';
  const heading = look.mono ? '#111111' : str(styles.headingColor) || look.heading || '#0F172A';
  const text = look.mono ? '#222222' : str(styles.textColor) || look.text || '#334155';
  const h2 = {
    'accent-rule': `color:${accent}; border-bottom: 1.5px solid ${accent}; padding-bottom: 2px;`,
    'full-rule': `color:${heading}; border-bottom: 1px solid ${heading}; padding-bottom: 1px; font-variant: small-caps; letter-spacing: 0.04em;`,
    plain: `color:${heading}; letter-spacing: ${look.h2ls || '0.08em'};`,
  }[look.h2];
  return `
  @page { size: A4; margin: 14mm 15mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: ${look.body}; font-size: ${look.size}pt; line-height: ${look.line}; color: ${text}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { background: #ffffff; }
  header { text-align: ${look.align}; margin-bottom: ${look.gap}px; ${look.nameBar ? `border-bottom: 3px solid ${accent}; padding-bottom: 6px;` : ''} }
  h1 { font-family: ${look.head}; font-size: ${look.nameSize}pt; line-height: 1.15; margin: 0; color: ${heading}; font-weight: 700; }
  .title { font-size: ${look.size + 1.5}pt; color: ${look.mono ? heading : accent}; margin-top: 2px; font-weight: 600; }
  .contact { margin-top: 4px; font-size: ${look.size - 0.5}pt; }
  .contact a, .entry a { color: ${text}; text-decoration: none; }
  .sep { opacity: 0.6; }
  section { margin-top: ${look.gap}px; }
  h2 { font-family: ${look.head}; font-size: ${look.size + 1.5}pt; text-transform: uppercase; margin: 0 0 ${Math.round(look.gap / 2)}px; font-weight: 700; ${h2} break-after: avoid; page-break-after: avoid; }
  .entry { margin-bottom: ${Math.round(look.gap * 0.7)}px; break-inside: avoid; page-break-inside: avoid; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .t { font-weight: 700; color: ${heading}; }
  .d { white-space: nowrap; font-size: ${look.size - 0.5}pt; }
  .sub { font-style: italic; }
  p { margin: 2px 0; }
  ul { margin: 2px 0 0; padding-left: 16px; }
  li { margin: 1px 0; break-inside: avoid; page-break-inside: avoid; }
  section > p, section > ul { break-inside: avoid; page-break-inside: avoid; }
  [dir="auto"] { unicode-bidi: plaintext; }${extras(look, { accent, heading, text })}
  @media screen {
    html { background: #525659; }
    body { padding: 16px 0; }
    .page { width: 794px; min-height: 1123px; margin: 0 auto; padding: 53px 57px; box-shadow: 0 6px 30px rgba(0,0,0,0.45); }
  }`;
}

// P3c: the theme's extra rules ('' for the five looks, so their CSS is unchanged)
function extras(look, { accent, heading, text }) {
  const out = [];
  const second = look.second || heading;
  if (look.margin) out.push(`@page { margin: ${look.margin}; }`);
  if (look.band) out.push(`header { background: ${accent}; color: #ffffff; padding: 14px 16px 12px; border-radius: 6px; }`, 'header h1, header .title, header .contact, header .contact a { color: #ffffff; }', 'header .sep { opacity: 0.8; }');
  if (look.nameAccent && !look.band) out.push(`h1 { color: ${accent}; }`);
  if (look.second) out.push(`h2 { color: ${second}; }`);
  // heading letter-spacing stays small (≤ 0.06em): wider spacing comes out of the PDF as "E D U C A T I O N", which
  // job portals can't read (tests/app/resume-ats.test.js)
  const h2x = {
    'bar-left': `h2 { border-bottom: none; border-left: 4px solid ${accent}; padding: 0 0 0 8px; letter-spacing: 0.02em; }`,
    'caps-spaced': `h2 { border-bottom: none; color: ${accent}; letter-spacing: 0.05em; font-size: ${look.size + 0.5}pt; }`,
    'thin-rule': `h2 { border-bottom: 0.75px solid ${look.second || '#CBD5E1'}; padding-bottom: 2px; letter-spacing: 0.02em; }`,
    'smallcaps-rule': `h2 { text-transform: none; font-variant: small-caps; letter-spacing: 0.06em; color: ${heading}; border-bottom: 1px solid ${heading}; padding-bottom: 1px; font-size: ${look.size + 2}pt; }`,
    'underline-accent': `h2 { display: inline-block; border-bottom: 2.5px solid ${accent}; padding-bottom: 1px; letter-spacing: 0.02em; }`,
    // a short accent line under the heading (no full-width rule): Scholar
    'short-rule': `h2 { border-bottom: none; color: ${accent}; letter-spacing: 0.06em; font-size: ${look.size + 0.5}pt; } h2::after { content: ''; display: block; width: 36px; border-bottom: 2px solid ${accent}; margin-top: 3px; }`,
  }[look.h2x];
  if (h2x) out.push(h2x);
  if (look.h2x === 'none') out.push('h2 { border: none; padding: 0; letter-spacing: 0.02em; }');
  if (look.h2case === 'title') out.push('h2 { text-transform: none; letter-spacing: 0.01em; }');
  if (look.pageSize === 'Letter') out.push('@page { size: Letter; }');
  if (look.photoUrl) out.push(`header .photo { float: right; width: 72px; height: 72px; object-fit: cover; margin: 0 0 6px 12px; border-radius: ${{ circle: '50%', rounded: '10px', square: '0' }[look.photoShape] || '50%'}; }`);
  if (look.dateAccent) out.push(`.d { color: ${accent}; font-weight: 600; }`);
  if (look.subPlain) out.push(`.sub { font-style: normal; color: ${text}; opacity: 0.85; }`);
  return out.length ? `\n  ${out.join('\n  ')}` : '';
}

/**
 * The student's customisation (P3-6) on top of the template's theme. With none of the studio's keys, the theme comes
 * back unchanged (the five render exactly as before). Library templates read the model's default colours as "not
 * chosen", so their own colours show.
 */
function customise(look, styles = {}, { library = false, resume } = {}) {
  const st = styles || {};
  const keys = ['palette', 'fontPair', 'size', 'density', 'margins', 'headingCase', 'headingStyle', 'sectionOrder', 'hiddenSections', 'headings', 'photo', 'dateFormat', 'pageSize', 'linkStyle'];
  const colours = { ...st };
  if (library) for (const [k, v] of Object.entries(MODEL_DEFAULT_COLOURS)) if (str(colours[k]).toUpperCase() === v) delete colours[k];
  const pal = PALETTES.find((x) => x.id === st.palette);
  if (pal) { delete colours.accentColor; delete colours.headingColor; delete colours.textColor; }
  if (!keys.some((k) => st[k] !== undefined && st[k] !== null) && !library) return { look, styles: st };
  const l = { ...look };
  if (pal) Object.assign(l, { accent: pal.accent, heading: pal.heading, text: pal.text });
  const fp = FONT_PAIRS.find((x) => x.id === st.fontPair);
  if (fp) Object.assign(l, { body: fp.body, head: fp.head, fontPair: fp.id });
  if (SIZES[st.size]) { l.size = look.size + SIZES[st.size]; l.nameSize = look.nameSize + SIZES[st.size] * 2; }
  if (DENSITY[st.density] && st.density !== 'normal') { l.gap = Math.round(look.gap * DENSITY[st.density].gap); l.line = Math.round(look.line * DENSITY[st.density].line * 100) / 100; }
  if (MARGINS[st.margins]) l.margin = MARGINS[st.margins];
  if (st.headingCase === 'title') l.h2case = 'title';
  if (HEADING_STYLES[st.headingStyle]) l.h2x = HEADING_STYLES[st.headingStyle];
  if (Array.isArray(st.hiddenSections) && st.hiddenSections.length) l.hidden = st.hiddenSections;
  if (Array.isArray(st.sectionOrder) && st.sectionOrder.length) l.sectionOrder = st.sectionOrder;
  if (st.headings && typeof st.headings === 'object') l.headings = { ...(look.headings || {}), ...st.headings };
  const photo = str(resume?.personalInfo?.photoUrl);
  if (st.photo && st.photo.on && /^https:\/\//i.test(photo)) { l.photoUrl = photo; l.photoShape = st.photo.shape; }
  if (st.dateFormat === 'mm/yyyy') l.dateFormat = 'mm/yyyy';
  if (st.pageSize === 'Letter') l.pageSize = 'Letter';
  if (st.linkStyle === 'short') l.linkStyle = 'short';
  return { look: l, styles: colours };
}

const renderResumeHTML = (resume, templateId, customStyles = {}, _isPrinting = false, opts = {}) => {
  const base = templateOf(templateId);
  const library = LIBRARY.some((t) => t.id === base.id);
  const chosen = customStyles || resume?.customStyles || {};
  const { look, styles: cleanStyles } = customise(base.look, chosen, { library, resume });
  const id = base.id;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=794">
<title>${esc([str(resume?.personalInfo?.firstName), str(resume?.personalInfo?.lastName)].filter(Boolean).join(' ') || 'Resume')} Resume</title>
<style>${opts.fontCss || ''}${css(look, library || look !== base.look ? cleanStyles : customStyles || resume?.customStyles || {})}</style>
</head>
<body data-template="${id}"><main class="page">${body(resume, look)}</main></body>
</html>`;
};

module.exports = {
  PALETTES, FONT_PAIRS, SIZES, DENSITY, MARGINS, HEADING_STYLES, SECTION_KEYS, MODEL_DEFAULT_COLOURS,
  LIBRARY, TEMPLATES, canonicalTemplate, templateOf, getDisplayLocation, formatDate, formatDateRange, customise, renderResumeHTML,
};
