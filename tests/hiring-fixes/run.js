// Hiring audit fixes (fix/hiring-audit), on in-memory data:
//   - apply after the deadline: 410 JOB_CLOSED (the public list already hid it; the app shows "Closed")
//   - PUT /update can't change the owner, archive state, counters; employers can't feature or flip import fields
//   - POST /add: an employer can't feature their own job
//   - POST /duplicate/:id: own job only (404 otherwise), new deadline, active, no counters, owned by the employer
//   - CSV upload by an employer: the jobs are theirs (postedBy, their e-mail, in-app applications, Company column
//     optional) and only their own jobs are updated; tdc's upload never overwrites an employer's job
//   node tests/hiring-fixes/run.js [serverDir]
const h = require("./harness")(process.argv[2]);
const { call, upload, check, rows, same, oid, user, token, fake, coll } = h;

const ids = { E1: oid(), E2: oid(), S1: oid(), admin: oid() };
fake.seed(coll("User"), [
  user(ids.E1, "employee", "Hina Bright", { companyName: "Bright Labs", email: "hina@brightlabs.pk" }),
  user(ids.E2, "employee", "Ali Nova", { companyName: "Nova Systems", email: "ali@novasystems.com" }),
  user(ids.S1, "student", "Student One"), user(ids.admin, "admin", "Admin"),
]);
// both companies are verified (an unverified company's job waits: tests/hiring-followups)
fake.seed(coll("EmployerCompanyVerification"), ["E1", "E2"].map((k, i) => ({ _id: oid(), employerUserId: ids[k], companyName: k, ntnOrSecp: `7654321${i}`, companyGroupKey: `reg:${k}`, status: "approved", history: [], duplicateOf: [] })));
const T = { E1: token(ids.E1, "employee"), E2: token(ids.E2, "employee"), S1: token(ids.S1, "student"), admin: token(ids.admin, "admin") };
const DAY = 864e5;
const jobDoc = (id, by, extra = {}) => ({ _id: id, title: "Backend Engineer", department: "Engineering", location: "Karachi", type: "Full-time", salary: "100k", email: "jobs@brightlabs.pk", description: "build things", companyName: "Bright Labs", postedBy: by, isExternal: false, active: true, archivedAt: null, totalApplications: 0, views: 0, applicationDeadline: new Date(Date.now() + 10 * DAY), createdAt: new Date(), ...extra });
const apply = (jobId, tok) => call("POST", `/api/jobs/apply/${jobId}`, { tok, body: { fullName: "Student One", email: "s1@test.local", phone: "03001234567", coverLetter: "hello" } });

(async () => {
  const server = h.start();
  let r;

  // ---------- closed jobs ----------
  const open = oid(), closed = oid();
  fake.seed(coll("Job"), [jobDoc(open, ids.E1), jobDoc(closed, ids.E1, { title: "Old role", applicationDeadline: new Date(Date.now() - DAY) })]);
  r = await apply(closed, T.S1);
  check("apply after the deadline: 410 JOB_CLOSED, nothing saved", r.status === 410 && r.json.code === "JOB_CLOSED" && rows("JobApplication", (a) => same(a.jobId, closed)).length === 0, r.text);
  r = await apply(open, T.S1);
  check("apply before the deadline: 201", r.status === 201, r.text.slice(0, 120));

  // ---------- PUT /update ----------
  r = await call("PUT", `/api/jobs/update/${open}`, { tok: T.E1, body: { title: "Backend Engineer II", postedBy: String(ids.E2), totalApplications: 999, views: 5000, archivedAt: null, featured: true, isExternal: true, externalUrl: "https://evil.example" } });
  const j1 = rows("Job", (j) => same(j._id, open))[0];
  check("update: the title changes; owner, counters, featured and import fields don't", r.status === 200 && j1.title === "Backend Engineer II" && same(j1.postedBy, ids.E1) && j1.totalApplications !== 999 && j1.views === 0 && !j1.featured && j1.isExternal === false && !j1.externalUrl, JSON.stringify({ t: j1.title, p: String(j1.postedBy), f: j1.featured, x: j1.isExternal }));
  r = await call("PUT", `/api/jobs/update/${open}`, { tok: T.E2, body: { title: "hijack" } });
  check("update another company's job: 403", r.status === 403);
  r = await call("PUT", `/api/jobs/update/${open}`, { tok: T.admin, body: { featured: true } });
  check("an admin can still feature a job", r.status === 200 && rows("Job", (j) => same(j._id, open))[0].featured === true);

  // ---------- POST /add ----------
  const post = (tok, extra = {}) => call("POST", "/api/jobs/add", { tok, body: { title: "Designer", department: "Design", location: "Lahore", type: "Full-time", salary: "80k", email: "jobs@brightlabs.pk", description: "make things", skills: ["Figma"], ...extra } });
  r = await post(T.E1, { featured: true });
  check("add: an employer's job is theirs and not featured", r.status === 201 && same(r.json.data.postedBy, ids.E1) && r.json.data.featured === false);

  // ---------- duplicate ----------
  const archived = oid();
  fake.seed(coll("Job"), [jobDoc(archived, ids.E1, { title: "Closed role", active: false, archivedAt: new Date(), totalApplications: 12, views: 300, applicationDeadline: new Date(Date.now() - 5 * DAY) })]);
  r = await call("POST", `/api/jobs/duplicate/${archived}`, { tok: T.E1 });
  const dup = r.json?.data;
  check("duplicate an own (deleted, closed) job: 201, a new active job, owned, no counters, deadline in ~30 days", r.status === 201 && dup && !same(dup._id, archived) && dup.title === "Closed role" && dup.active === true && !dup.archivedAt && same(dup.postedBy, ids.E1) && !dup.totalApplications && !dup.views && Math.abs(new Date(dup.applicationDeadline) - (Date.now() + 30 * DAY)) < 60e3, r.text.slice(0, 200));
  r = await call("POST", `/api/jobs/duplicate/${archived}`, { tok: T.E2 });
  check("duplicate another company's job: 404", r.status === 404);
  r = await call("POST", `/api/jobs/duplicate/${archived}`, { tok: T.S1 });
  check("a student can't duplicate", r.status === 403);
  r = await call("POST", `/api/jobs/duplicate/not-an-id`, { tok: T.E1 });
  check("a bad id: 404", r.status === 404);

  // ---------- CSV ----------
  const tdcJob = oid(), e2Job = oid();
  fake.seed(coll("Job"), [
    jobDoc(tdcJob, undefined, { title: "Sales Intern", companyName: "Acme", location: "Pakistan", isExternal: true, description: "old tdc row" }),
    jobDoc(e2Job, ids.E2, { title: "Sales Intern", companyName: "Acme", location: "Pakistan", description: "Nova's own posting of an Acme role" }),
  ]);
  r = await h.upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Location,Skills\nData Analyst,Karachi,SQL; Excel\nSupport Agent,Lahore,Customer Support\n");
  const mine = rows("Job", (j) => same(j.postedBy, ids.E1) && ["Data Analyst", "Support Agent"].includes(j.title));
  check("employer CSV: 2 jobs created, theirs (postedBy, their e-mail, their company), in-app applications", r.status === 200 && r.json.created === 2 && mine.length === 2 && mine.every((j) => j.email === "hina@brightlabs.pk" && j.companyName === "Bright Labs" && j.isExternal === false), r.text.slice(0, 200));
  r = await call("GET", "/api/jobs/my-jobs", { tok: T.E1 });
  check("employer CSV jobs show in 'my jobs' (they can manage them)", r.status === 200 && ["Data Analyst", "Support Agent"].every((t) => r.json.some((j) => j.title === t)));
  const before = JSON.stringify(rows("Job", (j) => same(j._id, e2Job))[0]);
  r = await h.upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Company,Location\nSales Intern,Acme,Pakistan\n");
  check("employer CSV with another company's title/company/location: a new own job, nothing else touched", r.status === 200 && r.json.created === 1 && r.json.updated === 0 && JSON.stringify(rows("Job", (j) => same(j._id, e2Job))[0]) === before && rows("Job", (j) => same(j._id, tdcJob))[0].description === "old tdc row", r.text.slice(0, 200));
  r = await h.upload("/api/jobs/admin/import-csv", T.admin, "jobs.csv", "Title,Company,Location\nSales Intern,Acme,Pakistan\n");
  check("tdc's CSV updates only its own unowned row, never an employer's job", r.status === 200 && r.json.updated === 1 && r.json.created === 0 && rows("Job", (j) => same(j._id, tdcJob))[0].description !== "old tdc row" && JSON.stringify(rows("Job", (j) => same(j._id, e2Job))[0]) === before, r.text.slice(0, 200));
  r = await h.upload("/api/jobs/admin/import-csv", T.E1, "jobs.csv", "Title,Location\nData Analyst,Karachi\n");
  check("employer re-upload updates their own job (no duplicate)", r.status === 200 && r.json.updated === 1 && rows("Job", (j) => same(j.postedBy, ids.E1) && j.title === "Data Analyst").length === 1, r.text.slice(0, 200));
  r = await h.upload("/api/jobs/admin/import-csv", T.S1, "jobs.csv", "Title,Location\nX,Y\n");
  check("a student can't upload", r.status === 403);

  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
