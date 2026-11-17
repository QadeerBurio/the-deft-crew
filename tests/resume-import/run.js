// Resume upload auto-fill (fix/resume-import): text PDF and DOCX are read, the AI's JSON is checked against the
// file (nothing invented), scans are refused with a plain message, a failed / slow AI keeps the contact details,
// the resume gets a sensible name and a "resume strength" that matches the app's calculation.
//   node tests/resume-import/run.js [serverDir]
// Real route + model on fake-mongo; the AI is a stub per case (no network).
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
delete process.env.OPENAI_API_KEY;
process.env.RESUME_IMPORT_TIMEOUT_MS = "400";
// the route file (and the services it loads) build OpenAI clients at load: a stub that never reaches the network
const load0 = Module._load;
Module._load = function (request) {
  if (request === "openai") return class OpenAI { constructor() { const no = async () => { throw new Error("AI off in tests"); }; this.chat = { completions: { create: no } }; this.embeddings = { create: no }; } };
  return load0.apply(this, arguments);
};
const h = require("../hiring-fixes/harness")(SERVER, { models: ["Resume", "ResumeCreationLock", "EngagementEvent"] });
const { reqS, app, call, check, rows, oid, user, token, fake, coll } = h;
const importer = reqS("./services/resumeImport");
const rules = reqS("./utils/resumeRules");
const JSZip = reqS("jszip");

// the stubbed multer leaves req.file empty: the test sends { name, b64 } and this writes it like multer would
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-import-"));
app.use("/api/resume", (req, res, next) => {
  if (req.method === "POST" && req.path === "/upload" && req.body && req.body.b64) {
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(req.body.name)}`;
    const p = path.join(tmp, filename);
    fs.writeFileSync(p, Buffer.from(req.body.b64, "base64"));
    req.file = { path: p, originalname: req.body.name, filename };
  }
  next();
}, reqS("./routes/resume.routes"));

// ---------- sample files ----------
const FULL = [
  "Ayesha Khan",
  "HR Intern",
  "ayesha.khan@example.com | +92 300 1234567 | Karachi, Pakistan",
  "linkedin.com/in/ayeshakhan",
  "SUMMARY",
  "Business student who enjoys hiring and onboarding. Organised campus job fair for 300 students.",
  "EXPERIENCE",
  "HR Intern, Acme Textiles, Karachi, Jun 2023 - Aug 2023",
  "- Screened 120 CVs for three roles",
  "- Scheduled 40 interviews with hiring managers",
  "Volunteer, Edhi Foundation, 2022 - Present",
  "- Managed donation drive records",
  "EDUCATION",
  "Institute of Business Administration, BBA, Human Resource Management, 2021 - 2025, CGPA 3.6/4.0",
  "SKILLS",
  "Recruitment, MS Excel, Communication, Onboarding, Payroll basics",
  "PROJECTS",
  "Campus Job Fair - organised a job fair with 25 employers",
  "CERTIFICATIONS",
  "Google Project Management Certificate, Coursera, 2024",
  "LANGUAGES",
  "English (Fluent), Urdu (Native)",
  "ACHIEVEMENTS",
  "Dean's List 2023",
  "HOBBIES",
  "Cricket and debate club",
].join("\n");
const FULL_AI = {
  personal: { fullName: "Ayesha Khan", firstName: "Ayesha", lastName: "Khan", email: "ayesha.khan@example.com", phone: "+92 300 1234567", city: "Karachi", country: "Pakistan", linkedin: "linkedin.com/in/ayeshakhan", github: "", portfolio: "" },
  title: "HR Intern",
  summary: "Business student who enjoys hiring and onboarding. Organised campus job fair for 300 students.",
  experience: [
    { company: "Acme Textiles", role: "HR Intern", location: "Karachi", startDate: "2023-06", endDate: "2023-08", description: "", bullets: ["Screened 120 CVs for three roles", "Scheduled 40 interviews with hiring managers"] },
    { company: "Edhi Foundation", role: "Volunteer", startDate: "2022", endDate: "Present", bullets: ["Managed donation drive records"] },
    // invented by the AI: not in the file
    { company: "Google", role: "Software Engineer", startDate: "2019", endDate: "2020", bullets: ["Led a team of 50 engineers"] },
  ],
  education: [{ school: "Institute of Business Administration", degree: "BBA", field: "Human Resource Management", startDate: "2021", endDate: "2025", grade: "3.6/4.0" }],
  skills: ["Recruitment", "MS Excel", "Communication", "Onboarding", "Payroll basics", "Kubernetes"],
  projects: [{ name: "Campus Job Fair", description: "organised a job fair with 25 employers", bullets: [], technologies: [] }],
  certifications: [{ name: "Google Project Management Certificate", issuer: "Coursera", date: "2024" }],
  languages: [{ name: "English", level: "Fluent" }, { name: "Urdu", level: "Native" }],
  achievements: ["Dean's List 2023"],
  other: ["Cricket and debate club"],
};
const SPARSE = "Bilal Ahmed\nbilal.ahmed@example.com\nEDUCATION\nNED University of Engineering and Technology, BE Civil Engineering, 2022 - 2026";
const SPARSE_AI = {
  personal: { fullName: "Bilal Ahmed", email: "bilal.ahmed@example.com" },
  title: "", summary: "Motivated civil engineering student with a passion for excellence.", // invented summary
  experience: [], education: [{ school: "NED University of Engineering and Technology", degree: "BE", field: "Civil Engineering", startDate: "2022", endDate: "2026" }],
  skills: [], projects: [], certifications: [], languages: [], achievements: [], other: [],
};

// a small, valid PDF written by hand (pdfkit 0.18's cross-reference stream trips pdf-parse's bundled pdf.js):
// text lines in Helvetica, or (scan) one grey image and no text at all
function makePdf(lines) {
  const NL = "\n";
  const esc = (s) => s.split("\\").join("\\\\").split("(").join("\(").split(")").join("\)");
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  let content;
  if (lines) {
    objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
    content = ["BT /F1 10 Tf 40 800 Td 12 TL", ...lines.map((l) => "(" + esc(l) + ") Tj T*"), "ET"].join(NL);
  } else {
    objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>");
    content = "q 500 0 0 700 40 60 cm /Im1 Do Q";
  }
  objs.push("<< /Length " + Buffer.byteLength(content, "latin1") + " >>" + NL + "stream" + NL + content + NL + "endstream");
  if (lines) objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  else objs.push("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>" + NL + "stream" + NL + "\x80\x90\xa0\xb0" + NL + "endstream");
  let out = "%PDF-1.4" + NL;
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += (i + 1) + " 0 obj" + NL + o + NL + "endobj" + NL; });
  const xref = Buffer.byteLength(out, "latin1");
  out += "xref" + NL + "0 " + (objs.length + 1) + NL + "0000000000 65535 f " + NL + offs.map((n) => String(n).padStart(10, "0") + " 00000 n " + NL).join("");
  out += "trailer" + NL + "<< /Size " + (objs.length + 1) + " /Root 1 0 R >>" + NL + "startxref" + NL + xref + NL + "%%EOF" + NL;
  return Buffer.from(out, "latin1");
}
const pdf = async (text) => makePdf(text.replace(/[–—]/g, "-").split("\n"));
const scanPdf = async () => makePdf(null);
async function docx(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    text.split("\n").map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join("") + "</w:body></w:document>");
  return zip.generateAsync({ type: "nodebuffer" });
}

// the AI stub: answers with `json`, or hangs, or says nonsense; records the text it was given
let seen = [];
const ai = (mode, json) => importer._setClient({ chat: { completions: { create: async (args) => {
  seen.push(args.messages[1].content);
  if (mode === "hang") return new Promise(() => {});
  if (mode === "bad") return { choices: [{ message: { content: "{not json" } }] };
  return { choices: [{ message: { content: JSON.stringify(json) } }] };
} } } });

const users = [];
async function newStudent() {
  const id = oid();
  await reqS("./models/User").collection.insertOne(user(id, "student", `Student ${users.length}`));
  users.push(id);
  return { id, tok: token(id, "student") };
}
const up = (tok, name, buf) => call("POST", "/api/resume/upload", { tok, body: { name, b64: buf.toString("base64") } });
const section = (r, key) => (r.json?.import?.sections || []).find((x) => x.key === key) || {};
const resumesOf = (id) => rows("Resume", (r) => String(r.user) === String(id));

(async () => {
  const server = h.start();

  // ---------- 1. full PDF ----------
  {
    const s = await newStudent();
    ai("ok", FULL_AI); seen = [];
    const r = await up(s.tok, "Ayesha_CV_final.pdf", await pdf(FULL));
    check("full PDF: 200 with the resume", r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 200)}`);
    const d = r.json?.data || {};
    check("full PDF: the AI got the bullets as written (no header rewriting)", seen[0]?.includes("Screened 120 CVs for three roles") && seen[0]?.includes("Business student who enjoys hiring"));
    check("full PDF: name, email, phone, city, LinkedIn", d.personalInfo?.firstName === "Ayesha" && d.personalInfo?.lastName === "Khan" && d.personalInfo?.email === "ayesha.khan@example.com" && d.personalInfo?.phone === "+92 300 1234567" && d.personalInfo?.city === "Karachi" && d.personalInfo?.linkedin === "linkedin.com/in/ayeshakhan", JSON.stringify(d.personalInfo));
    check("full PDF: title and summary as written", d.personalInfo?.title === "HR Intern" && d.professionalSummary?.summary === FULL_AI.summary);
    check("full PDF: 2 experiences with dates and bullets (the invented Google job dropped)", d.workExperience?.length === 2 && !JSON.stringify(d.workExperience).includes("Google") &&
      new Date(d.workExperience[0].startDate).toISOString().startsWith("2023-06") && d.workExperience[0].achievements.length === 2 && d.workExperience[1].current === true, JSON.stringify(d.workExperience));
    check("full PDF: education with field, dates, grade as written and gpa", d.education?.[0]?.institution === "Institute of Business Administration" && d.education[0].fieldOfStudy === "Human Resource Management" && d.education[0].grade === "3.6/4.0" && d.education[0].gpa === 3.6 && new Date(d.education[0].endDate).getUTCFullYear() === 2025, JSON.stringify(d.education));
    check("full PDF: 5 skills, the invented one (Kubernetes) dropped", d.skills?.length === 5 && !d.skills.some((k) => k.name === "Kubernetes"), JSON.stringify(d.skills?.map((k) => k.name)));
    check("full PDF: projects, certifications, languages, achievements", d.projects?.[0]?.name === "Campus Job Fair" && d.certifications?.[0]?.organization === "Coursera" && d.languages?.length === 2 && d.achievements?.[0] === "Dean's List 2023");
    check("full PDF: hobbies kept in other notes, not lost", d.otherNotes === "Cricket and debate club");
    check("full PDF: report says 'we filled in N sections' with a status per section", /^we filled in \d+ sections, please check\.$/.test(r.json?.import?.message) && section(r, "experience").status === "filled" && section(r, "other").status === "check" && section(r, "skills").status === "filled" && section(r, "personal").status === "filled", JSON.stringify(r.json?.import));
    check("full PDF: invented values are counted, never saved", r.json?.import?.dropped >= 2);
    check("full PDF: resume name '<Full name> – <title>', not the file name", d.name === "Ayesha Khan – HR Intern" && d.nameCustom === false && !/\.pdf|CV_final/i.test(d.name), d.name);
    check("full PDF: resume strength = the shared calculation", d.completionPercentage === rules.resumeStrength(d).score && d.completionPercentage >= 80, `${d.completionPercentage} vs ${rules.resumeStrength(d).score}`);
    check("full PDF: no AI rewrite or made-up scores on upload", !d.optimizedSummary && !(d.hrRecommendations || []).length);
  }

  // ---------- 2. DOCX ----------
  {
    const s = await newStudent();
    ai("ok", FULL_AI);
    const r = await up(s.tok, "Ayesha Khan.docx", await docx(FULL));
    const d = r.json?.data || {};
    check("DOCX: read and filled like the PDF", r.status === 200 && d.workExperience?.length === 2 && d.education?.length === 1 && d.skills?.length === 5 && d.personalInfo?.email === "ayesha.khan@example.com", `${r.status} ${r.text.slice(0, 200)}`);
  }

  // ---------- 3. sparse PDF ----------
  {
    const s = await newStudent();
    ai("ok", SPARSE_AI);
    const r = await up(s.tok, "bilal.pdf", await pdf(SPARSE));
    const d = r.json?.data || {};
    check("sparse PDF: name, email, education filled", r.status === 200 && d.personalInfo?.firstName === "Bilal" && d.education?.[0]?.institution === "NED University of Engineering and Technology");
    check("sparse PDF: no invented summary, no filler text", d.professionalSummary?.summary === "" && !/experienced professional|motivated/i.test(JSON.stringify(d)));
    check("sparse PDF: empty sections reported empty", section(r, "experience").status === "empty" && section(r, "skills").status === "empty" && section(r, "summary").status === "empty");
    check("sparse PDF: name without a title is '<Full name> – Resume'", d.name === "Bilal Ahmed – Resume", d.name);
    check("sparse PDF: strength lists what is missing", rules.resumeStrength(d).missing.some((m) => m.text === "add 5 more skills"));
  }

  // ---------- 4. scanned PDF ----------
  {
    const s = await newStudent();
    ai("ok", FULL_AI); seen = [];
    const r = await up(s.tok, "scan.pdf", await scanPdf());
    check("scan: 422 RESUME_SCAN with the plain message", r.status === 422 && r.json?.code === "RESUME_SCAN" && r.json?.error === "this file looks like a scan, please type your details or upload a text PDF.", `${r.status} ${r.text}`);
    check("scan: no resume created, the AI not called", resumesOf(s.id).length === 0 && seen.length === 0);
  }

  // ---------- 5. AI too slow: partial, contact details kept ----------
  {
    const s = await newStudent();
    ai("hang");
    const t0 = Date.now();
    const r = await up(s.tok, "ayesha.pdf", await pdf(FULL));
    const d = r.json?.data || {};
    check("AI timeout: answered at the limit (not hanging)", Date.now() - t0 < 5000);
    check("AI timeout: saved as partial with a plain message", r.status === 200 && r.json?.import?.status === "partial" && /took too long/.test(r.json?.import?.message) && r.json?.import?.reason === "timeout", r.text.slice(0, 300));
    check("AI timeout: name, email, phone, LinkedIn kept", d.personalInfo?.firstName === "Ayesha" && d.personalInfo?.lastName === "Khan" && d.personalInfo?.email === "ayesha.khan@example.com" && /300 1234567/.test(d.personalInfo?.phone) && /linkedin\.com\/in\/ayeshakhan/.test(d.personalInfo?.linkedin), JSON.stringify(d.personalInfo));
    check("AI timeout: nothing made up for the rest", (d.workExperience || []).length === 0 && d.professionalSummary?.summary === "" && (d.skills || []).length === 0);
  }

  // ---------- 6. AI answers nonsense / no AI ----------
  {
    const s = await newStudent();
    ai("bad");
    const r = await up(s.tok, "ayesha.pdf", await pdf(FULL));
    check("bad AI JSON: partial, contact kept", r.status === 200 && r.json?.import?.status === "partial" && r.json?.data?.personalInfo?.email === "ayesha.khan@example.com");
    importer._setClient(null);
    const r2 = await up(s.tok, "ayesha.docx", await docx(FULL));
    check("no AI key: partial, contact kept", r2.status === 200 && r2.json?.import?.status === "partial" && r2.json?.import?.reason === "no_ai" && r2.json?.data?.personalInfo?.firstName === "Ayesha");
  }

  // ---------- 7. old .doc ----------
  {
    const s = await newStudent();
    const r = await up(s.tok, "old.doc", Buffer.from("not really a doc file"));
    check(".doc: 422 RESUME_UNSUPPORTED asking for PDF or DOCX", r.status === 422 && r.json?.code === "RESUME_UNSUPPORTED" && /PDF or a Word \(\.docx\)/.test(r.json?.error) && resumesOf(s.id).length === 0);
  }

  // ---------- 8. the resume name is editable; empty goes back to the default ----------
  {
    const s = await newStudent();
    ai("ok", FULL_AI);
    const r = await up(s.tok, "a.pdf", await pdf(FULL));
    const id = r.json?.data?._id;
    const p1 = await call("PUT", `/api/resume/${id}`, { tok: s.tok, body: { name: "Ayesha – HR applications" } });
    check("rename: the student's own name is kept", p1.status === 200 && p1.json?.data?.name === "Ayesha – HR applications" && p1.json?.data?.nameCustom === true, p1.text.slice(0, 200));
    const p2 = await call("PUT", `/api/resume/${id}`, { tok: s.tok, body: { personalInfo: { title: "Recruitment Intern" } } });
    check("rename: a later title change doesn't overwrite it", p2.json?.data?.name === "Ayesha – HR applications");
    const p3 = await call("PUT", `/api/resume/${id}`, { tok: s.tok, body: { name: "   " } });
    check("rename: an empty name goes back to the default with the new title", p3.json?.data?.name === "Ayesha Khan – Recruitment Intern" && p3.json?.data?.nameCustom === false, p3.json?.data?.name);
    const p4 = await call("PUT", `/api/resume/${id}`, { tok: s.tok, body: { achievements: ["Dean's List 2023", "Best intern award"], otherNotes: "Cricket" } });
    check("update: achievements and other notes saved", p4.json?.data?.achievements?.length === 2 && p4.json?.data?.otherNotes === "Cricket");
  }

  // ---------- 9. the shared rules ----------
  {
    const st = rules.resumeStrength({ personalInfo: { firstName: "A", email: "a@b.co" }, workExperience: [{ company: "Acme", position: "Intern" }], skills: [{ name: "Excel" }, { name: "Word" }, { name: "Talking" }] });
    check("strength: 'add 2 more skills'", st.missing.some((m) => m.text === "add 2 more skills" && m.step === 7), JSON.stringify(st.missing));
    check("strength: 'add dates to your experience at Intern at Acme'", st.missing.some((m) => m.key === "experience_dates" && m.text === "add dates to your experience at Intern at Acme" && m.step === 3));
    check("strength: 0-100 and a label", st.score > 0 && st.score < 100 && typeof st.label === "string");
    check("strength: an empty resume is 0 with everything listed", rules.resumeStrength({}).score === 0 && rules.resumeStrength({}).missing.length >= 8);
    const fe = rules.finishErrors({ personalInfo: {} });
    check("finish: name, contact and background required", fe.map((e) => e.field).join() === "name,contact,background");
    check("finish: phone alone is enough contact; a project alone is enough background", rules.finishErrors({ personalInfo: { firstName: "A", phone: "0300" }, projects: [{ name: "X" }] }).length === 0);
    check("finish: optional sections never block", rules.finishErrors({ personalInfo: { firstName: "A", email: "a@b.co" }, education: [{ institution: "IBA" }] }).length === 0);
    check("name: never 'Untitled' or a file name", rules.resumeName({ name: "Untitled", nameCustom: true }) === "My resume" && rules.resumeName({ name: "ayesha_cv.pdf", nameCustom: true }) === "ayesha cv" && rules.defaultResumeName({ personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "Ayesha Khan" } }) === "Ayesha Khan – Resume");
    check("pdf name: '<Full name> Resume.pdf'", rules.pdfFileName({ personalInfo: { firstName: "Ayesha", lastName: "Khan" } }) === "Ayesha Khan Resume.pdf" && rules.pdfFileName({}) === "My Resume.pdf");
  }

  // ---------- 10. normalizer edge cases ----------
  {
    const { parseDate } = reqS("./services/resumeImport/normalize");
    const g = { year: () => true };
    check("dates: 'Jun 2023', '06/2023', '2023-06', '2023', 'Present'", new Date(parseDate("Jun 2023", g).date).getUTCMonth() === 5 && parseDate("06/2023", g).date.getUTCMonth() === 5 && parseDate("2023-06", g).date.getUTCFullYear() === 2023 && parseDate("2023", g).date.getUTCMonth() === 0 && parseDate("Present", g).current === true);
    check("dates: nonsense -> nothing (no CastError on save)", Object.keys(parseDate("sometime", g)).length === 0 && Object.keys(parseDate("2023-13", g)).length === 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
