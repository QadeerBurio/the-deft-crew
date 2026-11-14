// Mutual ratings (FLAG_CAREER_RATINGS): who can rate what (completed interviews not disputed, a verified hire;
// the two sides only), answers and comments (1-5 on 3 fixed questions, 300 characters, profanity), one per side
// per event (idempotent), the 14-day window, release (both rated or the window closed), the employer's average
// (5+ released, half stars, no comments), a student's ratings never shown to other employers, reports and
// admin decisions (hidden ratings stop counting, recorded), no side effects, account deletion.
//   node tests/career-ratings/run.js [serverDir]
// No database, no network, no .env (the fake in-memory database from tests/hide-user-secrets).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "" }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
  { get: (t, k) => (k in t ? t[k] : multerLike) }
);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
// pilot checks: no built-in "on" default (as before this branch), so "outside the pilot" still means off
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Job", "JobApplication", "CareerApplicationEvent", "CareerRating", "CareerRatingReport", "DomainEvent"]) reqS(`./models/${m}`);
const { findProfanity } = reqS("./utils/profanity");

const responses = [];
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/career/ratings", reqS("./routes/careerRatings.routes"));

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const rows = (m, f = () => true) => (fake.STORE.get(coll(m)) || []).filter(f);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
let PORT;
function call(method, url, { tok, body } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) };
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data) q.write(data);
    q.end();
  });
}
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
const ids = {};
for (const k of ["E", "E2", "A", "S", "S2", "S3"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, role, status: "active", createdAt: new Date(), ...extra });
fake.seed(coll("User"), [user(ids.E, "employee", "hireco", { companyName: "Hire Co" }), user(ids.E2, "employee", "otherco", { companyName: "Other Co" }), user(ids.A, "admin", "admin"), user(ids.S, "student", "Sana Khan"), user(ids.S2, "student", "Taha Ali"), user(ids.S3, "student", "Umar Raza")]);
const J = oid(), J2 = oid();
const job = (id, by, title) => ({ _id: id, title, companyName: by === ids.E ? "Hire Co" : "Other Co", department: "Eng", location: "Karachi", type: "Full-time", salary: "x", email: "j@test.local", description: "d", postedBy: by, isExternal: false, active: true });
fake.seed(coll("Job"), [job(J, ids.E, "Data intern"), job(J2, ids.E2, "Designer")]);
// a timeline: applied → interview completed `doneDaysAgo` → (hired `hireDaysAgo`)
function timeline(appId, student, employer, { doneDaysAgo = 2, hireDaysAgo = null, disputed = false } = {}) {
  let seq = 0;
  const ev = (type, d, metadata = {}, actorRole = "employer") => ({ _id: oid(), application: appId, job: J, candidate: student, employer, seq: ++seq, type, actor: actorRole === "candidate" ? student : employer, actorRole, source: "portal", metadata, idempotencyKey: `${appId}:${seq}`, occurredAt: ago(d) });
  const iv = String(oid());
  const list = [ev("APPLIED", 30, {}, "candidate"), ev("SHORTLISTED", 25), ev("INTERVIEW_INVITED", 20, { interviewId: iv }), ev("INTERVIEW_ACCEPTED", 19, { interviewId: iv }, "candidate"), ev("INTERVIEW_COMPLETED", doneDaysAgo, { interviewId: iv })];
  if (disputed) list.push(ev("INTERVIEW_DISPUTED", doneDaysAgo - 0.5, { interviewId: iv }, "candidate"));
  if (hireDaysAgo != null) list.push(ev("OFFER_SENT", hireDaysAgo + 1, { offerId: "o1", expiresAt: new Date(Date.now() + 9 * DAY) }), ev("OFFER_ACCEPTED", hireDaysAgo + 0.5, { offerId: "o1" }, "candidate"), ev("HIRE_CONFIRMED", hireDaysAgo, { offerId: "o1" }));
  fake.seed(coll("CareerApplicationEvent"), list);
  return iv;
}
const apps = {};
const mkApp = (key, student, jobId, employer, opts) => {
  apps[key] = oid();
  fake.seed(coll("JobApplication"), [{ _id: apps[key], jobId, userId: student, fullName: "x", email: "x@test.local", phone: "03005550199", status: "interview", appliedAt: ago(30) }]);
  return timeline(apps[key], student, employer, opts);
};
mkApp("main", ids.S, J, ids.E, { doneDaysAgo: 2, hireDaysAgo: 1 });
mkApp("old", ids.S2, J, ids.E, { doneDaysAgo: 15 });
mkApp("disputed", ids.S3, J, ids.E, { doneDaysAgo: 3, disputed: true });
mkApp("other", ids.S2, J2, ids.E2, { doneDaysAgo: 2 });
const T = Object.fromEntries(Object.entries({ E: "employee", E2: "employee", A: "admin", S: "student", S2: "student", S3: "student" }).map(([k, r]) => [k, token(ids[k], r)]));
const goodE = { communication: 4, punctuality: 5, preparation: 3 };
const goodS = { communication: 5, respect: 4, clarity: 3 };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  let r;

  console.log("-- the profanity filter");
  check("clean comments pass, including words that only contain a rude one (class, assessment, Scunthorpe)", [ "Very clear process, thank you", "classic assessment in Scunthorpe", "passage assigned"].every((t) => !findProfanity(t)));
  check("English and Roman Urdu insults are refused, also disguised (f.u.c.k, sh1t, chutiyaaa, kuttay)", ["f.u.c.k this", "sh1t process", "CHUTIYAAAA", "kuttay log", "what a bastard"].every((t) => findProfanity(t)));

  console.log("-- flag and who can rate");
  r = await call("GET", `/api/career/ratings/applications/${apps.main}`, { tok: T.S });
  check("flag off: 404 RATINGS_OFF", r.status === 404 && r.json?.error?.code === "RATINGS_OFF");
  process.env.FLAG_CAREER_RATINGS = `ids:${ids.E},${ids.S},${ids.S2},${ids.S3},${ids.E2}`;
  r = await call("GET", `/api/career/ratings/applications/${apps.main}`, { tok: T.S });
  const sv = r.json?.data;
  check("the candidate: the completed interview and the verified hire, both open, the 3 candidate questions", r.status === 200 && sv.side === "candidate" && sv.events.map((e) => `${e.kind}:${e.open}`).join() === "interview:true,hire:true" && sv.questions.map((q) => q.id).join() === "communication,respect,clarity", r.text.slice(0, 300));
  r = await call("GET", `/api/career/ratings/applications/${apps.main}`, { tok: T.E });
  check("the job's employer: the same events, the 3 employer questions", r.status === 200 && r.json.data.side === "employer" && r.json.data.questions.map((q) => q.id).join() === "communication,punctuality,preparation");
  const outsiders = await Promise.all([T.E2, T.S2, T.A].map((tok) => call("GET", `/api/career/ratings/applications/${apps.main}`, { tok })));
  check("another employer, another student and an admin: 404 (only the two sides rate)", outsiders.every((x) => x.status === 404), outsiders.map((x) => x.status).join());
  r = await call("GET", `/api/career/ratings/applications/${apps.disputed}`, { tok: T.S3 });
  check("an interview disputed after being recorded as completed can't be rated (no events)", r.status === 200 && r.json.data.events.length === 0);

  console.log("-- rating");
  const post = (tok, body) => call("POST", "/api/career/ratings", { tok, body: { applicationId: String(apps.main), ...body } });
  const bad = await Promise.all([
    post(T.S, { kind: "interview", answers: { communication: 5, respect: 4 } }),
    post(T.S, { kind: "interview", answers: { communication: 6, respect: 4, clarity: 3 } }),
    post(T.S, { kind: "interview", answers: { communication: 0, respect: 4, clarity: 3 } }),
    post(T.S, { kind: "interview", answers: { ...goodS, punctuality: 2 } }),
    post(T.S, { kind: "interview", answers: goodE }),
  ]);
  check("answers must be the rater's 3 questions, whole stars 1-5 (missing, 6, 0, an extra or the other side's questions → 400)", bad.every((x) => x.status === 400 && x.json?.error?.code === "INVALID_ANSWERS"), bad.map((x) => x.status).join());
  r = await post(T.S, { kind: "interview", answers: goodS, comment: "x".repeat(301) });
  check("a comment over 300 characters → 400", r.status === 400 && r.json?.error?.code === "COMMENT_TOO_LONG");
  r = await post(T.S, { kind: "interview", answers: goodS, comment: "the interviewer was a total b@stard" });
  check("a comment with profanity → 400 COMMENT_NOT_ALLOWED, nothing saved", r.status === 400 && r.json?.error?.code === "COMMENT_NOT_ALLOWED" && rows("CareerRating").length === 0, r.text);
  const sim = await Promise.all([1, 2, 3, 4, 5].map(() => post(T.S, { kind: "interview", answers: goodS, comment: "Clear and kind" })));
  check("5 simultaneous submissions of the same rating: one saved (201), the rest return it (200)", sim.filter((x) => x.status === 201).length === 1 && sim.filter((x) => x.status === 200 && x.json.data.duplicate).length === 4 && rows("CareerRating").length === 1, sim.map((x) => x.status).join());
  r = await post(T.S, { kind: "interview", answers: { communication: 1, respect: 1, clarity: 1 } });
  check("a different rating for the same event: 409 ALREADY_RATED (one per side per event)", r.status === 409 && r.json?.error?.code === "ALREADY_RATED");
  check("…saved private and not released yet (the employer hasn't rated)", !rows("CareerRating")[0].releasedAt);
  r = await call("GET", "/api/career/ratings/me/received", { tok: T.E });
  check("the employer can't see it yet (not released, and under 5)", r.status === 200 && r.json.data.ratings.length === 0 && r.json.data.count === 0);
  r = await call("POST", "/api/career/ratings", { tok: T.E, body: { applicationId: String(apps.main), kind: "interview", answers: goodE, comment: "Prepared and on time" } });
  check("the employer rates the candidate: 201, and both ratings are released now", r.status === 201 && rows("CareerRating").every((x) => x.releasedAt));
  r = await call("GET", "/api/career/ratings/me/received", { tok: T.S });
  check("the student sees the rating they received (to read it, and report it if unfair)", r.status === 200 && r.json.data.ratings.length === 1 && r.json.data.ratings[0].answers.punctuality === 5 && r.json.data.ratings[0].job.title === "Data intern");
  r = await post(T.S, { kind: "hire", answers: goodS });
  check("after the verified hire the candidate can rate again (a separate event); not released until the employer rates the hire", r.status === 201 && rows("CareerRating").length === 3 && !rows("CareerRating", (x) => x.kind === "hire")[0].releasedAt);
  r = await call("POST", "/api/career/ratings", { tok: T.E, body: { applicationId: String(apps.main), kind: "hire", answers: goodE } });
  check("…the employer rates the hire: both hire ratings released", r.status === 201 && rows("CareerRating", (x) => x.kind === "hire").every((x) => x.releasedAt));
  r = await call("POST", "/api/career/ratings", { tok: T.S2, body: { applicationId: String(apps.old), kind: "interview", answers: goodS } });
  check("15 days after the interview: 409 WINDOW_CLOSED", r.status === 409 && r.json?.error?.code === "WINDOW_CLOSED", r.text);
  r = await call("POST", "/api/career/ratings", { tok: T.S2, body: { applicationId: String(apps.other), kind: "hire", answers: goodS } });
  check("no verified hire: 409 NOT_ELIGIBLE", r.status === 409 && r.json?.error?.code === "NOT_ELIGIBLE");
  const statuses = rows("JobApplication").map((a) => a.status).join();

  console.log("-- the employer's average: from 5 released ratings, no comments");
  r = await call("GET", `/api/career/ratings/jobs/${J}/employer`, { tok: T.S2 });
  check("2 released ratings: not shown (count 2, minimum 5, no average)", r.status === 200 && r.json.data.shown === false && r.json.data.count === 2 && r.json.data.average === null, r.text);
  // three more candidates rated Hire Co; their windows closed, so released without the employer's rating
  for (let i = 0; i < 3; i++) {
    const a = oid(), s = oid();
    fake.seed(coll("CareerRating"), [{ _id: oid(), key: `${a}:interview:x:candidate`, application: a, job: J, employer: ids.E, candidate: s, kind: "interview", ref: "x", eventAt: ago(20), windowEndsAt: ago(6), raterRole: "candidate", rater: s, ratee: ids.E, answers: { communication: 2, respect: 2, clarity: 2 }, comment: "secret comment", releasedAt: null, status: "visible", createdAt: ago(10) }]);
  }
  r = await call("GET", `/api/career/ratings/jobs/${J}/employer`, { tok: T.S2 });
  const avg = r.json?.data;
  // (5+4+3)/3=4, (5+4+3)/3=4 for the two of Sana; 2 for each of the three others: (4+4+2+2+2)/5 = 2.8 → 3
  check("5 released ratings: shown, rounded to half a star (2.8 → 3), per question too, and no comment anywhere", r.status === 200 && avg.shown === true && avg.count === 5 && avg.average === 3 && avg.questions.length === 3 && !/secret comment|Clear and kind/.test(r.text), r.text);
  const U = oid();
  fake.seed(coll("User"), [user(U, "student", "Not Piloted")]);
  r = await call("GET", `/api/career/ratings/jobs/${J}/employer`, { tok: token(U, "student") });
  check("a viewer without the flag: 404", r.status === 404);
  r = await call("GET", "/api/career/ratings/me/received", { tok: T.E });
  check("the employer sees its own average and the ratings anonymised (no candidate, job or exact date)", r.status === 200 && r.json.data.shown && r.json.data.ratings.length === 5 && r.json.data.ratings.every((x) => !x.job && !x.candidate && /^\d{4}-\d{2}$/.test(x.month)) && !r.text.includes(String(ids.S)), r.text.slice(0, 200));
  r = await call("GET", "/api/career/ratings/me/received", { tok: T.E2 });
  check("a student's ratings are never shown to another employer", r.status === 200 && !r.text.includes("Prepared and on time") && r.json.data.count === 0);

  console.log("-- reports and admin");
  const aboutS = rows("CareerRating", (x) => x.raterRole === "employer")[0];
  r = await call("POST", `/api/career/ratings/${aboutS._id}/report`, { tok: T.S, body: { reason: "x" } });
  check("a report needs a reason (400)", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED");
  r = await call("POST", `/api/career/ratings/${aboutS._id}/report`, { tok: T.S2, body: { reason: "not even about me" } });
  check("only the person rated can report it (404 for others)", r.status === 404);
  r = await call("POST", `/api/career/ratings/${aboutS._id}/report`, { tok: T.S, body: { reason: "I was on time; the office gave the wrong address" } });
  const rep2 = await call("POST", `/api/career/ratings/${aboutS._id}/report`, { tok: T.S, body: { reason: "again" } });
  check("the student reports it: 201; twice: 409", r.status === 201 && rep2.status === 409, `${r.status} ${rep2.status}`);
  const lowOne = rows("CareerRating", (x) => x.comment === "secret comment")[0];
  r = await call("POST", `/api/career/ratings/${lowOne._id}/report`, { tok: T.E, body: { reason: "this candidate never came to an interview with us" } });
  check("the employer can report a rating about it too", r.status === 201);
  r = await call("GET", "/api/career/ratings/admin/reports", { tok: T.S });
  check("admin reports: 403 for a student", r.status === 403);
  r = await call("GET", "/api/career/ratings/admin/reports", { tok: T.A });
  check("admin: both open reports with the rating, its comment, who rated whom (names) and the job", r.status === 200 && r.json.data.length === 2 && r.json.data.some((x) => x.rating.rater.name === "Hire Co" && x.rating.ratee.name === "Sana Khan" && x.rating.comment === "Prepared and on time"));
  const repS = r.json.data.find((x) => x.reporterRole === "candidate");
  const repE = r.json.data.find((x) => x.reporterRole === "employer");
  r = await call("POST", `/api/career/ratings/admin/reports/${repE.id}/decide`, { tok: T.A, body: { action: "hide" } });
  check("deciding without a reason: 400", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED");
  const hiddenEvents = rows("DomainEvent", (e) => e.type === "career.rating.hidden").length;
  r = await call("POST", `/api/career/ratings/admin/reports/${repE.id}/decide`, { tok: T.A, body: { action: "hide", reason: "the candidate's interview was with another company" } });
  check("…and in the admin action log", rows("AdminActionLog", (x) => x.action === "career.rating.report.decide" && x.targetId === String(repE.id) && x.after.action === "hide" && x.reason === "the candidate's interview was with another company").length === 1);
  check("admin hides it with a reason: the rating is hidden, the decision recorded (report + DomainEvent)", r.status === 200 && rows("CareerRating", (x) => same(x._id, lowOne._id))[0].status === "hidden" && rows("CareerRating", (x) => same(x._id, lowOne._id))[0].hiddenReason && rows("DomainEvent", (e) => e.type === "career.rating.hidden").length === hiddenEvents + 1);
  r = await call("GET", `/api/career/ratings/jobs/${J}/employer`, { tok: T.S2 });
  check("…a hidden rating no longer counts: 4 left, so the average is no longer shown", r.json.data.count === 4 && r.json.data.shown === false);
  r = await call("POST", `/api/career/ratings/admin/reports/${repE.id}/decide`, { tok: T.A, body: { action: "keep", reason: "deciding twice" } });
  check("deciding the same report again: 409", r.status === 409);
  r = await call("POST", `/api/career/ratings/admin/reports/${repS.id}/decide`, { tok: T.A, body: { action: "keep", reason: "the employer's record shows the late arrival" } });
  check("admin keeps the other one: the rating stays visible, the report is closed as kept", r.status === 200 && r.json.data.status === "kept" && rows("CareerRating", (x) => same(x._id, aboutS._id))[0].status === "visible");
  const flagWas = process.env.FLAG_CAREER_RATINGS;
  process.env.FLAG_CAREER_RATINGS = "off";
  r = await call("GET", "/api/career/ratings/admin/reports", { tok: T.A });
  process.env.FLAG_CAREER_RATINGS = flagWas;
  check("FLAG_CAREER_RATINGS off: the admin page is 404 (the portal hides it)", r.status === 404);

  console.log("-- no automatic penalties; account deletion");
  check("ratings changed nothing else: every application's status is as it was", rows("JobApplication").map((a) => a.status).join() === statuses);
  const retention = reqS("./services/career/retentionService");
  const del = async (M, f) => (await M.deleteMany(f)).deletedCount;
  const upd = async (M, f, u) => (await M.updateMany(f, u)).modifiedCount;
  await retention.forDeletedStudent({ id: ids.S, ghost: oid(), upd, del });
  check("account deletion: the student's ratings (given and received) and their reports are deleted; others stay", rows("CareerRating", (x) => same(x.rater, ids.S) || same(x.ratee, ids.S)).length === 0 && rows("CareerRatingReport", (x) => same(x.reporter, ids.S)).length === 0 && rows("CareerRating").length === 3, rows("CareerRating").length);
  // the seeded phone in full: a bare "0300" also turned up inside random ids now and then (a flaky failure)
  check("no e-mail or phone in any reply", !/@test\.local|03005550199/.test(responses.map((x) => x.text).join(" ")));
  check("no 500s", !responses.some((x) => x.status >= 500));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
