// pushGateway.send for an account without an engagement profile (older accounts): the default profile is made, the
// same as signup (engine.ensureProfile), and the push goes on; existing profiles are unchanged; caps, quiet hours and
// opt-outs still apply; no profile for an account that doesn't exist, and none for admin / system pushes (skipCaps).
//   node tests/push-gateway-profile/run.js [serverDir]
// Real gateway, engine and models on a fake MongoDB; only the last step (Expo's send) and the clock's quiet hours
// are stubbed. No database, no network, no .env.
const path = require("path");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

class Expo {
  static isExpoPushToken(t) { return /^ExponentPushToken\[.+\]$/.test(String(t)); }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const sentToExpo = [];
let quiet = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("utils", "pushNotification.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, sendAllSafe: async (_x, messages) => { sentToExpo.push(...messages); return messages.map((_, i) => ({ status: "ok", id: `t${sentToExpo.length}-${i}` })); }, handleTickets: async () => {} };
  }
  if (resolved.endsWith(path.join("utils", "karachiTime.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, isQuietHour: () => quiet };
  }
  return origLoad.apply(this, arguments);
};

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "EngagementProfile", "PushLog"]) reqS(`./models/${m}`);
const gateway = reqS("./services/engagement/pushGateway");

const oid = () => new mongoose.Types.ObjectId();
const ids = { NEW: oid(), NEW2: oid(), NEW3: oid(), OLD: oid(), OPTOUT: oid(), ADMINPUSH: oid(), GHOST: oid() };
const tokenOf = (k) => `ExponentPushToken[${k}]`;
const user = (k, extra = {}) => ({ _id: ids[k], name: k, email: `${k}@test.local`, role: "student", pushTokens: [{ token: tokenOf(k), platform: "android", channels: "snd_v2", updatedAt: new Date() }], createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), ["NEW", "NEW2", "NEW3", "OLD", "OPTOUT", "ADMINPUSH"].map((k) => user(k)));
// existing profiles, with values the defaults would never set
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: ids.OLD, level: { id: "regular", tiersIssued: ["regular"] }, points: { balance: 50, lifetime: 120, lifetimeReferral: 0 }, streak: { count: 7, best: 9, freezesLeft: 0 }, notifPrefs: { deals: true, jobsScholarships: true }, push: {} },
  { _id: oid(), user: ids.OPTOUT, level: { id: "member" }, points: { balance: 0 }, streak: { count: 0, best: 0, freezesLeft: 1 }, notifPrefs: { deals: false, jobsScholarships: true }, push: {} },
]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  (" + detail + ")" : ""}`); };
const rows = (f) => (fake.STORE.get(coll("EngagementProfile")) || []).filter(f);
const profileOf = (k) => rows((p) => String(p.user) === String(ids[k]));
const msg = (over = {}) => ({ type: "nearby_deal", pref: "deals", title: "New box", body: "A Surprise Box near you", data: {}, ...over });

(async () => {
  console.log("── 1. no profile: the default one is made and the push goes");
  let n = sentToExpo.length;
  let r = await gateway.send(ids.NEW, msg());
  const p = profileOf("NEW");
  check("a student with no profile gets the push", r.sent === true && sentToExpo.length === n + 1 && sentToExpo[n].to === tokenOf("NEW"), JSON.stringify(r));
  check("…exactly one profile was made", p.length === 1);
  check("…with the signup defaults (member, 0 points, 1 streak freeze, every notification on)", p[0]?.level?.id === "member" && p[0].points.balance === 0 && p[0].streak.freezesLeft === 1 && p[0].notifPrefs.deals === true && p[0].notifPrefs.jobsScholarships === true, JSON.stringify({ level: p[0]?.level, points: p[0]?.points, streak: p[0]?.streak, prefs: p[0]?.notifPrefs }));
  check("…and the push was counted on it (the marketing cap)", p[0]?.push?.lastPushDay && p[0].push.sentThisWeek === 1, JSON.stringify(p[0]?.push));

  console.log("── 2. caps, quiet hours and opt-outs still apply");
  n = sentToExpo.length;
  r = await gateway.send(ids.NEW, msg());
  check("a second marketing push the same day → daily_cap, nothing sent", r.sent === false && r.reason === "daily_cap" && sentToExpo.length === n, JSON.stringify(r));
  quiet = true;
  r = await gateway.send(ids.NEW2, msg());
  check("no profile, quiet hours → quiet_hours, nothing sent", r.sent === false && r.reason === "quiet_hours" && sentToExpo.length === n, JSON.stringify(r));
  check("…the default profile exists for next time (one)", profileOf("NEW2").length === 1);
  quiet = false;
  r = await gateway.send(ids.OPTOUT, msg());
  check("an existing profile with deals off → pref_off, nothing sent", r.sent === false && r.reason === "pref_off" && sentToExpo.length === n, JSON.stringify(r));
  r = await gateway.send(ids.NEW3, msg({ essential: true }));
  const p3 = profileOf("NEW3")[0];
  check("an essential push (order ready) to a student with no profile: sent, and doesn't use the marketing cap", r.sent === true && !p3?.push?.lastPushDay && !(p3?.push?.sentThisWeek > 0), JSON.stringify(p3?.push));
  r = await gateway.send(ids.NEW3, msg());
  check("…a marketing push the same day still goes (the essential one didn't count)", r.sent === true, JSON.stringify(r));

  console.log("── 3. existing profiles unchanged; nothing made where it shouldn't be");
  const before = JSON.stringify(profileOf("OLD")[0]);
  r = await gateway.send(ids.OLD, msg());
  const after = profileOf("OLD")[0];
  check("an existing profile: sent, and only its push counters changed", r.sent === true && profileOf("OLD").length === 1 && after.level.id === "regular" && after.points.balance === 50 && after.streak.count === 7 && after.streak.freezesLeft === 0, JSON.stringify(after));
  // (push counters and updatedAt change on every sent push, as they always did)
  check("…the rest of it the same (everything but the push counters and updatedAt)", JSON.stringify({ ...after, push: undefined, updatedAt: undefined }) === JSON.stringify({ ...JSON.parse(before), push: undefined, updatedAt: undefined }));
  r = await gateway.send(ids.GHOST, msg());
  check("an account that doesn't exist → no_user, no profile made", r.sent === false && r.reason === "no_user" && profileOf("GHOST").length === 0, JSON.stringify(r));
  r = await gateway.send(ids.ADMINPUSH, msg({ skipCaps: true }));
  check("an admin / system push (skipCaps) still needs no profile and makes none", r.sent === true && profileOf("ADMINPUSH").length === 0, JSON.stringify(r));
  check("one profile per account in total (no duplicates)", new Set(rows(() => true).map((x) => String(x.user))).size === rows(() => true).length);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
