// Suggested candidates and "invite to apply" (models/CareerInvite.js, services/career/invites.js), FLAG_CAREER_MATCHING
// (+ FLAG_CAREER_TIMELINE for the employer): only students who opted in (ProfessionalProfile.discoverable through the
// existing POST /api/professional-profile; off by default), haven't applied, match 70%+ with no criterion "not met".
// The employer sees an anonymous label, the estimate, matched skills and the resume SECTION only: the identity leak
// scan proves no name, e-mail, phone, university, city, photo or id reaches the employer. The employer can only
// invite (max 20 per job a day, once per candidate); the student decides (interested / declined / applies).
//   node tests/career-invites/run.js [serverDir]
// Real routes, services and models on a fake MongoDB. No database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

class Expo {
  static isExpoPushToken(t) { return /^ExponentPushToken\[.+\]$/.test(String(t)); }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "", api: { delete_resources: async () => ({}) } }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
  { get: (t, k) => (k in t ? t[k] : multerLike) }
);
const pushed = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  if (resolved.endsWith(path.join("utils", "pushNotification.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, sendAllSafe: async (_x, messages) => { pushed.push(...messages); return messages.map((_, i) => ({ status: "ok", id: `t${pushed.length}-${i}` })); }, handleTickets: async () => {} };
  }
  if (resolved.endsWith(path.join("utils", "karachiTime.js"))) return { ...origLoad.apply(this, arguments), isQuietHour: () => false };
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = async (url) => { throw new Error(`network blocked in test: ${url}`); };

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "Resume", "ProfessionalProfile", "CareerInvite", "Notification", "EngagementProfile", "PushLog"]) reqS(`./models/${m}`);
const { dayKey } = reqS("./utils/karachiTime");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
const employerReplies = []; // every reply an employer got (the leak scan)
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (b) => { if (req.headers["x-who"] === "employer") employerReplies.push({ url: req.originalUrl, text: typeof b === "string" ? b : JSON.stringify(b) }); return send(b); };
  next();
});
app.use("/api/career/matching", reqS("./routes/careerMatching.routes"));
app.use("/api/career/invites", reqS("./routes/careerInvites.routes"));
app.use("/api/professional-profile", reqS("./routes/professionalProfile.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["E", "E2", "E3", "ADM", "D1", "D2", "D3", "N1", "A1", "OUT", "J", "J2", "J3", "JC"]) ids[k] = oid();
const NAMES = { D1: "Ayesha Khan", D2: "Bilal Ahmed", D3: "Sana Ali", N1: "Nida Raza", A1: "Ali Hassan", OUT: "Omar Out" };
const UNIS = { D1: "NED University", D2: "Some Other University" };
const CITIES = { D1: "Karachi", D2: "Lahore" };
const tok = (k) => `ExponentPushToken[${k}]`;
const student = (k) => ({ _id: ids[k], name: NAMES[k], email: `${k.toLowerCase()}@students.test`, phone: `0300${String(Object.keys(NAMES).indexOf(k)).padStart(7, "1")}`, role: "student", status: "Verified", accountStatus: "active", location: `${CITIES[k] || "Karachi"}, Pakistan`, pushTokens: [{ token: tok(k), platform: "android", channels: "snd_v2", updatedAt: new Date() }], createdAt: new Date() });
fake.seed(coll("User"), [
  { _id: ids.E, name: "Hina", email: "hina@brightlabs.test", role: "employee", companyName: "Bright Labs", status: "Verified", createdAt: new Date() },
  { _id: ids.E2, name: "Zoya", email: "zoya@noline.test", role: "employee", companyName: "No Timeline Co", status: "Verified", createdAt: new Date() },
  { _id: ids.E3, name: "Kamran", email: "kamran@other.test", role: "employee", companyName: "Other Co", status: "Verified", createdAt: new Date() },
  { _id: ids.ADM, name: "admin", email: "admin@test.local", role: "admin", createdAt: new Date() },
  ...["D1", "D2", "D3", "N1", "A1", "OUT"].map(student),
]);
const blank = () => ({ personalInfo: {}, professionalSummary: { summary: "" }, workExperience: [], education: [], projects: [], skills: [], certifications: [], languages: [] });
function person(k, skills) {
  const c = blank();
  const [first, last] = NAMES[k].split(" ");
  c.personalInfo = { firstName: first, lastName: last, title: "Software developer", email: `${k.toLowerCase()}@students.test`, phone: "+92 300 0000000", location: CITIES[k] || "Karachi", photo: `https://cdn.test/${k}.png` };
  c.education = [{ institution: UNIS[k] || "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", current: false }];
  c.skills = skills.map((s) => ({ name: s, category: "" }));
  // a project description that names the university and the city: never shown to the employer
  c.projects = [{ name: "Final year project", description: `Built at ${UNIS[k] || "NED University"} in ${CITIES[k] || "Karachi"} with ${skills.join(", ")}.`, technologies: skills }];
  return c;
}
const STRONG = ["JavaScript", "React", "Node.js"];
fake.seed(coll("Resume"), ["D1", "D2", "N1", "A1", "OUT"].map((k) => ({ _id: oid(), user: ids[k], isPrimary: true, ...person(k, STRONG), updatedAt: new Date() })).concat([{ _id: oid(), user: ids.D3, isPrimary: true, ...person("D3", ["JavaScript"]), updatedAt: new Date() }]));
const deadline = new Date(Date.now() + 20 * 864e5);
const job = (id, postedBy, title, extra = {}) => ({ _id: id, title, department: "Eng", location: "Karachi", type: "Internship", salary: "x", email: "hr@brightlabs.test", description: "d", companyName: "Bright Labs", skills: STRONG, requirements: [], minExperience: 0, education: "Bachelor's Degree", postedBy, isExternal: false, active: true, applicationDeadline: deadline, createdAt: new Date(), ...extra });
fake.seed(coll("Job"), [job(ids.J, ids.E, "React intern"), job(ids.J2, ids.E3, "Other React job", { companyName: "Other Co" }), job(ids.J3, ids.E, "Busy React job"), job(ids.JC, ids.E, "Closed React job", { active: false })]);
// D2, D3, A1, OUT opted in already; D1 opts in through the route below; N1 never did
fake.seed(coll("ProfessionalProfile"), ["D2", "D3", "A1", "OUT"].map((k) => ({ _id: oid(), userId: ids[k], discoverable: true, isComplete: false, skills: [], portfolioLinks: [] })));
fake.seed(coll("JobApplication"), [{ _id: oid(), jobId: ids.J, userId: ids.A1, status: "pending", appliedAt: new Date() }]);
process.env.FLAG_CAREER_MATCHING = `ids:${["E", "E2", "E3", "D1", "D2", "D3", "N1", "A1"].map((k) => ids[k]).join(",")}`;
process.env.FLAG_CAREER_TIMELINE = `ids:${ids.E},${ids.E3}`;
const jwtFor = (k, role) => jwt.sign({ id: String(ids[k]), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { body, t, employer = false } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = employer ? { "x-who": "employer" } : {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (t) h.authorization = `Bearer ${t}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["E", "E2", "E3", "D1", "D2", "D3", "N1", "A1", "OUT"].map((k) => [k, jwtFor(k, /^E/.test(k) ? "employee" : "student")]));
  const E = (url, opts = {}) => call(opts.method || "GET", url, { ...opts, t: opts.t || T.E, employer: true });

  console.log("── 1. the opt-in (existing POST /api/professional-profile), off by default");
  let r = await call("POST", "/api/professional-profile", { t: T.D1, body: { discoverable: "yes" } });
  check("a non-boolean value is ignored: a new profile starts off", r.status === 200 && rows("ProfessionalProfile", (p) => same(p.userId, ids.D1))[0]?.discoverable === false, JSON.stringify(rows("ProfessionalProfile", (p) => same(p.userId, ids.D1))[0]));
  r = await call("POST", "/api/professional-profile", { t: T.D1, body: { discoverable: true } });
  check("discoverable: true turns it on", r.status === 200 && rows("ProfessionalProfile", (p) => same(p.userId, ids.D1))[0].discoverable === true);
  check("…the new profile stays incomplete (the Skillshare onboarding is unaffected)", rows("ProfessionalProfile", (p) => same(p.userId, ids.D1))[0].isComplete === false);

  console.log("── 2. suggested candidates: only who opted in, matches strongly and hasn't applied; anonymous");
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested`);
  const C = r.json?.data?.candidates || [];
  check("two candidates (D1, D2), labelled 'candidate 1' and 'candidate 2', score 100, strong", r.status === 200 && C.length === 2 && C[0].label === "candidate 1" && C[1].label === "candidate 2" && C.every((c) => c.score === 100 && c.quality === "strong"), JSON.stringify(C.map((c) => [c.label, c.score])));
  check("…matched skills with the resume SECTION only, never the text", C[0].matchedSkills.length === 3 && C[0].matchedSkills.every((s) => s.where.every((w) => ["skills list", "a project", "work experience", "a certification", "summary", "headline", "resume"].includes(w))), JSON.stringify(C[0].matchedSkills));
  check("…invites left today: 20; an honest note", r.json.data.invitesLeftToday === 20 && /You see who they are only if they apply/.test(r.json.data.note));
  check("…not D3 (weak), N1 (never opted in), A1 (already applied), OUT (outside the pilot)", C.length === 2);
  check("same skills, another name / university / city: the same score (no ordering by identity)", C[0].score === C[1].score);

  console.log("── 3. who may see suggestions");
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested`, { t: T.E2 });
  check("not the job's employer → 404", r.status === 404);
  const e2Job = { ...rows("Job", (j) => same(j._id, ids.J))[0] };
  rows("Job", (j) => same(j._id, ids.J))[0].postedBy = ids.E2;
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested`, { t: T.E2 });
  check("the job's employer without FLAG_CAREER_TIMELINE → 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF", r.text.slice(0, 120));
  rows("Job", (j) => same(j._id, ids.J))[0].postedBy = e2Job.postedBy;
  r = await call("GET", `/api/career/matching/jobs/${ids.J}/suggested`, { t: T.D1 });
  check("a student → 404", r.status === 404);
  r = await call("GET", `/api/career/matching/jobs/${ids.J}/suggested`);
  check("signed out → 401", r.status === 401);
  r = await E(`/api/career/matching/jobs/${ids.JC}/suggested`);
  check("a closed job → 409 JOB_CLOSED", r.status === 409 && r.json?.error?.code === "JOB_CLOSED");

  console.log("── 4. invite to apply");
  const token1 = C[0].token;
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested/${token1}/invite`, { method: "POST" });
  const inv = rows("CareerInvite")[0];
  const invited = inv && Object.keys(ids).find((k) => same(ids[k], inv.student));
  check("invite → 200, one CareerInvite (status sent)", r.status === 200 && r.json.data.invite.status === "sent" && rows("CareerInvite").length === 1 && inv.status === "sent", r.text.slice(0, 160));
  check("…the student is told in the app (and by push): the company, the job, that only skills were seen", rows("Notification", (n) => same(n.recipient, ids[invited]) && /invites you to apply for React intern\. They saw your skills only/.test(n.description)).length === 1 && pushed.some((m) => m.to === tok(invited) && /invited to apply/.test(m.title)));
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested/${token1}/invite`, { method: "POST" });
  check("the same candidate again → 409 ALREADY_INVITED", r.status === 409 && r.json?.error?.code === "ALREADY_INVITED");
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested/not-a-token/invite`, { method: "POST" });
  check("an unknown token → 404", r.status === 404 && r.json?.error?.code === "NOT_SUGGESTED");
  r = await E(`/api/career/matching/jobs/${ids.J2}/suggested/${token1}/invite`, { method: "POST", t: T.E3 });
  check("a token from another job doesn't work on another employer's job → 404", r.status === 404);
  r = await E(`/api/career/matching/jobs/${ids.J}/suggested`);
  check("the suggestion now shows 'invite sent' (still anonymous)", r.json.data.candidates.find((c) => c.token === token1)?.invite?.status === "sent");
  fake.seed(coll("CareerInvite"), Array.from({ length: 20 }, () => ({ _id: oid(), job: ids.J3, student: oid(), employer: ids.E, status: "sent", dayKey: dayKey(), createdAt: new Date() })));
  const busy = (await E(`/api/career/matching/jobs/${ids.J3}/suggested`)).json.data;
  r = await E(`/api/career/matching/jobs/${ids.J3}/suggested/${busy.candidates[0].token}/invite`, { method: "POST" });
  check("20 invites on a job today: the 21st → 429 INVITE_LIMIT; 0 left", r.status === 429 && r.json?.error?.code === "INVITE_LIMIT" && busy.invitesLeftToday === 0);

  console.log("── 5. the student decides");
  const TS = T[invited];
  r = await call("GET", "/api/career/invites/me", { t: TS });
  const mine = r.json?.data;
  check("GET /invites/me: discoverable, the invite with the job (title, company, place, type), status sent", r.status === 200 && mine.discoverable === true && mine.invites.length === 1 && mine.invites[0].job.title === "React intern" && mine.invites[0].job.companyName === "Bright Labs" && mine.invites[0].status === "sent");
  check("…no employer e-mail in it", !/hr@brightlabs\.test|hina@brightlabs\.test/.test(r.text));
  r = await call("POST", `/api/career/invites/${mine.invites[0].id}/respond`, { t: TS, body: { response: "maybe" } });
  check("an unknown answer → 400", r.status === 400);
  const other = invited === "D1" ? "D2" : "D1";
  r = await call("POST", `/api/career/invites/${mine.invites[0].id}/respond`, { t: T[other], body: { response: "declined" } });
  check("someone else's invite → 404", r.status === 404);
  r = await call("POST", `/api/career/invites/${mine.invites[0].id}/respond`, { t: TS, body: { response: "interested" } });
  const sugg = async () => (await E(`/api/career/matching/jobs/${ids.J}/suggested`)).json.data.candidates;
  check("interested → the employer sees 'interested' (still anonymous)", r.status === 200 && (await sugg()).find((c) => c.token === token1)?.invite?.status === "interested");
  r = await call("POST", `/api/career/invites/${mine.invites[0].id}/respond`, { t: TS, body: { response: "declined" } });
  check("declined → the employer sees 'declined', nothing more", r.status === 200 && (await sugg()).find((c) => c.token === token1)?.invite?.status === "declined");
  fake.seed(coll("JobApplication"), [{ _id: oid(), jobId: ids.J, userId: ids[invited], status: "pending", appliedAt: new Date() }]);
  r = await call("GET", "/api/career/invites/me", { t: TS });
  check("the student applies (the normal flow): the invite reads 'applied'; the candidate leaves the suggestions", r.json.data.invites[0].status === "applied" && !(await sugg()).some((c) => c.token === token1));
  r = await call("GET", "/api/career/invites/me", { t: T.OUT });
  check("a student outside the pilot → 404 MATCHING_OFF", r.status === 404 && r.json?.error?.code === "MATCHING_OFF");
  r = await call("GET", "/api/career/invites/me", { t: T.E });
  check("an employer → 404 (students only)", r.status === 404);

  console.log("── 6. opting out");
  await call("POST", "/api/professional-profile", { t: T[other], body: { discoverable: false } });
  check("turning it off: no longer suggested", (await sugg()).length === 0);

  console.log("── 7. the identity leak scan (every reply an employer got)");
  const all = employerReplies.map((x) => x.text).join("\n");
  const forbidden = [...Object.values(NAMES), ...Object.values(NAMES).map((n) => n.split(" ")[0]), ...Object.values(UNIS), "Lahore", "students.test", "0300", "+92", "cdn.test", ...["D1", "D2", "D3", "N1", "A1", "OUT"].map((k) => String(ids[k])), ...rows("Resume").map((x) => String(x._id))];
  const leaks = forbidden.filter((f) => all.includes(f));
  check(`no name, first name, university, city, e-mail, phone, photo, student id or resume id in ${employerReplies.length} employer replies`, employerReplies.length >= 10 && leaks.length === 0, leaks.join(", "));
  check("…and the token is not a student id", !/^[0-9a-f]{24}$/.test(token1) && !Object.values(ids).map(String).includes(token1));

  console.log("── 8. account deletion removes the invites");
  const deletion = reqS("./services/accountDeletion");
  let err = null;
  try { await deletion.deleteAccount(String(ids[invited]), { actor: { type: "admin", adminId: String(ids.ADM) }, confirmName: NAMES[invited] }); } catch (e) { err = e.message; }
  check("deleting the student deletes their invites", !err && rows("CareerInvite", (i) => same(i.student, ids[invited])).length === 0, err || "");

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
