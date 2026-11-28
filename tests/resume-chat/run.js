// Resume full fix: "build it by chatting" (services/resumeChat.js, routes/resumeCoach.routes.js /chat), on fake-mongo with
// a scripted AI (no network):
//   flags: resumeV2 + resumeCoach, else 404; another student's resume → 404
//   a real interview: one question at a time in the fresher order, every section; a thin answer gets a follow-up ("what
//     did you do", tools, a result or number); the coach's lines are kept by entry id (two entries with the same name:
//     the right one); "another project?" until the minimum (2 for a fresher); then the gap check keeps asking
//   Roman Urdu: translated first, the fields come from the English, the resume is English; a number or an employer
//     that isn't in what the student wrote is dropped (bullets too)
//   never a raw sentence saved as a name: nothing pulled out → asked again, nothing added
//   skip only when the whole answer is a skip ("nahi", "kuch nahi"); "nothing much but I tutored…" is an answer
//   empty / very long / off-topic / abusive: a polite redirect, nothing saved
//   saved on the server: reopening continues where it left off, no second education entry
//   speak mode: no fixed language
//   node tests/resume-chat/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume/ai", "./routes/resumeCoach.routes"]], models: ["Resume", "ResumeCoachSession"] });
const { call, check, oid, user, token, fake, coll, reqS } = h;

const S = oid(); const O = oid(); const X = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student"), user(X, "student", "Roman Student")]);
const T = { S: token(S, "student"), O: token(O, "student"), X: token(X, "student") };
const R1 = oid(); const R2 = oid(); const R3 = oid();
const base = (id, u, extra = {}) => ({ _id: id, user: u, personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha.khan@example.com", phone: "+92 300 1234567" }, settings: { track: "fresher" }, education: [], projects: [], skills: [], workExperience: [], activities: [], volunteering: [], awards: [], certifications: [], languages: [], createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("Resume"), [base(R1, S), base(R2, O), base(R3, X, { personalInfo: { firstName: "Bilal", lastName: "Raza", email: "bilal@example.com", phone: "+92 321 7654321", city: "Karachi", linkedin: "linkedin.com/in/bilal" }, settings: { track: "experienced" }, targetJob: { jobTitle: "Sales executive" } })]);

// ---------- the scripted AI: answers by what is asked ----------
const asked = [];
const TRIAGE = {
  "maine Daraz mein internship ki, sales team ke saath": { kind: "answer", language: "roman_ur", english: "I did an internship at Daraz with the sales team" },
  "June 2024 se August 2024 tak": { kind: "answer", language: "roman_ur", english: "from June 2024 to August 2024" },
  "customers ki queries handle ki aur listings theek ki": { kind: "answer", language: "roman_ur", english: "handled customer queries and fixed listings" },
  "mujhe cricket pasand hai": { kind: "offtopic", english: "I like cricket" },
  "what should I write here?": { kind: "question", english: "what should I write here?" },
  "میں نے شاہین کمپنی میں کام کیا": { kind: "answer", language: "ur", english: "I worked at Shaheen Company" },
};
const PULL = {
  Lahore: { city: "Lahore" },
  "a marketing internship": { targetRole: "marketing internship" },
  "BBA at IBA Karachi": { programme: "BBA", university: "IBA Karachi" },
  "dean's list twice, and courses Digital Marketing and Consumer Behaviour": { achievements: ["dean's list twice"], courses: ["Digital Marketing", "Consumer Behaviour"] },
  "a cafe business plan for class": { name: "cafe business plan", did: [], tools: [] },
  "I researched campus demand and wrote the pricing section": { did: ["researched campus demand", "wrote the pricing section"] },
  "Excel and Canva": { tools: ["Excel", "Canva"] },
  "we got an A grade": { result: "an A grade" },
  "the weather was nice": {},
  "a quiz app for my class, I built the scoring": { name: "quiz app", did: ["built the scoring"], tools: [] },
  "I did an internship at Daraz with the sales team": { organisation: "Daraz", role: "intern", did: [] },
  "handled customer queries and fixed listings": { did: ["handled customer queries", "fixed listings"] },
  "I worked at Shaheen Company": { organisation: "Shaheen Company", role: "", did: [] },
  "nothing much but I tutored 3 kids in maths": { organisation: "tuition", role: "tutor", did: ["tutored 3 kids in maths"] },
};
const BULLETS = [
  [/researched campus demand/, ["Researched campus demand and wrote the pricing section of the cafe business plan, graded A", "Built a 50 page plan with 12 charts in Excel"]],
  [/handled customer queries/, ["Handled customer queries and fixed product listings with the sales team", "Handled 40 customer queries a day", "Supported the Careem rollout team"]],
  [/built the scoring/, ["Built the scoring for a class quiz app"]],
];
reqS("./services/resumeCoach")._setClient({
  chat: { completions: { create: async (req) => {
    const sys = req.messages[0].content; const u = JSON.parse(req.messages[1].content || "{}");
    asked.push({ sys: sys.slice(0, 60), user: u });
    let out = {};
    if (/Say what kind it is/.test(sys)) out = TRIAGE[u.answer] || { kind: "answer", language: "en", english: u.answer };
    else if (/From a student's answer/.test(sys)) out = PULL[u.answer] || {};
    else if (/Write 2 or 3 resume bullets/.test(sys)) { const did = (u.did || []).join(" "); out = { bullets: (BULLETS.find(([re]) => re.test(did)) || [null, []])[1] }; }
    else if (/resume summaries/.test(sys)) out = { summaries: ["BBA student at IBA Karachi who researched campus demand for a cafe business plan. Looking for a marketing internship to grow brand pages and campaigns."] };
    return { choices: [{ message: { content: JSON.stringify(out) } }] };
  } } },
  audio: { transcriptions: { create: async (req) => { asked.push({ audio: true, language: req.language }); return { text: "a quiz app" }; } } },
});

const Resume = reqS("./models/Resume");
const say = async (tok, id, text) => { const r = await call("POST", `/api/resume/ai/chat/${id}`, { tok, body: { text } }); if (process.env.DEBUG_CHAT) console.log(`   [${String(text).slice(0, 40)}] → ${r.status} ${(r.json?.data?.messages || []).map((m) => m.text).join(" | ")}${r.json?.error ? " ERR " + r.json.error : ""}`); return r; };
const last = (r) => (r.json?.data?.messages || []).filter((m) => !m.card).map((m) => m.text).pop() || "";
const all = (r) => (r.json?.data?.messages || []).map((m) => m.text).join(" | ");
const fresh = async (id) => JSON.parse(JSON.stringify(await Resume.findById(id).lean()));

(async () => {
  const server = h.start();
  console.log("-- flags and access");
  let r = await call("GET", `/api/resume/ai/chat/${R1}`, { tok: T.S });
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O},${X}`;
  process.env.FLAG_RESUME_COACH = `ids:${S},${O},${X}`;
  process.env.FLAG_RESUME_SPEAK = `ids:${S}`;
  r = await call("GET", `/api/resume/ai/chat/${R2}`, { tok: T.S });
  check("another student's resume → 404", r.status === 404);

  console.log("-- a fresher interview, one question at a time");
  r = await call("GET", `/api/resume/ai/chat/${R1}`, { tok: T.S });
  check("starts with the first missing contact detail (city): name, email, phone are already there", r.status === 200 && /which city/.test(last(r)) && r.json.data.all.length === 1, all(r));
  r = await say(T.S, R1, "");
  check("empty: a polite redirect that repeats the question, nothing saved", /type or say your answer/.test(last(r)) && /which city/.test(last(r)));
  r = await say(T.S, R1, "x".repeat(1600));
  check("very long: asked to keep it short, nothing saved", /a lot at once/.test(last(r)) && !(await fresh(R1)).personalInfo.city);
  r = await say(T.S, R1, "you idiot bc");
  check("abusive: friendly redirect, nothing saved", /keep it friendly/.test(last(r)) && !(await fresh(R1)).personalInfo.city);
  r = await say(T.S, R1, "mujhe cricket pasand hai");
  check("off-topic: back to the question, nothing saved", /only help with your resume/.test(last(r)) && /which city/.test(last(r)) && !(await fresh(R1)).personalInfo.city);
  r = await say(T.S, R1, "Lahore");
  check("city saved; next: LinkedIn (optional)", (await fresh(R1)).personalInfo.city === "Lahore" && /LinkedIn/.test(last(r)));
  r = await say(T.S, R1, "skip");
  check("skip → the job they want", /job or internship do you want/.test(last(r)));
  r = await say(T.S, R1, "a marketing internship");
  check("target saved as a card; next: education (fresher order)", (await fresh(R1)).targetJob.jobTitle === "marketing internship" && /studying/.test(last(r)) && r.json.data.messages.some((m) => m.card && m.card.section === "target"));
  r = await say(T.S, R1, "BBA at IBA Karachi");
  let doc = await fresh(R1);
  check("education entry (English, from the answer) + a card; then the years", doc.education.length === 1 && doc.education[0].institution === "IBA Karachi" && doc.education[0].degree === "BBA" && /when did you start/.test(last(r)) && r.json.data.messages.some((m) => m.card && m.card.section === "education" && m.card.entryId === String(doc.education[0]._id)));

  console.log("-- reopening continues where it left off");
  r = await call("GET", `/api/resume/ai/chat/${R1}`, { tok: T.S });
  check("the whole conversation comes back; no new question, no second education entry", r.status === 200 && r.json.data.messages.length === 0 && r.json.data.all.length > 8 && /when did you start/.test(r.json.data.all.filter((m) => m.from === "tdc" && !m.card).pop().text) && (await fresh(R1)).education.length === 1);
  r = await say(T.S, R1, "2022 to 2026");
  doc = await fresh(R1);
  check("years saved (only years the student typed); then the CGPA (optional)", new Date(doc.education[0].startDate).getUTCFullYear() === 2022 && new Date(doc.education[0].endDate).getUTCFullYear() === 2026 && /CGPA/.test(last(r)));
  r = await say(T.S, R1, "3.4");
  check("grade as written; then an achievement or courses", (await fresh(R1)).education[0].grade === "3.4" && /achievement|courses/.test(last(r)));
  r = await say(T.S, R1, "dean's list twice, and courses Digital Marketing and Consumer Behaviour");
  doc = await fresh(R1);
  check("achievement on the education entry, courses as coursework; then projects", /Dean's list twice/.test(doc.education[0].description) && doc.coursework.includes("Digital Marketing") && /project/.test(last(r)));

  console.log("-- follow-ups when an answer is thin");
  r = await say(T.S, R1, "the weather was nice");
  check("nothing could be pulled out: asked again, nothing saved (never the raw sentence as a name)", /project called|what did it do/.test(last(r)) && (await fresh(R1)).projects.length === 0);
  r = await say(T.S, R1, "a cafe business plan for class");
  doc = await fresh(R1);
  check("project added from the answer; thin → 'what did you build or do'", doc.projects.length === 1 && doc.projects[0].name === "Cafe business plan" && /what did you build/.test(last(r)));
  r = await say(T.S, R1, "I researched campus demand and wrote the pricing section");
  check("→ which tools", /tools/.test(last(r)));
  r = await say(T.S, R1, "Excel and Canva");
  check("tools on the project; no number yet → 'any result or number?'", (await fresh(R1)).projects[0].technologies.join() === "Excel,Canva" && /result or number/.test(last(r)));
  r = await say(T.S, R1, "we got an A grade");
  const sug = r.json.data.suggestions;
  check("the coach's lines to keep: the invented '50 page plan with 12 charts' is dropped", sug && sug.items.length === 1 && /graded A/.test(sug.items[0]) && !sug.items.some((x) => /50/.test(x)) && sug.entryId === String(doc.projects[0]._id), JSON.stringify(sug));
  r = await say(T.S, R1, "ok");
  check("while lines wait: a reminder, nothing else changes", /keep the lines/.test(last(r)) && r.json.data.suggestions);
  r = await call("POST", `/api/resume/ai/chat/${R1}/keep`, { tok: T.S, body: { entryId: String(doc.projects[0]._id), lines: sug.items } });
  doc = await fresh(R1);
  check("kept: written to that project; a fresher needs 2 → 'let's add one more project'", /graded A/.test(doc.projects[0].description) && /one more project/.test(last(r)) && /freshers need at least 2/.test(last(r)));
  r = await say(T.S, R1, "a quiz app for my class, I built the scoring");
  doc = await fresh(R1);
  check("second project; 'built the scoring' is enough → tools", doc.projects.length === 2 && /tools/.test(last(r)));

  console.log("-- keep writes by entry id, never by name");
  await Resume.updateOne({ _id: R1 }, { $push: { projects: { name: "Quiz app", description: "an older one" } } });
  doc = await fresh(R1);
  const quizIds = doc.projects.filter((p) => /quiz app/i.test(p.name)).map((p) => String(p._id));
  r = await say(T.S, R1, "skip");
  r = await say(T.S, R1, "skip");
  const s2 = r.json.data.suggestions;
  check("lines for the new quiz app (its id)", s2 && s2.entryId === quizIds[0], JSON.stringify(s2));
  r = await call("POST", `/api/resume/ai/chat/${R1}/keep`, { tok: T.S, body: { entryId: s2.entryId, lines: s2.items } });
  doc = await fresh(R1);
  check("two projects with the same name: only the one with that id got the line", doc.projects.find((p) => String(p._id) === quizIds[0]).description.includes("scoring") && doc.projects.find((p) => String(p._id) === quizIds[1]).description === "an older one");
  r = await call("POST", `/api/resume/ai/chat/${R1}/keep`, { tok: T.S, body: { entryId: String(oid()), lines: ["x"] } });
  check("an id that isn't on the resume → 404 (or nothing pending: 409), nothing written", [404, 409].includes(r.status));
  r = await say(T.S, R1, "no");
  check("minimum met → 'no' moves on to skills", /skills/.test(last(r)));

  console.log("-- skip rule");
  check("a whole-answer skip only: nahi, kuch nahi, skip", ["nahi", "kuch nahi", "Skip.", "no", "nothing"].every((x) => reqS("./services/resumeChat").SKIP_RE.test(x)) && !reqS("./services/resumeChat").SKIP_RE.test("nothing much but I tutored 3 kids in maths"));

  console.log("-- Roman Urdu → English (experienced track)");
  r = await call("GET", `/api/resume/ai/chat/${R3}`, { tok: T.X });
  check("experienced: contact and target already there → experience first", /worked, interned/.test(last(r)), last(r));
  r = await say(T.X, R3, "what should I write here?");
  check("a question: an example, then the question again", /example/.test(last(r)) && /worked, interned/.test(last(r)));
  r = await say(T.X, R3, "maine Daraz mein internship ki, sales team ke saath");
  doc = await fresh(R3);
  check("translated first: the role in English (company 'Daraz' was in the original)", doc.workExperience.length === 1 && doc.workExperience[0].company === "Daraz" && doc.workExperience[0].position === "intern" && /when was it/.test(last(r)), JSON.stringify(doc.workExperience));
  r = await say(T.X, R3, "June 2024 se August 2024 tak");
  doc = await fresh(R3);
  check("dates from the Roman Urdu answer (years the student typed)", new Date(doc.workExperience[0].startDate).getUTCMonth() === 5 && new Date(doc.workExperience[0].endDate).getUTCMonth() === 7 && /what did you do/.test(last(r)));
  r = await say(T.X, R3, "customers ki queries handle ki aur listings theek ki");
  check("no number given → asked for one", /result or number/.test(last(r)));
  r = await say(T.X, R3, "skip");
  const s3 = r.json.data.suggestions;
  check("English bullets; '40 a day' (no such number said) and 'Careem' (no such name said) dropped", s3 && s3.items.length === 1 && /Handled customer queries/.test(s3.items[0]) && !s3.items.some((x) => /40|Careem/.test(x)), JSON.stringify(s3));
  r = await call("POST", `/api/resume/ai/chat/${R3}/keep`, { tok: T.X, body: { lines: s3.items } });
  doc = await fresh(R3);
  check("kept in English on that role", doc.workExperience[0].achievements.length === 1 && !/[؀-ۿ]|\bki\b|\bka\b/.test(JSON.stringify(doc.workExperience)));
  check("the resume is all English (no Roman Urdu words saved)", !/\b(maine|mein|ki|aur|theek|tak|se)\b/.test(JSON.stringify({ w: doc.workExperience, p: doc.projects })));
  r = await say(T.X, R3, "yes");
  r = await say(T.X, R3, "میں نے شاہین کمپنی میں کام کیا");
  doc = await fresh(R3);
  check("Urdu script: an employer that only exists in the translation ('Shaheen Company') is never saved: asked again", doc.workExperience.length === 1 && /where was it/.test(last(r)), JSON.stringify(doc.workExperience.map((w) => w.company)));
  r = await say(T.X, R3, "nothing much but I tutored 3 kids in maths");
  doc = await fresh(R3);
  check("'nothing much but I tutored…' is an answer, not a skip: a tutor role is added", doc.workExperience.length === 2 && doc.workExperience[1].position === "tutor");

  console.log("-- the gap check at the end keeps asking");
  for (let i = 0; i < 30 && !/one thing left|has what it needs|still missing/.test(all(r)); i += 1) {
    const d = r.json.data;
    if (d.suggestions) r = await call("POST", `/api/resume/ai/chat/${R1}/next`, { tok: T.S });
    else r = await say(T.S, R1, "skip");
  }
  check("after the planned questions: 'one thing left: …' from the gap check (required items still missing)", /one thing left/.test(all(r)) && r.json.data.gaps.length > 0, all(r));
  check("…and the next one is a different gap (a skipped one comes back after the others)", await (async () => { const a1 = all(r).match(/one thing left: ([^.]+)/)[1]; const r2 = await call("POST", `/api/resume/ai/chat/${R1}/next`, { tok: T.S }); const m = all(r2).match(/one thing left: ([^.]+)/); return m && m[1] !== a1; })());
  let rr = r;
  for (let i = 0; i < 60 && !/still missing|has what it needs/.test(all(rr)); i += 1) rr = rr.json.data.suggestions ? await call("POST", `/api/resume/ai/chat/${R1}/next`, { tok: T.S }) : await say(T.S, R1, "skip");
  check("a student who skips everything: it ends honestly ('N things are still missing'), never 'done'", /still missing/.test(all(rr)) && !/has what it needs/.test(all(rr)), all(rr));
  r = await call("GET", `/api/resume/ai/chat/${R1}?topic=skills`, { tok: T.S });
  check("'help me write this' from the gap check opens the chat on that gap (skills)", /skills/.test(last(r)));
  r = await call("GET", `/api/resume/ai/chat/${R3}?topic=projects&alt=1`, { tok: T.X });
  check("'I really don't have this': the coach offers the fresher alternatives", /society role|freelance|tuition|hackathon/.test(last(r)));

  console.log("-- speak mode");
  const b = "----tdc" + Math.random().toString(16).slice(2);
  const raw = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="seconds"\r\n\r\n4\r\n`), Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="a.m4a"\r\nContent-Type: audio/m4a\r\n\r\n`), Buffer.alloc(200, 1), Buffer.from(`\r\n--${b}--\r\n`)]);
  r = await call("POST", "/api/resume/ai/transcribe", { tok: T.S, raw, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
  const au = asked.find((a) => a.audio);
  check("transcribed with no fixed language (auto-detect: English, Urdu, Roman Urdu)", r.status === 200 && au && au.language === undefined);

  console.log("-- the resume stays valid");
  doc = await fresh(R1);
  check("the chat marks it 'made with the gap check' (settings.gate) and stores strength v2", doc.settings.gate === true && typeof doc.strength === "number");
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
