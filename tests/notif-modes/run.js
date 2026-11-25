// N-5 simpler notification settings (flag notifSettingsV2, per account; upgrade/phase-n):
//   prefs: flag off → no mode / digest keys, a saved mode is ignored; on → mode (everything by default) and digest
//     (off by default) are read and saved; anything else is ignored
//   pushes (every sender: bell / sendToUser, gateway, social bulk): quiet → personal only; only important → no
//     broadcast; everything → as before; digest on → the per-item campus pushes skip the student
//   the 6 pm digest: real counts of today only ("today at your campus: …"), nothing → no push; only students with the
//     digest on and the flag
//   flag off: a stored mode changes nothing
//   node tests/notif-modes/run.js [serverDir]
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
// r10 (owner): launchV2 is on for every student by default; this suite tests its flag on / off per account, so the
// students' launchV2 default is turned off first, as an admin can (the per-account rules are then exactly as before)
reqS("./config/featureFlags").applyDefault("launchV2", "student", false);
process.env.JWT_SECRET = "test-only";
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB|PUSH_BUDGET)_|^MONGO|^SOCIAL_PUSH|^EXPO_ACCESS|^DISABLE_NOTIFICATION_PUSH$/.test(k)) delete process.env[k];

const expo = { requests: [] };
class Expo {
  constructor() {}
  static isExpoPushToken(t) { return typeof t === "string" && t.startsWith("ExponentPushToken["); }
  chunkPushNotifications(ms) { return [ms]; }
  async sendPushNotificationsAsync(ms) { expo.requests.push(ms.map((m) => JSON.parse(JSON.stringify(m)))); return ms.map((m, i) => ({ status: "ok", id: `t${expo.requests.length}-${i}` })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = async (url) => { throw new Error(`network blocked in test: ${url}`); };
const kt = reqS("./utils/karachiTime");
kt.isQuietHour = () => false; // daytime for every module

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true });
const quiet = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };
const express = reqS("express");
const jwt = reqS("jsonwebtoken");

const User = reqS("./models/User");
const EngagementProfile = reqS("./models/EngagementProfile");
const { sendToUser } = reqS("./utils/pushNotification");
const socialPush = reqS("./services/socialPush");
const gateway = reqS("./services/engagement/pushGateway");
const digest = reqS("./services/notifDigest");
reqS("./models/University");

const app = express();
app.use(express.json());
app.use("/api/engagement", reqS("./routes/engagement.routes"));

const oid = () => new mongoose.Types.ObjectId();
const U1 = oid(); const U2 = oid();
const A = oid(); const B = oid(); const C = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
const person = (id, k, uni) => ({ _id: id, name: `${k} Student`, email: `${k}@test.local`, role: "student", status: "Verified", accountStatus: "active", university: uni, pushTokens: [{ token: tok(k), channels: "snd_v2" }], createdAt: new Date() });
fake.seed(User.collection.collectionName, [person(A, "a", U1), person(B, "b", U1), person(C, "c", U2)]);
fake.seed(EngagementProfile.collection.collectionName, [A, B, C].map((u) => ({ _id: oid(), user: u, notifPrefs: {} })));
const T = { A: jwt.sign({ id: String(A), role: "student" }, "test-only"), B: jwt.sign({ id: String(B), role: "student" }, "test-only") };

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  (" + detail + ")" : ""}`); };
const to = (k) => expo.requests.flat().filter((m) => m.to === tok(k));
const setPrefs = (who, p) => EngagementProfile.updateOne({ user: who }, { $set: Object.fromEntries(Object.entries(p).map(([k, v]) => [`notifPrefs.${k}`, v])) });

(async () => {
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const api = async (method, url, who, body) => { const r = await fetch(`http://127.0.0.1:${port}/api/engagement${url}`, { method, headers: { authorization: `Bearer ${T[who]}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

  quiet.log("-- prefs");
  let r = await api("GET", "/notification-prefs", "A");
  check("flag off: no mode / digest in the prefs", r.status === 200 && !("mode" in r.json) && !("digest" in r.json), JSON.stringify(r.json));
  r = await api("PUT", "/notification-prefs", "A", { mode: "quiet", digest: true });
  check("flag off: a mode / digest sent is ignored", !("mode" in r.json) && !(await EngagementProfile.findOne({ user: A }).lean()).notifPrefs.mode);
  process.env.FLAG_NOTIF_SETTINGS_V2 = `ids:${A}`;
  r = await api("GET", "/notification-prefs", "A");
  check("flag on: mode 'everything' and digest off by default; the old switches unchanged", r.json.mode === "everything" && r.json.digest === false && r.json.posts === true && r.json.streaks === true, JSON.stringify(r.json));
  r = await api("PUT", "/notification-prefs", "A", { mode: "important", digest: true });
  check("flag on: mode and digest saved", r.json.mode === "important" && r.json.digest === true);
  r = await api("PUT", "/notification-prefs", "A", { mode: "loud", digest: "yes" });
  check("…an unknown mode / a non-boolean digest is ignored", r.json.mode === "important" && r.json.digest === true);
  r = await api("GET", "/notification-prefs", "B");
  check("another account without the flag: no mode / digest", !("mode" in r.json));

  quiet.log("-- modes act on every sender");
  await setPrefs(A, { mode: "quiet", digest: false });
  let n = to("a").length;
  const q = [await sendToUser(A, "chat", "hi", { type: "message" }), await sendToUser(A, "50% off", "", { type: "System", notificationType: "Promotion" }), await sendToUser(A, "frontend dev", "", { type: "System", notificationType: "Job Posting" }), await gateway.send(A, { type: "daily_drop", title: "t", body: "b" })];
  check("quiet: personal goes; broadcast and relevant don't (bell and gateway)", q[0].sent && q[1].reason === "mode_quiet" && q[2].reason === "mode_quiet" && q[3].reason === "mode_quiet" && to("a").length === n + 1, JSON.stringify(q));
  await setPrefs(A, { mode: "important" });
  n = to("a").length;
  const im = [await sendToUser(A, "frontend dev", "", { type: "System", notificationType: "Job Posting" }), await sendToUser(A, "50% off", "", { type: "System", notificationType: "Promotion" })];
  check("only important: relevant goes, broadcast doesn't", im[0].sent && im[1].reason === "mode_important" && to("a").length === n + 1, JSON.stringify(im));
  await setPrefs(A, { mode: "everything" });
  r = await sendToUser(A, "50% off", "", { type: "System", notificationType: "Promotion" });
  check("everything: as before", r.sent === true);
  await setPrefs(B, { mode: "quiet" });
  r = await sendToUser(B, "50% off", "", { type: "System", notificationType: "Promotion" });
  check("flag off (B): a stored mode changes nothing", r.sent === true);
  await setPrefs(A, { digest: true });
  await socialPush.sendToStudents("post", [{ id: oid(), firstName: "Zed", text: "hello" }], await User.find({}).select("+pushTokens role").lean());
  const last = expo.requests[expo.requests.length - 1].map((m) => m.to);
  check("digest on: the per-item campus push skips A; B and C get it", !last.includes(tok("a")) && last.includes(tok("b")) && last.includes(tok("c")), last.join());

  quiet.log("-- the 6 pm digest");
  check("the line: only parts that aren't 0", digest.line({ confessions: 12, posts: 3, events: 2 }) === "today at your campus: 12 confessions, 3 posts. 2 new events." && digest.line({ confessions: 1 }) === "today at your campus: 1 confession." && digest.line({ events: 1 }) === "1 new event." && digest.line({}) === null);
  const now = new Date();
  const yesterday = new Date(Date.now() - 30 * 3600e3);
  fake.seed(reqS("./models/Confession").collection.collectionName, [
    { _id: oid(), text: "x", university: U1, createdAt: now }, { _id: oid(), text: "y", university: U1, createdAt: now, status: "live" },
    { _id: oid(), text: "held", university: U1, createdAt: now, status: "pending" }, { _id: oid(), text: "old", university: U1, createdAt: yesterday },
    { _id: oid(), text: "other campus", university: U2, createdAt: now },
  ]);
  fake.seed(reqS("./models/Post").collection.collectionName, [{ _id: oid(), author: B, content: "p", createdAt: now }, { _id: oid(), author: C, content: "q", createdAt: now }]);
  fake.seed(reqS("./models/Event").Event.collection.collectionName, [{ _id: oid(), title: "open mic", status: "approved", createdAt: now }, { _id: oid(), title: "pending", status: "pending", createdAt: now }]);
  const sent = [];
  const g = { send: async (uid, msg) => { sent.push({ uid: String(uid), msg }); return { sent: true }; } };
  await setPrefs(B, { digest: true });
  const res = await digest.sendDigests({ now, gateway: g });
  check("sent only to A (digest on + flag); B has the digest saved but no flag", sent.length === 1 && sent[0].uid === String(A) && res.students === 2 && res.sent === 1, JSON.stringify(res));
  check("A's campus: 2 live confessions today (not the held one, not yesterday's, not the other campus), 1 post, 1 new event", sent[0]?.msg.body === "today at your campus: 2 confessions, 1 post. 1 new event.", sent[0]?.msg.body);
  check("…a personal push, tapping opens the feed", sent[0]?.msg.budgetClass === "personal" && sent[0].msg.type === "campus_digest" && sent[0].msg.data.route === "FeedScreen");
  delete process.env.FLAG_NOTIF_SETTINGS_V2;
  sent.length = 0;
  const off = await digest.sendDigests({ now, gateway: g });
  check("flag configured nowhere: no digest at all", off.students === 0 && sent.length === 0);

  server.close();
  const failed = results.filter((x) => !x).length;
  quiet.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { quiet.error(e); process.exit(1); });
