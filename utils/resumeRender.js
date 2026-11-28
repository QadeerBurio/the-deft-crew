// utils/resumeRender.js — the resume renderer the app and the server share, byte for byte
// (app: app/src/utils/resumeRender.js, server: utils/resumeRender.js; tests in both repos check they are identical).
// The app prints the PDF from it (expo-print); the server renders the public resume page (P3d) with it, so the web page
// looks like the PDF. Pure: no imports, no I/O. Fonts are added by the caller as @font-face text (opts.fontCss).
//   renderResumeHTML(resume, templateId, customStyles?, _isPrinting?, opts?) -> full HTML document
//     opts: { fontCss: "@font-face …", verified: [{ text, url? }] (P3d "verified by tdc" line) }
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
// an experienced resume leads with work
const EXP_ORDER = ['experience', 'projects', 'education', 'skills', 'certifications', 'awards', 'activities', 'volunteering', 'languages'];
// two columns (resume full fix): the side panel holds skills, languages, certificates and awards; everything else in the
// main column. The HTML is in the order the page is read (left column first), so text comes out of the PDF in order.
const TWO = { layout: 'two-col', side: ['skills', 'languages', 'certifications', 'awards'], sidePos: 'left', size: 9.8, line: 1.33, nameSize: 22, gap: 8 };
// rows: [id, name, description, look (on top of BASE), fit (what "recommended for you" reads: fields, level, roles)]
// ats: two columns start as 'design' and only earn 'safe' when the PDF test reads them in order (ATS_SAFE_TWO_COL)
const ATS_SAFE_TWO_COL = ['canvas']; // the PDF test (tests/app/resume-ats.test.js): pdftotext reads only this one in order
const lib = (collection, rows) => rows.map(([id, name, description, look, fit]) => ({
  id, name, collection, description,
  ats: look.layout === 'two-col' && !ATS_SAFE_TWO_COL.includes(id) ? 'design' : 'safe',
  approved: true, fit: fit || {},
  look: { ...BASE, ...look },
}));

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
    // line 1.32 (resume full fix): one page with the embedded fonts (tests/app/resume-templates-50.test.js)
    look: { ...BASE, line: 1.32, head: OUTFIT, nameAccent: true, h2x: 'underline-accent', accent: '#6D28D9', heading: '#111827', text: '#1F2937',
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
    look: { ...BASE, line: 1.32, gap: 8, nameSize: 22, h2x: 'thin-rule', accent: '#0F172A', heading: '#0F172A', text: '#334155', second: '#94A3B8', subPlain: true }, // line 1.36 → 1.32: one page with the embedded fonts
  },
  {
    id: 'two_tone', name: 'Two-tone', collection: 'ats', ats: 'safe', description: 'name and headings in two calm colours',
    look: { ...BASE, head: OUTFIT, nameAccent: true, second: '#0E7490', h2x: 'thin-rule', accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', dateAccent: true },
  },
  // ---------- resume full fix: 35 more (each one page by default; ats = what tests/app/resume-ats.test.js finds) ----------
  ...lib('ats', [
    ['ats_plain', 'ATS Plain', 'the plainest layout portals read: one column, black text', { body: stack('Roboto'), head: stack('Roboto'), h2: 'accent-rule', accent: '#111111', heading: '#111111', text: '#222222', order: EXP_ORDER }, { level: 'any' }],
  ]),
  ...lib('tech', [
    ['dev_stack', 'Dev Stack', 'projects and skills up top, for software roles', { body: stack('IBM Plex Sans'), head: stack('IBM Plex Sans'), h2x: 'thin-rule', dateAccent: true, accent: '#2563EB', heading: '#0F172A', text: '#1E293B', skillSep: ' · ', order: ['projects', 'skills', 'experience', 'education', 'activities', 'awards', 'certifications', 'volunteering', 'languages'] }, { fields: ['cs'], roles: 'developer|engineer|software|frontend|backend|mobile|web' }],
    ['code_clean', 'Code Clean', 'quiet sans, thin rules, built to scan', { body: stack('Inter'), head: stack('Inter'), line: 1.32, h2x: 'thin-rule', accent: '#0F172A', heading: '#0F172A', text: '#334155', second: '#475569', subPlain: true, order: EXP_ORDER }, { fields: ['cs'], level: 'experienced' }],
    ['data_lens', 'Data Lens', 'skills first, teal headings, for data and analytics', { body: stack('Source Sans 3'), head: stack('Source Sans 3'), h2x: 'underline-accent', accent: '#0F766E', heading: '#0F172A', text: '#1F2937', skillSep: ' · ', order: ['skills', 'projects', 'experience', 'education', 'certifications', 'activities', 'awards', 'volunteering', 'languages'] }, { fields: ['cs', 'business'], roles: 'data|analyst|analytics|bi|machine learning|ai' }],
    ['cloud_side', 'Cloud Side', 'two columns: skills and tools in a side panel', { ...TWO, body: stack('Inter'), head: stack('Inter'), accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', sideTint: '#EEF2FF' }, { fields: ['cs'] }],
  ]),
  ...lib('business', [
    ['banker', 'Banker', 'serif, small capitals, the look banks expect', { body: LIB_SERIF, head: LIB_SERIF, size: 10, line: 1.32, nameSize: 21, align: 'center', h2x: 'smallcaps-rule', accent: '#111111', heading: '#111111', text: '#1A1A1A', order: EXP_ORDER }, { fields: ['business'], roles: 'bank|finance|investment|account|audit' }],
    ['analyst', 'Analyst', 'navy headings, numbers easy to find', { body: stack('Lato'), head: stack('Merriweather', true), h2x: 'thin-rule', dateAccent: true, accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', order: EXP_ORDER }, { fields: ['business'], roles: 'analyst|finance|consult|strategy' }],
    ['consulting', 'Consulting', 'serif headings with a burgundy rule', { body: stack('Source Sans 3'), head: stack('Lora', true), h2: 'accent-rule', accent: '#7F1D1D', heading: '#111111', text: '#222222' }, { fields: ['business'], level: 'experienced', roles: 'consult|manager|strategy' }],
    ['ledger', 'Ledger', 'two columns: numbers-first layout with a side panel', { ...TWO, sidePos: 'right', body: stack('Lato'), head: stack('Lato'), accent: '#475569', heading: '#0F172A', text: '#334155', sideTint: '#F1F5F9' }, { fields: ['business'] }],
  ]),
  ...lib('design', [
    ['portfolio', 'Portfolio', 'two columns, a coloured side panel and room for a photo', { ...TWO, body: stack('Open Sans'), head: stack('Poppins'), accent: '#6D28D9', heading: '#111827', text: '#1F2937', sideTint: '#F5F3FF', photoDefault: true }, { fields: ['design'], roles: 'design|ui|ux|graphic|creative|artist|illustrat' }],
    ['studio', 'Studio', 'a bold name and a coloured bar on each heading', { head: stack('Poppins'), body: stack('Open Sans'), nameSize: 26, h2x: 'bar-left', nameAccent: true, accent: '#C2410C', heading: '#111827', text: '#1F2937' }, { fields: ['design'] }],
    ['canvas', 'Canvas', 'two columns in berry, photo on by default', { ...TWO, body: stack('DM Sans'), head: stack('DM Serif Display', true), accent: '#BE185D', heading: '#111827', text: '#1F2937', sideTint: '#FDF2F8', photoDefault: true }, { fields: ['design'], level: 'fresher' }],
    ['gallery', 'Gallery', 'centred, spaced headings, calm teal', { head: OUTFIT, align: 'center', h2x: 'caps-spaced', accent: '#0F766E', heading: '#0F172A', text: '#1F2937', skillSep: ' · ' }, { fields: ['design'] }],
  ]),
  ...lib('engineering', [
    ['blueprint', 'Blueprint', 'royal blue rules, projects right after experience', { body: stack('Roboto'), head: stack('Roboto'), h2x: 'thin-rule', second: '#1D4ED8', accent: '#1D4ED8', heading: '#0F172A', text: '#1E293B', order: ['experience', 'projects', 'education', 'skills', 'certifications', 'awards', 'activities', 'volunteering', 'languages'] }, { fields: ['engineering', 'cs'], roles: 'engineer|mechanical|electrical|civil|chemical' }],
    ['mechanic', 'Workshop', 'compact and practical, green headings', { body: stack('Roboto'), head: stack('Bitter', true), size: 9.5, line: 1.3, gap: 7, h2: 'accent-rule', accent: '#15803D', heading: '#0F172A', text: '#1F2937' }, { fields: ['engineering'] }],
    ['circuit', 'Circuit', 'two columns: tools and certificates on the side', { ...TWO, body: stack('IBM Plex Sans'), head: stack('IBM Plex Sans'), accent: '#0369A1', heading: '#0C1A2B', text: '#1E293B', sideTint: '#F0F9FF' }, { fields: ['engineering', 'cs'] }],
  ]),
  ...lib('medical', [
    ['clinical', 'Clinical', 'clean teal, education and licences up front', { body: stack('Source Sans 3'), head: stack('Source Sans 3'), h2x: 'underline-accent', accent: '#0F766E', heading: '#0F172A', text: '#1F2937', order: ['education', 'experience', 'certifications', 'projects', 'skills', 'awards', 'activities', 'volunteering', 'languages'], headings: { certifications: 'Licences & Certifications' } }, { fields: ['medical'], roles: 'doctor|nurse|medical|clinic|pharm|health|dent|physio' }],
    ['care', 'Care', 'centred and warm, a short green line under each heading', { body: stack('Lato'), head: stack('Lora', true), align: 'center', h2x: 'short-rule', accent: '#15803D', heading: '#111111', text: '#222222' }, { fields: ['medical'] }],
    ['medic_side', 'Rounds', 'two columns: licences and skills on the side', { ...TWO, body: stack('Source Sans 3'), head: stack('Source Sans 3'), accent: '#0F766E', heading: '#0F172A', text: '#1F2937', sideTint: '#F0FDFA', side: ['certifications', 'skills', 'languages', 'awards'] }, { fields: ['medical'] }],
  ]),
  ...lib('teaching', [
    ['classroom', 'Classroom', 'friendly olive headings, activities near the top', { body: stack('Open Sans'), head: stack('Open Sans'), line: 1.3, h2x: 'underline-accent', accent: '#4D7C0F', heading: '#1A2E05', text: '#1F2937', order: ['education', 'experience', 'activities', 'volunteering', 'projects', 'skills', 'certifications', 'awards', 'languages'] }, { fields: ['teaching'], roles: 'teach|tutor|lecturer|instructor|educat|trainer' }],
    ['lecturer', 'Lecturer', 'serif, centred, ruled headings', { body: LIB_SERIF, head: LIB_SERIF, align: 'center', h2: 'full-rule', accent: '#1E3A8A', heading: '#111827', text: '#1F2937', headings: { projects: 'Research & Projects' } }, { fields: ['teaching'], level: 'experienced' }],
    ['mentor', 'Mentor', 'a plum bar on each heading', { head: OUTFIT, h2x: 'bar-left', accent: '#6D28D9', heading: '#111827', text: '#1F2937' }, { fields: ['teaching'] }],
  ]),
  ...lib('sales', [
    ['pitch', 'Pitch', 'your name on a colour band, results up front', { head: stack('Poppins'), body: stack('Open Sans'), band: true, h2x: 'caps-spaced', accent: '#C2410C', heading: '#111827', text: '#1F2937', order: EXP_ORDER }, { fields: ['business'], roles: 'sales|business development|account|retail' }],
    ['growth', 'Growth', 'berry name and spaced headings, for marketing', { head: OUTFIT, nameAccent: true, h2x: 'caps-spaced', accent: '#BE185D', heading: '#111827', text: '#1F2937', skillSep: ' · ' }, { fields: ['business'], roles: 'market|brand|social media|content|growth|digital' }],
    ['brand_side', 'Brand Side', 'two columns: skills and tools beside your campaigns', { ...TWO, body: stack('DM Sans'), head: stack('Poppins'), accent: '#C2410C', heading: '#111827', text: '#1F2937', sideTint: '#FFF7ED' }, { fields: ['business'] }],
  ]),
  ...lib('minimal', [
    ['mono', 'Mono', 'black and white, nothing else', { body: stack('Inter'), head: stack('Inter'), h2: 'plain', h2ls: '0.05em', accent: '#111111', heading: '#111111', text: '#222222', second: '#111111' }, {}],
    ['whitespace', 'Whitespace', 'airy spacing, slate lines', { body: stack('Lato'), head: stack('Lato'), line: 1.36, gap: 8, h2x: 'thin-rule', accent: '#475569', heading: '#0F172A', text: '#334155', subPlain: true }, {}],
    ['paper', 'Paper', 'serif and quiet: no rules, no colour', { body: stack('Merriweather', true), head: stack('Merriweather', true), size: 9.5, line: 1.36, h2x: 'none', accent: '#1A1A1A', heading: '#111111', text: '#222222', h2case: 'title' }, {}],
  ]),
  ...lib('twocol', [
    ['split', 'Split', 'two columns: contact skills on the left, story on the right', { ...TWO, body: stack('Inter'), head: stack('Inter'), accent: '#475569', heading: '#0F172A', text: '#334155', sideTint: '#F8FAFC' }, {}],
    ['sidebar_right', 'Sidebar Right', 'two columns with the side panel on the right', { ...TWO, sidePos: 'right', body: stack('Source Sans 3'), head: stack('Lora', true), accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', sideTint: '#EFF6FF' }, {}],
    ['modern_split', 'Modern Split', 'two columns, ocean blue headings', { ...TWO, body: stack('DM Sans'), head: OUTFIT, accent: '#0369A1', heading: '#0C1A2B', text: '#1E293B', sideTint: '#E0F2FE' }, { level: 'fresher' }],
    ['compact_split', 'Compact Split', 'two columns, tighter: fits more', { ...TWO, size: 9.5, line: 1.3, gap: 7, body: stack('Roboto'), head: stack('Roboto'), accent: '#111111', heading: '#111111', text: '#222222', sideTint: '#F4F4F5' }, { level: 'experienced' }],
  ]),
  ...lib('executive', [
    ['boardroom', 'Boardroom', 'serif headings, a bold bar under your name', { body: stack('Source Sans 3'), head: stack('Lora', true), nameSize: 24, nameBar: true, h2: 'accent-rule', accent: '#1E3A8A', heading: '#0F172A', text: '#1F2937', order: EXP_ORDER }, { level: 'experienced', roles: 'manager|head|director|lead|senior' }],
    ['director', 'Director', 'centred serif, small capitals', { body: LIB_SERIF, head: LIB_SERIF, nameSize: 23, align: 'center', h2x: 'smallcaps-rule', accent: '#1A1A1A', heading: '#111111', text: '#1A1A1A', order: EXP_ORDER }, { level: 'experienced' }],
    ['executive_side', 'Executive Side', 'two columns in burgundy, achievements on the right', { ...TWO, sidePos: 'right', body: stack('Lato'), head: stack('Merriweather', true), accent: '#7F1D1D', heading: '#111111', text: '#222222', sideTint: '#FEF2F2' }, { level: 'experienced' }],
  ]),
];

// ---------- the registry: one list the app's gallery, the approval gate, the server's allowed ids and the admin's
// hide list all read (resume full fix). Adding a template = one entry above (+ regenerated previews and tests). ----------
const COLLECTIONS = Object.freeze({
  ats: 'ATS Pro', fresher: 'Fresher & Student', tech: 'Tech / IT', business: 'Business & Finance', design: 'Design / Creative',
  engineering: 'Engineering', medical: 'Medical / Healthcare', teaching: 'Teaching', sales: 'Sales & Marketing', minimal: 'Minimal',
  twocol: 'Two-column', executive: 'Executive',
});
// the first ten (P3c): approved by the owner (25 Nov 2026), and what "recommended for you" reads
const FIRST_FIT = { campus: { level: 'fresher' }, first_step: { level: 'fresher' }, fresh_start: { level: 'fresher' }, society_leader: { level: 'fresher' }, project_first: { level: 'fresher', fields: ['cs', 'engineering', 'design'] }, internship_ready: { level: 'fresher', roles: 'intern' }, scholar: { level: 'fresher', roles: 'ms|mphil|phd|research|scholarship|graduate school' }, harvard: { level: 'any' }, clean_line: { level: 'any' }, two_tone: { level: 'any' } };
LIBRARY.forEach((t) => { if (t.approved === undefined) t.approved = true; if (!t.fit) t.fit = FIRST_FIT[t.id] || {}; });

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

const section = (title, inner, icon = '') => (inner ? `<section><h2>${icon}${esc(title)}</h2>${inner}</section>` : '');

// heading icons (studio: customStyles.headingIcons, off by default): small line drawings in the heading's colour. Vector
// only, no text, so the PDF's text (what an ATS reads) is the same with or without them.
const ICON_PATHS = {
  summary: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  experience: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  education: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
  projects: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  skills: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  certifications: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14l-1.5 7 5-3 5 3-1.5-7"/>',
  languages: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  activities: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  volunteering: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  awards: '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 21h8"/>',
  achievements: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
};
const iconOf = (look, key) => (look.icons && ICON_PATHS[key] ? `<svg class="hi" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[key]}</svg>` : '');

// P3d "verified by tdc": facts the server checked (never typed), each with its verify link; nothing when absent
const verifiedLine = (facts) => {
  const items = list(facts).filter((f) => f && str(f.text)).map((f) => esc(str(f.text)) + (str(f.url) ? ` (<a href="${esc(str(f.url))}" style="color: inherit; text-decoration: none;">${esc(str(f.url).replace(/^https?:\/\/(www\.)?/i, ''))}</a>)` : ''));
  return items.length ? `\n    <div class="verified" style="margin-top: 3px; font-size: 0.92em;">✓ verified by tdc: ${items.join(' · ')}</div>` : '';
};

// skills the student grouped (technical / tools / soft): [[label, names]] in that order, ungrouped ones first without a
// label; null when none is grouped (then the line renders exactly as before)
const SKILL_LABELS = [['technical', 'Technical'], ['tools', 'Tools'], ['soft', 'Soft skills']];
function groupedSkills(items) {
  const xs = list(items).filter((s) => s && str(typeof s === 'string' ? s : s.name));
  const groupOf = (s) => (typeof s === 'object' ? str(s.group).toLowerCase() : '');
  if (!xs.some((s) => SKILL_LABELS.some(([g]) => g === groupOf(s)))) return null;
  const out = [];
  const loose = xs.filter((s) => !SKILL_LABELS.some(([g]) => g === groupOf(s))).map((s) => str(typeof s === 'string' ? s : s.name));
  if (loose.length) out.push(['', loose]);
  for (const [g, lbl] of SKILL_LABELS) { const names = xs.filter((s) => groupOf(s) === g).map((s) => str(s.name)); if (names.length) out.push([lbl, names]); }
  return out;
}

function body(resume, look = {}, verified) {
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
  const skillGroups = groupedSkills(r.skills);
  const skillsInner = skillGroups ? skillGroups.map(([g, xs]) => `<p class="skills" dir="auto">${g ? `<span style="font-weight: 700;">${g}:</span> ` : ''}${xs.map(esc).join(look.skillSep || ', ')}</p>`).join('') : skills.length ? `<p class="skills" dir="auto">${skills.map(esc).join(look.skillSep || ', ')}</p>` : '';
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
  if (look.layout === 'two-col') {
    const sectionsHtml = {
      experience: section(H('experience', 'Experience'), work, iconOf(look, 'experience')),
      education: section(H('education', 'Education'), eduWithCourses, iconOf(look, 'education')),
      projects: section(H('projects', 'Projects'), projects, iconOf(look, 'projects')),
      skills: section(H('skills', 'Skills'), skillGroups ? skillsInner : skills.length ? skills.map((x) => `<p class="skills" dir="auto">${esc(x)}</p>`).join('') : '', iconOf(look, 'skills')),
      certifications: section(H('certifications', 'Certifications'), certs, iconOf(look, 'certifications')),
      languages: section(H('languages', 'Languages'), langs.map((l) => `<p dir="auto">${l}</p>`).join(''), iconOf(look, 'languages')),
      activities: section(H('activities', 'Leadership & Activities'), activities, iconOf(look, 'activities')),
      volunteering: section(H('volunteering', 'Volunteering'), volunteering, iconOf(look, 'volunteering')),
      awards: section(H('awards', 'Awards'), awards, iconOf(look, 'awards')),
    };
    const sideKeys = list(look.side).filter((k) => k in sectionsHtml);
    const mainHtml = {};
    for (const k of Object.keys(sectionsHtml)) if (!sideKeys.includes(k)) mainHtml[k] = sectionsHtml[k];
    const chosen = Array.isArray(r.sectionOrder) ? r.sectionOrder.filter((k) => sideKeys.includes(k)) : [];
    const sideOrder = [...chosen, ...sideKeys.filter((k) => !chosen.includes(k))];
    const side = `<aside class="side">${sideOrder.map((k) => sectionsHtml[k]).join('')}</aside>`;
    const main = `<div class="main">
  ${section(H('summary', 'Summary'), summary ? `<p dir="auto">${esc(summary)}</p>` : '', iconOf(look, 'summary'))}
  ${ordered(r, workFirst, mainHtml, look.order)}
  ${section(H('achievements', 'Achievements'), achievements.length ? `<ul>${achievements.map((a) => `<li dir="auto">${esc(a)}</li>`).join('')}</ul>` : '', iconOf(look, 'achievements'))}
  ${section('Additional information', str(r.otherNotes) ? lines(r.otherNotes) : '')}</div>`;
    return `
  <header>${look.photoUrl ? `<img class="photo" src="${esc(look.photoUrl)}" alt="">` : ''}
    <h1 dir="auto">${esc(name || 'Your name')}</h1>
    ${title ? `<div class="title" dir="auto">${esc(title)}</div>` : ''}
    ${contact.length ? `<div class="contact">${contact.join('<span class="sep"> | </span>')}</div>` : ''}${verifiedLine(verified)}
  </header>
  <div class="cols${look.sidePos === 'right' ? ' cols-r' : ''}">${look.sidePos === 'right' ? main + side : side + main}</div>`;
  }
  return `
  <header>${look.photoUrl ? `<img class="photo" src="${esc(look.photoUrl)}" alt="">` : ''}
    <h1 dir="auto">${esc(name || 'Your name')}</h1>
    ${title ? `<div class="title" dir="auto">${esc(title)}</div>` : ''}
    ${contact.length ? `<div class="contact">${contact.join('<span class="sep"> | </span>')}</div>` : ''}${verifiedLine(verified)}
  </header>
  ${section(H('summary', 'Summary'), summary ? `<p dir="auto">${esc(summary)}</p>` : '', iconOf(look, 'summary'))}
  ${ordered(r, workFirst, {
    experience: section(H('experience', 'Experience'), work, iconOf(look, 'experience')),
    education: section(H('education', 'Education'), eduWithCourses, iconOf(look, 'education')),
    projects: section(H('projects', 'Projects'), projects, iconOf(look, 'projects')),
    skills: section(H('skills', 'Skills'), skillsInner, iconOf(look, 'skills')),
    certifications: section(H('certifications', 'Certifications'), certs, iconOf(look, 'certifications')),
    languages: section(H('languages', 'Languages'), langs.length ? `<p dir="auto">${langs.join(', ')}</p>` : '', iconOf(look, 'languages')),
    activities: section(H('activities', 'Leadership & Activities'), activities, iconOf(look, 'activities')),
    volunteering: section(H('volunteering', 'Volunteering'), volunteering, iconOf(look, 'volunteering')),
    awards: section(H('awards', 'Awards'), awards, iconOf(look, 'awards')),
  }, look.order)}
  ${section(H('achievements', 'Achievements'), achievements.length ? `<ul>${achievements.map((a) => `<li dir="auto">${esc(a)}</li>`).join('')}</ul>` : '', iconOf(look, 'achievements'))}
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
  if (look.icons) out.push('h2 .hi { display: inline-block; width: 0.95em; height: 0.95em; vertical-align: -0.12em; margin-right: 0.35em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }');
  if (look.photoUrl) out.push(`header .photo { float: right; width: 72px; height: 72px; object-fit: cover; margin: 0 0 6px 12px; border-radius: ${{ circle: '50%', rounded: '10px', square: '0' }[look.photoShape] || '50%'}; }`);
  if (look.dateAccent) out.push(`.d { color: ${accent}; font-weight: 600; }`);
  if (look.subPlain) out.push(`.sub { font-style: normal; color: ${text}; opacity: 0.85; }`);
  if (look.layout === 'two-col') {
    const right = look.sidePos === 'right';
    out.push(`.cols { display: grid; grid-template-columns: ${right ? '1fr 30%' : '30% 1fr'}; column-gap: 16px; align-items: start; margin-top: ${look.gap}px; }`,
      `.side { ${look.sideTint ? `background: ${look.sideTint}; padding: 8px 10px 10px; border-radius: 6px; ` : ''}font-size: ${look.size - 0.4}pt; overflow-wrap: anywhere; }`,
      '.side section:first-child, .main section:first-child { margin-top: 0; }',
      `.side h2 { font-size: ${look.size + 0.5}pt; }`,
      '.side .row { display: block; } .side .d { display: block; white-space: normal; }',
      '.main { min-width: 0; }');
  }
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
  if (!keys.some((k) => st[k] !== undefined && st[k] !== null) && st.headingIcons !== true && !library) return { look, styles: st };
  const l = { ...look };
  if (pal) Object.assign(l, { accent: pal.accent, heading: pal.heading, text: pal.text });
  const fp = FONT_PAIRS.find((x) => x.id === st.fontPair);
  if (fp) Object.assign(l, { body: fp.body, head: fp.head, fontPair: fp.id });
  if (SIZES[st.size]) { l.size = look.size + SIZES[st.size]; l.nameSize = look.nameSize + SIZES[st.size] * 2; }
  if (DENSITY[st.density] && st.density !== 'normal') { l.gap = Math.round(look.gap * DENSITY[st.density].gap); l.line = Math.round(look.line * DENSITY[st.density].line * 100) / 100; }
  if (MARGINS[st.margins]) l.margin = MARGINS[st.margins];
  if (st.headingCase === 'title') l.h2case = 'title';
  if (HEADING_STYLES[st.headingStyle]) l.h2x = HEADING_STYLES[st.headingStyle];
  if (st.headingIcons === true) l.icons = true;
  if (Array.isArray(st.hiddenSections) && st.hiddenSections.length) l.hidden = st.hiddenSections;
  if (Array.isArray(st.sectionOrder) && st.sectionOrder.length) l.sectionOrder = st.sectionOrder;
  if (st.headings && typeof st.headings === 'object') l.headings = { ...(look.headings || {}), ...st.headings };
  const photo = str(resume?.personalInfo?.photoUrl);
  if (st.photo && st.photo.on && /^https:\/\//i.test(photo)) { l.photoUrl = photo; l.photoShape = st.photo.shape; }
  else if (!st.photo && look.photoDefault && /^https:\/\//i.test(photo)) { l.photoUrl = photo; l.photoShape = 'circle'; }
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
<body data-template="${id}"><main class="page">${body(resume, look, opts.verified)}</main></body>
</html>`;
};

/**
 * P3-9 (flag resumeWriter): a cover letter in the resume's own design (same theme, fonts, colours and header). letter:
 * { company, paragraphs: [text], date? }. The greeting and sign-off use only real data: the company the student typed
 * and their own name. The resume's renderer above is not touched (a resume prints exactly as before).
 */
const renderCoverLetterHTML = (resume, templateId, customStyles = {}, letter = {}, opts = {}) => {
  const base = templateOf(templateId);
  const library = LIBRARY.some((t) => t.id === base.id);
  const chosen = customStyles || resume?.customStyles || {};
  const { look, styles: cleanStyles } = customise(base.look, chosen, { library, resume });
  const pi = resume?.personalInfo || {};
  const name = [str(pi.firstName), str(pi.lastName)].filter(Boolean).join(' ');
  const title = str(pi.title) || str(resume?.professionalSummary?.title);
  const ln = look.linkStyle === 'short' ? shortLink : link;
  const contact = [esc(getDisplayLocation(resume || {})), esc(str(pi.phone)), str(pi.email) ? `<a href="mailto:${esc(str(pi.email))}">${esc(str(pi.email))}</a>` : '', ln(pi.linkedin)].filter(Boolean);
  const company = str(letter.company);
  const paras = list(letter.paragraphs).map(str).filter(Boolean);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=794">
<title>${esc(name || 'Cover')} Cover Letter</title>
<style>${opts.fontCss || ''}${css(look, library || look !== base.look ? cleanStyles : customStyles || resume?.customStyles || {})}
.letter p { margin: 0 0 0.9em; }
.letter .date { margin: 1.4em 0 1.2em; }</style>
</head>
<body data-template="${base.id}" data-doc="cover-letter"><main class="page">
  <header>
    <h1 dir="auto">${esc(name || 'Your name')}</h1>
    ${title ? `<div class="title" dir="auto">${esc(title)}</div>` : ''}
    ${contact.length ? `<div class="contact">${contact.join('<span class="sep"> | </span>')}</div>` : ''}
  </header>
  <section class="letter">
    ${str(letter.date) ? `<p class="date">${esc(str(letter.date))}</p>` : '<p class="date"></p>'}
    <p dir="auto">Dear hiring team${company ? ` at ${esc(company)}` : ''},</p>
    ${paras.map((t) => `<p dir="auto">${esc(t)}</p>`).join('\n    ')}
    <p dir="auto">Sincerely,<br>${esc(name || '')}</p>
  </section>
</main></body>
</html>`;
};

// ---------- the registry (resume full fix) ----------
// every template the app can offer, in gallery order: the five older ones, then the library
const REGISTRY = Object.freeze([
  ...TEMPLATES.map((t) => Object.freeze({ id: t.id, name: t.name, description: t.description, collection: 'ats', ats: 'safe', approved: true, older: true, layout: 'single', fit: {} })),
  ...LIBRARY.map((t) => Object.freeze({ id: t.id, name: t.name, description: t.description, collection: t.collection, ats: t.ats, approved: t.approved !== false, older: false, layout: t.look.layout || 'single', fit: t.fit || {} })),
]);
// what a resume may store as its template: the old aliases (opened as their closest look) + every registry id
const TEMPLATE_IDS = Object.freeze([...Object.keys(LEGACY), ...REGISTRY.map((t) => t.id)]);
const OFFERED_IDS = Object.freeze(REGISTRY.filter((t) => t.approved).map((t) => t.id));

// ---------- the page: measured on the real render (resume full fix) ----------
// The printed page box of a template + the student's customisation, in CSS px (96 per inch): the PDF's @page.
const MM = 96 / 25.4;
function pageBox(templateId, customStyles, resume) {
  const base = templateOf(templateId);
  const library = LIBRARY.some((t) => t.id === base.id);
  const { look } = customise(base.look, customStyles == null ? (resume && resume.customStyles) || {} : customStyles, { library, resume });
  const m = /([\d.]+)mm\s+([\d.]+)mm/.exec(String(look.margin || '14mm 15mm')) || [0, 14, 15];
  const letter = look.pageSize === 'Letter';
  return { width: letter ? 816 : 794, height: letter ? 1056 : 1123, top: Math.round(Number(m[1]) * MM * 10) / 10, x: Math.round(Number(m[2]) * MM * 10) / 10 };
}
// Run inside the rendered page (the preview WebView, or Chrome in the tests): lays the page out exactly as it prints
// (width and margins of the PDF) and reports how full one page is: { type: 'tdc-page', fill, pages, height, overflow }
//   fill 1 = exactly one full page; pages = how many pages it prints on; overflow = text wider than its box
function measureScript(box) {
  return `(function(){var B=${JSON.stringify(box)};function run(){try{var m=document.querySelector('main.page');if(!m)return;` +
    `document.documentElement.style.background='#ffffff';document.body.style.padding='0';document.body.style.margin='0';` +
    `m.style.boxShadow='none';m.style.margin='0';m.style.width=B.width+'px';m.style.minHeight='0';m.style.padding=B.top+'px '+B.x+'px';` +
    // the ink: from the top of the page's content to the bottom of its last visible box (a trailing margin prints nothing)
    `var avail=B.height-2*B.top;var top=m.getBoundingClientRect().top+B.top;var bottom=top;var over=0;var all=m.querySelectorAll('*');` +
    `for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();if(r.height>0&&r.width>0&&r.bottom>bottom)bottom=r.bottom;if(e.scrollWidth>e.clientWidth+2&&e.clientWidth>0&&e.tagName!=='A'){over++;}}` +
    `var h=bottom-top;var res={type:'tdc-page',fill:Math.round(h/avail*1000)/1000,pages:Math.max(1,Math.ceil((h-1)/avail)),height:Math.round(h),overflow:over};` +
    `window.__tdcPage=res;if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage)window.ReactNativeWebView.postMessage(JSON.stringify(res));}catch(e){}}` +
    `if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(run,40);});}else{setTimeout(run,250);}})();true;`;
}
// a short key for "this exact render" (resume content + template + customisation): a stored measurement only counts
// while its key matches the resume as it is now (any content or template change makes it stale)
function layoutKey(resume, templateId, customStyles) {
  const r = resume || {};
  const html = renderResumeHTML(r, templateId || r.template, customStyles == null ? r.customStyles || {} : customStyles);
  let h = 5381;
  for (let i = 0; i < html.length; i += 1) h = ((h * 33) ^ html.charCodeAt(i)) >>> 0;
  return `${(templateOf(templateId || r.template).id)}:${h.toString(36)}`;
}

module.exports = {
  REGISTRY, TEMPLATE_IDS, OFFERED_IDS, COLLECTIONS, pageBox, measureScript, layoutKey,
  PALETTES, FONT_PAIRS, SIZES, DENSITY, MARGINS, HEADING_STYLES, SECTION_KEYS, MODEL_DEFAULT_COLOURS,
  LIBRARY, TEMPLATES, canonicalTemplate, templateOf, getDisplayLocation, formatDate, formatDateRange, customise, renderResumeHTML, renderCoverLetterHTML,
};
