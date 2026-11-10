// services/resumeStudio/renderer.js
// "ATS Classic": the one Resume Studio template. A4, one column, standard fonts, no tables, no images,
// no icons, so applicant tracking systems read it in order:
//   - dates sit in the line under each heading (reading order), never in a right-hand column
//   - bullets are drawn shapes, so text extracts without stray glyphs
//   - links and e-mails are clickable
//   - a heading is never left alone at the bottom of a page (keep-with-next)
//   - "DRAFT - not approved" on previews only; an approved version renders without it
// Freshers (no work experience) get Projects and Education before Experience.
// Urdu (Arabic script) is drawn with an embedded open-licensed font, right to left (services/pdfText/urdu.js);
// if that isn't possible the Urdu lines are left out and pdfStatus() tells the student before export.
// Bump RENDERER_VERSION whenever the output changes: approved versions record the version they used.
const PDFDocument = require("pdfkit");
const urdu = require("../pdfText/urdu");

const RENDERER_VERSION = "ats-classic-2";
const MARGIN = 50;
const BODY = 10;
const SMALL = 9;
const INK = "#111111";
const MUTED = "#444444";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// standard PDF fonts only cover Latin-1; keep text readable and extractable
const safe = (s) => String(s ?? "")
  .replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"')
  .replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/[\u2022\u25cf\u25aa]/g, "-")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "")
  .replace(/\s+/g, " ").trim();
// the same clean-up for text that has Urdu in it: the Latin parts as above, the Arabic-script parts kept as typed
const ARABIC_RUN = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g;
const safeKeepingUrdu = (s) => {
  const parts = [];
  let last = 0;
  const t = String(s ?? "");
  for (const m of t.matchAll(ARABIC_RUN)) {
    parts.push(safe(t.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(safe(t.slice(last)));
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
};
const month = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : safe(ym);
};
const range = (start, end, current) => {
  const a = month(start);
  const b = current ? "Present" : month(end);
  return a && b ? `${a} - ${b}` : a || b;
};
const fullUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const shownUrl = (u) => String(u).replace(/^https?:\/\//i, "").replace(/\/$/, "");

/**
 * @param content a contentSnapshot (facts.contentOf shape)
 * @param opts { draft: boolean }
 * @returns Promise<Buffer>
 */
function render(content, { draft = false } = {}) {
  const c = content;
  const doc = new PDFDocument({ size: "A4", margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }, info: { Title: safeKeepingUrdu(`${c.personalInfo.firstName} ${c.personalInfo.lastName} - Resume`), Creator: "TDC Resume Studio" } });
  const chunks = [];
  doc.on("data", (b) => chunks.push(b));
  const done = new Promise((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const width = doc.page.width - 2 * MARGIN;
  const bottom = () => doc.page.height - MARGIN;

  const draftMark = () => {
    if (!draft) return;
    const { x, y } = doc;
    doc.save().font("Helvetica-Bold").fontSize(9).fillColor("#b00020")
      .text("DRAFT - not approved", MARGIN, 24, { width, align: "right", lineBreak: false });
    doc.restore();
    doc.x = x; doc.y = y;
  };
  draftMark();
  doc.on("pageAdded", draftMark);

  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  // Urdu: drawn right to left with the embedded font; if it can't be, the Latin parts stay (pdfStatus warns)
  const urduOk = urdu.supported();
  const urduPara = (text, { x, w, font, size, color }) => {
    const t = safeKeepingUrdu(text);
    if (!t) return;
    // left-aligned like every other line, so the resume reads top to bottom as one column (text extraction
    // and ATS parsers read a right-aligned Urdu line as a separate column, after everything else)
    urdu.paragraph(doc, t, { x, y: doc.y, width: w, size, latinFont: font, color, lineGap: 1, bottom: bottom(), align: "left" });
  };
  const para = (text, { font = "Helvetica", size = BODY, color = INK, gap = 2, indent = 0 } = {}) => {
    if (urdu.hasArabic(text)) {
      if (urduOk) { urduPara(text, { x: MARGIN + indent, w: width - indent, font, size, color }); doc.y += gap; return; }
      text = urdu.withoutArabic(text).text;
    }
    const t = safe(text);
    if (!t) return;
    doc.font(font).fontSize(size).fillColor(color).text(t, MARGIN + indent, doc.y, { width: width - indent, lineGap: 1 });
    doc.y += gap;
  };
  const bullet = (text) => {
    if (urdu.hasArabic(text)) {
      if (urduOk) {
        const t = safeKeepingUrdu(text);
        ensure(urdu.heightOf(doc, t, { width: width - 12, size: BODY }));
        doc.circle(MARGIN + 4, doc.y + 8, 1.6).fill(INK);
        urduPara(t, { x: MARGIN + 12, w: width - 12, font: "Helvetica", size: BODY, color: INK });
        doc.y += 1;
        return;
      }
      text = urdu.withoutArabic(text).text;
    }
    const t = safe(text);
    if (!t) return;
    doc.font("Helvetica").fontSize(BODY);
    ensure(doc.heightOfString(t, { width: width - 12 }) > 40 ? 26 : doc.heightOfString(t, { width: width - 12 }));
    doc.circle(MARGIN + 4, doc.y + 5, 1.6).fill(INK);
    doc.fillColor(INK).text(t, MARGIN + 12, doc.y, { width: width - 12, lineGap: 1 });
    doc.y += 1;
  };
  const section = (title) => {
    ensure(48); // the heading plus at least the first entry's first lines
    doc.y += 6;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(title.toUpperCase(), MARGIN, doc.y, { width, characterSpacing: 0.5 });
    const y = doc.y + 1;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.6).strokeColor("#888888").stroke();
    doc.y = y + 5;
  };
  const entry = (heading, meta) => {
    ensure(40);
    para(heading, { font: "Helvetica-Bold", gap: 0 });
    if (meta) para(meta, { size: SMALL, color: MUTED, gap: 2 });
  };
  const link = (label, url) => ({ label: safe(label), url });

  // ---------- header ----------
  const pi = c.personalInfo;
  para(`${pi.firstName} ${pi.lastName}`, { font: "Helvetica-Bold", size: 18, gap: 0 });
  if (pi.title) para(pi.title, { size: 11, color: MUTED, gap: 1 });
  // a location written in Urdu gets its own line under the contacts (it can't share their left-to-right row)
  const urduLocation = pi.location && urdu.hasArabic(pi.location) ? pi.location : "";
  const contacts = [
    pi.email && link(pi.email, `mailto:${pi.email}`),
    pi.phone && link(pi.phone, null),
    pi.location && !urduLocation && link(pi.location, null),
    pi.linkedin && link(shownUrl(pi.linkedin), fullUrl(pi.linkedin)),
    pi.github && link(shownUrl(pi.github), fullUrl(pi.github)),
    pi.portfolio && link(shownUrl(pi.portfolio), fullUrl(pi.portfolio)),
  ].filter(Boolean);
  if (contacts.length) {
    // laid out by hand: one line of items left to right, wrapping between items, each link its own rectangle
    doc.font("Helvetica").fontSize(SMALL).fillColor(INK);
    const sep = "  |  ";
    const lineH = doc.currentLineHeight(true) + 2;
    let x = MARGIN;
    let y = doc.y;
    contacts.forEach((ct, i) => {
      const w = doc.widthOfString(ct.label);
      if (i > 0) {
        if (x + doc.widthOfString(sep) + w > MARGIN + width) { x = MARGIN; y += lineH; }
        else { doc.text(sep, x, y, { lineBreak: false }); x += doc.widthOfString(sep); }
      }
      doc.text(ct.label, x, y, { lineBreak: false });
      if (ct.url) doc.link(x, y, w, lineH - 2, ct.url);
      x += w;
    });
    doc.x = MARGIN;
    doc.y = y + lineH + 4;
  }
  if (urduLocation) para(urduLocation, { size: SMALL, gap: 4 });

  // ---------- sections ----------
  const summary = () => { if (c.professionalSummary.summary) { section("Summary"); para(c.professionalSummary.summary); } };
  const experience = () => {
    if (!c.workExperience.length) return;
    section("Experience");
    for (const w of c.workExperience) {
      entry(`${w.position}${w.company ? `, ${w.company}` : ""}`, [range(w.startDate, w.endDate, w.current), w.location].filter(Boolean).join("  |  "));
      if (w.description) para(w.description);
      w.achievements.forEach(bullet);
      doc.y += 3;
    }
  };
  const projects = () => {
    if (!c.projects.length) return;
    section("Projects");
    for (const p of c.projects) {
      entry(p.name, [range(p.startDate, p.endDate, false), p.technologies.join(", ")].filter(Boolean).join("  |  "));
      if (p.description) para(p.description);
      for (const u of [p.url, p.githubUrl].filter(Boolean)) {
        doc.font("Helvetica").fontSize(SMALL).fillColor(INK).text(safe(shownUrl(u)), MARGIN, doc.y, { width, link: fullUrl(u) });
      }
      doc.y += 3;
    }
  };
  const education = () => {
    if (!c.education.length) return;
    section("Education");
    for (const e of c.education) {
      entry(`${e.degree}${e.fieldOfStudy ? ` in ${e.fieldOfStudy}` : ""}${e.institution ? `, ${e.institution}` : ""}`, [range(e.startDate, e.endDate, e.current), e.gpa && `GPA ${e.gpa}`].filter(Boolean).join("  |  "));
      if (e.description) para(e.description);
      doc.y += 3;
    }
  };
  const skills = () => {
    if (!c.skills.length) return;
    section("Skills");
    para(c.skills.map((s) => s.name).join(", "));
  };
  const certifications = () => {
    if (!c.certifications.length) return;
    section("Certifications");
    for (const ct of c.certifications) {
      const line = [ct.name, ct.organization, ct.issueDate && `Issued ${month(ct.issueDate)}`].filter(Boolean).join("  |  ");
      if (urdu.hasArabic(line)) { ensure(20); para(line, { gap: 0 }); continue; }
      doc.font("Helvetica").fontSize(BODY).fillColor(INK);
      ensure(14);
      doc.text(safe(line), MARGIN, doc.y, { width, link: ct.credentialUrl ? fullUrl(ct.credentialUrl) : null });
    }
  };
  const languages = () => {
    if (!c.languages.length) return;
    section("Languages");
    para(c.languages.map((l) => (l.proficiency ? `${l.name} (${l.proficiency})` : l.name)).join(", "));
  };

  const fresher = c.workExperience.length === 0;
  const order = fresher
    ? [summary, projects, education, skills, experience, certifications, languages]
    : [summary, experience, skills, projects, education, certifications, languages];
  order.forEach((f) => f());
  doc.end();
  return done;
}

/** What to tell the student before exporting this content: { urdu: none | included | not_included, message } */
const pdfStatus = (content) => urdu.pdfStatus(content);

module.exports = { render, RENDERER_VERSION, safe, pdfStatus };
