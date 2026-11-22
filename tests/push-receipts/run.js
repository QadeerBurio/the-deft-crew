// Scheduled push receipts (owner, Phase N sign-off; job pushReceipts, JOB_PUSH_RECEIPTS):
//   pushGateway.checkReceipts on logged pushes (the gateway's rows and every tracked row from any sender): receipt ok →
//     delivered; error → failed with the reason; DeviceNotRegistered on a one-device row → the dead token removed from
//     whoever has it; rows already checked, older than a day, or without a ticket are left alone
//   startReceiptChecks: runs on its timer, never two at once, stops cleanly
//   the switch: a background job (on in production, off on staging, JOB_PUSH_RECEIPTS=off turns it off), on the
//     startup line; server.js starts it only when on
//   node tests/push-receipts/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_|^MONGO|^EXPO_ACCESS|^APP_ENV$|^RAILWAY_ENVIRONMENT_NAME$|^BACKGROUND_JOBS$/.test(k)) delete process.env[k];
let receipts = {};
let receiptCalls = 0;
class Expo {
  constructor() {}
  static isExpoPushToken() { return true; }
  chunkPushNotifications(ms) { return [ms]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "t" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync(ids) { receiptCalls++; await new Promise((r) => setTimeout(r, 20)); return Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id]])); }
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
const quiet = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };

const User = reqS("./models/User");
const PushLog = reqS("./models/PushLog");
const gateway = reqS("./services/engagement/pushGateway");
const flags = reqS("./config/featureFlags");

const oid = () => new mongoose.Types.ObjectId();
const A = oid(); const B = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
fake.seed(User.collection.collectionName, [
  { _id: A, name: "A", email: "a@test.local", role: "student", pushTokens: [{ token: tok("a1") }, { token: tok("a2") }], createdAt: new Date() },
  { _id: B, name: "B", email: "b@test.local", role: "student", pushTokens: [{ token: tok("b1") }], createdAt: new Date() },
]);
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
const row = (id, user, ticketId, extra = {}) => ({ _id: id, user, type: "x", status: "sent", receiptStatus: "pending", ticketId, tokens: [tok("a1")], sentAt: hoursAgo(1), createdAt: hoursAgo(1), ...extra });
const R = { ok: oid(), err: oid(), dead: oid(), deadMulti: oid(), old: oid(), done: oid(), noTicket: oid() };
fake.seed(PushLog.collection.collectionName, [
  row(R.ok, A, "k-ok", { tracked: true, sender: "send" }),
  row(R.err, A, "k-err"),
  row(R.dead, B, "k-dead", { tokens: [tok("b1")], tracked: true, sender: "send" }),
  row(R.deadMulti, A, "k-dead2", { tokens: [tok("a1"), tok("a2")] }),
  row(R.old, A, "k-old", { sentAt: hoursAgo(30) }),
  row(R.done, A, "k-done", { receiptStatus: "ok", deliveredAt: hoursAgo(1) }),
  row(R.noTicket, A, null),
]);
receipts = {
  "k-ok": { status: "ok" }, "k-err": { status: "error", message: "too big", details: { error: "MessageTooBig" } },
  "k-dead": { status: "error", details: { error: "DeviceNotRegistered" } }, "k-dead2": { status: "error", details: { error: "DeviceNotRegistered" } },
  "k-old": { status: "ok" }, "k-done": { status: "ok" },
};

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  (" + detail + ")" : ""}`); };
const get = (id) => (fake.STORE.get(PushLog.collection.collectionName) || []).find((r) => String(r._id) === String(id));
const tokens = (id) => ((fake.STORE.get(User.collection.collectionName) || []).find((u) => String(u._id) === String(id)).pushTokens || []).map((t) => t.token);

(async () => {
  quiet.log("-- checkReceipts");
  const r = await gateway.checkReceipts();
  check("4 rows checked (pending, with a ticket, in the last day); ok 1, failed 3", r.checked === 4 && r.ok === 1 && r.error === 3, JSON.stringify(r));
  check("ok → delivered (a tracked row from any sender)", get(R.ok).receiptStatus === "ok" && !!get(R.ok).deliveredAt);
  check("an error → failed with its reason", get(R.err).receiptStatus === "error" && /MessageTooBig/.test(get(R.err).receiptError));
  check("DeviceNotRegistered on a one-device row: that dead token removed", !tokens(B).includes(tok("b1")) && get(R.dead).receiptStatus === "error");
  check("…on a several-device row: no token removed (which one died isn't known)", tokens(A).length === 2);
  check("older than a day, already checked, or without a ticket: left alone", get(R.old).receiptStatus === "pending" && get(R.done).deliveredAt && get(R.noTicket).receiptStatus === "pending");
  const again = await gateway.checkReceipts();
  check("a second run: nothing left to check", again.checked === 0);

  quiet.log("-- the timer");
  await PushLog.updateOne({ _id: R.old }, { $set: { sentAt: hoursAgo(1) } });
  receiptCalls = 0;
  const stop = gateway.startReceiptChecks(15, 1);
  await new Promise((res) => setTimeout(res, 120));
  const calls = receiptCalls;
  stop();
  await new Promise((res) => setTimeout(res, 60));
  check("runs on its timer (the moved row delivered) and stops cleanly", get(R.old).receiptStatus === "ok" && receiptCalls === calls, `${calls} → ${receiptCalls}`);
  check("never two runs at once (each run waits for its receipts; ticks while one runs are skipped)", calls >= 1 && calls <= 5, String(calls));

  quiet.log("-- the switch");
  check("a background job: on in production by default", flags.jobEnabled("pushReceipts") === true && /pushReceipts/.test(flags.describeJobs()));
  process.env.JOB_PUSH_RECEIPTS = "off";
  check("JOB_PUSH_RECEIPTS=off: off", flags.jobEnabled("pushReceipts") === false);
  delete process.env.JOB_PUSH_RECEIPTS;
  process.env.APP_ENV = "staging";
  check("staging: off unless JOB_PUSH_RECEIPTS=on", flags.jobEnabled("pushReceipts") === false);
  delete process.env.APP_ENV;
  const server = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
  check("server.js starts it only when the job is on", /if \(jobEnabled\("pushReceipts"\)\) \{\s*\n\s*require\("\.\/services\/engagement\/pushGateway"\)\.startReceiptChecks\(\);/.test(server));

  const failed = results.filter((x) => !x).length;
  quiet.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { quiet.error(e); process.exit(1); });
