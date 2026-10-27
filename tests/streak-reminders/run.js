// Streak reminders: the 20:00 "expires tonight" warning and the 20:30 "ended last night" reminder.
//   node tests/streak-reminders/run.js [serverDir]
// Real models, streak engine, copy bank, push gateway and scheduler; only MongoDB (the in-memory layer from
// tests/hide-user-secrets/fake-mongo.js), Expo and node-cron are replaced. No database, no network, no .env.
const path = require("path");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));

// ---------- stubs (before any server file loads) ----------
const pushes = [];
const crons = [];
let QUIET = false; // quiet hours are switched on and off by the tests, not by the clock
class Expo {
  constructor() {}
  static isExpoPushToken(t) { return typeof t === "string" && t.startsWith("ExponentPushToken["); }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { pushes.push(...ms); return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  if (request === "node-cron") return { schedule: (expr, fn, opts) => { crons.push({ expr, fn, tz: opts?.timezone }); return { stop() {} }; } };
  const loaded = origLoad.apply(this, arguments);
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "karachiTime.js"))) return { ...loaded, isQuietHour: () => QUIET };
  return loaded;
};

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const { ObjectId } = mongoose.Types;

const EngagementProfile = reqS("./models/EngagementProfile");
const User = reqS("./models/User");
const streakSvc = reqS("./services/engagement/streak");
const streakExpiry = reqS("./services/engagement/streakExpiry");
const pushGateway = reqS("./services/engagement/pushGateway");
const copy = reqS("./services/engagement/copy");
const { dayKey, yesterday } = reqS("./utils/karachiTime");

// ---------- tiny runner ----------
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

const today = dayKey();
const yday = yesterday(today);
const token = (n) => `ExponentPushToken[test-${n}]`;
async function person(name, streak, extra = {}) {
  const u = await User.create({ name, email: `${name}@test.local`, password: "x", role: "student", pushTokens: [{ token: token(name), platform: "android" }] });
  await EngagementProfile.create({ user: u._id, streak, notifPrefs: { streaks: true, dailyDrop: true }, ...extra });
  return String(u._id);
}
const pushesTo = (name) => pushes.filter((m) => m.to === token(name));
const profileOf = async (uid) => EngagementProfile.findOne({ user: uid }).lean();

(async () => {
  // ---------- rollover keeps the broken streak's length ----------
  const p = { streak: { count: 9, best: 9, lastActionDay: yesterday(yday), freezesLeft: 0 } };
  const r = streakSvc.rollover(p, today);
  check("rollover: a missed day with no freeze breaks the streak", r.action === "broke" && p.streak.count === 0);
  check("rollover: the broken streak's length is kept as brokenCount", p.streak.brokenCount === 9, `brokenCount=${p.streak.brokenCount}`);
  const revived = streakSvc.applyAction(p.streak, today).streak;
  check("acting again clears brokenAt and brokenCount", revived.brokenAt === null && revived.brokenCount === 0 && revived.count === 1);

  // ---------- 20:00 warning ----------
  const ids = {
    atRisk: await person("atrisk", { count: 5, lastActionDay: yday, freezesLeft: 1 }),
    capped: await person("capped", { count: 3, lastActionDay: yday, freezesLeft: 0 }, { push: { lastPushDay: today, weekKey: "x", sentThisWeek: 99 } }),
    doneToday: await person("donetoday", { count: 7, lastActionDay: today }),
    noStreak: await person("nostreak", { count: 0, lastActionDay: null }),
    exam: await person("exam", { count: 4, lastActionDay: yday, examModeUntil: today }),
    oldBreak: await person("oldbreak", { count: 2, lastActionDay: yesterday(yday) }),
    prefOff: await person("prefoff", { count: 6, lastActionDay: yday }),
  };
  await EngagementProfile.updateOne({ user: ids.prefOff }, { $set: { "notifPrefs.streaks": false } });

  const w = await streakExpiry.sendStreakExpiryWarnings(today);
  check("warning: a user who has not acted today is warned", pushesTo("atrisk").length === 1);
  check("warning: the 19:00 drop / weekly cap does not block it (essential)", pushesTo("capped").length === 1);
  check("warning: a user who already acted today is not warned", pushesTo("donetoday").length === 0);
  check("warning: no streak, no warning", pushesTo("nostreak").length === 0);
  check("warning: exam mode is not warned", pushesTo("exam").length === 0);
  check("warning: a streak that already broke is not warned", pushesTo("oldbreak").length === 0);
  check("warning: the streaks setting off is respected", pushesTo("prefoff").length === 0);
  check("warning: totals", w.total === 3 && w.sent === 2 && w.skipped === 1, JSON.stringify({ sent: w.sent, skipped: w.skipped, total: w.total }));
  const m = pushesTo("atrisk")[0] || {};
  check("warning: body names the streak and midnight", /5/.test(m.body) && /midnight|12/.test(m.body), m.body);
  check("warning: type and tap route", m.data?.type === "streak_warning" && m.data?.route === "Home", JSON.stringify({ type: m.data?.type, route: m.data?.route }));
  const pa = await profileOf(ids.atRisk);
  check("warning: does not use up the user's daily or weekly cap", !pa.push?.lastPushDay && !(pa.push?.sentThisWeek > 0), JSON.stringify(pa.push || {}));
  const pc = await profileOf(ids.capped);
  check("warning: a capped user's counters are left as they were", pc.push.sentThisWeek === 99 && pc.push.lastPushDay === today);

  // quiet hours still apply
  QUIET = true;
  const before = pushes.length;
  await streakExpiry.sendStreakExpiryWarnings(today);
  QUIET = false;
  check("warning: nothing goes out in quiet hours", pushes.length === before);

  // ordinary pushes are still capped
  const dd = await pushGateway.sendFromCopy(ids.capped, "daily_drop", "dailyDrop", {}, {});
  check("other pushes: the daily cap still applies to non-essential pushes", dd.sent === false && dd.reason === "daily_cap", dd.reason);

  // ---------- 20:30 the day after ----------
  const brokeAt = new Date(`${today}T00:05:00+05:00`);
  const lids = {
    lapsed: await person("lapsed", { count: 0, lastActionDay: null, brokenAt: brokeAt, brokenCount: 12 }),
    lapsedCapped: await person("lapsedcapped", { count: 0, lastActionDay: null, brokenAt: brokeAt, brokenCount: 3 }, { push: { lastPushDay: today, sentThisWeek: 99, weekKey: "x" } }),
    brokeYesterday: await person("brokeyesterday", { count: 0, lastActionDay: null, brokenAt: new Date(`${yday}T00:05:00+05:00`), brokenCount: 4 }),
    restarted: await person("restarted", { count: 1, lastActionDay: today, brokenAt: null, brokenCount: 0 }),
    unknownCount: await person("unknowncount", { count: 0, lastActionDay: null, brokenAt: brokeAt, brokenCount: 0 }),
  };
  const l = await streakExpiry.sendStreakLapsedReminders(today);
  check("day after: a streak that broke last night gets a reminder", pushesTo("lapsed").length === 1);
  check("day after: caps do not block it", pushesTo("lapsedcapped").length === 1);
  check("day after: a streak that broke the night before is not reminded again", pushesTo("brokeyesterday").length === 0);
  check("day after: a user who already started again today is skipped", pushesTo("restarted").length === 0);
  check("day after: a break with no recorded length is skipped", pushesTo("unknowncount").length === 0);
  const lm = pushesTo("lapsed")[0] || {};
  check("day after: body names the lost streak", /12/.test(lm.body) && /today|reload/.test(lm.body), lm.body);
  check("day after: type and tap route", lm.data?.type === "streak_broken" && lm.data?.route === "Home");
  check("day after: totals", l.total === 2 && l.sent === 2, JSON.stringify({ sent: l.sent, total: l.total }));

  // ---------- a 1-day streak gets its own line ----------
  await person("oneday", { count: 1, lastActionDay: yday, freezesLeft: 0 });
  await person("onedaybroke", { count: 0, lastActionDay: null, brokenAt: brokeAt, brokenCount: 1 });
  await streakExpiry.sendStreakExpiryWarnings(today);
  await streakExpiry.sendStreakLapsedReminders(today);
  const one = pushesTo("oneday")[0] || {};
  const oneBroke = pushesTo("onedaybroke")[0] || {};
  check("1-day warning: 'your streak ends at midnight. one tap keeps it.'", one.body === "your streak ends at midnight. one tap keeps it.", one.body);
  check("1-day warning: still a streak_warning push", one.data?.type === "streak_warning");
  check("1-day day after: 'your streak ended last night. start a new one today.'", oneBroke.body === "your streak ended last night. start a new one today.", oneBroke.body);
  check("1-day day after: still a streak_broken push", oneBroke.data?.type === "streak_broken");
  check("2 days and up keep the n-day copy", /5/.test((pushesTo("atrisk")[0] || {}).body) && /12/.test((pushesTo("lapsed")[0] || {}).body));

  // ---------- 10:00 freeze notice ----------
  const fp = { streak: { count: 6, best: 6, lastActionDay: yesterday(yday), freezesLeft: 1 } };
  const fr = streakSvc.rollover(fp, today);
  check("rollover: a freeze saves the streak and records frozenAt", fr.action === "froze" && fp.streak.count === 6 && fp.streak.frozenAt instanceof Date);
  const frozeAt = new Date(`${today}T00:05:00+05:00`);
  await person("frozen", { count: 6, lastActionDay: yday, freezesLeft: 0, frozenAt: frozeAt });
  await person("frozencapped", { count: 2, lastActionDay: yday, freezesLeft: 0, frozenAt: frozeAt }, { push: { lastPushDay: today, sentThisWeek: 99, weekKey: "x" } });
  await person("frozenyesterday", { count: 3, lastActionDay: yday, freezesLeft: 0, frozenAt: new Date(`${yday}T00:05:00+05:00`) });
  const frozenPrefOff = await person("frozenprefoff", { count: 4, lastActionDay: yday, freezesLeft: 0, frozenAt: frozeAt });
  await EngagementProfile.updateOne({ user: frozenPrefOff }, { $set: { "notifPrefs.streaks": false } });
  QUIET = true;
  const quietBefore = pushes.length;
  await streakExpiry.sendFreezeUsedNotices(today);
  QUIET = false;
  check("freeze notice: nothing goes out in quiet hours", pushes.length === quietBefore);
  const fz = await streakExpiry.sendFreezeUsedNotices(today);
  const fm = pushesTo("frozen")[0] || {};
  check("freeze notice: a streak saved by a freeze last night gets it", pushesTo("frozen").length === 1 && /6/.test(fm.body), fm.body);
  check("freeze notice: caps do not block it", pushesTo("frozencapped").length === 1);
  check("freeze notice: a freeze from the night before is not repeated", pushesTo("frozenyesterday").length === 0);
  check("freeze notice: the streaks setting off is respected", pushesTo("frozenprefoff").length === 0);
  check("freeze notice: type and tap route", fm.data?.type === "freeze_used" && fm.data?.route === "Home");
  check("freeze notice: totals", fz.total === 3 && fz.sent === 2, JSON.stringify({ sent: fz.sent, total: fz.total }));

  // ---------- copy and schedule ----------
  const warnCopy = JSON.stringify(copy);
  const raw = require("fs").readFileSync(path.join(SERVER, "services", "engagement", "copy.js"), "utf8");
  const variantsOf = (type) => (raw.split(`  ${type}: {`)[1] || "").split("],")[0].split(/\r?\n/).map((x) => x.trim()).filter((x) => /^['"]/.test(x));
  const warnLines = variantsOf("streak_warning");
  check("copy: every warning line names the streak length and midnight", warnLines.length > 0 && warnLines.every((x) => /\{count\}/.test(x) && /midnight|12/.test(x)), `${warnLines.length} lines`);
  check("copy: every day-after line names the streak length, says it ended and points to today", variantsOf("streak_broken").every((x) => /{count}/.test(x) && /last night|missed a day|days gone/.test(x) && /today|reload/.test(x)));
  check("copy: no 'mins left' lines for a push sent four hours before midnight", !/mins? left|min countdown|11:58/.test(warnCopy.match(/streak_warning[^\]]*\]/)?.[0] || ""));
  reqS("./services/engagement/schedular").start();
  const exprs = crons.map((c) => c.expr);
  check("schedule: 20:00 warning registered", exprs.includes("0 20 * * *"));
  check("schedule: 20:30 day-after reminder registered", exprs.includes("30 20 * * *"));
  check("schedule: 10:00 freeze notice registered", exprs.includes("0 10 * * *"));
  check("schedule: all jobs run in Asia/Karachi", crons.every((c) => c.tz === "Asia/Karachi"), crons.map((c) => `${c.expr}@${c.tz}`).join(", "));

  // the 20:00 job and POST /streak/expiry-warnings/send share one send a day
  // MongoDB rejects a second document with the same _id (error 11000); the in-memory layer does not, so the
  // lock collection gets that one rule here
  const JobLock = reqS("./models/JobLock");
  const realCreate = JobLock.create.bind(JobLock);
  JobLock.create = async (doc) => {
    if (await JobLock.findOne({ _id: doc._id }).lean()) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
    return realCreate(doc);
  };
  await person("onceaday", { count: 3, lastActionDay: yday, freezesLeft: 0 });
  const warnJob = crons.find((c) => c.expr === "0 20 * * *");
  await warnJob.fn();
  const afterJob = pushesTo("onceaday").length;
  const viaRoute = await streakExpiry.sendStreakExpiryWarningsOnce(today);
  const viaRouteAgain = await streakExpiry.sendStreakExpiryWarningsOnce(today);
  await warnJob.fn();
  check("once a day: the 20:00 job warns", afterJob === 1, `${afterJob}`);
  check("once a day: the route after the job sends nothing", viaRoute.alreadySent === true && viaRoute.sent === 0);
  check("once a day: calling the route again sends nothing", viaRouteAgain.alreadySent === true);
  check("once a day: the user got exactly one warning", pushesTo("onceaday").length === 1, `${pushesTo("onceaday").length}`);

  // the 00:05 rollover itself sends no pushes any more (quiet hours dropped them); it still saves the change
  const roll = crons.find((c) => c.expr === "5 0 * * *");
  const rFreeze = await person("rollfreeze", { count: 8, lastActionDay: yesterday(yday), freezesLeft: 1 });
  const rBreak = await person("rollbreak", { count: 5, lastActionDay: yesterday(yday), freezesLeft: 0 });
  const rollBefore = pushes.length;
  // the in-memory layer has no Mongoose cursor: hand the job an async-iterable over the same query
  const realFind = EngagementProfile.find;
  EngagementProfile.find = function (...args) {
    const q = realFind.apply(this, args);
    q.cursor = function () { const docs = this.exec(); return { async *[Symbol.asyncIterator]() { for (const d of await docs) yield d; } }; };
    return q;
  };
  await roll.fn();
  EngagementProfile.find = realFind;
  const pf = await profileOf(rFreeze);
  const pb = await profileOf(rBreak);
  check("00:05 rollover: sends no pushes", pushes.length === rollBefore, `${pushes.length - rollBefore} sent`);
  check("00:05 rollover: a freeze is saved with frozenAt for the 10:00 notice", pf.streak.count === 8 && pf.streak.freezesLeft === 0 && !!pf.streak.frozenAt);
  check("00:05 rollover: a break is saved with brokenCount for the 20:30 reminder", pb.streak.count === 0 && pb.streak.brokenCount === 5 && !!pb.streak.brokenAt);

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
