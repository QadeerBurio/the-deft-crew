// Every job push / notification names its job, so the app can open that job (JobDetails):
//  - routes/jobs.routes.js: each Notification.create of a job type (Job Posting, Job Application, Application
//    Status, Interview, Jobs) has metadata with jobId (the push data carries the whole metadata: models/Notification.js)
//  - services/career/careerNotificationService.js: hiring-timeline pushes carry jobId next to applicationId
//  - invites, job alerts and the Daily Drop already send params.openJobId
//  - models/Notification.js: the route name stays "TDCCareers" (1.1.x apps open that screen; 1.2.0 maps it to the job)
//   node tests/job-push-targets/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), "utf8").replace(/\r\n/g, "\n");
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };

// each Notification.create({ ... }) call, its object text (balanced braces)
function creates(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf("Notification.create(", i)) >= 0) {
    let j = src.indexOf("{", i), depth = 0, k = j;
    for (; k < src.length; k++) { if (src[k] === "{") depth++; else if (src[k] === "}" && --depth === 0) break; }
    out.push({ at: src.slice(0, i).split("\n").length, text: src.slice(j, k + 1) });
    i = k;
  }
  return out;
}
const JOB_TYPES = /type:\s*["'](Job Posting|Job Application|Application Status|Interview|Jobs)["']/;

const jobs = read("routes/jobs.routes.js");
const jobCreates = creates(jobs).filter((c) => JOB_TYPES.test(c.text));
check(`routes/jobs.routes.js: job notifications found (${jobCreates.length})`, jobCreates.length >= 8);
const missing = jobCreates.filter((c) => !/metadata:\s*\{[\s\S]*?\bjobId\s*:/.test(c.text));
check("…every one has metadata.jobId (the app opens that job)", missing.length === 0, missing.map((c) => `line ${c.at}`).join(", "));
const cancelled = jobCreates.find((c) => /Interview Cancelled/.test(c.text));
check("…interview cancelled: jobId and applicationId", cancelled && /jobId: application\.jobId\?\._id \|\| application\.jobId/.test(cancelled.text) && /applicationId: application\._id/.test(cancelled.text));
const bulk = jobCreates.find((c) => /Application Status Update - \$\{app\.jobId\.title\}/.test(c.text));
check("…bulk status update: jobId and applicationId", bulk && /jobId: app\.jobId\?\._id \|\| app\.jobId/.test(bulk.text) && /applicationId: app\._id/.test(bulk.text));

const timeline = read("services/career/careerNotificationService.js");
check("hiring-timeline pushes carry jobId next to applicationId", /data: \{ applicationId: String\(event\.application\), jobId: event\.job \? String\(event\.job\) : undefined,/.test(timeline));
check("career events always store the job", /job: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: "Job", required: true \}/.test(read("models/CareerApplicationEvent.js")));

check("invites send params.openJobId", /screen: "Career", params: \{ openJobId: String\(job\._id\) \}/.test(read("services/career/invites.js")));
check("job alerts send params.openJobId", /screen: "Career", params: \{ openJobId: String\(job\._id\) \}/.test(read("services/career/jobAlerts.js")));
check("the Daily Drop job sends params.openJobId", /route: 'Career', params: \{ openJobId: id, jobId: id \}/.test(read("services/engagement/drops.js")));

const model = read("models/Notification.js");
check("models/Notification.js: job notifications keep the route name TDCCareers (installed 1.1.x apps)", /route: 'TDCCareers'/.test(model));
check("…and the push data carries the whole metadata (jobId included)", /await sendToUser\(doc\.recipient, doc\.title, doc\.description, \{\n\s*\.\.\.meta,/.test(model));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
