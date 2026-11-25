// N-7 push copy that names the specific thing, real numbers only (flag pushCopyV2, per student; upgrade/phase-n):
//   copy.fillV2: never a "{placeholder}" left in a push; a variant needs every value it names (numbers above 0);
//     the generic variants (a friend joined without the name, a deal without the brand) are gone; win-back uses real
//     counts; the daily drop names itself; nothing specific and real → null
//   gateway.sendFromCopy: flag on → the v2 copy, or no push ('no_specific_copy'); off → today's copy
//   the admin win-back nudge: nothing without the flag; the route finds inactivity.js (the shadowing empty file is gone)
//   inactivity win-back: real days / deals / campus confessions since the last visit; "exclusive offer" = the best
//     live offer with its real brand and discount (none → no push), tapping opens it
//   node tests/push-copy/run.js [serverDir]
const fs = require("fs");
const path = require("path");
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
reqS("./utils/karachiTime").isQuietHour = () => false;
const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true });
const quiet = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };

const User = reqS("./models/User");
const EngagementProfile = reqS("./models/EngagementProfile");
const Offer = reqS("./models/Offer");
const Confession = reqS("./models/Confession");
reqS("./models/University");
const copy = reqS("./services/engagement/copy");
const gateway = reqS("./services/engagement/pushGateway");
const inactivity = reqS("./services/engagement/inactivity"); // the same path the admin route uses

const oid = () => new mongoose.Types.ObjectId();
const U1 = oid(); const A = oid(); const BR = oid();
const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600e3);
fake.seed(User.collection.collectionName, [
  { _id: A, name: "Aisha Student", email: "a@test.local", role: "student", status: "Verified", accountStatus: "active", university: U1, pushTokens: [{ token: "ExponentPushToken[a]", channels: "snd_v2" }], createdAt: new Date() },
  { _id: BR, name: "Cafe X", brandName: "Cafe X", email: "x@test.local", role: "brand", status: "Verified", accountStatus: "active", createdAt: new Date() },
]);
fake.seed(EngagementProfile.collection.collectionName, [{ _id: oid(), user: A, notifPrefs: {}, stats: { lastActiveAt: daysAgo(10) } }]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  (" + detail + ")" : ""}`); };
const last = () => (expo.requests[expo.requests.length - 1] || [])[0];
const reset = () => EngagementProfile.updateMany({}, { $set: { push: {} } });

(async () => {
  quiet.log("-- copy.fillV2");
  const keys = Object.keys(copy.BANK);
  let leaks = [];
  for (const k of keys) for (let i = 0; i < 10; i++) { const r = copy.fillV2(k, {}, `u${i}`); if (r && /\{\w+\}/.test(r.body)) leaks.push(`${k}: ${r.body}`); }
  check("no copy type ever leaves a '{placeholder}' in a push (no values given)", leaks.length === 0, leaks.slice(0, 3).join(" | "));
  check("today's copy (flag off) still can: win-back '{n} deals' with the days as the number (why N-7 exists)", copy.BANK.win_back_soft.variants.some((v) => v.includes("{n} deals")));
  check("every v2 variant names something (has a placeholder)", Object.values(copy.BANK_V2).flat().every((v) => /\{\w+\}/.test(v)));
  const ref = Array.from({ length: 12 }, (_, i) => copy.fillV2("referral_joined", { friend_name: "Ali" }, `r${i}`).body);
  check("a friend joined: always with the name", ref.every((b) => b.includes("Ali")), ref.join(" | "));
  check("a deal nearby: always with the brand and the discount", copy.fillV2("nearby_deal", { brand: "Cafe X", discount: 30 }, "n").body.includes("Cafe X") && copy.fillV2("nearby_deal", { brand: "Cafe X" }, "n") === null);
  check("win-back: only real counts above 0; nothing → null", copy.fillV2("win_back_soft", { deals: 0, confessions: 4 }, "w").body === "4 new confessions at your campus since you left." && copy.fillV2("win_back_soft", { n: 3, deals: 0, confessions: 0 }, "w") === null);
  check("the daily drop names itself; without a title → null", copy.fillV2("daily_drop", { title: "free coffee at cafe x" }, "d").body === "today's drop: free coffee at cafe x" && copy.fillV2("daily_drop", {}, "d") === null);
  check("a type without v2 variants keeps its own, minus those missing a value", copy.fillV2("streak_milestone", { count: 5 }, "s").body === "your 5 day streak. respect." && copy.fillV2("streak_milestone", {}, "s") === null && copy.fillV2("card_sorted", {}, "s").body === "sorted.");

  quiet.log("-- the admin win-back nudge (owner, Phase N sign-off)");
  check("the empty extensionless file that shadowed inactivity.js is gone: the admin route's require finds sendWinBack", !fs.existsSync(path.join(SERVER, "services", "engagement", "inactivity")) && typeof inactivity.sendWinBack === "function");
  for (const days of [4, 10, 20, 40]) {
    const before = expo.requests.length;
    const w = await inactivity.sendWinBack(A, days);
    check(`pushCopyV2 off: the nudge (${days} days) sends nothing (no made-up numbers)`, w.sent === false && w.reason === "push_copy_v2_off" && expo.requests.length === before, JSON.stringify(w));
  }

  quiet.log("-- the gateway");
  let r = await gateway.sendFromCopy(A, "win_back_soft", null, { n: 3 }, { route: "Home" });
  check("flag off: today's copy goes out (as before)", r.sent === true && /deals dropped|minute|campus moved on|confessions happened/.test(last().body), last()?.body);
  await reset();
  process.env.FLAG_PUSH_COPY_V2 = `ids:${A}`;
  r = await gateway.sendFromCopy(A, "win_back_soft", null, { n: 3 }, { route: "Home" });
  check("flag on, nothing real to say: no push ('no_specific_copy')", r.sent === false && r.reason === "no_specific_copy");
  r = await gateway.sendFromCopy(A, "referral_joined", "social", { friend_name: "Ali" }, { route: "Points" });
  check("flag on: the specific copy goes out", r.sent === true && last().body.includes("Ali"), last()?.body);
  await reset();

  quiet.log("-- win-back with real facts");
  fake.seed(Offer.collection.collectionName, [
    { _id: oid(), title: "coffee", category: "Cafe & Coffee", discountPercentage: 30, brand: BR, status: "active", createdAt: daysAgo(2) },
    { _id: oid(), title: "old", category: "Cafe & Coffee", discountPercentage: 50, brand: BR, status: "archived", createdAt: daysAgo(2) },
    { _id: oid(), title: "before", category: "Cafe & Coffee", discountPercentage: 10, brand: BR, createdAt: daysAgo(20) },
  ]);
  fake.seed(Confession.collection.collectionName, [{ _id: oid(), text: "c1", university: U1, createdAt: daysAgo(1) }, { _id: oid(), text: "c2", university: U1, createdAt: daysAgo(1), status: "pending" }, { _id: oid(), text: "c3", university: oid(), createdAt: daysAgo(1) }]);
  const facts = await inactivity.realFacts(A, 10, "win_back_soft");
  check("since the last visit (10 days ago): 1 live new deal (not the archived one, not older), 1 live confession at your campus", facts.days === 10 && facts.deals === 1 && facts.confessions === 1, JSON.stringify(facts));
  r = await inactivity.sendWinBack(A, 10);
  check("win-back (7–13 days → welcome back with real points): sent or skipped, never a made-up number", r.copyKey === "welcome_back" && (r.sent === false ? r.reason === "no_specific_copy" : !/\{|\b0 points/.test(last().body)), JSON.stringify(r));
  await reset();
  r = await inactivity.sendWinBack(A, 4);
  check("win-back (under 7 days): a real count ('1 new deals…' or '1 new confessions…')", r.sent === true && /^1 new (deals since you were last here|confessions at your campus since you left)\.$/.test(last().body), last()?.body);
  await reset();
  r = await inactivity.sendWinBack(A, 20);
  check("'exclusive offer' (14+ days): the best live offer, its real brand and discount; tapping opens it", r.sent === true && last().body === "Cafe X: 30% off right now. claim in 1 tap." && last().data.route === "OfferScreen", `${last()?.body} ${JSON.stringify(last()?.data)}`);
  await reset();
  await Offer.updateMany({}, { $set: { status: "archived" } });
  r = await inactivity.sendWinBack(A, 20);
  check("…no live offer: no push (never a made-up 'tdc · 20% off')", r.sent === false && r.reason === "no_specific_copy");
  delete process.env.FLAG_PUSH_COPY_V2;

  quiet.log("-- the daily drop");
  const src = ["services/engagement/schedular.js", "services/engagement/pushGateway.js"].map((f) => fs.readFileSync(path.join(SERVER, f), "utf8"));
  check("both daily-drop senders pass the drop's title (used only by the v2 copy)", /sendFromCopy\(c\.user, 'daily_drop', 'dailyDrop', \{ title: drop\.title \}/.test(src[0]) && /'dailyDrop',\s*\n\s*\{ title: drop\.title \},/.test(src[1]));

  const failed = results.filter((x) => !x).length;
  quiet.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { quiet.error(e); process.exit(1); });
