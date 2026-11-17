// Free trial and hiring plans (feat/hiring-trial), the whole flow on in-memory data:
//   post -> apply -> pipeline (reviewed, shortlisted) -> interview (schedule, student accepts, reschedule) -> offer ->
//   accept -> hire confirmed -> First Hire Free used (company approved by an admin) -> the trial ends ("your free hire
//   is used") -> posting refused (add, duplicate, CSV, deadline extension, switching a closed job on) -> the existing
//   job still works (apply, pipeline, interview) -> request a plan (admins notified) -> admin grants 2 jobs -> 2 posts
//   allowed, the 3rd refused (also two at once with one left) -> CSV within a plan -> plan expiry locks again;
//   the 60-day path; admin extend / end (AdminActionLog); existing employers start fresh; the overview counts;
//   HIRING_TRIAL_OFF; roles; leak scan.
//   node tests/hiring-trial/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/career", "./routes/hiringAccess.routes"]], models: ["EmployerHiringAccess", "EmployerPlanRequest"] });
const { call, upload, check, rows, same, oid, user, token, fake, coll } = h;
const DAY = 864e5;
const now = Date.now();

const ids = { E1: oid(), E2: oid(), E3: oid(), E4: oid(), E5: oid(), S1: oid(), S2: oid(), S3: oid(), admin: oid(), admin2: oid() };
fake.seed(coll("User"), [
  user(ids.E1, "employee", "Hina Bright", { companyName: "Bright Labs", email: "hina@brightlabs.pk" }),
  user(ids.E2, "employee", "Old Timer", { companyName: "Legacy Co" }),
  user(ids.E3, "employee", "Sixty Days", { companyName: "Clock Co" }),
  user(ids.E4, "employee", "Admin Target", { companyName: "Target Co" }),
  user(ids.E5, "employee", "Brand New", { companyName: "Fresh Co" }),
  user(ids.S1, "student", "Student One"), user(ids.S2, "student", "Student Two"), user(ids.S3, "student", "Student Three"),
  user(ids.admin, "admin", "Admin One"), user(ids.admin2, "admin", "Admin Two"),
]);
const T = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, token(id, /^S/.test(k) ? "student" : /^admin/.test(k) ? "admin" : "employee")]));
const jobDoc = (id, by, extra = {}) => ({ _id: id, title: "Old role", department: "Engineering", location: "Karachi", type: "Full-time", salary: "100k", email: "jobs@test.local", description: "build things", companyName: "Co", postedBy: by, isExternal: false, active: true, archivedAt: null, totalApplications: 0, views: 0, applicationDeadline: new Date(now + 20 * DAY), createdAt: new Date(now - DAY), ...extra });
const B = "/api/career";
const post = (tok, title = "Designer") => call("POST", "/api/jobs/add", { tok, body: { title, department: "Design", location: "Lahore", type: "Full-time", salary: "80k", email: "jobs@brightlabs.pk", description: "make things", skills: ["Figma"] } });
const apply = (jobId, tok, name = "Student") => call("POST", `/api/jobs/apply/${jobId}`, { tok, body: { fullName: name, email: "s@test.local", phone: "03001234567", coverLetter: "hello" } });
const accessOf = (k) => rows("EmployerHiringAccess", (a) => same(a.employerUserId, ids[k]))[0];
const logs = (action) => rows("AdminActionLog", (l) => l.action === action);
const me = async (k) => (await call("GET", `${B}/employers/me/hiring-access`, { tok: T[k] })).json?.data;
const inHours = (x) => new Date(Date.now() + x * 3600e3).toISOString();

(async () => {
  const server = h.start();
  let r, d;
  // policy start: yesterday (release); the pilots for the hiring timeline and First Hire Free
  process.env.HIRING_TRIAL_START = new Date(now - DAY).toISOString();
  process.env.FLAG_CAREER_TIMELINE = `ids:${Object.values(ids).join(",")}`;
  process.env.FLAG_EMPLOYER_FIRST_HIRE_FREE = `ids:${ids.E1}`;

  // ---------- roles ----------
  r = await call("GET", `${B}/employers/me/hiring-access`, { tok: T.S1 });
  check("a student can't read an employer's hiring access (403)", r.status === 403);
  r = await call("GET", `${B}/admin/hiring-plans`, { tok: T.E1 });
  check("an employer can't open the admin hiring plans (403)", r.status === 403);
  r = await call("GET", `${B}/employers/me/hiring-access`);
  check("signed out: 401", r.status === 401);

  // ---------- a new employer: trial, clock not started ----------
  d = await me("E1");
  check("new employer: free trial, can post, the 60 days haven't started (no job yet), the policy text", d.canPost && d.trial.status === "active" && d.trial.clockStarted === false && d.trial.daysLeft === null && /60 days after your first job/.test(d.policy.text) && !d.plan, JSON.stringify(d.trial));

  // ---------- post ----------
  r = await post(T.E1, "Backend Engineer");
  const J1 = r.json?.data?._id;
  check("post a job on the trial: 201", r.status === 201 && J1, r.text.slice(0, 150));
  d = await me("E1");
  check("after the first job: the 60 days started (60 days left)", d.trial.clockStarted && d.trial.daysLeft === 60 && accessOf("E1").trialStartedAt, JSON.stringify(d.trial));
  r = await call("GET", "/api/jobs/public/all", { tok: T.S1 });
  check("the job is live for students", r.status === 200 && JSON.stringify(r.json).includes("Backend Engineer"));

  // ---------- apply + pipeline + interview + offer + hire ----------
  r = await apply(J1, T.S1, "Student One");
  check("student applies: 201", r.status === 201);
  const A1 = rows("JobApplication", (a) => same(a.jobId, J1) && same(a.userId, ids.S1))[0]._id;
  const ver = async (tok) => (await call("GET", `${B}/applications/${A1}/timeline`, { tok })).json.data.version;
  r = await call("POST", `${B}/applications/${A1}/events`, { tok: T.E1, body: { type: "REVIEWED", version: await ver(T.E1) } });
  check("pipeline: reviewed", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  r = await call("POST", `${B}/applications/${A1}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: await ver(T.E1) } });
  check("pipeline: shortlisted", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  const slot = { startsAt: inHours(48), durationMinutes: 45, timezone: "Asia/Karachi", mode: "online", meetingLink: "https://meet.example.test/abc" };
  r = await call("POST", `${B}/interviews`, { tok: T.E1, body: { applicationId: String(A1), version: await ver(T.E1), ...slot } });
  const IV = rows("CareerInterview", (i) => same(i.application, A1))[0];
  check("interview scheduled", (r.status === 201 || r.status === 200) && IV, r.text.slice(0, 150));
  r = await call("POST", `${B}/interviews/${IV._id}/respond`, { tok: T.S1, body: { version: await ver(T.S1), response: "accept" } });
  check("student accepts the interview", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  r = await call("POST", `${B}/interviews/${IV._id}/reschedule`, { tok: T.E1, body: { version: await ver(T.E1), ...slot, startsAt: inHours(72) } });
  check("employer reschedules", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  r = await call("POST", `${B}/offers`, { tok: T.E1, body: { applicationId: String(A1), version: await ver(T.E1), title: "Backend Engineer", terms: "full time", expiresAt: inHours(24 * 7) } });
  const OF = rows("CareerOffer", (o) => same(o.application, A1))[0];
  check("offer sent", (r.status === 201 || r.status === 200) && OF, r.text.slice(0, 150));
  r = await call("POST", `${B}/offers/${OF._id}/respond`, { tok: T.S1, body: { version: await ver(T.S1), response: "accept" } });
  check("student accepts the offer", r.status === 201 || r.status === 200, r.text.slice(0, 150));

  // First Hire Free: the company is verified by an admin and the free hire activated before the hire
  r = await call("POST", `${B}/employers/me/verification`, { tok: T.E1, body: { companyName: "Bright Labs (Pvt) Ltd", registrationType: "ntn", ntnOrSecp: "1234567-8", businessEmailDomain: "brightlabs.pk", website: "brightlabs.pk" } });
  const V1 = r.json?.data?.verification?.id;
  r = await call("POST", `${B}/admin/verifications/${V1}/review`, { tok: T.admin, body: { action: "approve", reason: "NTN checked on FBR" } });
  check("admin verifies the company (First Hire Free)", r.status === 200 && r.json.data.status === "approved", r.text.slice(0, 150));
  r = await call("POST", `${B}/employers/me/trial/activate`, { tok: T.E1 });
  check("free hire activated", r.status === 201 || r.status === 200);
  d = await me("E1");
  check("before the hire: still on the trial, free hire not used", d.canPost && d.trial.status === "active" && !d.trial.freeHireUsed);
  r = await call("POST", `${B}/offers/${OF._id}/confirm-hire`, { tok: T.E1, body: { version: await ver(T.E1) } });
  await new Promise((x) => setTimeout(x, 60));
  check("hire confirmed: the free hire is used (First Hire Free ledger)", (r.status === 201 || r.status === 200) && rows("EmployerHiringBillingEvent", (b) => b.eventType === "free_hire_consumed").length === 1, r.text.slice(0, 150));

  // ---------- the trial ended by the hire ----------
  d = await me("E1");
  check("trial ended: 'your free hire is used', reason free_hire_used, can't post, the lock message says request a plan", !d.canPost && d.trial.status === "ended" && d.trial.endReason === "free_hire_used" && d.trial.label === "your free hire is used" && d.trial.freeHireUsed && d.lock?.code === "POSTING_LOCKED" && /request a plan/i.test(d.lock.message), JSON.stringify(d));
  const jobsBefore = rows("Job").length;
  r = await post(T.E1, "Refused role");
  check("post after the trial: 403 POSTING_LOCKED with the reason, nothing saved", r.status === 403 && r.json.code === "POSTING_LOCKED" && r.json.reason === "free_hire_used" && /free hire is used/i.test(r.json.error) && rows("Job").length === jobsBefore, r.text);
  r = await call("POST", `/api/jobs/duplicate/${J1}`, { tok: T.E1 });
  check("duplicate after the trial: 403 POSTING_LOCKED", r.status === 403 && r.json.code === "POSTING_LOCKED" && rows("Job").length === jobsBefore);
  r = await upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Location\nCSV role,Karachi\n");
  check("CSV upload after the trial: 403 POSTING_LOCKED", r.status === 403 && r.json.code === "POSTING_LOCKED" && rows("Job").length === jobsBefore, r.text.slice(0, 150));
  r = await call("PUT", `/api/jobs/update/${J1}`, { tok: T.E1, body: { applicationDeadline: new Date(now + 300 * DAY).toISOString() } });
  check("extending a deadline after the trial: 403 POSTING_LOCKED", r.status === 403 && r.json.code === "POSTING_LOCKED");
  r = await call("PUT", `/api/jobs/update/${J1}`, { tok: T.E1, body: { description: "build better things", applicationDeadline: new Date(now + 2 * DAY).toISOString() } });
  check("editing the job (and an earlier deadline) still works", r.status === 200 && rows("Job", (j) => same(j._id, J1))[0].description === "build better things", r.text.slice(0, 150));
  const closedJ = oid();
  fake.seed(coll("Job"), [jobDoc(closedJ, ids.E1, { title: "Closed role", active: false, applicationDeadline: new Date(now - DAY) })]);
  r = await call("PATCH", `/api/jobs/toggle/${closedJ}`, { tok: T.E1 });
  check("switching a closed (past deadline) job back on after the trial: 403", r.status === 403 && r.json.code === "POSTING_LOCKED");
  r = await call("POST", "/api/jobs/add", { tok: T.admin, body: { title: "tdc role", department: "Ops", location: "Karachi", type: "Full-time", salary: "1", email: "a@tdc.pk", description: "x" } });
  check("an admin still posts (never locked)", r.status === 201);

  // ---------- the existing job keeps working ----------
  r = await apply(J1, T.S2, "Student Two");
  check("the existing open job still takes applications", r.status === 201, r.text.slice(0, 150));
  const A2 = rows("JobApplication", (a) => same(a.jobId, J1) && same(a.userId, ids.S2))[0]._id;
  const ver2 = async (tok) => (await call("GET", `${B}/applications/${A2}/timeline`, { tok })).json.data.version;
  r = await call("POST", `${B}/applications/${A2}/events`, { tok: T.E1, body: { type: "SHORTLISTED", version: await ver2(T.E1) } });
  check("pipeline still works after the trial (shortlist)", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  r = await call("POST", `${B}/interviews`, { tok: T.E1, body: { applicationId: String(A2), version: await ver2(T.E1), ...slot } });
  check("interviews still work after the trial", r.status === 201 || r.status === 200, r.text.slice(0, 150));
  r = await call("PATCH", `/api/jobs/toggle/${J1}`, { tok: T.E1 });
  check("closing an open job early still works", r.status === 200 && r.json.active === false);
  r = await call("PATCH", `/api/jobs/toggle/${J1}`, { tok: T.E1 });
  check("and re-opening it before its deadline still works", r.status === 200 && r.json.active === true);

  // ---------- request a plan ----------
  r = await call("POST", `${B}/employers/me/plan-requests`, { tok: T.E1, body: { jobs: 0 } });
  check("request with 0 jobs: 400 INVALID_JOBS", r.status === 400 && r.json.error.code === "INVALID_JOBS");
  r = await call("POST", `${B}/employers/me/plan-requests`, { tok: T.E1, body: { jobs: 3, note: "  hiring  for Q1  " } });
  const adminNotes = rows("Notification", (n) => n.metadata?.kind === "hiring_plan_request");
  check("request a plan: 201, open, admins notified (both)", r.status === 201 && r.json.data.request.jobs === 3 && r.json.data.request.note === "hiring for Q1" && adminNotes.length === 2 && adminNotes.some((n) => same(n.recipient, ids.admin)) && adminNotes.some((n) => same(n.recipient, ids.admin2)), r.text.slice(0, 200));
  r = await call("POST", `${B}/employers/me/plan-requests`, { tok: T.E1, body: { jobs: 2, note: "actually two" } });
  check("sending again updates the same open request (no new admin notification)", r.status === 200 && rows("EmployerPlanRequest").length === 1 && rows("EmployerPlanRequest")[0].jobs === 2 && rows("Notification", (n) => n.metadata?.kind === "hiring_plan_request").length === 2);
  r = await call("GET", `${B}/admin/hiring-plans`, { tok: T.admin });
  const e1Row = r.json?.data?.employers?.find((e) => e.employer.id === String(ids.E1));
  check("admin hiring plans: the open request and E1 locked (free hire used)", r.status === 200 && r.json.data.requests.some((q) => q.status === "open" && q.jobs === 2 && q.employer.name === "Bright Labs") && e1Row && !e1Row.canPost && e1Row.trial.endReason === "free_hire_used", r.text.slice(0, 200));

  // ---------- admin grants 2 jobs ----------
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { jobs: 2 } });
  check("grant without a reason: 400 REASON_REQUIRED", r.status === 400 && r.json.error.code === "REASON_REQUIRED");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { reason: "pilot plan" } });
  check("grant with neither jobs nor a date: 400 PLAN_EMPTY", r.status === 400 && r.json.error.code === "PLAN_EMPTY");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.S1}/grant`, { tok: T.admin, body: { jobs: 2, reason: "x x x" } });
  check("grant to a student: 404", r.status === 404);
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { jobs: 2, reason: "agreed on a call" } });
  check("admin grants 2 job posts: posting unlocks at once, plan 2 left", r.status === 200 && r.json.data.canPost && r.json.data.plan.status === "active" && r.json.data.plan.jobsLeft === 2 && !r.json.data.lock, r.text.slice(0, 200));
  const grantLog = logs("hiring.plan.grant")[0];
  check("the grant is in AdminActionLog (admin, employer, reason, before locked / after active)", grantLog && same(grantLog.admin, ids.admin) && grantLog.targetId === String(ids.E1) && grantLog.reason === "agreed on a call" && grantLog.before.canPost === false && grantLog.after.canPost === true && grantLog.after.jobsGranted === 2, JSON.stringify(grantLog));
  check("the open request is marked granted; the employer is notified", rows("EmployerPlanRequest")[0].status === "granted" && rows("Notification", (n) => same(n.recipient, ids.E1) && n.metadata?.kind === "hiring_plan_granted").length === 1);
  r = await post(T.E1, "Plan job 1");
  check("plan post 1: 201", r.status === 201);
  r = await call("POST", `/api/jobs/duplicate/${J1}`, { tok: T.E1 });
  check("plan post 2 (a duplicate counts): 201", r.status === 201);
  d = await me("E1");
  check("plan used up: 0 left, locked again with 'plan's job posts are used'", !d.canPost && d.plan.status === "used_up" && d.plan.jobsLeft === 0 && /plan's job posts are used/.test(d.lock.message), JSON.stringify(d.plan));
  r = await post(T.E1, "Plan job 3");
  check("3rd post refused: 403 POSTING_LOCKED (plan_used_up)", r.status === 403 && r.json.code === "POSTING_LOCKED" && r.json.reason === "plan_used_up", r.text);

  // two at once with one left: one wins
  await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { jobs: 1, reason: "one more" } });
  const both = await Promise.all([post(T.E1, "Race A"), post(T.E1, "Race B")]);
  check("two posts at the same moment with 1 job left: exactly one saved", both.filter((x) => x.status === 201).length === 1 && both.filter((x) => x.status === 403).length === 1 && accessOf("E1").plan.jobsUsed === 1, both.map((x) => x.status).join(","));

  // CSV within a plan: rows past the limit aren't saved
  await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { jobs: 1, reason: "csv test" } });
  r = await upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Location\nCSV One,Karachi\nCSV Two,Lahore\n");
  check("CSV within a plan of 1: 1 created, the 2nd row listed as not saved", r.status === 200 && r.json.created === 1 && r.json.rejected.length === 1 && /plan's job posts are used/.test(r.json.rejected[0].reason) && accessOf("E1").plan.jobsUsed === 1, r.text.slice(0, 200));

  // ---------- plan expiry ----------
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { validUntil: new Date(now - DAY).toISOString(), reason: "past date" } });
  check("a valid-until date in the past: 400", r.status === 400 && r.json.error.code === "INVALID_DATE");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/grant`, { tok: T.admin, body: { validUntil: new Date(now + 30 * DAY).toISOString(), reason: "a month, any number of jobs" } });
  check("a plan valid until a date (no job limit): can post", r.status === 200 && r.json.data.canPost && r.json.data.plan.jobsLeft === null);
  r = await post(T.E1, "Date plan job");
  check("post within the dated plan: 201", r.status === 201);
  // time passes: the plan's date is behind us
  accessOf("E1").plan.validUntil = new Date(Date.now() - 1000);
  d = await me("E1");
  r = await post(T.E1, "After expiry");
  check("plan expired: locked again ('your plan has ended'), post refused (plan_expired)", !d.canPost && d.plan.status === "expired" && /plan has ended/.test(d.lock.message) && r.status === 403 && r.json.reason === "plan_expired", r.text);

  // ---------- the 60-day path ----------
  const e3job = oid();
  fake.seed(coll("Job"), [jobDoc(e3job, ids.E3, { createdAt: new Date(now - 5 * DAY) })]);
  process.env.HIRING_TRIAL_START = new Date(now - 100 * DAY).toISOString(); // a policy that started long ago
  accessOf("E3"); // none yet
  d = await me("E3");
  check("an employer whose first job was 5 days ago: 55 days left", d.canPost && d.trial.daysLeft === 55, JSON.stringify(d.trial));
  accessOf("E3").trialStartedAt = new Date(now - 61 * DAY); // 61 days later
  d = await me("E3");
  r = await post(T.E3, "Day 61");
  check("61 days after the first job: 'your free trial has ended' (days_over), post refused", !d.canPost && d.trial.endReason === "days_over" && d.trial.label === "your free trial has ended" && r.status === 403 && r.json.reason === "days_over", JSON.stringify(d.trial) + r.text);
  r = await call("GET", "/api/jobs/my-jobs", { tok: T.E3 });
  check("their jobs are still listed and manageable", r.status === 200 && r.json.length === 1);

  // ---------- admin extend / end ----------
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E3}/trial`, { tok: T.admin, body: { action: "extend", until: new Date(now + 14 * DAY).toISOString() } });
  check("extend without a reason: 400", r.status === 400 && r.json.error.code === "REASON_REQUIRED");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E3}/trial`, { tok: T.admin, body: { action: "extend", until: new Date(now + 14 * DAY).toISOString(), reason: "slow hiring season" } });
  check("admin extends the trial 14 days: active, 14 days left, can post", r.status === 200 && r.json.data.canPost && r.json.data.trial.status === "active" && r.json.data.trial.daysLeft === 14, r.text.slice(0, 200));
  r = await post(T.E3, "Extended post");
  check("post during the extension: 201", r.status === 201);
  const extLog = logs("hiring.trial.extend")[0];
  check("the extension is in AdminActionLog with the reason", extLog && extLog.reason === "slow hiring season" && extLog.before.trial === "ended" && extLog.after.trial === "active");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E3}/trial`, { tok: T.admin, body: { action: "end", reason: "fraud check" } });
  check("admin ends the trial: locked, reason ended_by_admin", r.status === 200 && !r.json.data.canPost && r.json.data.trial.endReason === "ended_by_admin");
  check("the end is in AdminActionLog", logs("hiring.trial.end").length === 1 && logs("hiring.trial.end")[0].reason === "fraud check");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E3}/trial`, { tok: T.admin, body: { action: "end", reason: "again" } });
  check("ending an ended trial: 409", r.status === 409 && r.json.error.code === "TRIAL_NOT_ACTIVE");
  r = await call("POST", `${B}/admin/hiring-plans/${ids.E1}/trial`, { tok: T.admin, body: { action: "extend", until: new Date(now + 7 * DAY).toISOString(), reason: "goodwill after the free hire" } });
  check("extending after a free hire reopens the trial (the earlier hire no longer ends it)", r.status === 200 && r.json.data.canPost && r.json.data.trial.status === "active" && r.json.data.trial.daysLeft === 7, r.text.slice(0, 200));

  // ---------- existing employers start fresh ----------
  process.env.HIRING_TRIAL_START = new Date(now).toISOString(); // release today
  const oldJob = oid();
  fake.seed(coll("Job"), [jobDoc(oldJob, ids.E2, { createdAt: new Date(now - 400 * DAY), applicationDeadline: new Date(now + 3 * DAY) })]);
  r = await call("GET", `${B}/admin/hiring-plans`, { tok: T.admin });
  const counts = r.json?.data?.counts;
  check("the overview counts employers that would be locked without the fresh start (E2: first job 400 days ago)", r.status === 200 && counts.wouldBeLockedWithoutFreshStart >= 1 && r.json.data.employers.find((e) => e.employer.id === String(ids.E2))?.canPost === true, JSON.stringify(counts));
  check("reading the overview writes nothing", !accessOf("E2"));
  d = await me("E2");
  check("an existing employer (first job 400 days ago): a fresh trial from today, 60 days left, can post", d.canPost && d.trial.status === "active" && d.trial.daysLeft === 60 && new Date(accessOf("E2").trialStartedAt).getTime() === now, JSON.stringify(d.trial));
  r = await post(T.E2, "Fresh start post");
  check("and posts: 201", r.status === 201);
  d = await me("E5");
  check("an employer with no job: active, clock not started", d.canPost && !d.trial.clockStarted);

  // ---------- decline + kill switch ----------
  r = await call("POST", `${B}/employers/me/plan-requests`, { tok: T.E3, body: { jobs: 5 } });
  const q3 = r.json?.data?.request?.id;
  r = await call("POST", `${B}/admin/plan-requests/${q3}/decline`, { tok: T.admin, body: { reason: "not now" } });
  check("admin declines a request (logged)", r.status === 200 && r.json.data.status === "declined" && logs("hiring.plan.decline").length === 1);
  process.env.HIRING_TRIAL_OFF = "true";
  r = await post(T.E3, "Kill switch");
  check("HIRING_TRIAL_OFF=true: nothing is locked", r.status === 201);
  delete process.env.HIRING_TRIAL_OFF;

  // nothing private in employer replies about another employer
  const e3Replies = h.responses.filter((x) => x.who.endsWith(T.E3));
  check("an employer's replies never carry another employer's company", e3Replies.every((x) => !x.text.includes("Bright Labs")));
  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
