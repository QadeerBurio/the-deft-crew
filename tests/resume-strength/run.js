// Resume full fix: "resume strength" v2 on the server (models/Resume.js strength, routes/resume.routes.js).
//   the bug: a resume at 100% (completionPercentage, the old field count) with thin content → strength well below 100,
//     the gaps say what to add; completionPercentage itself is unchanged (the 1.2.x app shows it)
//   the page: POST /:id/layout stores the app's measurement; it only counts while its key matches the resume as it is
//     (layoutKey of the same render); a change makes it stale; strength 100 only with every minimum AND >= 85% of one page
//   a fresher with no work experience reaches 100
//   settings: gate only turns on, waived only known keys; skills: groups checked, no level the student didn't give
//   analytics: strength v2 with resumeV2 on, the old number with it off; the home card reads strength under resumeV2
//   upload: the track asked first is stored, activities / volunteering / awards get their own sections, uncertain
//     values are listed, no skill / language level is invented
//   profile facts: education with years, bio, the professional profile and verified hires (never a guessed job)
//   old app (1.2.x) payloads still save and score as before
//   node tests/resume-strength/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
delete process.env.OPENAI_API_KEY;
const load0 = Module._load;
Module._load = function (request) {
  if (request === "openai") return class OpenAI { constructor() { const no = async () => { throw new Error("AI off in tests"); }; this.chat = { completions: { create: no } }; this.embeddings = { create: no }; } };
  return load0.apply(this, arguments);
};
const h = require("../hiring-fixes/harness")(SERVER, { models: ["Resume", "ResumeCreationLock", "EngagementEvent", "ProfessionalProfile"] });
const { reqS, app, call, check, oid, user, token, fake, coll } = h;
const importer = reqS("./services/resumeImport");
const rules = reqS("./utils/resumeRules");
const render = reqS("./utils/resumeRender");
const JSZip = reqS("jszip");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-strength-"));
app.use("/api/resume", (req, res, next) => {
  if (req.method === "POST" && req.path === "/upload" && req.body && req.body.b64) {
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(req.body.name)}`;
    const p = path.join(tmp, filename);
    fs.writeFileSync(p, Buffer.from(req.body.b64, "base64"));
    req.file = { originalname: req.body.name, path: p, filename, mimetype: "application/octet-stream" };
  }
  next();
});
app.use("/api/resume", reqS("./routes/resume.routes"));

const S = oid(); const F = oid();
fake.seed(coll("User"), [
  { ...user(S, "student", "Ayesha Khan"), email: "ayesha.khan@example.com", phone: "+92 300 1234567", bio: "BBA student who runs the marketing society page.", education: [{ school: "IBA Karachi", degree: "BBA", startYear: "2022", endYear: "2026" }] },
  user(F, "student", "Fresher Student"),
]);
fake.seed(coll("ProfessionalProfile"), [{ _id: oid(), userId: S, headline: "Marketing student", university: "IBA Karachi", fieldOfStudy: "Marketing", skills: ["Canva", "Excel"], portfolioLinks: ["https://linkedin.com/in/ayesha-khan"] }]);
const T = { S: token(S, "student"), F: token(F, "student") };

const THIN = {
  personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "a@example.com", phone: "0300 1234567", city: "Lahore", title: "HR Intern" },
  professionalSummary: { summary: "Motivated BBA student looking for an HR role." },
  workExperience: [{ company: "ABC", position: "Intern", startDate: "2025-06-01", description: "Helped HR team." }],
  education: [{ institution: "IBA", degree: "BBA", startDate: "2022-09-01", endDate: "2026-06-01" }],
  projects: [{ name: "FYP", description: "HR survey app" }],
  skills: ["Excel", "Word", "Teamwork", "Communication", "HR"].map((name) => ({ name })),
  languages: [{ name: "Urdu" }],
};
// a fresher with everything a strong one-page resume needs, and no work experience at all
const FRESHER = {
  personalInfo: { firstName: "Sara", lastName: "Example", email: "sara.example@example.com", phone: "+92 300 7654321", city: "Karachi", linkedin: "linkedin.com/in/sara-example" },
  professionalSummary: { summary: "Final-year BBA student at Sample University who ran the marketing society's Instagram and built two class projects in Excel and Canva. Looking for a marketing internship." },
  targetJob: { jobTitle: "Marketing intern" },
  settings: { track: "fresher" },
  education: [{ institution: "Sample University", degree: "BBA", fieldOfStudy: "Marketing", startDate: "2022-09-01", endDate: "2026-06-01", description: "- Dean's list in 2 semesters" }],
  coursework: ["Digital Marketing", "Consumer Behaviour"],
  projects: [
    { name: "Cafe business plan", technologies: ["Excel"], description: "A class business plan for a campus cafe: researched demand from 120 students and wrote the pricing section; graded A." },
    { name: "Society Instagram page", technologies: ["Canva"], description: "Designed weekly posts for the marketing society page; followers grew from 300 to 900 in one semester." },
  ],
  skills: [{ name: "Excel", group: "tools" }, { name: "Canva", group: "tools" }, { name: "Market research", group: "technical" }, { name: "Copywriting", group: "technical" }, { name: "Teamwork", group: "soft" }, { name: "Presenting", group: "soft" }],
  activities: [{ organisation: "Marketing Society", role: "Social media lead", bullets: ["Ran the society's Instagram with 900 followers", "Organised welcome week for 300 students"] }],
  languages: [{ name: "English", proficiency: "Fluent" }, { name: "Urdu", proficiency: "Native" }],
};

(async () => {
  const server = h.start();
  const create = (tok, body) => call("POST", "/api/resume", { tok, body });
  const get = async (tok, id) => (await call("GET", `/api/resume/${id}`, { tok })).json.data;
  const keyOf = (r) => render.layoutKey(r, r.template, r.customStyles || {});

  console.log("-- the bug: 100% with thin content");
  let r = await create(T.S, THIN);
  const id1 = r.json?.data?._id;
  let doc = await get(T.S, id1);
  check("completionPercentage (the old score, unchanged for 1.2.x) is 100 for the thin resume", doc.completionPercentage === 100, String(doc.completionPercentage));
  r = await call("POST", `/api/resume/${id1}/layout`, { tok: T.S, body: { key: keyOf(doc), fill: 0.42, pages: 1, template: doc.template } });
  check("the app's measurement is stored (42% of the page)", r.status === 200 && r.json.data.layout.fill === 0.42 && r.json.data.page.measured === true, JSON.stringify(r.json));
  check("strength v2 is far from 100 and the gaps say exactly what to add (summary, bullets, project detail, skills, page fill)", r.json.data.strength < 60 && ["summary", "experience_bullets", "project_detail", "skills", "page_fill"].every((k) => r.json.data.gaps.some((g) => g.key === k)), `${r.json.data.strength} ${r.json.data.gaps.map((g) => g.key)}`);
  const fillGap = r.json.data.gaps.find((g) => g.key === "page_fill");
  check("half page: says how full it is and what to add, with a reason and an example", /fills 42% of the page/.test(fillGap.text) && /add/.test(fillGap.advice) && fillGap.why && fillGap.example.fresher && fillGap.example.experienced, fillGap.text);
  check("every required gap has a why and a fresher + experienced example", r.json.data.gaps.every((g) => g.why && g.example && g.example.fresher && g.example.experienced));
  r = await call("POST", `/api/resume/${id1}/layout`, { tok: T.S, body: { key: "nope", fill: 7, pages: 0 } });
  check("a bad measurement → 400, nothing stored", r.status === 400);

  console.log("-- the measurement only counts for the render it measured");
  r = await create(T.S, FRESHER);
  const id2 = r.json.data._id;
  doc = await get(T.S, id2);
  check("strong fresher content but no measurement yet: not 100 (the page is unmeasured)", doc.strength < 100 && doc.strength >= 85, String(doc.strength));
  r = await call("POST", `/api/resume/${id2}/layout`, { tok: T.S, body: { key: keyOf(doc), fill: 0.91, pages: 1 } });
  check("a fresher with NO work experience reaches 100: every minimum + 91% of one page", r.json.data.strength === 100 && r.json.data.gaps.length === 0, `${r.json.data.strength} ${r.json.data.gaps.map((g) => g.key)}`);
  await call("PUT", `/api/resume/${id2}`, { tok: T.S, body: { professionalSummary: { summary: FRESHER.professionalSummary.summary + " Available from June 2026." } } });
  doc = await get(T.S, id2);
  check("any content change makes the measurement stale: strength drops until the page is measured again", doc.strength < 100, String(doc.strength));
  await call("POST", `/api/resume/${id2}/layout`, { tok: T.S, body: { key: keyOf(doc), fill: 1.18, pages: 2 } });
  doc = await get(T.S, id2);
  const rep = rules.resumeStrengthV2(doc, { fill: 1.18, pages: 2 });
  check("over one page: not 100, and the gap offers \"fit on one page\"", doc.strength < 100 && rep.gaps.some((g) => g.key === "page_over" && g.fit), String(doc.strength));
  await call("PUT", `/api/resume/${id2}`, { tok: T.S, body: { template: "split" } });
  doc = await get(T.S, id2);
  check("a template change is a new render: the old measurement no longer counts", doc.layout.key !== keyOf(doc) && doc.strength < 100);

  console.log("-- settings and skills from the app");
  await call("PUT", `/api/resume/${id1}`, { tok: T.S, body: { settings: { gate: true, waived: ["projects", "made_up", "projects"] } } });
  doc = await get(T.S, id1);
  check("gate turns on; waived keeps only known keys, once", doc.settings.gate === true && JSON.stringify(doc.settings.waived) === '["projects"]', JSON.stringify(doc.settings));
  await call("PUT", `/api/resume/${id1}`, { tok: T.S, body: { settings: { gate: false } } });
  doc = await get(T.S, id1);
  check("gate never turns off from the app", doc.settings.gate === true);
  r = await call("PUT", `/api/resume/${id1}`, { tok: T.S, body: { skills: [{ name: "Excel", group: "tools" }, { name: "Teamwork", group: "SOFT" }, { name: "Odd", group: "wizardry" }, "SQL"] } });
  doc = await get(T.S, id1);
  check("skill groups: known ones kept (lower case), unknown → ungrouped, a plain string becomes a skill; never a failed save", r.status === 200 && doc.skills.map((s) => `${s.name}:${s.group}`).join() === "Excel:tools,Teamwork:soft,Odd:,SQL:", doc.skills.map((s) => `${s.name}:${s.group}`).join());
  check("no level the student didn't give (was 'Intermediate')", doc.skills.every((s) => s.level === ""), doc.skills.map((s) => s.level).join());
  await call("PUT", `/api/resume/${id1}`, { tok: T.S, body: { languages: [{ name: "Punjabi" }] } });
  doc = await get(T.S, id1);
  check("no language level the student didn't give (it printed \"(Intermediate)\")", doc.languages[0].proficiency === "" && !render.renderResumeHTML(doc, "modern_ats").includes("Intermediate"));

  console.log("-- analytics and the home card");
  r = await call("GET", `/api/resume/${id1}/analytics`, { tok: T.S });
  const offStrength = r.json.data.strength;
  process.env.FLAG_RESUME_V2 = `ids:${S}`;
  r = await call("GET", `/api/resume/${id1}/analytics`, { tok: T.S });
  doc = await get(T.S, id1);
  check("analytics: resumeV2 on → strength v2; off → the old number", r.json.data.strength === doc.strength && offStrength !== doc.strength, `${offStrength} / ${r.json.data.strength} / ${doc.strength}`);
  const eng = fs.readFileSync(path.join(SERVER, "routes", "engagement.routes.js"), "utf8");
  check("the home 'next action' card reads strength under resumeV2 (completionPercentage otherwise)", /select\('completionPercentage strength'\)/.test(eng) && /isEnabled\('resumeV2',[\s\S]{0,120}\?\s*resume\.strength\s*:\s*resume\.completionPercentage/.test(eng));

  console.log("-- upload: track first, own sections, uncertain values");
  importer._setClient({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
    personal: { fullName: "Hamza Ali Sheikh", email: "hamza.sheikh@example.com", phone: "0301 2223334", city: "Lahore" },
    summary: "Computer science student who builds web apps.",
    experience: [{ company: "Sample Labs", role: "", startDate: "2024", endDate: "2024", bullets: ["Wrote tests for the billing page"] }],
    education: [{ school: "Sample University", degree: "BS Computer Science", startDate: "2021", endDate: "2025", courses: ["Data Structures"] }],
    skills: ["React", "Node.js"], languages: [{ name: "English" }],
    activities: [{ organisation: "ACM Chapter", role: "Events lead", bullets: ["Organised a coding contest"] }],
    volunteering: [{ organisation: "Robin Hood Army", role: "Volunteer", bullets: ["Packed food boxes"] }],
    awards: [{ title: "Dean's Honour List", issuer: "Sample University" }],
    other: [],
  }) } }] }) } } });
  const text = ["Hamza Ali Sheikh", "hamza.sheikh@example.com", "0301 2223334", "Lahore", "Computer science student who builds web apps.", "Experience", "Sample Labs 2024 - 2024", "Wrote tests for the billing page",
    "Education", "Sample University BS Computer Science 2021 - 2025", "Data Structures", "Skills React Node.js", "Languages English", "Activities ACM Chapter Events lead Organised a coding contest", "Volunteering Robin Hood Army Volunteer Packed food boxes", "Awards Dean's Honour List Sample University"].join("\n");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split("\n").map((l) => `<w:p><w:r><w:t xml:space="preserve">${l.replace(/&/g, "&amp;").replace(/'/g, "&apos;")}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  r = await call("POST", "/api/resume/upload", { tok: T.F, body: { name: "hamza.docx", b64: docx.toString("base64"), track: "fresher", gate: "true" } });
  const up = r.json?.data;
  check("upload: the track asked first is stored, and it is made with the gap check", r.status === 200 && up.settings.track === "fresher" && up.settings.gate === true, JSON.stringify(r.json).slice(0, 300));
  check("activities, volunteering and awards get their own sections (not 'other notes')", up.activities.length === 1 && up.activities[0].organisation === "ACM Chapter" && up.volunteering.length === 1 && up.awards.length === 1 && !up.otherNotes);
  check("no skill or language level invented", up.skills.every((s) => !s.level) && up.languages.every((l) => !l.proficiency));
  const unc = up.importReport.uncertain || [];
  check("uncertain values are listed: a role with no title, a year without a month, a name split from one line", unc.some((u) => u.section === "experience" && u.field === "position") && unc.some((u) => u.section === "experience" && u.field === "dates") && unc.some((u) => u.field === "name"), JSON.stringify(unc));
  check("courses from the file land on the education entry", /Data Structures/.test(up.education[0].description));
  check("the report has the new sections", ["activities", "volunteering", "awards"].every((k) => up.importReport.sections.some((s) => s.key === k && s.status !== "empty")));

  console.log("-- profile facts (build from my tdc profile)");
  r = await call("GET", "/api/resume/profile-facts", { tok: T.S });
  check("education with its years, bio, headline and the professional profile; hires only when verified (none here)", r.status === 200 && r.json.data.user.education[0].endYear === "2026" && /marketing society/.test(r.json.data.user.bio) && r.json.data.profile.fieldOfStudy === "Marketing" && Array.isArray(r.json.data.hires) && r.json.data.hires.length === 0, JSON.stringify(r.json).slice(0, 300));
  check("profile facts is not shadowed by GET /:id", r.status === 200 && !r.json.error);

  console.log("-- the 1.2.x app still works");
  r = await create(T.F, { personalInfo: { firstName: "Old", lastName: "App", email: "old@example.com" }, skills: [{ name: "Excel", level: "Intermediate", category: "Technical" }], template: "modern" });
  doc = r.json.data;
  check("an old app's create (old template id, skill with a level): saved as sent", r.status === 201 || r.status === 200);
  check("…completionPercentage is the old rules' score, exactly", doc.completionPercentage === rules.resumeStrength(doc).score);
  r = await call("PUT", `/api/resume/${doc._id}`, { tok: T.F, body: { skills: [{ name: "Excel", level: "Advanced", category: "Technical" }], template: "jakes" } });
  check("…an old app's update keeps its level and template", r.status === 200 && r.json.data.skills[0].level === "Advanced" && r.json.data.template === "jakes");
  check("…every template the old app knows is still accepted", ["modern", "classic", "creative", "minimal", "professional", "modern_ats", "stanford", "faang", "jakes", "rezi", "flowcv", "reactive", "canva"].every((id) => reqS("./config/resumeTemplates").TEMPLATE_IDS.includes(id)));
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
