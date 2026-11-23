// P3 #7 (owner): no made-up resume defaults, and the builder's AI helpers never add facts
//   POST /api/resume/enhance-text: OPENAI_MODEL; the prompt forbids new numbers / tools / employers; a rewrite that adds
//     a number anyway is not used (the original back, unchanged: true); the summary request (context "professional
//     summary for …", every app version) is written from its facts only, and nothing comes back if it adds a number
//   POST /api/resume/suggest-skills: no assumed role ("Software Engineer" is gone); no role and no skills → []
//   both: a per-user limit (resume_ai, 120 an hour by default), guests refused as before
//   POST /api/resume: the account's default location "Karachi, Pakistan" isn't put on the resume; a real one is
//   node tests/resume-ai-defaults/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key"; // resume.routes makes a client at load
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resume.routes"]], models: ["Resume", "ResumeCreationLock"] });
const { call, check, oid, user, token, fake, coll, rows, reqS, same } = h;

const S = oid(); const K = oid(); const L = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Malik", { location: "Karachi, Pakistan", headline: "" }),
  user(K, "student", "Kamran Ali", { location: "Lahore", headline: "" }),
  user(L, "student", "Limit Tester"),
]);
const T = { S: token(S, "student"), K: token(K, "student"), L: token(L, "student") };

const sent = [];
let replyText = "";
reqS("./services/resumeAi")._setClient({ chat: { completions: { create: async (req) => { sent.push(req); return { choices: [{ message: { content: replyText } }] }; } } } });

(async () => {
  const server = h.start();
  process.env.OPENAI_MODEL = "gpt-test-model";

  console.log("-- enhance-text");
  replyText = "Organised weekly coding sessions for the society.";
  let r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: "i organised coding sessions every week for our society", context: "experience" } });
  check("a rewrite comes back (reply shape kept: success, enhanced)", r.status === 200 && r.json.success === true && r.json.enhanced === replyText && r.json.unchanged === false, r.text);
  const sys = sent[0].messages[0].content;
  check("OPENAI_MODEL is used", sent[0].model === "gpt-test-model");
  check("the prompt no longer asks for quantifiable achievements / STAR, and forbids new numbers, tools, employers", !/quantifiable|STAR/i.test(sys) && /Never add a number/.test(sys) && /tool/.test(sys) && /employer/.test(sys));
  replyText = "Organised weekly coding sessions for 50+ students, improving attendance by 30%.";
  r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: "i organised coding sessions every week for our society" } });
  check("a rewrite that adds numbers the student didn't give is not used: the original back, unchanged", r.json.enhanced === "i organised coding sessions every week for our society" && r.json.unchanged === true, r.text);
  replyText = "Led a team of 4 to build the app.";
  r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: "we were 4 people and i led the app build" } });
  check("a number the student gave may stay", r.json.enhanced === "Led a team of 4 to build the app.");
  r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: "   " } });
  check("no text → 400 as before", r.status === 400 && r.json.error === "text is required");
  r = await call("POST", "/api/resume/enhance-text", { body: { text: "x" } });
  check("signed out → refused", r.status === 401 || r.status === 403);

  console.log("-- the builder's summary request");
  sent.length = 0;
  replyText = "Computer science student with skills in Python and React, looking for a frontend internship.";
  const prompt = "Write a concise, powerful 3-4 sentence professional summary for a Frontend Intern resume. Skills: Python, React. Experience: not specified. Make it ATS-optimized.";
  r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: prompt, context: "professional summary for Frontend Intern" } });
  check("written from its facts (the summary prompt, not the rewrite one)", r.json.enhanced === replyText && /resume summary/.test(sent[0].messages[0].content) && /not specified/.test(sent[0].messages[0].content), sent[0]?.messages[0]?.content);
  replyText = "Frontend intern with 2 years of React experience who boosted performance by 40%.";
  r = await call("POST", "/api/resume/enhance-text", { tok: T.S, body: { text: prompt, context: "professional summary for Frontend Intern" } });
  check("a summary with invented numbers → nothing (the instruction itself never comes back)", r.status === 200 && r.json.enhanced === "" && r.json.unchanged === true, r.text);

  console.log("-- suggest-skills");
  sent.length = 0;
  replyText = '["Docker", "python", "Kubernetes"]';
  r = await call("POST", "/api/resume/suggest-skills", { tok: T.S, body: { currentSkills: [], targetRole: "" } });
  check("no role and no skills → [] without asking the AI", r.status === 200 && r.json.success === true && Array.isArray(r.json.suggestions) && r.json.suggestions.length === 0 && sent.length === 0);
  r = await call("POST", "/api/resume/suggest-skills", { tok: T.S, body: { currentSkills: ["Python"] } });
  check("skills, no role: no role is assumed (no 'Software Engineer' anywhere)", !JSON.stringify(sent[0].messages).includes("Software Engineer") && !/Target role/.test(sent[0].messages[1].content) && /Do not assume a job/.test(sent[0].messages[0].content));
  check("…skills they already have are dropped", JSON.stringify(r.json.suggestions) === JSON.stringify(["Docker", "Kubernetes"]), r.text);
  r = await call("POST", "/api/resume/suggest-skills", { tok: T.S, body: { currentSkills: [], targetRole: "Data Analyst" } });
  check("a role the student chose is used", /Target role: Data Analyst/.test(sent[1].messages[1].content) && sent[1].model === "gpt-test-model");

  console.log("-- create: no made-up city");
  r = await call("POST", "/api/resume", { tok: T.S, body: { personalInfo: { firstName: "Sana" } } });
  let doc = rows("Resume", (x) => same(x.user, S))[0];
  check("the account default 'Karachi, Pakistan' is not put on the resume", r.status === 201 || r.status === 200 ? doc && doc.personalInfo.location === "" : false, r.text.slice(0, 200));
  r = await call("POST", "/api/resume", { tok: T.K, body: {} });
  doc = rows("Resume", (x) => same(x.user, K))[0];
  check("a location the student set (Lahore) is", doc && doc.personalInfo.location === "Lahore", r.text.slice(0, 200));
  check("no made-up title either", doc && doc.personalInfo.title === "");

  console.log("-- per-user limit");
  process.env.RATE_LIMIT_RESUME_AI_MAX = "2";
  replyText = "ok.";
  const a = await call("POST", "/api/resume/enhance-text", { tok: T.L, body: { text: "one" } });
  const b = await call("POST", "/api/resume/suggest-skills", { tok: T.L, body: { currentSkills: ["x"] } });
  const c = await call("POST", "/api/resume/enhance-text", { tok: T.L, body: { text: "three" } });
  check("resume_ai: shared between the two helpers, 429 over the limit", a.status === 200 && b.status === 200 && c.status === 429, `${a.status} ${b.status} ${c.status}`);
  const d = await call("POST", "/api/resume/enhance-text", { tok: T.K, body: { text: "another student" } });
  check("…per student", d.status === 200);
  delete process.env.RATE_LIMIT_RESUME_AI_MAX;
  const { LIMITS } = (() => { try { return { LIMITS: require("fs").readFileSync(require("path").join(h.SERVER, "utils", "userRateLimit.js"), "utf8") }; } catch { return { LIMITS: "" }; } })();
  check("the default is generous (120 an hour)", /resume_ai: \{ max: 120, windowMin: 60 \}/.test(LIMITS));

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
