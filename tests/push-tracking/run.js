// N-6 push open tracking (flag pushOpenTracking, per recipient; upgrade/phase-n):
//   flag off (not configured): no PushLog rows from other senders, no pushLogId in any push, gateway rows as before
//   flag on for A: every sender (bell, sendToUser, social bulk, engagement gateway) → one tracked PushLog row per send
//     with its id in A's push data; B (flag off) in the same bulk send gets nothing extra; the gateway's own row is
//     used (no second row); sent / failed and the ticket id recorded; receipts mark tracked rows delivered
//   POST /api/notifications/push-opened/:logId: the recipient only, the first tap only; bad ids → false, no 500
//   node tests/push-tracking/run.js [serverDir]
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_|^MONGO|^SOCIAL_PUSH|^EXPO_ACCESS|^DISABLE_NOTIFICATION_PUSH$/.test(k)) delete process.env[k];

const expo = { requests: [], dead: new Set() };
class Expo {
  constructor() {}
  static isExpoPushToken(t) { return typeof t === "string" && t.startsWith("ExponentPushToken["); }
  chunkPushNotifications(ms) { const out = []; for (let i = 0; i < ms.length; i += 100) out.push(ms.slice(i, i + 100)); return out; }
  async sendPushNotificationsAsync(ms) {
    expo.requests.push(ms.map((m) => JSON.parse(JSON.stringify(m))));
    return ms.map((m, i) => (expo.dead.has(m.to) ? { status: "error", message: "dead", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `t${expo.requests.length}-${i}` }));
  }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync(ids) { return Object.fromEntries(ids.map((id) => [id, { status: "ok" }])); }
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

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };

const User = reqS("./models/User");
const PushLog = reqS("./models/PushLog");
const Notification = reqS("./models/Notification");
const EngagementProfile = reqS("./models/EngagementProfile");
const { sendToUser, handleTickets } = reqS("./utils/pushNotification");
const socialPush = reqS("./services/socialPush");
const gateway = reqS("./services/engagement/pushGateway");
const tracking = reqS("./services/pushTracking");

const app = express();
app.use(express.json());
app.use("/api/notifications", reqS("./routes/notification.routes"));

const oid = () => new mongoose.Types.ObjectId();
const A = oid(); const B = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
const person = (id, k) => ({ _id: id, name: `${k} Student`, email: `${k}@test.local`, role: "student", status: "Verified", accountStatus: "active", pushTokens: [{ token: tok(k), channels: "snd_v2" }], createdAt: new Date() });
fake.seed(User.collection.collectionName, [person(A, "a"), person(B, "b")]);
fake.seed(EngagementProfile.collection.collectionName, [{ _id: oid(), user: A, notifPrefs: {} }, { _id: oid(), user: B, notifPrefs: {} }]);
const T = { A: jwt.sign({ id: String(A), role: "student" }, "test-only"), B: jwt.sign({ id: String(B), role: "student" }, "test-only") };

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  (" + detail + ")" : ""}`); };
const rows = () => fake.STORE.get(PushLog.collection.collectionName) || [];
const lastMsgs = () => expo.requests[expo.requests.length - 1] || [];
const msgTo = (k) => expo.requests.flat().filter((m) => m.to === tok(k));
const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const tap = async (id, who) => { const r = await fetch(`http://127.0.0.1:${port}/api/notifications/push-opened/${id}`, { method: "POST", headers: { authorization: `Bearer ${T[who]}`, "content-type": "application/json" }, body: "{}" }); return { status: r.status, json: await r.json().catch(() => null) }; };

  quiet.log("-- flag off (not configured)");
  await sendToUser(A, "hi", "there", { type: "System" });
  check("sendToUser: no pushLogId in the push, no PushLog row", !("pushLogId" in (lastMsgs()[0]?.data || {})) && rows().length === 0, JSON.stringify(lastMsgs()));
  await Notification.create({ recipient: A, title: "bell", description: "d", type: "System" });
  await settle();
  check("a bell notification's push: no pushLogId, no row", !("pushLogId" in (lastMsgs()[0]?.data || {})) && rows().length === 0);
  await socialPush.sendToStudents("post", [{ id: oid(), firstName: "Zed", text: "hello" }], await User.find({}).select("+pushTokens").lean());
  check("social bulk push: nothing extra", lastMsgs().every((m) => !("pushLogId" in m.data)) && rows().length === 0);
  let g = await gateway.send(A, { type: "admin_test", title: "t", body: "b", skipCaps: true });
  const gRow = rows().find((r) => String(r._id) === g.logId);
  check("engagement gateway: its row as before (not tracked), no pushLogId", g.sent && gRow && gRow.tracked === undefined && gRow.sender === undefined && !("pushLogId" in lastMsgs()[0].data), JSON.stringify(gRow));
  const before = rows().length;

  quiet.log("-- flag on for A");
  process.env.FLAG_PUSH_OPEN_TRACKING = `ids:${A}`;
  await sendToUser(A, "hi", "again", { type: "System", route: "Home" });
  let m = lastMsgs()[0]; let row = rows().find((r) => String(r._id) === m.data.pushLogId);
  check("sendToUser(A): the push carries its row's id", !!row && row.tracked === true && row.sender === "send" && String(row.user) === String(A) && row.type === "System");
  check("…the row is marked sent with the ticket id", row.status === "sent" && /^t[0-9]+-0$/.test(row.ticketId) && expo.requests.flat().some((x) => x.data?.pushLogId === String(row._id)), `${row.status} ${row.ticketId}`);
  await sendToUser(B, "hi", "b", { type: "System" });
  check("sendToUser(B) (flag off): nothing extra", !("pushLogId" in lastMsgs()[0].data) && rows().length === before + 1);
  await Notification.create({ recipient: A, title: "someone replied", description: "d", type: "Message", metadata: { pushType: "reply" } });
  await settle();
  m = lastMsgs()[0];
  check("a bell notification to A: tracked row with the push type", !!m.data.pushLogId && rows().some((r) => String(r._id) === m.data.pushLogId && r.type === "reply"));
  await socialPush.sendToStudents("post", [{ id: oid(), firstName: "Zed", text: "hello" }], await User.find({}).select("+pushTokens").lean());
  const bulk = lastMsgs();
  const mA = bulk.find((x) => x.to === tok("a")); const mB = bulk.find((x) => x.to === tok("b"));
  check("social bulk push: A's message has a pushLogId, B's doesn't", !!mA?.data.pushLogId && mB && !("pushLogId" in mB.data));
  check("…one row for A for that send, type social_post", rows().filter((r) => String(r._id) === mA.data.pushLogId && r.type === "social_post").length === 1);
  const n0 = rows().length;
  g = await gateway.send(A, { type: "admin_test", title: "t", body: "b", skipCaps: true });
  m = lastMsgs()[0];
  check("engagement gateway to A: the push carries the gateway's own row id; no second row", m.data.pushLogId === g.logId && rows().length === n0 + 1 && rows().find((r) => String(r._id) === g.logId).sender === "gateway");
  expo.dead.add(tok("a"));
  await sendToUser(A, "x", "y", { type: "System" });
  const failedRow = rows().find((r) => String(r._id) === lastMsgs()[0].data.pushLogId);
  check("every device refused: the row is marked failed", failedRow?.status === "failed" && failedRow.receiptError === "DeviceNotRegistered", JSON.stringify(failedRow));
  expo.dead.clear();
  await User.updateOne({ _id: A }, { $push: { pushTokens: { token: tok("a"), channels: "snd_v2" } } }); // the dead-device check removed it

  quiet.log("-- receipts");
  await tracking.markDelivered([row.ticketId, gRow.ticketId]);
  const fresh = (id) => rows().find((r) => String(r._id) === String(id));
  check("receipt ok: the tracked row is delivered; the untracked gateway row from before is untouched", !!fresh(row._id).deliveredAt && fresh(row._id).receiptStatus === "ok" && !fresh(gRow._id).deliveredAt);

  quiet.log("-- opens");
  let r = await tap(row._id, "B");
  check("B can't open A's push", r.status === 200 && r.json.ok === false && !fresh(row._id).openedAt);
  r = await tap(row._id, "A");
  const firstOpen = fresh(row._id).openedAt;
  check("A's tap: openedAt set", r.json.ok === true && !!firstOpen);
  await new Promise((res) => setTimeout(res, 5));
  r = await tap(row._id, "A");
  check("a second tap keeps the first time", r.json.ok === false && fresh(row._id).openedAt.getTime() === new Date(firstOpen).getTime());
  r = await tap("not-an-id", "A");
  check("a bad id: ok false, no 500", r.status === 200 && r.json.ok === false);
  r = await tap(String(oid()), "A");
  check("an unknown id: ok false", r.json.ok === false);

  quiet.log("-- the flag off again");
  delete process.env.FLAG_PUSH_OPEN_TRACKING;
  const n1 = rows().length;
  await sendToUser(A, "hi", "off", { type: "System" });
  const reqs = expo.requests.length;
  await sendToUser(A, "hi", "off2", { type: "System" });
  check("off again: sent, no row, no pushLogId", expo.requests.length === reqs + 1 && rows().length === n1 && !("pushLogId" in lastMsgs()[0].data));
  check("the flag: client, grantable to students, off by default", reqS("./config/featureFlags").FLAGS.pushOpenTracking.client === true && reqS("./config/featureFlags").isEnabled("pushOpenTracking", { id: String(A), role: "student" }) === false);
  void handleTickets; void msgTo;

  server.close();
  const failed = results.filter((x) => !x).length;
  quiet.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { quiet.error(e); process.exit(1); });
