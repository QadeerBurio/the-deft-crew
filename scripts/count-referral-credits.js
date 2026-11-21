// scripts/count-referral-credits.js
// READ ONLY (P1 follow-up). Were referral points credited? For every student who joined with a code it checks the
// points ledger for the three awards the live system pays (routes/auth.routes.js at signup; services/engagement/
// referral.js later uses the same keys, so it never pays twice):
//   referrer +50   'referral:signup_bonus'   idemKey referral_signup_bonus:<referee>
//   referrer +100  'referral:verified'       idemKey referral:verified:referrer:<referrer>:<referee>
//   referee  +100  'referral:welcome'        idemKey referral:welcome:<referee>
// points.award saves the balance first and then writes the ledger row, so a ledger row means the balance was credited.
// It prints: how many referred students; missing awards per type (students, points), by month of signup; the
// earliest and latest signup with something missing; how many referred students never verified their e-mail but were
// paid anyway (a farming risk); and the referral events actually stored (they were rejected: source 'system').
// It never writes, never prints MONGO_URI (host and database only), names, e-mails or phone numbers.
//   MONGO_URI=<the database> node scripts/count-referral-credits.js
const mongoose = require("mongoose");

const AWARDS = [
  { type: "referrer +50 (signup bonus)", reason: "referral:signup_bonus", points: 50, key: (r, ref) => `referral_signup_bonus:${ref}` },
  { type: "referrer +100 (verified)", reason: "referral:verified", points: 100, key: (r, ref) => `referral:verified:referrer:${r}:${ref}` },
  { type: "referee +100 (welcome)", reason: "referral:welcome", points: 100, key: (r, ref) => `referral:welcome:${ref}` },
];
const monthOf = (d) => (d ? new Date(d).toISOString().slice(0, 7) : "unknown");

/** The counts. models: { User, PointsLedger, EngagementEvent } */
async function count({ User, PointsLedger, EngagementEvent }) {
  const referees = await User.find({ referredBy: { $exists: true, $ne: null } }).select("_id referredBy createdAt emailVerified").lean();
  const ledger = await PointsLedger.find({ reason: { $in: AWARDS.map((a) => a.reason) } }).select("idemKey dedupeKey").lean();
  const keys = new Set();
  for (const l of ledger) { if (l.idemKey) keys.add(l.idemKey); if (l.dedupeKey) keys.add(l.dedupeKey); }

  const missing = Object.fromEntries(AWARDS.map((a) => [a.type, { students: 0, points: 0 }]));
  const byMonth = {};
  let first = null; let last = null; let unverifiedPaid = 0;
  for (const u of referees) {
    if (!u.referredBy) continue;
    const r = String(u.referredBy); const id = String(u._id);
    let anyMissing = false; let anyPaid = false;
    for (const a of AWARDS) {
      if (keys.has(a.key(r, id))) { anyPaid = true; continue; }
      anyMissing = true;
      missing[a.type].students++; missing[a.type].points += a.points;
      const m = monthOf(u.createdAt);
      byMonth[m] = byMonth[m] || { students: 0, points: 0 };
      byMonth[m].points += a.points;
    }
    if (anyMissing) {
      byMonth[monthOf(u.createdAt)].students++;
      const t = u.createdAt ? new Date(u.createdAt) : null;
      if (t && (!first || t < first)) first = t;
      if (t && (!last || t > last)) last = t;
    }
    if (anyPaid && u.emailVerified === false) unverifiedPaid++;
  }
  const events = {};
  for (const name of ["referral_signup_bonus", "referral_credited"]) events[name] = await EngagementEvent.countDocuments({ name });
  const totalMissingPoints = Object.values(missing).reduce((s, x) => s + x.points, 0);
  return { referredStudents: referees.filter((u) => u.referredBy).length, missing, totalMissingPoints, byMonth, firstMissing: first, lastMissing: last, unverifiedPaid, eventsStored: events };
}

async function main() {
  require("dotenv").config();
  if (!process.env.MONGO_URI) { console.error("Refusing to run: MONGO_URI is not set."); process.exit(1); }
  const where = (() => { try { const u = new URL(process.env.MONGO_URI); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable MONGO_URI)"; } })();
  console.log(`database: ${where} (read only)`);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const r = await count({ User: require("../models/User"), PointsLedger: require("../models/PointsLedger"), EngagementEvent: require("../models/EngagementEvent") });
    console.log(`students who joined with a code: ${r.referredStudents}`);
    for (const [t, x] of Object.entries(r.missing)) console.log(`  missing ${t}: ${x.students} students, ${x.points} points`);
    console.log(`points missing in all: ${r.totalMissingPoints}`);
    if (r.totalMissingPoints) {
      console.log(`  first / last signup with something missing: ${r.firstMissing?.toISOString().slice(0, 10)} / ${r.lastMissing?.toISOString().slice(0, 10)}`);
      for (const [m, x] of Object.entries(r.byMonth).sort()) console.log(`  ${m}: ${x.students} students, ${x.points} points`);
    }
    console.log(`paid although the new student never verified their e-mail: ${r.unverifiedPaid}`);
    console.log(`referral events stored: referral_signup_bonus ${r.eventsStored.referral_signup_bonus}, referral_credited ${r.eventsStored.referral_credited}`);
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(`failed: ${e.name}`); process.exit(1); });

module.exports = { count, AWARDS };
