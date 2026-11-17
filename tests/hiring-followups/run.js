// Hiring follow-ups (feat/hiring-followups), on in-memory data:
//   1. company verification before posting: an unverified company's new job (add, duplicate, CSV) waits (not live,
//      not public, no applications, can't be switched on); admins see it with the verification; approving publishes
//      it (deadline moved by the wait, trial clock starts, employer note); a verified company posts live; jobs live
//      before stay live
//   2. defaults: currency PKR, company name and logo from the poster's profile (editable); no "The Deft Crew"
//   3. expiry: jobs past their deadline close (closedAt, reason, counts), the employer gets one in-app note per job
//      (no push), a second run does nothing; reopening follows the trial / plan lock and gives 30 more days
//   4. upcoming interviews: classic + hiring timeline, by time, once each
//   node tests/hiring-followups/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/career", "./routes/hiringAccess.routes"]], models: ["EmployerHiringAccess", "EmployerPlanRequest"] });
const { call, upload, check, rows, same, oid, user, token, fake, coll, reqS } = h;
const DAY = 864e5;
const now = Date.now();

const ids = { E1: oid(), E2: oid(), E3: oid(), S1: oid(), S2: oid(), S3: oid(), admin: oid(), admin2: oid() };
fake.seed(coll("User"), [
  user(ids.E1, "employee", "Hina Bright", { companyName: "Bright Labs", logo: "https://cdn.test/bright.png", email: "hina@brightlabs.pk" }),
  user(ids.E2, "employee", "Old Employer", { companyName: "Legacy Co" }),
  user(ids.E3, "employee", "Verified Boss", { companyName: "Verified Co", logo: "https://cdn.test/v.png" }),
  user(ids.S1, "student", "Student One"), user(ids.S2, "student", "Student Two"), user(ids.S3, "student", "Student Three"),
  user(ids.admin, "admin", "Admin One"), user(ids.admin2, "admin", "Admin Two", { companyName: "" }),
]);
const T = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, token(id, /^S/.test(k) ? "student" : /^admin/.test(k) ? "admin" : "employee")]));
const B = "/api/career";
const jobDoc = (id, by, extra = {}) => ({ _id: id, title: "Old role", department: "Engineering", location: "Karachi", type: "Full-time", salary: "100k", email: "jobs@test.local", description: "build things", companyName: "Co", postedBy: by, isExternal: false, active: true, archivedAt: null, totalApplications: 0, views: 0, applicationDeadline: new Date(now + 20 * DAY), createdAt: new Date(now - 30 * DAY), ...extra });
const body = (extra = {}) => ({ title: "Designer", department: "Design", location: "Lahore", type: "Full-time", salary: "80k", email: "jobs@brightlabs.pk", description: "make things", skills: ["Figma"], ...extra });
const post = (tok, extra) => call("POST", "/api/jobs/add", { tok, body: body(extra) });
const jobOf = (id) => rows("Job", (j) => same(j._id, id))[0];
const notes = (who, kind) => rows("Notification", (n) => same(n.recipient, ids[who]) && n.metadata?.kind === kind);
const publicTitles = async () => JSON.stringify((await call("GET", "/api/jobs/public/all?limit=100", { tok: T.S1 })).json);
const details = { companyName: "Bright Labs (Pvt) Ltd", registrationType: "ntn", ntnOrSecp: "1234567-8", businessEmailDomain: "brightlabs.pk", website: "brightlabs.pk" };

(async () => {
  const server = h.start();
  let r;
  process.env.HIRING_TRIAL_START = new Date(now - DAY).toISOString();

  // E3 is verified already (approved before)
  fake.seed(coll("EmployerCompanyVerification"), [{ _id: oid(), employerUserId: ids.E3, companyName: "Verified Co", registrationType: "ntn", ntnOrSecp: "99999999", businessEmailDomain: "verified.pk", website: "verified.pk", companyGroupKey: "reg:99999999", status: "approved", duplicateOf: [], history: [], reviewedAt: new Date(now - 5 * DAY), createdAt: new Date(now - 6 * DAY), updatedAt: new Date(now - 5 * DAY) }]);
  // E2 has a job that was live before verification existed
  const legacyJob = oid();
  fake.seed(coll("Job"), [jobDoc(legacyJob, ids.E2, { title: "Legacy live role" })]);

  // ---------- 2. defaults ----------
  r = await post(T.E3, { title: "Verified role" });
  const vJob = r.json?.data;
  check("verified company: the job is live at once", r.status === 201 && vJob.active === true && vJob.status === "live" && !r.json.pendingVerification, r.text.slice(0, 200));
  check("defaults: currency PKR, company name and logo from the employer's profile", vJob.currency === "PKR" && vJob.companyName === "Verified Co" && vJob.companyLogo === "https://cdn.test/v.png", JSON.stringify({ c: vJob.currency, n: vJob.companyName, l: vJob.companyLogo }));
  r = await post(T.E3, { title: "Edited company", companyName: "Verified Co Karachi", companyLogo: "https://cdn.test/other.png", currency: "USD" });
  check("the form's own company name, logo and currency are kept (editable)", r.status === 201 && r.json.data.companyName === "Verified Co Karachi" && r.json.data.companyLogo === "https://cdn.test/other.png" && r.json.data.currency === "USD");
  r = await post(T.admin2, { title: "No company" });
  check("no company name anywhere: 400 COMPANY_NAME_REQUIRED (never 'The Deft Crew')", r.status === 400 && r.json.code === "COMPANY_NAME_REQUIRED");
  check("the Job model's currency default is PKR", new (reqS("./models/Job"))({}).currency === "PKR");
  check("no job carries 'The Deft Crew' as a default", rows("Job").every((j) => j.companyName !== "The Deft Crew"));

  // ---------- 1. verification before posting ----------
  r = await post(T.E1, { title: "Waiting designer" });
  const W1 = r.json?.data?._id;
  check("unverified company: 201, the job waits ('goes live once your company is verified'), not active", r.status === 201 && r.json.pendingVerification === true && r.json.code === "PENDING_COMPANY_VERIFICATION" && /goes live once your company is verified/.test(r.json.message) && jobOf(W1).active === false && jobOf(W1).pendingVerification === true && r.json.data.status === "pending_verification", r.text.slice(0, 200));
  check("admins are told a job is waiting for verification (both admins)", rows("Notification", (n) => n.metadata?.pendingVerification === true && same(n.metadata.jobId, W1)).length === 2);
  check("the waiting job isn't in the students' list", !(await publicTitles()).includes("Waiting designer"));
  r = await call("GET", `/api/jobs/public/job/${W1}`, { tok: T.S1 });
  check("nor reachable by its link (404)", r.status === 404);
  r = await call("POST", `/api/jobs/apply/${W1}`, { tok: T.S1, body: { fullName: "S", email: "s@t.local", phone: "03001234567", coverLetter: "x" } });
  check("nor open to applications", r.status === 404 && rows("JobApplication", (a) => same(a.jobId, W1)).length === 0);
  r = await call("PATCH", `/api/jobs/toggle/${W1}`, { tok: T.E1 });
  check("switching it on: 409 PENDING_COMPANY_VERIFICATION", r.status === 409 && r.json.code === "PENDING_COMPANY_VERIFICATION" && jobOf(W1).active === false);
  r = await call("PUT", `/api/jobs/update/${W1}`, { tok: T.E1, body: { active: true, description: "edited while waiting" } });
  check("editing it works, but 'active' is ignored", r.status === 200 && jobOf(W1).active === false && jobOf(W1).description === "edited while waiting");
  r = await call("POST", `/api/jobs/duplicate/${W1}`, { tok: T.E1 });
  const W2 = r.json?.data?._id;
  check("a duplicate waits too", r.status === 201 && r.json.pendingVerification === true && jobOf(W2).active === false);
  r = await upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Location\nCSV waiting role,Karachi\n");
  const W3 = rows("Job", (j) => j.title === "CSV waiting role")[0];
  check("a CSV upload's jobs wait too (the reply says so)", r.status === 200 && r.json.pendingVerification === true && W3 && W3.active === false && W3.pendingVerification === true && W3.companyLogo === "https://cdn.test/bright.png", r.text.slice(0, 200));
  r = await call("GET", "/api/jobs/my-jobs", { tok: T.E1 });
  check("'my jobs' shows them as pending_verification", r.status === 200 && r.json.filter((j) => j.status === "pending_verification").length === 3);
  r = await call("GET", "/api/jobs/stats", { tok: T.E1 });
  check("stats: 3 jobs, 0 active, 3 pending", r.json.totalJobs === 3 && r.json.activeJobs === 0 && r.json.pendingJobs === 3, JSON.stringify(r.json).slice(0, 200));
  r = await call("GET", `${B}/employers/me/hiring-access`, { tok: T.E1 });
  check("a waiting job doesn't start the trial's 60 days", r.json.data.trial.clockStarted === false, JSON.stringify(r.json.data.trial));
  check("a job live before verification existed stays live", jobOf(legacyJob).active === true && (await publicTitles()).includes("Legacy live role"));

  // the employer verifies (no First Hire Free pilot needed)
  r = await call("GET", `${B}/employers/me/company-verification`, { tok: T.E1 });
  check("employer: not verified, 3 jobs waiting, the message", r.status === 200 && r.json.data.verified === false && r.json.data.pendingJobs.length === 3 && /go live once your company is verified/.test(r.json.data.message));
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: details });
  check("employer sends company details outside the pilot: 201 pending", r.status === 201 && r.json.data.verification.status === "pending", r.text.slice(0, 200));
  r = await call("GET", `${B}/admin/company-verifications?status=pending`, { tok: T.E1 });
  check("an employer can't open the admin list", r.status === 403);
  r = await call("GET", `${B}/admin/company-verifications?status=pending`, { tok: T.admin });
  const row = r.json?.data?.[0];
  check("admin: the verification with its 3 waiting jobs", r.status === 200 && row && row.companyName === "Bright Labs (Pvt) Ltd" && row.pendingJobs.length === 3 && row.pendingJobs.some((j) => j.title === "Waiting designer"), r.text.slice(0, 300));
  const deadlineBefore = new Date(jobOf(W1).applicationDeadline).getTime();
  const createdW1 = new Date(jobOf(W1).createdAt).getTime();
  r = await call("POST", `${B}/admin/company-verifications/${row.id}/review`, { tok: T.admin, body: { action: "approve" } });
  check("approve without a reason: 400", r.status === 400);
  r = await call("POST", `${B}/admin/company-verifications/${row.id}/review`, { tok: T.admin, body: { action: "approve", reason: "NTN checked on FBR" } });
  check("approve: 3 jobs published", r.status === 200 && r.json.data.status === "approved" && r.json.data.publishedJobs === 3, r.text.slice(0, 200));
  check("they're live now, waiting flag cleared", [W1, W2, W3._id].every((id) => jobOf(id).active === true && jobOf(id).pendingVerification === false && jobOf(id).publishedAt));
  check("the deadline moved by the time it waited", new Date(jobOf(W1).applicationDeadline).getTime() >= deadlineBefore + (new Date(jobOf(W1).publishedAt).getTime() - createdW1) - 1000);
  check("students see them", (await publicTitles()).includes("Waiting designer"));
  check("the employer gets one note 'Your jobs are live' (no push)", notes("E1", "jobs_published").length === 1 && notes("E1", "jobs_published")[0].metadata.skipPush === true);
  r = await call("GET", `${B}/employers/me/hiring-access`, { tok: T.E1 });
  check("the trial's 60 days started when they went live", r.json.data.trial.clockStarted === true && r.json.data.trial.daysLeft === 60);
  check("the approval is in AdminActionLog", rows("AdminActionLog", (l) => l.action === "employer.verification.review" && l.after?.publishedJobs === 3).length === 1);
  r = await post(T.E1, { title: "After approval" });
  check("after approval, a new job is live at once", r.status === 201 && r.json.data.active === true && !r.json.pendingVerification);

  // ---------- 3. expiry ----------
  const X1 = oid(), X2 = oid(), X3 = oid();
  fake.seed(coll("Job"), [
    jobDoc(X1, ids.E3, { title: "Expired one", applicationDeadline: new Date(now - DAY) }),
    jobDoc(X2, ids.E3, { title: "Expired two", applicationDeadline: new Date(now - 2 * DAY) }),
    jobDoc(X3, undefined, { title: "Expired import", isExternal: true, applicationDeadline: new Date(now - DAY) }),
  ]);
  r = await call("GET", "/api/jobs/stats", { tok: T.E3 });
  check("before the run, a past-deadline job already isn't counted as active", r.json.activeJobs === 2 && r.json.closedJobs === 2, JSON.stringify(r.json).slice(0, 200));
  const closed = await reqS("./services/jobIngestionService").cleanupExpiredJobs();
  check("the expiry run closes the 3 jobs past their deadline", closed === 3 && [X1, X2, X3].every((id) => jobOf(id).active === false && jobOf(id).closedReason === "deadline" && jobOf(id).closedAt), String(closed));
  check("the employer gets an in-app note per closed job (no push); the import has no owner, no note", notes("E3", "job_closed").length === 2 && notes("E3", "job_closed").every((n) => n.metadata.skipPush === true && /closed: its application deadline/.test(n.description)));
  check("a second run closes nothing and sends nothing", (await reqS("./services/jobs/jobStatus").closeExpired()) === 0 && notes("E3", "job_closed").length === 2);
  check("live jobs are untouched", jobOf(vJob._id).active === true && !jobOf(vJob._id).closedAt);
  r = await call("GET", "/api/jobs/my-jobs", { tok: T.E3 });
  check("'my jobs': closed jobs show as closed", r.json.filter((j) => j.status === "closed").length === 2);
  r = await call("GET", "/api/jobs/stats", { tok: T.E3 });
  check("stats after the run: active 2, closed 2", r.json.activeJobs === 2 && r.json.closedJobs === 2 && r.json.totalJobs === 4);
  r = await call("PATCH", `/api/jobs/toggle/${X1}`, { tok: T.E3 });
  check("reopen on the trial: open again with 30 more days, closed flag cleared", r.status === 200 && r.json.active === true && r.json.status === "live" && jobOf(X1).closedAt === null && Math.abs(new Date(jobOf(X1).applicationDeadline) - (Date.now() + 30 * DAY)) < 60e3, r.text);
  check("the reopened job is public again", (await publicTitles()).includes("Expired one"));
  // the trial ends: reopening is locked
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E3}/trial`, { tok: T.admin, body: { action: "end", reason: "test the lock" } });
  r = await call("PATCH", `/api/jobs/toggle/${X2}`, { tok: T.E3 });
  check("reopen after the trial (no plan): 403 POSTING_LOCKED, stays closed", r.status === 403 && r.json.code === "POSTING_LOCKED" && jobOf(X2).active === false);
  r = await call("PUT", `/api/jobs/update/${X2}`, { tok: T.E3, body: { active: true } });
  check("reopen through the edit form after the trial: 403 too", r.status === 403 && r.json.code === "POSTING_LOCKED" && jobOf(X2).active === false);
  await call("POST", `${B}/admin/hiring-plans/${ids.E3}/grant`, { tok: T.admin, body: { jobs: 1, reason: "one more" } });
  r = await call("PUT", `/api/jobs/update/${X2}`, { tok: T.E3, body: { active: true } });
  check("with a plan: reopening through the form works, 30 more days", r.status === 200 && jobOf(X2).active === true && !jobOf(X2).closedAt && new Date(jobOf(X2).applicationDeadline) > new Date(), r.text.slice(0, 150));

  // ---------- 4. upcoming interviews ----------
  const IJ = oid();
  fake.seed(coll("Job"), [jobDoc(IJ, ids.E1, { title: "Interview job" })]);
  const A1 = oid(), A2 = oid(), A3 = oid(), A4 = oid();
  const app = (id, who, name, extra = {}) => ({ _id: id, jobId: IJ, userId: ids[who], fullName: name, email: `${who}@t.local`, phone: "1", coverLetter: "x", status: "interview", appliedAt: new Date(), ...extra });
  fake.seed(coll("JobApplication"), [
    app(A1, "S1", "Classic Later", { interviewDate: new Date(now + 3 * DAY), meetingLink: "https://meet.test/classic" }),
    app(A2, "S2", "Timeline Sooner"),
    app(A3, "S3", "Both Kinds", { interviewDate: new Date(now + 5 * DAY) }),
    app(A4, "S1", "Past Classic", { interviewDate: new Date(now - DAY) }),
  ]);
  const iv = (application, candidate, startsAt, extra = {}) => ({ _id: oid(), application, job: IJ, employer: ids.E1, candidate: ids[candidate], startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60e3), timezone: "Asia/Karachi", mode: "online", meetingLink: "https://meet.test/tl", status: "accepted", active: true, calendarUid: String(oid()), calendarSequence: 0, history: [], responses: [], createdAt: new Date(), updatedAt: new Date(), ...extra });
  fake.seed(coll("CareerInterview"), [
    iv(A2, "S2", new Date(now + DAY)),
    iv(A3, "S3", new Date(now + 2 * DAY), { status: "invited" }),
    iv(oid(), "S1", new Date(now + 4 * DAY), { status: "cancelled", active: false }),
    { ...iv(oid(), "S1", new Date(now + DAY)), employer: ids.E3 }, // another employer's
  ]);
  r = await call("GET", "/api/jobs/interviews/upcoming", { tok: T.E1 });
  const list = r.json || [];
  check("upcoming: classic + timeline, sorted by time", r.status === 200 && JSON.stringify(list.map((x) => x.fullName)) === JSON.stringify(["Timeline Sooner", "Both Kinds", "Classic Later"]), JSON.stringify(list.map((x) => [x.fullName, x.source, x.interviewDate])));
  check("no duplicates: an application with both shows its timeline interview once", list.filter((x) => x.fullName === "Both Kinds").length === 1 && list.find((x) => x.fullName === "Both Kinds").source === "timeline");
  check("past, cancelled and other employers' interviews are left out", !list.some((x) => x.fullName === "Past Classic") && list.length === 3);
  check("timeline rows carry the job, meeting link and status", list[0].jobId?.title === "Interview job" && list[0].meetingLink === "https://meet.test/tl" && list[0].interviewStatus === "accepted");

  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
