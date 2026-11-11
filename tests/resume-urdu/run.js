// Urdu in resume PDFs (services/pdfText/urdu.js): the ATS Classic renderer and the older pdfService.
//   With the embedded font: letters joined (shaped) and right to left, every Urdu letter extracts as itself
//   (pdftotext), mixed Urdu / English lines keep every word, the page reads top to bottom (name first, each
//   heading before its text), English-only resumes are unchanged (no Urdu font embedded).
//   Without it (RESUME_PDF_URDU=off, or the font can't shape): the Latin layout stays, the Urdu text is left
//   out (never drawn as broken glyphs), and the student is told before export (pdf.urdu = not_included).
//   node tests/resume-urdu/run.js [serverDir]       (needs pdftotext: poppler, e.g. Git for Windows' mingw64)
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const { PassThrough } = require("stream");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = require("module").createRequire(path.join(SERVER, "server.js"));
const urdu = reqS("./services/pdfText/urdu");
const renderer = reqS("./services/resumeStudio/renderer");
const { generateResumePDF } = reqS("./services/pdfService");
const drafts = reqS("./services/resumeStudio/drafts");
const fontkit = reqS("fontkit");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  -> ${String(extra).slice(0, 400)}`}`); };
const pdftotext = (() => {
  for (const p of ["pdftotext", "/mingw64/bin/pdftotext", "C:/Program Files/Git/mingw64/bin/pdftotext.exe"]) {
    const r = spawnSync(p, ["-v"], { stdio: "ignore" });
    if (!r.error) return p;
  }
  return null;
})();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urdu-pdf-"));
const textOf = (buf, mode = []) => {
  const f = path.join(tmp, `${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  const r = spawnSync(pdftotext, [...mode, "-enc", "UTF-8", f, "-"], { encoding: "utf8" });
  // drop the direction marks pdftotext adds around right-to-left runs
  return (r.stdout || "").replace(/[\u202A-\u202E]/g, "").normalize("NFC");
};
const lines = (s) => s.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
const pdfServiceBuffer = (resume) => new Promise((resolve) => {
  const out = new PassThrough();
  const chunks = [];
  out.headers = {};
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.headersSent = false;
  out.on("data", (c) => chunks.push(c));
  out.on("end", () => resolve({ buf: Buffer.concat(chunks), headers: out.headers }));
  generateResumePDF(resume, out);
});
const embedsUrduFont = (buf) => buf.toString("latin1").includes("ScheherazadeNew");

// real words that together use every Urdu letter (and آ ؤ ئ ۓ أ, لا)
const WORDS = "آرڈر ابھی پاکستان ٹیم ثابت جگہ چھوٹا حل خوش دفتر ڈیٹا ذریعہ رنگ پڑھا زبان ژالہ سب شہر صفحہ ضرور طلبہ ظاہر عمل غلط فون قلم کام گھر لاہور مزید نیا میں وقت ہاں ھر بھائی جائے گئۓ مؤثر أمر یہ اپنے ہوگے";
const URDU_LINE = "میرا نام عائشہ ہے اور میں کراچی میں ڈیٹا کا کام کرتی ہوں";
const MIXED = "میں React اور Node.js جانتی ہوں اور 2024 سے ویب ایپس بنا رہی ہوں";
const content = (over = {}) => ({
  personalInfo: { firstName: "عائشہ", lastName: "خان", title: "Frontend Developer", email: "ayesha@example.com", phone: "+92 300 0000000", location: "کراچی", linkedin: "", github: "", portfolio: "" },
  professionalSummary: { summary: MIXED },
  workExperience: [{ company: "Bright Labs", position: "Frontend Intern", location: "Karachi", startDate: "2025-06", endDate: "2025-08", current: false, description: `Built the dashboard. ${URDU_LINE}`, achievements: ["آرڈر ٹریکنگ کا صفحہ بنایا", "Shipped every two weeks"] }],
  education: [{ institution: "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: "2022-09", endDate: "2026-06", current: false, gpa: "3.6", description: WORDS }],
  projects: [], skills: [{ name: "JavaScript", category: "" }, { name: "React", category: "" }], certifications: [], languages: [{ name: "اردو", proficiency: "Native" }, { name: "English", proficiency: "Fluent" }],
  ...over,
});
const latinOnly = () => content({
  personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "Frontend Developer", email: "ayesha@example.com", phone: "+92 300 0000000", location: "Karachi", linkedin: "", github: "", portfolio: "" },
  professionalSummary: { summary: "I build web apps with React and Node.js." },
  workExperience: [{ company: "Bright Labs", position: "Frontend Intern", location: "Karachi", startDate: "2025-06", endDate: "2025-08", current: false, description: "Built the dashboard.", achievements: ["Shipped every two weeks"] }],
  education: [{ institution: "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: "2022-09", endDate: "2026-06", current: false, gpa: "3.6", description: "" }],
  languages: [{ name: "English", proficiency: "Fluent" }],
});
const urduWords = (s) => s.split(/\s+/).filter((w) => urdu.hasArabic(w));

(async () => {
  if (!pdftotext) { console.log("SKIP  pdftotext not found (install poppler) - the extraction checks need it"); process.exit(1); }
  console.log("-- the font");
  const fontDir = path.join(SERVER, "assets", "fonts");
  check("Scheherazade New (regular + bold) and its Open Font License are in assets/fonts", ["ScheherazadeNew-Regular.ttf", "ScheherazadeNew-Bold.ttf", "OFL-ScheherazadeNew.txt"].every((f) => fs.existsSync(path.join(fontDir, f))) && /SIL Open Font License/.test(fs.readFileSync(path.join(fontDir, "OFL-ScheherazadeNew.txt"), "utf8")));
  check("supported(): the font loads and shapes", urdu.supported() === true);
  const run = fontkit.openSync(urdu.FONTS.regular).layout("پاکستان");
  check("shaping: joined letter forms (init / medi / fina), right to left, no missing glyph", run.direction === "rtl" && run.glyphs.every((g) => g.id !== 0) && run.glyphs.some((g) => /\.(init|medi|fina)/.test(g.name)), run.glyphs.map((g) => g.name).join(" "));

  console.log("-- ATS Classic renderer, with Urdu");
  const buf = await renderer.render(content());
  const t = textOf(buf);
  const tl = textOf(buf, ["-layout"]);
  check(`renderer version bumped (output changed): ${renderer.RENDERER_VERSION}`, renderer.RENDERER_VERSION === "ats-classic-2");
  check("an Urdu-only sentence extracts exactly, in order", lines(tl).some((l) => l.includes(URDU_LINE)), lines(tl).filter((l) => urdu.hasArabic(l)).join(" / "));
  const allWords = urduWords(WORDS);
  const missing = allWords.filter((w) => !tl.includes(w.normalize("NFC")));
  check(`every Urdu letter extracts as itself: ${allWords.length} words using the whole alphabet (and آ ؤ ئ ۓ أ لا) are all in the text`, missing.length === 0, missing.join(" "));
  const mixedMissing = MIXED.split(" ").filter((w) => !t.includes(w));
  check("a mixed Urdu / English line keeps every word (React, Node.js, 2024 in it)", mixedMissing.length === 0, mixedMissing.join(" "));
  const order = ["عائشہ خان", "Frontend Developer", "ayesha@example.com", "کراچی", "SUMMARY", "React", "EXPERIENCE", "Frontend Intern", "آرڈر ٹریکنگ کا صفحہ بنایا", "EDUCATION", "LANGUAGES", "اردو"].map((s) => t.indexOf(s));
  check("reading order (pdftotext): name, title, contacts, location, then each heading before its text", order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1])), JSON.stringify(order));
  check("the Urdu font is embedded (subset)", embedsUrduFont(buf));
  const lbuf = await renderer.render(latinOnly());
  const lt = lines(textOf(lbuf));
  check("an English-only resume embeds no Urdu font and reads as before (name, contacts, sections in order)", !embedsUrduFont(lbuf) && lt[0] === "Ayesha Khan" && lt.some((l) => l.includes("ayesha@example.com | +92 300 0000000 | Karachi")), lt.slice(0, 4).join(" / "));
  check("pdfStatus: Urdu content → included (no message); English only → none", renderer.pdfStatus(content()).urdu === "included" && !renderer.pdfStatus(content()).message && renderer.pdfStatus(latinOnly()).urdu === "none");
  const doc = { personalInfo: { firstName: "عائشہ" }, toObject() { const o = { personalInfo: this.personalInfo }; o.self = o; o.$__ = { parent: o }; return o; } };
  let threw = null;
  try { renderer.pdfStatus(doc); } catch (e) { threw = e.message; }
  check("pdfStatus on a Mongoose document (circular internals): no crash, Urdu found", !threw && renderer.pdfStatus(doc).urdu === "included", threw);
  const draft = { _id: "d1", resumeId: "r1", status: "open", revision: 1, target: {}, suggestions: [], facts: [], sourceContent: content() };
  check("the Resume Studio draft view says what the PDF will hold (pdf.urdu = included)", drafts.studentView(draft).pdf.urdu === "included");

  console.log("-- older resume PDF (pdfService), with Urdu");
  const p = await pdfServiceBuffer(content());
  const pt = textOf(p.buf);
  const porder = ["عائشہ خان", "FRONTEND DEVELOPER", "ayesha@example.com", "PROFESSIONAL SUMMARY", "React", "EXPERIENCE", "آرڈر ٹریکنگ کا صفحہ بنایا", "EDUCATION"].map((s) => pt.indexOf(s));
  check("pdfService: Urdu drawn and extractable, reading order name → title → contacts → sections", porder.every((x, i) => x >= 0 && (i === 0 || x > porder[i - 1])) && !p.headers["X-Resume-Warning"], JSON.stringify(porder));
  check("pdfService: every Urdu word of the education line extracts", allWords.every((w) => textOf(p.buf, ["-layout"]).includes(w.normalize("NFC"))), allWords.filter((w) => !textOf(p.buf, ["-layout"]).includes(w)).join(" "));
  const pl = await pdfServiceBuffer({ personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "Frontend Developer", email: "a@example.com", location: "Karachi" }, professionalSummary: { summary: "I build web apps with React and Node.js" }, workExperience: [{ position: "Data intern", company: "Bright Labs", startDate: "2025-06-01", endDate: "2025-08-01", description: "Built the dashboard.", achievements: ["Built the order tracking page"] }], education: [], skills: [], certifications: [], projects: [], languages: [] });
  check("pdfService, English only: unchanged (centred header first, no Urdu font)", !embedsUrduFont(pl.buf) && lines(textOf(pl.buf)).slice(0, 3).join(" / ") === "Ayesha Khan / FRONTEND DEVELOPER / a@example.com | Karachi", lines(textOf(pl.buf)).slice(0, 3).join(" / "));

  console.log("-- without Urdu support (RESUME_PDF_URDU=off): Latin layout kept, Urdu left out, the student told");
  process.env.RESUME_PDF_URDU = "off";
  urdu.supported.reset();
  check("supported() is false", urdu.supported() === false);
  const st = renderer.pdfStatus(content());
  check("pdfStatus: not_included, with a message for the student before export", st.urdu === "not_included" && /Urdu text can't be included/.test(st.message));
  check("…in the Resume Studio draft view too", drafts.studentView(draft).pdf.urdu === "not_included" && /can't be included/.test(drafts.studentView(draft).pdf.message));
  const fb = await renderer.render(content());
  const ft = textOf(fb);
  check("renderer: no Urdu font, no Arabic-script text, no broken glyphs (? or �) in the PDF", !embedsUrduFont(fb) && !urdu.hasArabic(ft) && !/[?\uFFFD]/.test(ft), ft.slice(0, 200));
  check("…the English text and the layout stay (title, contacts, headings, the English half of a mixed line)", ["Frontend Developer", "ayesha@example.com", "SUMMARY", "React", "Node.js", "EXPERIENCE", "Built the dashboard.", "Shipped every two weeks", "EDUCATION"].every((s) => ft.includes(s)));
  const fp = await pdfServiceBuffer(content());
  const fpt = textOf(fp.buf);
  check("pdfService: Urdu left out (no broken glyphs), English kept, and X-Resume-Warning: urdu-not-included", !urdu.hasArabic(fpt) && !/\uFFFD/.test(fpt) && fpt.includes("Built the dashboard.") && fp.headers["X-Resume-Warning"] === "urdu-not-included", JSON.stringify(fp.headers));
  delete process.env.RESUME_PDF_URDU;
  urdu.supported.reset();
  check("switched back on: supported again", urdu.supported() === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
