// P1 follow-up: referral events are stored again, points unchanged (upgrade/p1-followups), on in-memory data.
//   The referral event log wrote source 'system', which EngagementEvent's enum ['server', 'client'] rejects; the error
//   was caught, so the points were paid but no 'referral_signup_bonus' / 'referral_credited' event was ever stored.
//   - services/engagement/referral.js: creditReferralOnSignup and creditReferral now store their event (source server)
//   - the awards are unchanged (+50 referrer; +100 referrer, +100 referee) and still paid once (idempotent)
//   - nothing writes source 'system' to EngagementEvent any more (routes/auth.routes.js signup too)
//   - scripts/count-referral-credits.js count(): read only; finds missing ledger awards, unverified-email paid referees
//   node tests/referral-events/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["EngagementEvent", "EngagementProfile", "PointsLedger"] });
const { check, oid, user, fake, coll, rows, reqS, SERVER } = h;

const referral = reqS("./services/engagement/referral");
const { count } = reqS("./scripts/count-referral-credits");
const EngagementEvent = reqS("./models/EngagementEvent");
const User = reqS("./models/User");
const PointsLedger = reqS("./models/PointsLedger");
const EngagementProfile = reqS("./models/EngagementProfile");

const A = oid(); const B = oid(); const C = oid(); const D = oid();
fake.seed(coll("User"), [
  user(A, "student", "Aisha Referrer", { referralCode: "AISHA1" }),
  user(B, "student", "Bilal Friend", { referredBy: A, emailVerified: true }),
  user(C, "student", "Chand NoCode"),
  user(D, "student", "Dua Unverified", { referredBy: A, emailVerified: false }),
]);
const bal = (id) => rows("EngagementProfile").find((p) => String(p.user) === String(id))?.points?.balance || 0;
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };

(async () => {
  const server = h.start();
  console.log("-- the schema");
  check("EngagementEvent source enum is unchanged (server, client)", JSON.stringify(EngagementEvent.schema.path("source").enumValues) === '["server","client"]');
  check("…'system' is still rejected (so nothing may write it)", !!new EngagementEvent({ user: A, name: "x", source: "system" }).validateSync());
  const writers = ["services/engagement/referral.js", "services/engagement/referralSignup.js", "routes/auth.routes.js"].filter((f) => /source:\s*['"]system['"]/.test(fs.readFileSync(path.join(SERVER, f), "utf8")));
  check("no source 'system' in referral.js, referralSignup.js or auth.routes.js", writers.length === 0, writers.join(", "));

  console.log("-- stage 1: signup bonus");
  let r = await quiet(referral.creditReferralOnSignup)(B);
  check("referrer +50, credited", r.credited === true && r.points === 50 && bal(A) === 50, JSON.stringify(r));
  let ev = rows("EngagementEvent").filter((e) => e.name === "referral_signup_bonus");
  check("…the event is stored: referrer, referee id, source server, dedupe key", ev.length === 1 && String(ev[0].user) === String(A) && ev[0].meta.refereeId === String(B) && ev[0].source === "server" && ev[0].dedupeKey === `referral_signup_bonus:${B}`, JSON.stringify(ev));
  r = await quiet(referral.creditReferralOnSignup)(B);
  check("…again: no second award, no second event", r.credited === false && bal(A) === 50 && rows("EngagementEvent").filter((e) => e.name === "referral_signup_bonus").length === 1);
  r = await quiet(referral.creditReferralOnSignup)(C);
  check("a student without a code: nothing", r.credited === false && r.reason === "no_referrer" && rows("EngagementEvent").length === 1);

  console.log("-- stage 2: verified");
  r = await quiet(referral.creditReferral)(B);
  check("referrer +100 and referee +100", bal(A) === 150 && bal(B) === 100, `${bal(A)} ${bal(B)}`);
  ev = rows("EngagementEvent").filter((e) => e.name === "referral_credited");
  check("…the event is stored with source server", ev.length === 1 && String(ev[0].user) === String(A) && ev[0].source === "server" && ev[0].meta.refereeId === String(B), JSON.stringify(ev));
  await quiet(referral.creditReferral)(B);
  check("…again: no double payment, one event", bal(A) === 150 && bal(B) === 100 && rows("EngagementEvent").filter((e) => e.name === "referral_credited").length === 1);
  const reasons = rows("PointsLedger").map((l) => `${l.reason}:${l.delta}`).sort();
  check("ledger: exactly the three live awards", JSON.stringify(reasons) === JSON.stringify(["referral:signup_bonus:50", "referral:verified:100", "referral:welcome:100"]), reasons.join(","));

  console.log("-- the count script (read only)");
  const all = () => JSON.stringify(["User", "PointsLedger", "EngagementProfile", "EngagementEvent"].map((m) => rows(m)));
  const before = all();
  const c = await count({ User, PointsLedger, EngagementEvent });
  check("2 referred students (B, D)", c.referredStudents === 2, JSON.stringify(c));
  check("B fully paid; D (never paid here) is missing all three: 250 points", c.totalMissingPoints === 250 && c.missing["referrer +50 (signup bonus)"].students === 1 && c.missing["referee +100 (welcome)"].points === 100, JSON.stringify(c.missing));
  check("…by month of signup", Object.values(c.byMonth).reduce((s, x) => s + x.students, 0) === 1);
  check("count() wrote nothing", all() === before);
  check("unverified-email referees who were paid: 0 here (D wasn't paid)", c.unverifiedPaid === 0);
  check("stored events counted", c.eventsStored.referral_signup_bonus === 1 && c.eventsStored.referral_credited === 1);
  await quiet(referral.creditReferralOnSignup)(D);
  const c2 = await count({ User, PointsLedger, EngagementEvent });
  check("once D's referrer is paid, D counts as unverified-but-paid and only 200 points are missing", c2.unverifiedPaid === 1 && c2.totalMissingPoints === 200, JSON.stringify(c2));
  const src = fs.readFileSync(path.join(SERVER, "scripts", "count-referral-credits.js"), "utf8");
  check("the script has no write calls and refuses without MONGO_URI", !/\.(save|create|insertMany|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|bulkWrite|replaceOne)\(/.test(src) && /Refusing to run: MONGO_URI is not set/.test(src));
  check("…and never prints the full MONGO_URI", !/console\.log\([^)]*process\.env\.MONGO_URI/.test(src));
  void EngagementProfile;
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
