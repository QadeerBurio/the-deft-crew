// P3d outcome loop (owner #10 + P3d #7 / #8)
//   the snapshot: POST /api/jobs/apply/:jobId with tdcResumeId (the student's own resume) → JobApplication.resumeSource
//     { kind: "tdc_resume", resumeId, templateId (read from the resume now; an older id → its template), at }; another
//     student's resume, a malformed id or none → no snapshot and the application still goes through; a later template
//     switch doesn't change it
//   interviews: application status (interview / hired), a scheduled CareerInterview, a CareerOutcome not revoked
//   students (resumeV2 + resumeOutcomeStats): GET /api/resume/template-outcomes shows a template only with >= 30
//     applications AND >= 10 interviews (a revoked outcome doesn't count); never a number below that
//   admins (analytics.view): GET /api/analytics/admin/resume-metrics: every template's resumes, applications,
//     interviews, hires, whether its rate is shown; public pages on and their views; students → 403
//   node tests/resume-outcomes/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resumeFinish.routes"], ["/api/analytics", "./routes/analytics.routes"]], models: ["Resume", "CareerInterview", "CareerOutcome"] });
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;

const DAY = 86400000;
const S = oid(); const O = oid(); const E = oid(); const A = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Malik"), user(O, "student", "Other Student"), user(E, "employee", "Bright Labs"), user(A, "admin", "Admin One")]);
const job = (id) => ({ _id: id, title: "Marketing Intern", department: "Marketing", location: "Karachi", type: "Internship", salary: "40k", email: "jobs@example.com", description: "help", companyName: "Bright Labs", postedBy: E, isExternal: false, active: true, archivedAt: null, totalApplications: 0, views: 0, applicationDeadline: new Date(Date.now() + 10 * DAY), createdAt: new Date() });
const J1 = oid(); const J2 = oid(); const J3 = oid(); const J4 = oid();
fake.seed(coll("Job"), [job(J1), job(J2), job(J3), job(J4)]);
const R = oid(); const RO = oid();
fake.seed(coll("Resume"), [
  { _id: R, user: S, template: "classic", personalInfo: { firstName: "Sana" }, publicPage: { on: true, views: 7 }, createdAt: new Date(), updatedAt: new Date() },
  { _id: RO, user: O, template: "campus", personalInfo: { firstName: "Other" }, createdAt: new Date(), updatedAt: new Date() },
]);
const T = { S: token(S, "student"), O: token(O, "student"), A: token(A, "admin") };
const body = (extra = {}) => ({ fullName: "Sana Malik", email: "sana@test.local", phone: "03001234567", coverLetter: "hello", ...extra });
const appFor = (jobId) => rows("JobApplication", (x) => same(x.jobId, jobId) && same(x.userId, S))[0];

(async () => {
  const server = h.start();
  console.log("-- the snapshot");
  let r = await call("POST", `/api/jobs/apply/${J1}`, { tok: T.S, body: body({ tdcResumeId: String(R) }) });
  let a = appFor(J1);
  check("applied with my tdc resume → the snapshot, the template read from the resume ('classic' → Classic)", r.status === 201 || r.status === 200 ? a?.resumeSource?.kind === "tdc_resume" && same(a.resumeSource.resumeId, R) && a.resumeSource.templateId === "stanford" && a.resumeSource.at : false, `${r.status} ${JSON.stringify(a?.resumeSource)}`);
  rows("Resume", (x) => same(x._id, R))[0].template = "jakes";
  check("a later template switch doesn't change it", appFor(J1).resumeSource.templateId === "stanford");
  r = await call("POST", `/api/jobs/apply/${J2}`, { tok: T.S, body: body({ tdcResumeId: String(RO) }) });
  check("another student's resume → no snapshot, the application still goes through", [200, 201].includes(r.status) && appFor(J2) && !appFor(J2).resumeSource, `${r.status}`);
  r = await call("POST", `/api/jobs/apply/${J3}`, { tok: T.S, body: body({ tdcResumeId: "not-an-id" }) });
  check("a malformed id → no snapshot, applied", [200, 201].includes(r.status) && appFor(J3) && !appFor(J3).resumeSource);
  r = await call("POST", `/api/jobs/apply/${J4}`, { tok: T.S, body: body() });
  check("an older app (no field) → exactly as before", [200, 201].includes(r.status) && appFor(J4) && !appFor(J4).resumeSource);

  console.log("-- interview rates");
  const apps = []; const interviews = []; const outcomes = [];
  const seed = (templateId, n, interviewed, { revoked = 0 } = {}) => {
    for (let i = 0; i < n; i++) {
      const id = oid();
      let status = "pending";
      if (i < interviewed) {
        const how = i % 3;
        if (how === 0) status = i === 0 ? "hired" : "interview";
        if (how === 1) interviews.push({ _id: oid(), application: id, job: J1, employer: E, candidate: S, startsAt: new Date(), endsAt: new Date() });
        if (how === 2) outcomes.push({ _id: oid(), application: id, job: J1, candidate: S, employer: E, outcomeType: "interviewed", verificationLevel: "employer-recorded" });
      } else if (i < interviewed + revoked) {
        outcomes.push({ _id: oid(), application: id, job: J1, candidate: S, employer: E, outcomeType: "interviewed", verificationLevel: "revoked" });
      }
      apps.push({ _id: id, jobId: J1, userId: oid(), fullName: "x", email: "x@x.x", phone: "0", coverLetter: "x", status, resumeSource: { kind: "tdc_resume", resumeId: oid(), templateId, at: new Date() }, createdAt: new Date() });
    }
  };
  seed("campus", 30, 10);               // shown: 30 applications, 10 interviews → 33%
  seed("jakes", 29, 20);                // hidden: 29 applications
  seed("faang", 40, 9, { revoked: 5 }); // hidden: 9 interviews (the 5 revoked don't count)
  fake.seed(coll("JobApplication"), apps);
  fake.seed(coll("CareerInterview"), interviews);
  fake.seed(coll("CareerOutcome"), outcomes);
  reqS("./services/resumeOutcomes")._clear();
  r = await call("GET", "/api/resume/template-outcomes", { tok: T.S });
  check("students: flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O}`;
  process.env.FLAG_RESUME_OUTCOME_STATS = `ids:${S},${O}`;
  r = await call("GET", "/api/resume/template-outcomes", { tok: T.S });
  const shown = r.json?.data?.templates || [];
  check("only a template with >= 30 applications and >= 10 interviews: Campus, 33%", r.status === 200 && shown.length === 1 && shown[0].id === "campus" && shown[0].applications === 30 && shown[0].interviews === 10 && shown[0].rate === 33, JSON.stringify(r.json?.data));
  check("…the minimum is stated (30 / 10)", r.json.data.minimum.applications === 30 && r.json.data.minimum.interviews === 10);
  check("29 applications (Compact) and 9 interviews + 5 revoked (Executive) → nothing shown", !shown.some((x) => ["jakes", "faang"].includes(x.id)));

  console.log("-- admin metrics");
  r = await call("GET", "/api/analytics/admin/resume-metrics", { tok: T.S });
  check("a student → 403", r.status === 403);
  r = await call("GET", "/api/analytics/admin/resume-metrics", { tok: T.A });
  const m = r.json?.data || {};
  const row = (id) => (m.templates || []).find((x) => x.id === id) || {};
  check("200 for an admin", r.status === 200, r.text.slice(0, 200));
  check("Campus: 30 applications, 10 interviews, 1 hire, rate shown", row("campus").applications === 30 && row("campus").interviews === 10 && row("campus").hires === 1 && row("campus").rateShown === true, JSON.stringify(row("campus")));
  check("Executive: 40 applications, 9 interviews (revoked not counted), rate hidden", row("faang").applications === 40 && row("faang").interviews === 9 && row("faang").rateShown === false, JSON.stringify(row("faang")));
  check("Classic: the snapshot application counted; resumes now on each template (older ids read as theirs)", row("stanford").applications === 1 && row("jakes").resumes === 1 && row("campus").resumes === 1, JSON.stringify([row("stanford"), row("jakes"), row("campus")]));
  check("every template has a row (the five + the library), with its name", (m.templates || []).length >= 15 && row("harvard").name === "Harvard" && row("modern_ats").name === "Modern");
  check("public pages: 1 on, 7 views", m.publicPages?.on === 1 && m.publicPages.views === 7, JSON.stringify(m.publicPages));
  check("the route needs analytics.view (Phase A map)", /"GET \/admin\/resume-metrics": "analytics\.view"/.test(require("fs").readFileSync(require("path").join(h.SERVER, "routes", "analytics.routes.js"), "utf8")));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
