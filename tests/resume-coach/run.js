// P3b resume coach (flags resumeV2 + resumeCoach; speech resumeSpeak): /api/resume/ai/*
//   flags: off → 404 (as if absent); guests → 401; resumeV2 alone isn't enough
//   coach: bullets / summary / stronger / skills / extract / fit; the fact guardrail (the Studio validator): a
//     suggestion with a number, date, link, name, tool or claim the student didn't give is dropped (and logged, flags
//     only); missing facts → a question instead of a guess; extract keeps only what the student said; fit is
//     deterministic (3 lines per entry, the longest without numbers go first)
//   check: first person, no verb, tense, too long, vague words, informal e-mail, +92 phone, missing LinkedIn, spelling
//     (cached by text; a "mistake" not in the text is ignored)
//   autofix: reverse-chronological order, capitals, bullet endings, junk lines, the home address, empty entries →
//     changes to preview + the patch; never another student's resume
//   transcribe: the audio is only in memory; over a minute → 413; needs resumeSpeak
//   node tests/resume-coach/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume/ai", "./routes/resumeCoach.routes"]], models: ["Resume"] });
const { call, upload, check, oid, user, token, fake, coll, reqS } = h;
const http = require("http");

const S = oid(); const O = oid(); const N = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student"), user(N, "student", "No Flags")]);
const T = { S: token(S, "student"), O: token(O, "student"), N: token(N, "student") };
const R1 = oid(); const R2 = oid();
fake.seed(coll("Resume"), [
  { _id: R1, user: S, personalInfo: { firstName: "Ayesha", title: "Resume", address: "House 12, Street 4, Gulshan" }, professionalSummary: { summary: "BBA student. References available upon request." },
    workExperience: [{ company: "daraz", position: "SALES INTERN", startDate: new Date("2023-06-01"), endDate: new Date("2023-08-01"), achievements: ["Answered seller questions.", "fixed listings", "  ", "References available on request"] }, { company: "Careem", position: "intern", startDate: new Date("2024-06-01"), current: true, achievements: [] }],
    activities: [{ organisation: "ieee", role: "events lead", bullets: ["ran workshops."] }, {}],
    skills: [{ name: "javascript" }, { name: "Excel" }], education: [], projects: [], certifications: [], createdAt: new Date(), updatedAt: new Date() },
  { _id: R2, user: O, personalInfo: { firstName: "Other" }, createdAt: new Date(), updatedAt: new Date() },
]);

// the AI, scripted by what is asked
let replies = {};
const asked = [];
const svc = reqS("./services/resumeCoach");
svc._setClient({
  chat: { completions: { create: async (req) => { const sys = req.messages[0].content; asked.push({ sys, user: req.messages[1].content, model: req.model }); const k = Object.keys(replies).find((x) => sys.includes(x)); return { choices: [{ message: { content: JSON.stringify(k ? replies[k] : {}) } }] }; } } },
  audio: { transcriptions: { create: async ({ file, model }) => { asked.push({ audio: true, name: file.name, model }); return { text: "i was the events lead at ieee" }; } } },
});

function audioUpload(url, tok, bytes, seconds) {
  const b = "----tdc" + Math.random().toString(16).slice(2);
  const raw = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="seconds"\r\n\r\n${seconds}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="a.m4a"\r\nContent-Type: audio/m4a\r\n\r\n`), Buffer.alloc(bytes, 1), Buffer.from(`\r\n--${b}--\r\n`)]);
  return call("POST", url, { tok, raw, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
}

(async () => {
  const server = h.start();
  process.env.OPENAI_MODEL = "gpt-test";

  console.log("-- flags");
  let r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "bullets", facts: {} } });
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O},${N}`;
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "bullets", facts: {} } });
  check("resumeV2 alone → 404 (the coach has its own flag)", r.status === 404);
  process.env.FLAG_RESUME_COACH = `ids:${S},${O}`;
  r = await call("POST", "/api/resume/ai/coach", { body: { action: "bullets", facts: {} } });
  check("signed out → 401", r.status === 401);
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "dance" } });
  check("an unknown action → 400", r.status === 400 && r.json.code === "BAD_ACTION");

  console.log("-- bullets");
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "bullets", facts: { role: "events lead", organisation: "IEEE" } } });
  check("no answers → a question, no AI call, no guess", r.status === 200 && r.json.data.suggestions.length === 0 && r.json.data.questions[0].key === "did" && asked.length === 0);
  replies = { "resume bullets": { bullets: [
    "Organised the welcome week for IEEE as events lead",
    "Managed social media for the IEEE branch",
    "Organised 12 workshops attended by 300 students", // numbers nobody gave
    "Led a team at Google to launch IEEE events", // an employer nobody gave
    "Worked with Python and AWS on the IEEE website", // tools nobody gave
    "I organised events for IEEE", // first person
  ] } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "bullets", facts: { role: "events lead", organisation: "IEEE", did: ["organised events", "organised the welcome week", "managed social media"] } } });
  const b = r.json.data;
  check("only the supported bullets come back", JSON.stringify(b.suggestions) === JSON.stringify(["Organised the welcome week for IEEE as events lead", "Managed social media for the IEEE branch"]), JSON.stringify(b));
  check("…4 dropped: invented numbers, an employer, tools, first person", b.dropped === 4);
  check("…and no number given → it asks for one (never guesses)", b.questions.some((q) => q.key === "size"));
  check("OPENAI_MODEL, JSON, and the no-invention rules in the prompt", asked[0].model === "gpt-test" && /Never add a number/.test(asked[0].sys));
  replies = { "resume bullets": { bullets: ["Organised 3 workshops for 120 students at IEEE"] } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "bullets", facts: { role: "events lead", organisation: "IEEE", did: ["organised workshops"], size: "3 workshops, 120 students" } } });
  check("numbers the student gave may be used", r.json.data.suggestions.length === 1 && r.json.data.questions.length === 0);

  console.log("-- summary, stronger, skills, extract, fit");
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "summary", facts: { programme: "BBA" } } });
  check("summary without a target role → 'what job do you want?'", r.json.data.questions[0].key === "targetRole" && r.json.data.suggestions.length === 0);
  replies = { "resume summaries": { summaries: ["BBA student at IBA aiming for a marketing internship, with events experience at IEEE.", "Marketing-focused BBA student with 5 years of agency experience.", "BBA student at IBA who organises events and wants to grow in marketing."] } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "summary", facts: { programme: "BBA", university: "IBA", targetRole: "marketing internship", strengths: ["events lead at IEEE", "organises events"] } } });
  check("3 options asked; the one with invented years is dropped", r.json.data.suggestions.length === 2 && !r.json.data.suggestions.some((x) => /5 years/.test(x)), JSON.stringify(r.json.data));
  replies = { "stronger": { bullet: "Co-organised an inter-university event for IEEE" } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "stronger", facts: { bullet: "helped in event for IEEE", role: "member", organisation: "IEEE" } } });
  check("make it stronger: a rewrite, and 'roughly how many people came?' because no number was given", r.json.data.questions[0].key === "size");
  replies = { "hard skills": { skills: ["Canva", "Excel", "Market research"] } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "skills", facts: { programme: "BBA", current: ["Excel"], activities: [{ organisation: "IEEE", role: "events lead", bullets: ["organised the welcome week"] }], projects: [{ name: "Cafe plan", description: "built a business plan" }] } } });
  const sk = r.json.data;
  check("skills: suggestions without the ones they have", sk.suggestions.join() === "Canva,Market research", JSON.stringify(sk));
  check("…soft skills each linked to where they were shown", sk.soft.some((s) => s.skill === "leadership" && s.where === "IEEE") && sk.soft.some((s) => s.skill === "organisation") && sk.soft.some((s) => s.skill === "problem solving" && s.where === "Cafe plan"));
  replies = { "Pull out the society": { organisation: "IEEE student branch", role: "president" } };
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "extract", facts: { question: "society", answer: "i was on the ieee student branch team doing events" } } });
  check("extract keeps what the student said, drops a role they didn't ('president')", r.json.data.fields.organisation === "IEEE student branch" && !r.json.data.fields.role, JSON.stringify(r.json.data));
  r = await call("POST", "/api/resume/ai/coach", { tok: T.S, body: { action: "fit", facts: { resume: { workExperience: [{ achievements: ["a".repeat(150), "Grew sales 20%", "b".repeat(60), "c".repeat(200), "short"] }] } } } });
  const fx = r.json.data.suggestions[0];
  check("fit on one page: 3 lines per entry, the longest without numbers removed first, before / after", fx.before.length === 5 && fx.after.length === 3 && fx.after.includes("Grew sales 20%") && fx.after.includes("short") && fx.linesSaved >= 3, JSON.stringify(fx).slice(0, 200));

  console.log("-- live checks");
  const chk = async (field, text, extra = {}) => (await call("POST", "/api/resume/ai/check", { tok: T.S, body: { field, text, ...extra } })).json.data.issues;
  replies = {};
  let is = await chk("bullet", "I organised the welcome week for our society");
  check("starts with I → fix without it", is.some((x) => x.code === "first_person" && x.fix === "Organised the welcome week for our society"));
  is = await chk("bullet", "organise events every month for the society", { current: false });
  check("a finished role in the present tense → past tense fix", is.some((x) => x.code === "tense" && x.fix === "Organised events every month for the society"));
  is = await chk("bullet", "organised events every month for the society", { current: true });
  check("a current role in the past tense → present tense fix", is.some((x) => x.code === "tense" && /^Organise events/.test(x.fix)));
  is = await chk("bullet", "responsible for the society's events");
  check("no action verb → a hint", is.some((x) => x.code === "no_verb"));
  is = await chk("bullet", `Organised ${"many ".repeat(45)}events`);
  check("longer than 2 lines → a hint", is.some((x) => x.code === "too_long"));
  is = await chk("summary", "Hardworking team player looking for an internship");
  check("vague words → show it with an example", is.some((x) => x.code === "vague"));
  check("informal e-mail", (await chk("email", "cutiepie99@gmail.com")).some((x) => x.code === "informal_email") && !(await chk("email", "ayesha.khan@gmail.com")).length);
  check("phone → +92 format fix", (await chk("phone", "0300-1234567"))[0]?.fix === "+92 300 1234567");
  check("no LinkedIn → a hint", (await chk("linkedin", ""))[0]?.code === "no_linkedin");
  replies = { "spelling": { mistakes: [{ word: "recieved", suggestion: "received" }, { word: "ghost", suggestion: "host" }] } };
  const before = asked.length;
  is = await chk("bullet", "Recieved an award for the welcome week");
  check("spelling: the real mistake with a fix (capital kept); a 'mistake' not in the text ignored", is.filter((x) => x.code === "spelling").length === 1 && is.find((x) => x.code === "spelling").fix === "Received an award for the welcome week", JSON.stringify(is));
  await chk("bullet", "Recieved an award for the welcome week");
  check("…cached by text (no second AI call)", asked.length === before + 1);
  r = await call("POST", "/api/resume/ai/check", { tok: T.S, body: { field: "nope", text: "x" } });
  check("an unknown field → 400", r.status === 400);

  console.log("-- fix everything");
  r = await call("POST", "/api/resume/ai/autofix", { tok: T.S, body: { resumeId: String(R2) } });
  check("someone else's resume → 404", r.status === 404);
  r = await call("POST", "/api/resume/ai/autofix", { tok: T.S, body: { resumeId: String(R1) } });
  const af = r.json.data;
  const rules = new Set(af.changes.map((c) => c.rule));
  check("changes to preview: order, capitals, bullets, title, address, summary, empty entries", ["order", "capitals", "bullets", "title", "address", "summary", "empty"].every((x) => rules.has(x)), [...rules].join());
  check("reverse-chronological: the current internship first", af.patch.workExperience[0].company === "Careem" || af.patch.workExperience[0].company === "careem");
  check("capitals: 'SALES INTERN' → 'Sales Intern', 'daraz' → 'Daraz', 'javascript' → its known name", af.patch.workExperience.some((w) => w.position === "Sales Intern" && w.company === "Daraz") && af.patch.skills[0].name !== "javascript" && /^JavaScript$/i.test(af.patch.skills[0].name));
  const dz = af.patch.workExperience.find((w) => w.company === "Daraz");
  check("bullets: one ending everywhere, empty and 'references…' lines gone", JSON.stringify(dz.achievements) === JSON.stringify(["Answered seller questions", "fixed listings"]) || JSON.stringify(dz.achievements) === JSON.stringify(["Answered seller questions.", "fixed listings."]), JSON.stringify(dz.achievements));
  check("'Resume' as a title and the home address removed; the summary loses 'references available'", af.patch.personalInfo.title === "" && af.patch.personalInfo.address === "" && af.patch.professionalSummary.summary === "BBA student.");
  check("the empty activity removed", af.patch.activities.length === 1);
  check("nothing saved by the preview", (await reqS("./models/Resume").findById(R1).lean()).personalInfo.address === "House 12, Street 4, Gulshan");

  console.log("-- speak mode");
  r = await audioUpload("/api/resume/ai/transcribe", T.S, 1000, 5);
  check("resumeSpeak off → 404", r.status === 404);
  process.env.FLAG_RESUME_SPEAK = `ids:${S}`;
  r = await audioUpload("/api/resume/ai/transcribe", T.S, 1000, 5);
  check("on: the text comes back", r.status === 200 && r.json.data.text === "i was the events lead at ieee", r.text);
  check("…English, whisper by default, the audio only in memory", asked.some((a) => a.audio && a.model === "whisper-1"));
  r = await audioUpload("/api/resume/ai/transcribe", T.S, 1000, 75);
  check("over a minute → 413", r.status === 413);
  r = await audioUpload("/api/resume/ai/transcribe", T.S, 3 * 1024 * 1024, 30);
  check("over 2 MB → 413", r.status === 413);
  r = await audioUpload("/api/resume/ai/transcribe", T.O, 1000, 5);
  check("speak is its own flag (the other student has the coach, not speak) → 404", r.status === 404);

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
