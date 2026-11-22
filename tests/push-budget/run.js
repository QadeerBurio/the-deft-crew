// N-2 one push budget across senders (flag pushBudgetV1, per recipient; upgrade/phase-n):
//   classes: personal (no cap, no quiet hours), relevant (3 a day shared), broadcast (2 a day shared), unknown →
//   relevant and logged once; senders' budgetClass wins and is never sent to the phone
//   flag off: every sender keeps its own rules (gateway quiet hours + daily cap; bell pushes at any hour); no rows
//   flag on: gateway, bell / sendToUser and social bulk share the budget; the gateway's own quiet hours and caps are
//   replaced; quiet hours stop relevant and broadcast only; another student (flag off) is untouched
//   node tests/push-budget/run.js [serverDir]
const path = require("path");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
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

// the clock: quiet hours on or off, for every module (set before they load)
const kt = reqS("./utils/karachiTime");
let quietNow = false;
const realQuiet = kt.isQuietHour;
kt.isQuietHour = (d, cfg) => (d instanceof Date && d.__real ? realQuiet(d, cfg) : quietNow);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true });
const quiet = { log: console.log, warn: console.warn, error: console.error };
const warns = [];
console.log = () => {}; console.warn = (...a) => warns.push(a.join(" ")); console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };

const User = reqS("./models/User");
const PushBudget = reqS("./models/PushBudget");
const Notification = reqS("./models/Notification");
const EngagementProfile = reqS("./models/EngagementProfile");
const { sendToUser } = reqS("./utils/pushNotification");
const socialPush = reqS("./services/socialPush");
const gateway = reqS("./services/engagement/pushGateway");
const budget = reqS("./services/pushBudget");

const oid = () => new mongoose.Types.ObjectId();
const A = oid(); const B = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
const person = (id, k) => ({ _id: id, name: `${k} Student`, email: `${k}@test.local`, role: "student", status: "Verified", accountStatus: "active", pushTokens: [{ token: tok(k), channels: "snd_v2" }], createdAt: new Date() });
fake.seed(User.collection.collectionName, [person(A, "a"), person(B, "b")]);
fake.seed(EngagementProfile.collection.collectionName, [{ _id: oid(), user: A, notifPrefs: {} }, { _id: oid(), user: B, notifPrefs: {} }]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  (" + detail + ")" : ""}`); };
const to = (k) => expo.requests.flat().filter((m) => m.to === tok(k));
const rows = () => fake.STORE.get(PushBudget.collection.collectionName) || [];
const settle = () => new Promise((r) => setTimeout(r, 30));
const resetProfiles = () => EngagementProfile.updateMany({}, { $set: { push: {} } });
const gw = (who, type, extra = {}) => gateway.send(who, { type, title: "t", body: "b", ...extra });

(async () => {
  quiet.log("-- classes");
  const C = budget.classify;
  check("personal: chat, reply, mention, own ticket / claim / application, friend joined, account", ["message", "reply", "mention", "event", "Event", "redemption", "loyalty", "Application Status", "Interview", "referral_joined", "Security"].every((t) => C(t) === "personal"));
  check("relevant: job match, deal near you, followed post", ["job", "nearby_deal", "Job Posting", "followed_post"].every((t) => C(t) === "relevant"));
  check("broadcast: new posts / confessions / listings, events, announcements, daily drop, streak nudges, offers to all", ["social_post", "social_confession", "skillshare_listing", "new_event", "Update", "announcement", "daily_drop", "streak_warning", "new_offer", "try_jobs"].every((t) => C(t) === "broadcast"));
  check("a bell row: its generic push type 'System' uses the row's type", C("System", "Promotion") === "broadcast" && C("System", "Interview") === "personal" && C("System") === "personal");
  check("a bell row: its own type wins over the sound family (new_job: application vs posting; new_offer: payment vs promotion; event: your ticket)", C("new_job", "Application Status") === "personal" && C("new_job", "Job Posting") === "relevant" && C("new_offer", "Payment") === "personal" && C("new_offer", "Promotion") === "broadcast" && C("event", "Event") === "personal");
  warns.length = 0;
  check("unknown types → relevant, logged once per type", C("weird_new_type") === "relevant" && C("weird_new_type") === "relevant" && warns.filter((w) => w.includes("unclassified push type 'weird_new_type'")).length === 1, warns.join(" | "));

  quiet.log("-- flag off (as before)");
  quietNow = true;
  let r = await sendToUser(A, "x", "y", { type: "Promotion", notificationType: "Promotion" });
  check("a bell push at night: sent (bell pushes have no quiet hours today)", r.sent === true);
  r = await gw(A, "daily_drop");
  check("gateway at night: refused for quiet hours (its own rule)", r.sent === false && r.reason === "quiet_hours");
  quietNow = false;
  r = await gw(A, "daily_drop");
  const r2 = await gw(A, "badge_earned");
  check("gateway: the second push of the day hits its daily cap (its own rule)", r.sent === true && r2.sent === false && r2.reason === "daily_cap", JSON.stringify([r, r2]));
  check("…no budget rows", rows().length === 0);
  await resetProfiles();

  quiet.log("-- flag on for A");
  process.env.FLAG_PUSH_BUDGET_V1 = `ids:${A}`;
  quietNow = true;
  let n = to("a").length;
  for (let i = 0; i < 5; i++) await sendToUser(A, "chat", "hi", { type: "message" });
  r = await gw(A, "referral_joined");
  check("personal at night: chat ×5 and 'a friend joined' all sent, nothing counted", to("a").length === n + 6 && r.sent === true && rows().every((x) => !x.relevant && !x.broadcast), `${to("a").length - n}`);
  r = await gw(A, "job", { budgetClass: "relevant" });
  const rb = await sendToUser(A, "new posts", "", { type: "Promotion", notificationType: "Promotion" });
  check("relevant and broadcast at night: held back (quiet hours)", r.sent === false && r.reason === "quiet_hours" && rb.sent === false && rb.reason === "quiet_hours");
  quietNow = false;
  n = to("a").length;
  const rel = [await gw(A, "job", { budgetClass: "relevant" }), await sendToUser(A, "Frontend dev at X", "", { type: "System", notificationType: "Job Posting" }), await gw(A, "nearby_deal", { budgetClass: "relevant" }), await sendToUser(A, "?", "", { type: "brand_new_kind" })];
  check("relevant: 3 a day across senders (gateway, bell); the 4th (an unknown type) refused", rel.slice(0, 3).every((x) => x.sent) && rel[3].sent === false && rel[3].reason === "budget_relevant" && to("a").length === n + 3, JSON.stringify(rel));
  check("…the gateway's own daily cap no longer applies (3 gateway / bell pushes in one day)", rel[0].sent && rel[2].sent);
  n = to("a").length;
  await Notification.create({ recipient: A, title: "campus fest: tickets out", description: "friday 7pm", type: "Promotion" });
  await settle();
  const b2 = await gw(A, "daily_drop");
  await socialPush.sendToStudents("post", [{ id: oid(), firstName: "Zed", text: "hello" }], await User.find({}).select("+pushTokens role").lean());
  const lastSocial = expo.requests[expo.requests.length - 1];
  check("broadcast: 2 a day (a promotion bell push, the daily drop); the social push then skips A", b2.sent === true && to("a").length === n + 2 && !lastSocial.some((m) => m.to === tok("a")) && lastSocial.some((m) => m.to === tok("b")), `${to("a").length - n}`);
  const row = rows().find((x) => String(x.user) === String(A));
  check("…one row for A today: relevant 3, broadcast 2", row && row.relevant === 3 && row.broadcast === 2, JSON.stringify(row));
  r = await sendToUser(A, "chat", "still", { type: "message" });
  check("personal still goes when the budget is used up", r.sent === true);
  check("budgetClass never reaches the phone", expo.requests.flat().every((m) => !("budgetClass" in (m.data || {}))));

  quiet.log("-- another student and another day");
  n = to("b").length;
  for (let i = 0; i < 4; i++) await sendToUser(B, "x", "", { type: "Promotion", notificationType: "Promotion" });
  check("B (flag off): bell pushes as before (4 of 4), no budget row", to("b").length === n + 4 && !rows().some((x) => String(x.user) === String(B)));
  const tomorrow = new Date(Date.now() + 24 * 3600e3);
  const t1 = await budget._test.allowRaw({ _id: A, role: "student" }, "broadcast", { now: tomorrow });
  check("a new Karachi day: a fresh budget", t1.ok === true && t1.counted === true, JSON.stringify(t1));
  process.env.PUSH_BUDGET_BROADCAST_MAX = "5";
  check("PUSH_BUDGET_BROADCAST_MAX outside 1–2 is ignored (owner: 1–2 a day)", budget.caps().broadcast === 2);
  process.env.PUSH_BUDGET_BROADCAST_MAX = "1"; process.env.PUSH_BUDGET_RELEVANT_MAX = "4";
  check("…1 is accepted; PUSH_BUDGET_RELEVANT_MAX sets the relevant cap", budget.caps().broadcast === 1 && budget.caps().relevant === 4);
  delete process.env.PUSH_BUDGET_BROADCAST_MAX; delete process.env.PUSH_BUDGET_RELEVANT_MAX;
  const updateOne = PushBudget.updateOne;
  PushBudget.updateOne = async () => { throw new Error("db down"); };
  r = await sendToUser(A, "x", "", { type: "Promotion", notificationType: "Promotion" });
  PushBudget.updateOne = updateOne;
  check("a budget error never blocks a push", r.sent === true);
  quietNow = false;
  r = await gateway.send(A, { type: "admin_test", title: "t", body: "b", skipCaps: true });
  check("admin test pushes (skipCaps): exempt, as before", r.sent === true);
  delete process.env.FLAG_PUSH_BUDGET_V1;
  check("the flag: grantable to students, off by default", reqS("./config/featureFlags").FLAGS.pushBudgetV1.grant.roles.includes("student") && budget.onFor({ _id: A, role: "student" }) === false);

  const failed = results.filter((x) => !x).length;
  quiet.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { quiet.error(e); process.exit(1); });
