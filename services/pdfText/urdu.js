// services/pdfText/urdu.js
// Urdu (Arabic script) in resume PDFs, for the ATS Classic renderer and the older pdfService.
//
// The standard PDF fonts only cover Latin. Arabic-script text is drawn with Scheherazade New (SIL, Open Font
// License, assets/fonts, OFL-ScheherazadeNew.txt). PDFKit shapes it (fontkit joins the letters and orders
// them right to left within a word); this module does what PDFKit doesn't: the order of words and runs.
//   - A paragraph whose first letter is Arabic-script is right-to-left: its words are placed from the right
//     edge, and a Latin word or a number inside it (React, 2024) stays left-to-right in its place.
//   - A Latin paragraph with an Urdu phrase stays left-to-right, the phrase placed as one right-to-left run.
//   - Every run sits on one baseline, so text extraction (pdftotext, ATS parsers) reads each line once, in
//     logical order. Scheherazade New has one glyph per letter form, so each glyph maps to its own letter
//     (fonts that share a dotless base glyph between letters, like Noto Naskh, extract the wrong letters).
// If the font can't be loaded or doesn't shape (or RESUME_PDF_URDU=off), supported() is false: callers keep
// the Latin layout, leave the Urdu lines out and tell the student before export (never silently).
const fs = require("fs");
const path = require("path");

const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FONTS = { regular: path.join(FONT_DIR, "ScheherazadeNew-Regular.ttf"), bold: path.join(FONT_DIR, "ScheherazadeNew-Bold.ttf") };
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const STRONG = /[A-Za-zÀ-ɏ؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

const hasArabic = (s) => ARABIC.test(String(s ?? ""));

let checked = null;
/** Can Urdu be drawn correctly here? (the font loads and shapes a test word into joined letter forms) */
function supported() {
  if (String(process.env.RESUME_PDF_URDU || "").trim().toLowerCase() === "off") return false;
  if (checked != null) return checked;
  try {
    const fontkit = require("fontkit");
    checked = Object.values(FONTS).every((file) => {
      const f = fontkit.openSync(file);
      const run = f.layout("پاکستان"); // پاکستان
      // every glyph found (no .notdef) and shaped right to left
      return run.glyphs.length > 0 && run.glyphs.every((g) => g.id !== 0) && run.direction === "rtl";
    });
  } catch {
    checked = false;
  }
  return checked;
}
supported.reset = () => { checked = null; };

/** Remove Arabic-script text (when it can't be drawn); returns { text, removed } */
function withoutArabic(s) {
  const t = String(s ?? "");
  const kept = t.split(/(\s+)/).filter((w) => !hasArabic(w)).join("").replace(/\s+/g, " ").trim();
  return { text: kept, removed: hasArabic(t) };
}

// ---------- layout ----------
const isArabicWord = (w) => hasArabic(w);
// keep precomposed letters whole (آ أ stay one glyph instead of a base + a mark): text extraction would
// otherwise read the mark before its letter
const URDU_FEATURES = { ccmp: false };
const gapOf = (doc, latinFont, size) => Math.max(doc.font(latinFont).fontSize(size).widthOfString(" "), size * 0.33);
const firstStrongIsArabic = (s) => { const m = STRONG.exec(s); return !!m && ARABIC.test(m[0]); };

// The text map (ToUnicode) of an embedded Urdu font, built from glyph names. PDFKit maps each glyph to the
// characters of the first word it appeared in; with marks drawn as their own glyphs (آ = alef + madda) one glyph
// stands for several letters, and whichever came first wins (آ would extract as ا, or every ا as آ). By name,
// each glyph maps to its own character: the alef to ا, the madda mark to U+0653, a lam-alef ligature to both;
// ا + U+0653 is the canonical decomposition of آ, so extraction gives the same text.
const hex4 = (n) => n.toString(16).padStart(4, "0");
function charsOfGlyphName(name) {
  const base = String(name || "").split(".")[0];
  if (!base) return null;
  const out = [];
  for (const part of base.split("_")) {
    let m;
    if ((m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(part))) { for (let i = 0; i < m[1].length; i += 4) out.push(parseInt(m[1].slice(i, i + 4), 16)); }
    else if ((m = /^u([0-9A-Fa-f]{4,6})$/.exec(part))) out.push(parseInt(m[1], 16));
    else return null; // a name we can't read: keep PDFKit's own mapping
  }
  return out.length ? out : null;
}
function fixTextMap(font) {
  if (!font || font._urduTextMap) return;
  font._urduTextMap = true;
  font.toUnicodeCmap = function () {
    const cmap = this.document.ref();
    const pairs = [];
    this.unicode.forEach((codePoints, gid) => {
      const orig = this.subset?.glyphs?.[gid];
      let cps = orig != null ? charsOfGlyphName(this.font.getGlyph(orig)?.name) : null;
      if (!cps) cps = codePoints;
      if (!cps || !cps.length || (cps.length === 1 && cps[0] === 0)) return; // .notdef and unnamed marks: nothing
      const enc = [];
      for (let v of cps) {
        if (v > 0xffff) { v -= 0x10000; enc.push(hex4(((v >>> 10) & 0x3ff) | 0xd800)); v = 0xdc00 | (v & 0x3ff); }
        enc.push(hex4(v));
      }
      pairs.push(`<${hex4(gid)}> <${enc.join("")}>`);
    });
    const chunks = [];
    for (let i = 0; i < pairs.length; i += 100) chunks.push(`${pairs.slice(i, i + 100).length} beginbfchar\n${pairs.slice(i, i + 100).join("\n")}\nendbfchar`);
    cmap.end(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n${chunks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`);
    return cmap;
  };
}

function register(doc) {
  if (doc._urduFonts) return;
  doc.registerFont("Urdu-Regular", FONTS.regular);
  doc.registerFont("Urdu-Bold", FONTS.bold);
  // load both now (PDFKit creates the embedded font on first use) and give them the name-based text map
  const prev = { font: doc._font, size: doc._fontSize };
  for (const name of ["Urdu-Regular", "Urdu-Bold"]) { doc.font(name); fixTextMap(doc._font); }
  if (prev.font) doc._font = prev.font;
  if (prev.size) doc._fontSize = prev.size;
  doc._urduFonts = true;
}

/**
 * Draw one paragraph that contains Urdu at (x, y) within width. Returns the new y.
 *   opts: { x, y, width, size, latinFont ("Helvetica" | "Helvetica-Bold" | ...), color, lineGap, align
 *           ("left" | "center" | "right" | "natural"), bottom (page bottom; a new page starts below it) }
 */
function paragraph(doc, text, opts) {
  register(doc);
  const { x, width, size, latinFont = "Helvetica", color = "#111111", lineGap = 2, align = "natural" } = opts;
  let y = opts.y;
  const bold = /bold/i.test(latinFont);
  const urduFont = bold ? "Urdu-Bold" : "Urdu-Regular";
  const rtl = firstStrongIsArabic(text);
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const fontOf = (w) => (isArabicWord(w) ? urduFont : latinFont);
  const optsOf = (w) => (isArabicWord(w) ? { features: URDU_FEATURES } : {});
  const measure = (w) => doc.font(fontOf(w)).fontSize(size).widthOfString(w, optsOf(w));
  // words are drawn one by one (drawing a whole Urdu run with its spaces makes extraction swap its words);
  // the gap between words is wide enough that text extraction always sees a word break
  const gap = gapOf(doc, latinFont, size);
  // greedy lines
  const lines = [];
  let cur = [], curW = 0;
  for (const w of words) {
    const ww = measure(w);
    if (cur.length && curW + gap + ww > width) { lines.push(cur); cur = [], curW = 0; }
    cur.push({ w, ww });
    curW += (cur.length > 1 ? gap : 0) + ww;
  }
  if (cur.length) lines.push(cur);
  // a taller line than Latin text: Arabic script has deep descenders and marks above
  const lineH = size * 1.7;
  const bottom = opts.bottom ?? (doc.page.height - doc.page.margins.bottom);
  doc.fillColor(color);
  for (const line of lines) {
    if (y + lineH > bottom) { doc.addPage(); y = doc.page.margins.top; }
    // runs: consecutive words of the same script
    const runs = [];
    for (const t of line) {
      const ar = isArabicWord(t.w);
      const last = runs[runs.length - 1];
      if (last && last.ar === ar) last.words.push(t); else runs.push({ ar, words: [t] });
    }
    for (const r of runs) r.width = r.words.reduce((n, t) => n + t.ww, 0) + gap * (r.words.length - 1);
    const lineW = runs.reduce((n, r) => n + r.width, 0) + gap * (runs.length - 1);
    const a = align === "natural" ? (rtl ? "right" : "left") : align;
    const startX = a === "center" ? x + (width - lineW) / 2 : a === "right" ? x + width - lineW : x;
    const baseline = y + size * 1.2;
    // runs in reading order: left to right for a Latin paragraph, right to left for an Urdu one
    const ordered = rtl ? [...runs].reverse() : runs;
    let cx = startX;
    for (const r of ordered) {
      // inside a run: Latin words left to right, Urdu words right to left
      const ws = r.ar ? [...r.words].reverse() : r.words;
      let wx = cx;
      for (const t of ws) {
        doc.font(fontOf(t.w)).fontSize(size).fillColor(color);
        // PDFKit's own text(): a document may route Urdu text() calls here (pdfService's enableUrdu)
        (doc._urduRawText || doc.text).call(doc, t.w, wx, baseline, { lineBreak: false, baseline: "alphabetic", ...optsOf(t.w) });
        wx += t.ww + gap;
      }
      cx += r.width + gap;
    }
    y += lineH + lineGap;
  }
  doc.font(latinFont).fontSize(size);
  doc.x = x;
  doc.y = y;
  return y;
}

/** Height paragraph() will use (for keep-together checks), without drawing */
function heightOf(doc, text, { width, size, latinFont = "Helvetica", lineGap = 2 }) {
  register(doc);
  const bold = /bold/i.test(latinFont);
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const gap = gapOf(doc, latinFont, size);
  let lines = words.length ? 1 : 0, cur = 0;
  for (const w of words) {
    const ar = isArabicWord(w);
    const ww = doc.font(ar ? (bold ? "Urdu-Bold" : "Urdu-Regular") : latinFont).fontSize(size).widthOfString(w, ar ? { features: URDU_FEATURES } : {});
    if (cur && cur + gap + ww > width) { lines += 1; cur = ww; } else cur += (cur ? gap : 0) + ww;
  }
  doc.font(latinFont).fontSize(size);
  return lines * (size * 1.7 + lineGap);
}

/** Does this resume content have any Urdu? (every string in it) */
// (a Mongoose document is read as its plain object; only plain objects and arrays are followed, once each:
// a document's internals are circular)
function contentHasArabic(v, seen = new WeakSet()) {
  if (v == null) return false;
  if (typeof v === "string") return hasArabic(v);
  if (typeof v !== "object") return false;
  if (typeof v.toObject === "function") v = v.toObject();
  if (seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => contentHasArabic(x, seen));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false; // ids, dates, buffers
  return Object.values(v).some((x) => contentHasArabic(x, seen));
}

/** What the student is told before export: { urdu: "none" | "included" | "not_included", message } */
function pdfStatus(content) {
  if (!contentHasArabic(content)) return { urdu: "none", message: null };
  if (supported()) return { urdu: "included", message: null };
  return { urdu: "not_included", message: "Urdu text can't be included in this PDF right now: lines in Urdu will be left out. Write them in English, or export later." };
}

module.exports = { hasArabic, supported, withoutArabic, paragraph, heightOf, contentHasArabic, pdfStatus, FONTS };
