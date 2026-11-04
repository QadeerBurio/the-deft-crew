// Career data retention (pre-pilot): the retention job (services/career/retentionService.js) and its switch.
// Dry run by default (counts only, nothing written); apply anonymises applications whose last timeline event is
// over 2 years old: ids replaced by one placeholder per person, notes / terms / links / locations / messages
// cleared, types, times and funnel counts unchanged; public outcomes skipped; old unused resume versions emptied;
// marked so never redone; logs carry counts only.
//   node tests/career-retention/run.js [serverDir]
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
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "CareerApplicationEvent", "CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox", "CareerRetentionMark", "CareerResumeApprovedVersion", "CareerApplicationResumeAttachment"]) reqS(`./models/${m}`);
const retention = reqS("./services/career/retentionService");
const careerAnalytics = reqS("./services/career/careerAnalyticsService");
const flags = reqS("./config/featureFlags");

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const rows = (m, f = () => true) => (fake.STORE.get(coll(m)) || []).filter(f);
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
const S1 = oid(), S2 = oid(), E1 = oid(), ADMIN = oid();

// applications: OLD (last event 790 days ago), RECENT (old start, an event 10 days ago), PUBLIC (old, the
// student keeps the hire public), NEW (5 days ago)
const OLD = oid(), RECENT = oid(), PUBLIC = oid(), NEW = oid();
let seq = {};
const ev = (app, type, d, cand, extra = {}) => { seq[app] = (seq[app] || 0) + 1; return { _id: oid(), application: app, job: oid(), candidate: cand, employer: E1, seq: seq[app], type, actor: extra.actor === undefined ? E1 : extra.actor, actorRole: extra.role || "employer", source: "portal", metadata: extra.metadata || {}, idempotencyKey: `${app}:${seq[app]}`, occurredAt: ago(d) }; };
const events = [
  ev(OLD, "APPLIED", 820, S1, { actor: S1, role: "candidate" }),
  ev(OLD, "SHORTLISTED", 815, S1, { metadata: { note: "strong portfolio", internalNote: "call her on 0300 1234567" } }),
  ev(OLD, "INTERVIEW_INVITED", 810, S1, { metadata: { interviewId: "iv1", startsAt: ago(805), location: "Office 4, Clifton", meetingLink: "https://meet.example/abc" } }),
  ev(OLD, "INTERVIEW_COMPLETED", 805, S1),
  ev(OLD, "OFFER_SENT", 800, S1, { metadata: { offerId: "of1", expiresAt: ago(795), note: "salary 90k" } }),
  ev(OLD, "OFFER_ACCEPTED", 798, S1, { actor: S1, role: "candidate", metadata: { offerId: "of1", response: "accept", note: "my brother will drop me" } }),
  ev(OLD, "HIRE_CONFIRMED", 790, S1, { metadata: { offerId: "of1" } }),
  ev(RECENT, "APPLIED", 800, S2, { actor: S2, role: "candidate" }), ev(RECENT, "REVIEWED", 10, S2, { metadata: { note: "still in touch" } }),
  ev(PUBLIC, "APPLIED", 900, S2, { actor: S2, role: "candidate" }), ev(PUBLIC, "HIRE_CONFIRMED", 880, S2),
  ev(NEW, "APPLIED", 5, S1, { actor: S1, role: "candidate" }),
];
fake.seed(coll("CareerApplicationEvent"), events);
fake.seed(coll("CareerInterview"), [{ _id: oid(), application: OLD, job: oid(), employer: E1, candidate: S1, startsAt: ago(805), endsAt: ago(805), location: "Office 4, Clifton", meetingLink: "https://meet.example/abc", note: "bring your CNIC", status: "completed", active: false, calendarUid: "u1", responses: [{ response: "accept", message: "see you, my number is 0300 1234567", at: ago(808) }] }]);
fake.seed(coll("CareerOffer"), [{ _id: oid(), application: OLD, job: oid(), employer: E1, candidate: S1, title: "Junior analyst", terms: "90k, starts Monday", expiresAt: ago(795), status: "accepted", active: true, responseNote: "my brother will drop me", verificationStatus: "verified" }]);
fake.seed(coll("CareerOutcome"), [
  { _id: oid(), application: OLD, job: oid(), candidate: S1, employer: E1, outcomeType: "hired", verificationLevel: "verified", revokedReason: "", visibility: "private" },
  { _id: oid(), application: PUBLIC, job: oid(), candidate: S2, employer: E1, outcomeType: "hired", verificationLevel: "verified", revokedReason: "", visibility: "public" },
]);
fake.seed(coll("CareerNotificationOutbox"), [{ _id: oid(), kind: "event", event: events[6]._id, eventType: "HIRE_CONFIRMED", application: OLD, recipient: S1, channel: "inapp", key: "k1", payload: { title: "Hired via TDC", body: "Bright Labs confirmed your hire" }, status: "sent", lastError: "" }]);
// resume versions: one old and unused, one old but still attached to a live application, one new
const V_OLD = oid(), V_KEPT = oid(), V_NEW = oid();
const ver = (id, d) => ({ _id: id, userId: S1, sourceResumeId: oid(), draftId: oid(), label: "Analyst at Bright Labs", target: { kind: "pasted", title: "Analyst" }, contentSnapshot: { personalInfo: { firstName: "Ayesha", email: "ayesha@example.com" } }, contentHash: `h-${id}`, rendererVersion: "1", approvedAt: ago(d) });
fake.seed(coll("CareerResumeApprovedVersion"), [ver(V_OLD, 800), ver(V_KEPT, 800), ver(V_NEW, 30)]);
fake.seed(coll("CareerApplicationResumeAttachment"), [{ _id: oid(), applicationId: oid(), jobId: oid(), userId: S1, versionId: V_KEPT, contentHash: `h-${V_KEPT}`, attachedAt: ago(100), retainUntil: new Date(Date.now() + 630 * DAY) }]);

const ALL = ["CareerApplicationEvent", "CareerInterview", "CareerOffer", "CareerOutcome", "CareerNotificationOutbox", "CareerRetentionMark", "CareerResumeApprovedVersion", "CareerApplicationResumeAttachment"];
const snapshot = () => JSON.stringify(ALL.map((m) => rows(m)));
const logs = [];
const realLog = console.log;
const capture = async (fn) => { console.log = (...a) => { logs.push(a.join(" ")); }; try { return await fn(); } finally { console.log = realLog; } };
const range = { from: ago(1000), to: new Date() };

(async () => {
  console.log("-- dry run (the default)");
  delete process.env.CAREER_RETENTION_MODE;
  const before = snapshot();
  const funnelBefore = await careerAnalytics.funnel(range);
  let out = await capture(() => retention.run());
  check("without CAREER_RETENTION_MODE it is a dry run", out.mode === "dry-run", out.mode);
  check("dry run counts: 1 application (7 events, 1 interview, 1 offer, 1 outcome, 1 notification), 1 skipped (public), 1 old resume version", out.applications === 1 && out.events === 7 && out.interviews === 1 && out.offers === 1 && out.outcomes === 1 && out.outbox === 1 && out.skippedPublic === 1 && out.resumeVersions === 1, JSON.stringify(out));
  check("…and writes nothing at all", snapshot() === before);
  const line = logs.find((l) => l.startsWith("[career-retention]")) || "";
  check("one log line with counts only: no ids, names, notes or phone numbers", /dry-run: 1 application/.test(line) && /nothing written/.test(line) && !/[0-9a-f]{24}/.test(line) && !/Ayesha|0300|Clifton|brother/.test(line), line);
  process.env.CAREER_RETENTION_MODE = "dry-run";
  check("CAREER_RETENTION_MODE=dry-run (or any other value) is a dry run too", (await capture(() => retention.run())).mode === "dry-run" && snapshot() === before);

  console.log("-- apply");
  process.env.CAREER_RETENTION_MODE = "apply";
  logs.length = 0;
  out = await capture(() => retention.run());
  check("apply: the same counts, now written", out.mode === "apply" && out.applications === 1 && out.events === 7 && out.interviews === 1 && out.offers === 1 && out.outcomes === 1 && out.outbox === 1 && !out.errors, JSON.stringify(out));
  const oldEv = rows("CareerApplicationEvent", (e) => same(e.application, OLD)).sort((a, b) => a.seq - b.seq);
  const ids = new Set(oldEv.flatMap((e) => [e.candidate, e.employer, e.actor].map(String)));
  check("events: the student's and employer's ids are gone everywhere", !ids.has(String(S1)) && !ids.has(String(E1)), [...ids].join(","));
  check("…one placeholder per person: every event has the same candidate, every employer action the same actor", new Set(oldEv.map((e) => String(e.candidate))).size === 1 && new Set(oldEv.filter((e) => e.actorRole === "employer").map((e) => String(e.actor))).size === 1 && String(oldEv[0].actor) === String(oldEv[0].candidate));
  check("…types, order, times and roles are unchanged (7 events)", oldEv.map((e) => e.type).join() === events.filter((e) => same(e.application, OLD)).map((e) => e.type).join() && oldEv.every((e, i) => e.seq === i + 1 && +e.occurredAt === +events.find((x) => same(x._id, e._id)).occurredAt));
  const metaText = JSON.stringify(oldEv.map((e) => e.metadata));
  check("…notes, internal notes, locations and links are cleared; offer / interview ids and the answer stay", !/strong portfolio|0300|Clifton|meet\.example|90k|brother/.test(metaText) && oldEv[4].metadata.offerId === "of1" && oldEv[5].metadata.response === "accept" && oldEv[2].metadata.interviewId === "iv1", metaText);
  const iv = rows("CareerInterview", (x) => same(x.application, OLD))[0];
  check("interview: placeholder ids; location, meeting link and note empty; the candidate's message removed, the answer kept", !same(iv.candidate, S1) && !same(iv.employer, E1) && iv.location === "" && iv.meetingLink === "" && iv.note === "" && iv.responses.length === 1 && iv.responses[0].response === "accept" && !iv.responses[0].message && iv.status === "completed");
  const of = rows("CareerOffer", (x) => same(x.application, OLD))[0];
  check("offer: placeholder ids, terms and the reply note empty; status kept", !same(of.candidate, S1) && of.terms === "" && of.responseNote === "" && of.status === "accepted" && of.title === "Junior analyst");
  const oc = rows("CareerOutcome", (x) => same(x.application, OLD))[0];
  check("private outcome: placeholder ids; still a verified hire", !same(oc.candidate, S1) && !same(oc.employer, E1) && oc.verificationLevel === "verified");
  const ob = rows("CareerNotificationOutbox", (x) => same(x.application, OLD))[0];
  check("notification: placeholder recipient, payload emptied", !same(ob.recipient, S1) && JSON.stringify(ob.payload) === "{}");
  check("the same placeholder is used for the student across events, interview, offer and outcome", [iv.candidate, of.candidate, oc.candidate, ob.recipient].every((x) => same(x, oldEv[0].candidate)));
  check("the application is marked done, with its counts", rows("CareerRetentionMark", (m) => same(m.application, OLD) && m.counts.events === 7).length === 1);
  const funnelAfter = await careerAnalytics.funnel(range);
  check("the hiring funnel counts are exactly the same before and after", JSON.stringify(funnelAfter.counts) === JSON.stringify(funnelBefore.counts) && JSON.stringify(funnelAfter.conversions) === JSON.stringify(funnelBefore.conversions), `${JSON.stringify(funnelBefore.counts)} vs ${JSON.stringify(funnelAfter.counts)}`);
  check("not touched: the application with recent activity, the one with a public outcome, the new one", [RECENT, PUBLIC, NEW].every((a) => rows("CareerApplicationEvent", (e) => same(e.application, a)).every((e) => [String(S1), String(S2)].includes(String(e.candidate)))) && rows("CareerApplicationEvent", (e) => same(e.application, RECENT) && e.type === "REVIEWED")[0].metadata.note === "still in touch");
  const vOld = rows("CareerResumeApprovedVersion", (v) => same(v._id, V_OLD))[0];
  check("old unused resume version: content removed, label cleared, student id replaced; the hash stays (it can never be served again)", vOld.contentSnapshot.anonymised === true && !JSON.stringify(vOld.contentSnapshot).includes("Ayesha") && vOld.label === "" && !same(vOld.userId, S1) && vOld.contentHash === `h-${V_OLD}`);
  check("…the old version still attached to a live application, and the new one, are untouched", ["V_KEPT", "V_NEW"].every((k) => rows("CareerResumeApprovedVersion", (v) => same(v._id, k === "V_KEPT" ? V_KEPT : V_NEW))[0].contentSnapshot.personalInfo?.firstName === "Ayesha"));
  const applyLine = logs.find((l) => l.startsWith("[career-retention] apply")) || "";
  check("apply log: counts only", /apply: 1 application/.test(applyLine) && !/[0-9a-f]{24}/.test(applyLine), applyLine);

  console.log("-- again, and later");
  const afterFirst = snapshot();
  out = await capture(() => retention.run());
  check("a second run finds nothing new and changes nothing", out.applications === 0 && out.resumeVersions === 0 && snapshot() === afterFirst, JSON.stringify(out));
  rows("CareerOutcome", (x) => same(x.application, PUBLIC))[0].visibility = "private";
  out = await capture(() => retention.run());
  check("once the student makes the outcome private, the next run anonymises that application", out.applications === 1 && rows("CareerApplicationEvent", (e) => same(e.application, PUBLIC)).every((e) => !same(e.candidate, S2)), JSON.stringify(out));
  const A3 = oid(), A4 = oid();
  fake.seed(coll("CareerApplicationEvent"), [ev(A3, "APPLIED", 900, S1, { actor: S1, role: "candidate" }), ev(A4, "APPLIED", 900, S2, { actor: S2, role: "candidate" })]);
  out = await capture(() => retention.run({ limit: 1 }));
  check("at most `limit` applications per run (the rest next time)", out.applications === 1 && rows("CareerRetentionMark").length === 3, JSON.stringify(out));

  console.log("-- the background job switch");
  const env = { ...process.env };
  for (const k of ["APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "BACKGROUND_JOBS", "JOB_CAREER_RETENTION"]) delete process.env[k];
  const prod = flags.jobEnabled("careerRetention");
  process.env.APP_ENV = "staging";
  const staging = flags.jobEnabled("careerRetention");
  process.env.JOB_CAREER_RETENTION = "on";
  const stagingOn = flags.jobEnabled("careerRetention");
  delete process.env.APP_ENV; process.env.JOB_CAREER_RETENTION = "off";
  const prodOff = flags.jobEnabled("careerRetention");
  for (const k of ["APP_ENV", "JOB_CAREER_RETENTION"]) { delete process.env[k]; if (env[k] !== undefined) process.env[k] = env[k]; }
  check("JOB_CAREER_RETENTION: on in production, off in staging, switchable by name either way", prod && !staging && stagingOn && !prodOff, `${prod} ${staging} ${stagingOn} ${prodOff}`);
  check("the startup line lists it", /careerRetention/.test(flags.describeJobs()));
  delete process.env.CAREER_RETENTION_MODE;
  const job = reqS("./services/career/careerRetentionJob");
  out = await capture(() => job.tick());
  check("the job's tick is one pass (dry run by default)", out.mode === "dry-run");

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log = realLog; console.error("FATAL", e); process.exit(2); });
