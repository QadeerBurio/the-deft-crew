// r7, plan P3-9 (flags resumeV2 + resumeWriter): POST /api/resume/:id/cover-letter and /:id/linkedin
//   flags: off → 404; resumeV2 alone → 404; another student's resume → 404
//   cover letter: needs the job title + company (400 NEED_JOB); every paragraph checked against the resume + the job typed:
//     a new number, tool or employer → that paragraph dropped; first person is fine; the company and job title may be
//     named; fewer than 2 paragraphs left, or the AI down → 200 { paragraphs: [], ai: false, message } (never a made-up letter)
//   linkedin: headline + about, checked the same way; an empty resume → 400 NEED_MORE
//   the renderer (utils/resumeRender.js, shared with the app): the letter in the resume's design, greeting and sign-off
//     only from real data (the company typed, the student's name)
//   node tests/r7-writer/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resumeFinish.routes"]], models: ["Resume"] });
const { call, check, oid, user, token, fake, coll, reqS } = h;

const S = oid(); const O = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student")]);
const T = { S: token(S, "student"), O: token(O, "student") };
const R = oid(); const R2 = oid(); const EMPTY = oid();
const RESUME = { _id: R, user: S, template: "campus", personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92 300 0000000", title: "BBA Student" },
  professionalSummary: { summary: "BBA student at Sample University who likes sales and events." },
  education: [{ institution: "Sample University", degree: "BBA", fieldOfStudy: "Marketing", startDate: "2022-09", endDate: "2026-06" }],
  workExperience: [{ company: "Daraz", position: "Sales Intern", startDate: "2025-06", endDate: "2025-08", achievements: ["Answered seller questions", "Updated product listings for new sellers"] }],
  projects: [{ name: "Campus Bazaar", description: "- A marketplace page for student sellers" }],
  activities: [{ organisation: "IEEE", role: "Events Lead", bullets: ["Ran three workshops"] }],
  skills: [{ name: "Excel" }, { name: "Canva" }], certifications: [], languages: [], achievements: [], createdAt: new Date(), updatedAt: new Date() };
fake.seed(coll("Resume"), [RESUME, { _id: R2, user: O, personalInfo: { firstName: "Other" }, createdAt: new Date(), updatedAt: new Date() }, { _id: EMPTY, user: S, personalInfo: { firstName: "Ayesha" }, createdAt: new Date(), updatedAt: new Date() }]);

let reply = {}; let down = false; let asked = 0;
reqS("./services/resumeWriter")._setClient({ chat: { completions: { create: async () => { asked++; if (down) throw new Error("timeout"); return { choices: [{ message: { content: JSON.stringify(reply) } }] }; } } } });
const JOB = { jobTitle: "Marketing Intern", company: "Unilever Pakistan", jobDescription: "Support the brand team with campus activations and social posts." };

(async () => {
  const server = h.start();
  const cl = (tok, id, body) => call("POST", `/api/resume/${id}/cover-letter`, { tok, body });
  console.log("-- flags");
  let r = await cl(T.S, R, JOB);
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O}`;
  r = await cl(T.S, R, JOB);
  check("resumeV2 alone → 404", r.status === 404 && asked === 0);
  process.env.FLAG_RESUME_WRITER = `ids:${S},${O}`;
  r = await cl(T.O, R, JOB);
  check("another student's resume → 404", r.status === 404);

  console.log("-- cover letter");
  r = await cl(T.S, R, { company: "Unilever Pakistan" });
  check("no job title → 400 NEED_JOB (no AI call)", r.status === 400 && r.json?.code === "NEED_JOB" && asked === 0);
  r = await cl(T.S, EMPTY, JOB);
  check("an empty resume → 400 NEED_MORE", r.status === 400 && r.json?.code === "NEED_MORE");
  reply = { paragraphs: [
    "I am applying for the Marketing Intern role at Unilever Pakistan because the brand team's campus activations match what I enjoy.",
    "As a Sales Intern at Daraz I answered seller questions and updated product listings, and as Events Lead at IEEE I ran three workshops.",
    "At Daraz I grew sales by 40% using Salesforce.", // a new number and a new tool: dropped
    "I would welcome the chance to talk about how I can help the brand team.",
  ] };
  r = await cl(T.S, R, JOB);
  const paras = r.json?.data?.paragraphs || [];
  check("200: the supported paragraphs (first person kept; company and job title allowed)", r.status === 200 && paras.length === 3 && /Unilever Pakistan/.test(paras[0]) && /^I /.test(paras[0]) && r.json.data.ai === true, JSON.stringify(r.json));
  check("…the paragraph with a new number and tool is dropped", !paras.some((p) => /40%|Salesforce/.test(p)));
  reply = { paragraphs: ["I led a team of 12 at Google.", "I won the national award in 2019.", "I would welcome an interview."] };
  r = await cl(T.S, R, JOB);
  check("fewer than 2 paragraphs survive → no letter at all, ai: false, 'try again' (never a made-up letter)", r.status === 200 && r.json?.data?.ai === false && r.json.data.paragraphs.length === 0 && /try again/.test(r.json.data.message || ""), JSON.stringify(r.json));
  down = true;
  r = await cl(T.S, R, JOB);
  check("the AI down → no letter, ai: false, 'try again'", r.status === 200 && r.json?.data?.ai === false && r.json.data.paragraphs.length === 0 && /try again/.test(r.json.data.message || ""));
  r = await call("POST", `/api/resume/${R}/linkedin`, { tok: T.S });
  check("…linkedin too: nothing written, ai: false", r.status === 200 && r.json?.data?.ai === false && r.json.data.headline === null && r.json.data.about.length === 0);
  down = false;

  console.log("-- linkedin");
  reply = { headline: "BBA Marketing student at Sample University | Sales Intern at Daraz | IEEE Events Lead", about: ["I study marketing at Sample University and lead events at IEEE.", "I have worked with 500 sellers at Amazon."] };
  r = await call("POST", `/api/resume/${R}/linkedin`, { tok: T.S });
  check("200: the headline and the supported about paragraphs", r.status === 200 && /Daraz/.test(r.json?.data?.headline || "") && r.json.data.about.length === 1 && !/Amazon|500/.test(r.json.data.about.join(" ")), JSON.stringify(r.json));
  r = await call("POST", `/api/resume/${EMPTY}/linkedin`, { tok: T.S });
  check("an empty resume → 400 NEED_MORE", r.status === 400 && r.json?.code === "NEED_MORE");

  console.log("-- the letter in the resume's design (shared renderer)");
  const render = reqS("./utils/resumeRender");
  const html = render.renderCoverLetterHTML(RESUME, "campus", {}, { company: "Unilever Pakistan", paragraphs: paras, date: "25 November 2026" });
  const resumeHtml = render.renderResumeHTML(RESUME, "campus", {});
  const styleOf = (x) => (x.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  check("greeting with the company typed, sign-off with the student's name, the paragraphs as written", /Dear hiring team at Unilever Pakistan,/.test(html) && /Sincerely,<br>Ayesha Khan/.test(html) && paras.every((p) => html.includes(p.replace(/&/g, "&amp;"))));
  check("…the same theme as the resume (its CSS first, then two letter lines)", styleOf(html).startsWith(styleOf(resumeHtml)) && /data-template="campus" data-doc="cover-letter"/.test(html));
  delete process.env.FLAG_RESUME_V2; delete process.env.FLAG_RESUME_WRITER;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
