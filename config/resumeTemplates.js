// config/resumeTemplates.js
// Plan P3-6 (template studio, flag resumeTemplatesV2 in the app): the template ids a resume may store and the
// customisation keys it may carry in customStyles. Everything is optional and additive: older resumes and older apps
// (the five templates, the five colour keys) are unchanged.
//   TEMPLATE_IDS          the 13 older ids (the five today + their old aliases) + the library's ids
//   cleanCustomStyles(x)  only the known keys, each checked (anything else dropped, never a failed save)

// resume full fix: one registry (utils/resumeRender.js REGISTRY, shared byte for byte with the app) gives every id
const REG = require("../utils/resumeRender");
const OLD_IDS = ["modern", "classic", "creative", "minimal", "professional", "modern_ats", "stanford", "faang", "jakes", "rezi", "flowcv", "reactive", "canva"];
const LIBRARY_IDS = REG.LIBRARY.map((t) => t.id);
const TEMPLATE_IDS = Object.freeze([...OLD_IDS, ...LIBRARY_IDS.filter((id) => !OLD_IDS.includes(id))]);
// what the gallery offers (approved, in gallery order): the admin's hide list shows exactly these
const OFFERED_IDS = REG.OFFERED_IDS;

const SECTIONS = ["summary", "experience", "education", "projects", "skills", "certifications", "languages", "activities", "volunteering", "awards", "achievements"];
const CHOICES = {
  size: ["S", "M", "L"],
  density: ["compact", "normal", "airy"],
  margins: ["narrow", "normal", "wide"],
  headingCase: ["upper", "title"],
  headingStyle: ["rule", "bar", "underline", "none"],
  dateFormat: ["mon-yyyy", "mm/yyyy"],
  pageSize: ["A4", "Letter"],
  linkStyle: ["full", "short"],
};
const COLOURS = ["accentColor", "headingColor", "textColor", "bgColor"];
const STUDIO_KEYS = ["palette", "fontPair", "size", "density", "margins", "headingCase", "headingStyle", "headingIcons", "sectionOrder", "hiddenSections", "headings", "photo", "dateFormat", "pageSize", "linkStyle"];
const ID = /^[a-z0-9_-]{1,30}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** the keys a customStyles update may set, checked; unknown or invalid values are left out */
function cleanCustomStyles(input) {
  const x = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  // the five keys every app version sends (strings up to 40, as before)
  if (typeof x.font === "string" && x.font.length <= 40) out.font = x.font;
  for (const k of COLOURS) if (typeof x[k] === "string" && x[k].length <= 40) out[k] = x[k];
  // P3-6 (all optional)
  for (const k of ["palette", "fontPair"]) if (typeof x[k] === "string" && ID.test(x[k])) out[k] = x[k];
  for (const [k, list] of Object.entries(CHOICES)) if (list.includes(x[k])) out[k] = x[k];
  if (typeof x.headingIcons === "boolean") out.headingIcons = x.headingIcons;
  if (Array.isArray(x.sectionOrder)) out.sectionOrder = [...new Set(x.sectionOrder.filter((s) => SECTIONS.includes(s)))];
  if (Array.isArray(x.hiddenSections)) out.hiddenSections = [...new Set(x.hiddenSections.filter((s) => SECTIONS.includes(s)))];
  if (x.headings && typeof x.headings === "object" && !Array.isArray(x.headings)) {
    const h = {};
    for (const [k, v] of Object.entries(x.headings)) if (SECTIONS.includes(k) && str(v, 40)) h[k] = str(v, 40);
    out.headings = h;
  }
  if (x.photo && typeof x.photo === "object") {
    out.photo = { on: x.photo.on === true, shape: ["circle", "rounded", "square"].includes(x.photo.shape) ? x.photo.shape : "circle" };
  }
  // a colour key must be a colour if it's one of the P3-6 colour keys sent with a palette
  for (const k of COLOURS) if (out[k] !== undefined && out[k] !== "" && x.palette !== undefined && !HEX.test(out[k])) delete out[k];
  // null clears a studio key ("reset to the template's look"); the five older keys can't be cleared this way
  for (const k of STUDIO_KEYS) if (x[k] === null) out[k] = null;
  return out;
}

module.exports = { TEMPLATE_IDS, OLD_IDS, LIBRARY_IDS, OFFERED_IDS, SECTIONS, CHOICES, cleanCustomStyles };
