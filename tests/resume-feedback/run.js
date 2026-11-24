// P3d resume feedback (plan P3-7; flags resumeV2 + resumeFeedback): POST /api/resume/:id/feedback
//   flags: off → 404; resumeV2 alone → 404; guests → 401; another student's resume → 404
//   rules (always): strong points from what the resume has, weak points from its own text, the improvements from
//     resumeRules with the builder step (stepKey) for "fix it"
//   AI (one pass, English): each point checked against the resume's own text; a new number / tool / employer → dropped;
//     a missing result only as a question ("did this save time or money? if yes, add it"), never "add 20%"
//   cache: per content hash: the same text → no second AI call (cached: true); a template change → still cached; a text
//     change → a new pass; the AI down → the rules alone (200, ai: false)
//   node tests/resume-feedback/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resumeFinish.routes"]], models: ["Resume", "ResumeFeedback"] });
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;

const S = oid(); const O = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student")]);
const T = { S: token(S, "student"), O: token(O, "student") };
const R = oid(); const R2 = oid();
fake.seed(coll("Resume"), [
  { _id: R, user: S, template: "modern_ats", personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92 300 0000000", title: "BBA Student" },
    professionalSummary: { summary: "BBA student at Sample University who likes sales and events." },
    education: [{ institution: "Sample University", degree: "BBA", fieldOfStudy: "Marketing", startDate: "2022-09", endDate: "2026-06" }],
    workExperience: [{ company: "Daraz", position: "Sales Intern", startDate: "2025-06", endDate: "2025-08", achievements: ["Responsible for answering seller questions", "Updated product listings for new sellers"] }],
    projects: [{ name: "Campus Bazaar", description: "- A marketplace page for student sellers" }],
    activities: [{ organisation: "IEEE", role: "Events Lead", bullets: ["Ran three workshops"] }],
    skills: [{ name: "Excel" }, { name: "Canva" }], certifications: [], languages: [], achievements: [], createdAt: new Date(), updatedAt: new Date() },
  { _id: R2, user: O, personalInfo: { firstName: "Other" }, createdAt: new Date(), updatedAt: new Date() },
]);

let reply = {}; let asked = 0; let down = false;
reqS("./services/resumeCoach")._setClient({ chat: { completions: { create: async () => { asked++; if (down) throw new Error("timeout"); return { choices: [{ message: { content: JSON.stringify(reply) } }] }; } } } });
const doc = () => rows("Resume", (x) => same(x._id, R))[0];

(async () => {
  const server = h.start();
  const url = `/api/resume/${R}/feedback`;
  console.log("-- flags");
  let r = await call("POST", url, { tok: T.S });
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O}`;
  r = await call("POST", url, { tok: T.S });
  check("resumeV2 alone → 404 (feedback has its own flag)", r.status === 404);
  process.env.FLAG_RESUME_FEEDBACK = `ids:${S},${O}`;
  r = await call("POST", url, {});
  check("signed out → 401", r.status === 401);
  r = await call("POST", `/api/resume/${R2}/feedback`, { tok: T.S });
  check("another student's resume → 404", r.status === 404);

  console.log("-- rules + AI");
  reply = {
    strong: ["leading events at ieee shows you can organise people", "a Google internship shows top-tier experience"],
    weak: ["the daraz lines describe duties, not what changed"],
    improvements: [
      { text: "add a result to your daraz internship, like increasing sales by 20%", section: "experience" },
      { text: "quantify the impact of your listings work", section: "experience" },
      { text: "for your daraz listings work: did this save time or money? if yes, add it.", section: "experience" },
      { text: "say what campus bazaar does for student sellers", section: "projects" },
    ],
  };
  r = await call("POST", url, { tok: T.S });
  const d = r.json?.data || {};
  const texts = (k) => (d[k] || []).map((x) => x.text);
  check("200, with the AI", r.status === 200 && d.ai === true && d.cached === false && asked === 1, r.text.slice(0, 200));
  check("rules strong points: complete education, the project, activities", texts("strong").some((t) => /education is complete/.test(t)) && texts("strong").some((t) => /project shows/.test(t)) && texts("strong").some((t) => /initiative/.test(t)), JSON.stringify(texts("strong")));
  check("rules weak point: a line starting with 'responsible for', pointing at experience", (d.weak || []).some((x) => x.source === "rules" && /responsible for/.test(x.text) && x.stepKey === "experience"), JSON.stringify(d.weak));
  check("rules weak point: no result yet → only the question", (d.weak || []).some((x) => /did this save time or money\? if yes, add it\./.test(x.text)), JSON.stringify(texts("weak")));
  check("improvements from the rules carry the step to fix it", (d.improvements || []).filter((x) => x.source === "rules").every((x) => typeof x.stepKey === "string" && x.stepKey.length), JSON.stringify(d.improvements));
  check("AI strong point grounded in the resume is kept", texts("strong").includes("leading events at ieee shows you can organise people"));
  check("AI strong point with an employer the resume doesn't have (Google) → dropped", !texts("strong").some((t) => /google/i.test(t)), JSON.stringify(texts("strong")));
  check("AI improvement with an invented number (20%) → dropped", !texts("improvements").some((t) => /20%/.test(t)), JSON.stringify(texts("improvements")));
  check("AI improvement asking for numbers, not as a question → dropped", !texts("improvements").some((t) => /^quantify/.test(t)));
  check("AI improvement asking about a result as a question → kept, pointing at experience", (d.improvements || []).some((x) => x.source === "ai" && /did this save time or money\?/.test(x.text) && x.stepKey === "experience"), JSON.stringify(d.improvements));
  check("AI improvement for a section → its step", (d.improvements || []).some((x) => x.source === "ai" && /campus bazaar/.test(x.text) && x.stepKey === "projects"));
  check("no point anywhere has a number the resume doesn't", ![...texts("strong"), ...texts("weak"), ...texts("improvements")].some((t) => /\b(20|50|100)\b|%/.test(t)));

  console.log("-- cache");
  r = await call("POST", url, { tok: T.S });
  check("same text → cached, no second AI call", r.json?.data?.cached === true && r.json.data.ai === true && asked === 1);
  doc().template = "jakes"; doc().customStyles = { palette: "teal" };
  r = await call("POST", url, { tok: T.S });
  check("a template / colour change → still cached", r.json?.data?.cached === true && asked === 1);
  doc().professionalSummary = { summary: "BBA student who runs events and sells online." };
  r = await call("POST", url, { tok: T.S });
  check("a text change → one new AI pass", r.json?.data?.cached === false && asked === 2);
  check("the cache holds the AI part only, per resume + content hash", rows("ResumeFeedback").length === 2 && rows("ResumeFeedback").every((x) => same(x.resume, R) && /^[0-9a-f]{64}$/.test(x.contentHash)));

  console.log("-- AI down");
  down = true;
  doc().professionalSummary = { summary: "Marketing student." };
  r = await call("POST", url, { tok: T.S });
  check("the AI down → 200 with the rules alone (ai: false)", r.status === 200 && r.json.data.ai === false && r.json.data.strong.length > 0 && r.json.data.improvements.every((x) => x.source === "rules"), r.text.slice(0, 200));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
