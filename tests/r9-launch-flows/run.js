// r9 launch (owner): the full student flows with launchV2 ON (FLAG_LAUNCH_V2=on: everything it turns on, nothing else),
// on in-memory data with the real routes and the AI stubbed:
//   signup with an invite code → crew (invitation, hub, daily card) → ambassador apply → resume: create, coach, template,
//   feedback, cover letter, the PDF's HTML in the chosen template → confessions: rules, post (observe mode: live),
//   post with a poll, vote, follow, report → notifications: the unified inbox, settings → onboarding goals → home next
//   action. Every step answers as designed; no server error; no hidden field leaks (harness scan). Off: the v2 routes
//   are absent again (404).
//   node tests/r9-launch-flows/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
process.env.RATE_LIMIT_RESUME_AI_MAX = "1000";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [
    ["/api/auth", "./routes/auth.routes"], ["/api/app", "./routes/appFlags.routes"], ["/api/crew", "./routes/crew.routes"],
    ["/api/engagement", "./routes/engagement.routes"], ["/api/notification", "./routes/notification.routes"],
    ["/api/social", "./routes/confessionSafety.routes"], ["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"],
    ["/api/resume/ai", "./routes/resumeCoach.routes"], ["/api/resume", "./routes/resumeFinish.routes"], ["/api/resume", "./routes/resume.routes"],
  ],
  models: ["Confession", "University", "Resume", "Notification", "Report", "SafetySettings", "SavedItem", "ConfessionFollow", "ResumeSettings", "ResumeFeedback", "PartnerApplication", "OtpCode"],
});
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;
const ago = (d) => new Date(Date.now() - d * 864e5);
const U = oid(); const S = oid(); const O = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
fake.seed(coll("User"), [
  user(S, "student", "Sana Malik", { createdAt: ago(30), university: U, referralCode: "SANA01", emailVerified: true, isVerified: true }),
  user(O, "student", "Omar Reader", { createdAt: ago(40), university: U, referralCode: "OMAR02", emailVerified: true }),
]);
// the AI, stubbed: whatever a prompt asks for, a reply built only from the resume's own facts
const AI = { chat: { completions: { create: async ({ messages }) => {
  const sys = String(messages[0].content);
  let out = {};
  if (/cover letter/i.test(sys)) out = { paragraphs: ["I am applying for the Marketing Intern role at Acme because the role fits what I study.", "At Alpha University I built the Bus tracker project.", "I would welcome an interview."] };
  else if (/feedback/i.test(sys)) out = { strong: ["the projects section is clear"], weak: [], improvements: [] };
  else out = { bullets: ["Built a bus tracker for students"], suggestions: ["Built a bus tracker for students"] };
  return { choices: [{ message: { content: JSON.stringify(out) } }] };
} } } };
reqS("./services/resumeCoach")._setClient(AI);
reqS("./services/resumeWriter")._setClient(AI);

(async () => {
  const server = h.start();
  process.env.FLAG_LAUNCH_V2 = "on";
  const T = token(S, "student");
  const fl = (await call("GET", "/api/app/flags/me", { tok: T })).json || {};
  check("launchV2 on: the app sees resumeV2, confessionsV2, growthV2, ambassadorV2 on; confessionShare / resumePublicPage / confessionsVoting off", fl.resumeV2 && fl.confessionsV2 && fl.growthV2 && fl.ambassadorV2 && !fl.confessionShare && !fl.resumePublicPage && !fl.confessionsVoting);

  console.log("-- signup with an invite");
  let r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "new.student@test.local", password: "Passw0rd!x", phone: "03001112223", fullName: "New Student", universityName: "Alpha University", rollNo: "21K-9", referralCodeInput: "SANA01" } }); // the field the app sends (SignupScreen)
  const nu = rows("User", (x) => x.email === "new.student@test.local")[0];
  check("signup with Sana's code: account made, referred by her", r.status >= 200 && r.status < 300 && nu && same(nu.referredBy, S), `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

  console.log("-- crew and ambassador");
  for (const p of ["/api/crew/invitation", "/api/crew/daily-card", "/api/crew/campus-count", "/api/engagement/referrals/me"]) {
    r = await call("GET", p, { tok: T });
    check(`GET ${p}: 200`, r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  r = await call("POST", "/api/crew/applications", { tok: T, body: { why: "i run the coding society and want to help students save", whyChips: ["help students"], hoursPerWeek: 5 } });
  check("ambassador apply: accepted", r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  r = await call("GET", "/api/crew/applications/me", { tok: T });
  check("…status: pending", r.status === 200 && /pending/.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 160));
  r = await call("GET", "/api/crew/me", { tok: T });
  check("…the ambassador hub is for approved ambassadors only (403 NOT_AMBASSADOR while pending)", r.status === 403 && r.json?.code === "NOT_AMBASSADOR");

  console.log("-- resume: start → coach → template → feedback → cover letter → PDF");
  r = await call("POST", "/api/resume", { tok: T, body: { title: "My resume", personalInfo: { firstName: "Sana", lastName: "Malik", email: "sana@example.com" }, education: [{ institution: "Alpha University", degree: "BS", fieldOfStudy: "Computer Science" }], projects: [{ name: "Bus tracker", description: "- A live bus map for students" }], skills: [{ name: "Python" }] } });
  const R = r.json?.data?._id || r.json?._id || r.json?.resume?._id;
  check("resume created", r.status >= 200 && r.status < 300 && !!R, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  r = await call("POST", "/api/resume/ai/coach", { tok: T, body: { action: "bullets", facts: { role: "Developer", organisation: "Bus tracker", did: ["built a bus map"], section: "projects" } } });
  check("coach: suggestions from the student's facts", r.status === 200 && Array.isArray(r.json?.data?.suggestions), `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  r = await call("PUT", `/api/resume/${R}/template`, { tok: T, body: { template: "campus" } });
  check("template: one of the 10 new templates (campus) saved", r.status === 200 && rows("Resume", (x) => same(x._id, R))[0]?.template === "campus", `${r.status}`);
  r = await call("GET", "/api/resume/templates/hidden", { tok: T });
  check("…the admin-hidden list reads (none hidden)", r.status === 200 && JSON.stringify(r.json?.data?.hidden) === "[]");
  r = await call("POST", `/api/resume/${R}/feedback`, { tok: T });
  check("feedback: rules + AI points", r.status === 200 && Array.isArray(r.json?.data?.strong), `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  r = await call("POST", `/api/resume/${R}/cover-letter`, { tok: T, body: { jobTitle: "Marketing Intern", company: "Acme" } });
  check("cover letter: written from the resume", r.status === 200 && r.json?.data?.ai === true && r.json.data.paragraphs.length >= 2, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  const resume = rows("Resume", (x) => same(x._id, R))[0];
  const html = reqS("./utils/resumeRender").renderResumeHTML(resume, resume.template, resume.customStyles || {});
  check("PDF: the HTML the phone prints, in the chosen template (the name, the project)", /data-template="campus"/.test(html) && html.includes("Sana") && html.includes("Bus tracker"));

  console.log("-- confessions (safety in observe mode by default)");
  r = await call("POST", "/api/social/confessions/rules/accept", { tok: T });
  check("rules accepted", r.status === 200);
  r = await call("POST", "/api/social/confessions/create", { tok: T, body: { text: "the canteen chai saved my exam week", visibility: "public", tag: "food", postAs: "anon" } });
  const C1 = r.json?.confession?._id;
  check("post: live (observe mode never holds)", r.status === 201 && !!C1 && !r.json.held, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  r = await call("POST", "/api/social/confessions/create", { tok: token(O, "student"), body: { text: "chai or coffee before a viva?", visibility: "public", poll: { options: ["chai", "coffee"] } } });
  const C2 = r.json?.confession?._id;
  check("post with a poll", r.status === 201 && !!C2, `${r.status}`);
  r = await call("PUT", `/api/social/confessions/${C2}/poll`, { tok: T, body: { option: 0 } });
  check("vote in the poll", r.status === 200 && r.json?.poll?.myVote === 0, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call("PUT", `/api/social/confessions/${C2}/follow`, { tok: T, body: { on: true } });
  check("follow", r.status === 200 && r.json?.following === true);
  r = await call("POST", `/api/social/confessions/${C2}/report`, { tok: T, body: { reason: "Spam" } });
  check("report", r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call("PUT", `/api/social/confessions/${C2}/vote`, { tok: T, body: { vote: "down" } });
  check("voting stays off (not in launchV2): 404", r.status === 404);
  r = await call("POST", `/api/social/confessions/${C1}/share`, { tok: T });
  check("share links stay off until launchLinks (gettdc.pk): 404", r.status === 404);

  console.log("-- notifications, goals, home");
  r = await call("GET", "/api/notification/unified", { tok: T });
  check("the unified inbox", r.status === 200, `${r.status}`);
  r = await call("GET", "/api/engagement/notification-prefs", { tok: T });
  const prefs = r.json || {};
  check("notification settings read", r.status === 200);
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: T, body: { ...(prefs.data || prefs), messages: false } });
  check("…and saved", r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call("POST", "/api/engagement/goals", { tok: T, body: { goals: ["save_money", "internship"] } }); // services/engagement/goals.js ids
  check("onboarding goals saved", r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call("GET", "/api/engagement/next-action", { tok: T });
  check("home next action", r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

  delete process.env.FLAG_LAUNCH_V2;
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T });
  const r2 = await call("POST", `/api/resume/${R}/cover-letter`, { tok: T, body: { jobTitle: "x", company: "y" } });
  check("launchV2 off again: the v2 routes are absent (404), as today", r.status === 404 && r2.status === 404);
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
