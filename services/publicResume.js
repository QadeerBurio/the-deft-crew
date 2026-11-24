// services/publicResume.js
// P3d public resume page (owner #1, flags resumeV2 + resumePublicPage for the resume's owner): gettdc.pk/r/<link>
// (the portal forwards /r/* here). Private by default: the page exists only while the student has it on.
//   - the same design as the PDF: the shared renderer (utils/resumeRender.js) with the same OFL fonts, served from
//     /r/fonts/<file> (public/resume-fonts, each family's licence beside it)
//   - what shows (owner P3d #3): everything on the resume except: phone and e-mail (only when the student turns them
//     on), street address and postal code (never), any location text other than the city the student typed on the
//     resume, the target job's location; a photo only when the student switched it on in customise
//   - "verified by tdc" only when the student added it (settings.verifiedLine) and resumeVerified is on for them
//   - views (owner P3d #4): a real count, only for the student; their own visits (the selfKey in "open my page"),
//     link previews and crawlers aren't counted; the same visitor within 30 minutes counts once. No IP is stored: the
//     30-minute memory holds a salted hash (a new salt each start), never written anywhere.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const render = require("../utils/resumeRender");

const FONT_DIR = path.join(__dirname, "..", "public", "resume-fonts");
// family → { weight: file } (the app's services/templates/fonts.js, same files)
const FONTS = {
  Inter: { 400: "Inter-400.ttf", 700: "Inter-700.ttf" },
  Lora: { 700: "Lora-700.ttf" },
  "Source Sans 3": { 400: "SourceSans3-400.ttf", 700: "SourceSans3-700.ttf" },
  Merriweather: { 700: "Merriweather-700.ttf" },
  Lato: { 400: "Lato-400.ttf", 700: "Lato-700.ttf" },
  "DM Serif Display": { 400: "DMSerifDisplay-400.ttf" },
  "DM Sans": { 400: "DMSans_400Regular.ttf", 700: "DMSans_700Bold.ttf" },
  Outfit: { 600: "Outfit_600SemiBold.ttf", 700: "Outfit_700Bold.ttf" },
  Poppins: { 600: "Poppins-600.ttf" },
  "Open Sans": { 400: "OpenSans-400.ttf", 700: "OpenSans-700.ttf" },
  "IBM Plex Serif": { 700: "IBMPlexSerif-700.ttf" },
  "IBM Plex Sans": { 400: "IBMPlexSans-400.ttf", 700: "IBMPlexSans-700.ttf" },
  Bitter: { 700: "Bitter-700.ttf" },
  Roboto: { 400: "Roboto-400.ttf", 700: "Roboto-700.ttf" },
  "Noto Sans": { 400: "NotoSans-400.ttf", 700: "NotoSans-700.ttf" },
  "Noto Naskh Arabic": { 400: "NotoNaskhArabic-400.ttf", 700: "NotoNaskhArabic-700.ttf" },
};
const FONT_FILES = new Set(Object.values(FONTS).flatMap((w) => Object.values(w)));
const LICENCES = new Set(fs.existsSync(FONT_DIR) ? fs.readdirSync(FONT_DIR).filter((f) => /^OFL-[a-z0-9]+\.txt$/.test(f)) : []);
const firstFamily = (stack) => (/^\s*'([^']+)'/.exec(String(stack || "")) || [])[1] || null;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

/** @font-face rules pointing at /r/fonts (the five older templates use system fonts: none) */
function fontCss(look, resume) {
  const fam = [firstFamily(look.head), firstFamily(look.body)].filter((f) => f && FONTS[f]);
  const pi = resume?.personalInfo || {};
  if (fam.length && ARABIC_SCRIPT.test(`${pi.firstName || ""} ${pi.lastName || ""}`)) fam.push("Noto Naskh Arabic");
  const out = [];
  for (const family of [...new Set(fam)]) {
    const weights = Object.keys(FONTS[family]);
    for (const w of weights) out.push(`@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weights.length === 1 ? "400 700" : w}; font-display: swap; src: url(/r/fonts/${FONTS[family][w]}) format('truetype'); }`);
  }
  return out.join("\n");
}

/** the resume as the public sees it (a copy; the stored resume is never changed) */
function publicCopy(resume) {
  const pp = resume.publicPage || {};
  const pi = resume.personalInfo || {};
  const city = String(pi.city || "").trim();
  return {
    ...resume,
    personalInfo: {
      firstName: pi.firstName, lastName: pi.lastName, title: pi.title,
      email: pp.showEmail === true ? pi.email : "",
      phone: pp.showPhone === true ? pi.phone : "",
      location: "", city, state: "", country: "", address: "", postalCode: "",
      linkedin: pi.linkedin, github: pi.github, portfolio: pi.portfolio, photoUrl: pi.photoUrl,
    },
    targetJob: resume.targetJob ? { ...resume.targetJob, location: "" } : resume.targetJob,
    references: [],
  };
}

const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEAD_EXTRA = '<meta name="robots" content="noindex, nofollow">\n<meta name="referrer" content="no-referrer">\n';
const FOOT = '<footer style="font: 12px/1.4 -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif; color: #e5e5e5; text-align: center; padding: 12px 16px 24px;">resume page made with <a href="https://gettdc.pk" style="color: #F9C349; text-decoration: none;">tdc</a>, the student app</footer>';

/** the page's HTML: the PDF's HTML + noindex + a one-line footer */
function pageHtml(resume, { verified } = {}) {
  const shown = publicCopy(resume);
  const base = render.templateOf(resume.template);
  const library = render.LIBRARY.some((t) => t.id === base.id);
  const { look } = render.customise(base.look, resume.customStyles || {}, { library, resume: shown });
  const css = fontCss(look, shown);
  const opts = {};
  if (css) opts.fontCss = css;
  if (verified && verified.length) opts.verified = verified;
  const html = render.renderResumeHTML(shown, resume.template, resume.customStyles || {}, false, opts);
  return html.replace(/<head>\r?\n/, (m) => `${m}${HEAD_EXTRA}`).replace("</main></body>", () => `</main>${FOOT}</body>`);
}

function notFoundHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${HEAD_EXTRA}<title>page not found · tdc</title></head><body style="margin:0;background:#FAF8F3;color:#111;font:16px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;"><main style="max-width:440px;margin:0 auto;padding:48px 16px;"><span style="display:inline-block;background:#111;color:#F9C349;font-weight:800;padding:6px 12px;border-radius:12px;">tdc</span><h1 style="font-size:26px;margin:22px 0 6px;">this resume page isn't available</h1><p style="color:#6B675E;">the link may be old, or the student turned their page off.</p></main></body></html>`;
}

// ---------- views ----------
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|slack|discord|linkedin|twitter|skype|embedly|vkshare|pinterest|headless|lighthouse|curl|wget|python|axios|node-fetch|go-http/i;
const SALT = crypto.randomBytes(16).toString("hex");
const recent = new Map(); // salted hash → time (memory only)
const WINDOW = 30 * 60 * 1000;
function sweep(now) { if (recent.size < 5000) return; for (const [k, t] of recent) if (now - t > WINDOW) recent.delete(k); }

/** should this request add a view? (never the student's own, a preview / crawler, or a repeat within 30 minutes) */
function countsAsView({ method, userAgent, selfKeyGiven, selfKey, ip, slug, now = Date.now() }) {
  if (method !== "GET") return false;
  if (selfKeyGiven && selfKey && crypto.timingSafeEqual(Buffer.from(String(selfKeyGiven).padEnd(64).slice(0, 64)), Buffer.from(String(selfKey).padEnd(64).slice(0, 64)))) return false;
  if (!userAgent || BOTS.test(userAgent)) return false;
  const key = crypto.createHash("sha256").update(`${SALT}|${ip}|${slug}`).digest("hex");
  const seen = recent.get(key);
  if (seen && now - seen < WINDOW) return false;
  recent.set(key, now);
  sweep(now);
  return true;
}

const newSlug = () => crypto.randomBytes(16).toString("base64url"); // 22 characters
const SLUG = /^[A-Za-z0-9_-]{22}$/;
const pageUrl = (slug) => `${String(process.env.PORTAL_URL || "https://gettdc.pk").replace(/\/$/, "")}/r/${slug}`;

module.exports = { pageHtml, notFoundHtml, publicCopy, fontCss, countsAsView, newSlug, pageUrl, SLUG, FONT_DIR, FONT_FILES, LICENCES, _recent: recent };
