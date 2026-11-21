// scripts/count-account-status.js
// READ ONLY (plan P0-6). Before FLAG_ACCOUNT_STATUS_ENFORCE is switched on, shows who it would lock out: accounts whose
// accountStatus is "suspended" or "banned", counted by role, split into suspensions still running and suspensions
// whose suspensionExpiry has passed (enforcement treats those as active again), plus every ADMIN among them by id
// and name (admins are never locked out by the flag, but the owner should know). "deactivated" and isBlocked are
// counted for information only; the flag doesn't act on them.
//
// It never writes, never prints MONGO_URI (only host and database), and prints no e-mail or phone number.
//   MONGO_URI=<the database> node scripts/count-account-status.js
// (run by the owner; with a .env in the server folder, dotenv reads MONGO_URI from it as the server does)
const mongoose = require("mongoose");

const LOCK = ["suspended", "banned"];

/** The counts, read only. User: the mongoose model. now: Date. */
async function count(User, now = new Date()) {
  const rows = await User.find({ accountStatus: { $in: LOCK } }).select("_id role name accountStatus suspensionExpiry").lean();
  const byRole = {};
  const admins = [];
  let running = 0; let expired = 0; let banned = 0;
  for (const u of rows) {
    const role = u.role || "student";
    byRole[role] = byRole[role] || { suspended: 0, suspendedExpired: 0, banned: 0 };
    if (u.accountStatus === "banned") { byRole[role].banned++; banned++; }
    else if (u.suspensionExpiry && new Date(u.suspensionExpiry) <= now) { byRole[role].suspendedExpired++; expired++; }
    else { byRole[role].suspended++; running++; }
    if (role === "admin") admins.push({ id: String(u._id), name: u.name || "", accountStatus: u.accountStatus });
  }
  const deactivated = await User.countDocuments({ accountStatus: "deactivated" });
  const isBlocked = await User.countDocuments({ isBlocked: true });
  return {
    wouldBeLockedOut: running + banned - countAdminsLocked(rows, now),
    suspendedRunning: running,
    suspendedExpired: expired,
    banned,
    byRole,
    admins,
    infoOnly: { deactivated, isBlocked },
  };
}

// admins are exempt: they're not locked out even when suspended / banned
function countAdminsLocked(rows, now) {
  return rows.filter((u) => (u.role === "admin") && (u.accountStatus === "banned" || !u.suspensionExpiry || new Date(u.suspensionExpiry) > now)).length;
}

async function main() {
  require("dotenv").config();
  if (!process.env.MONGO_URI) { console.error("Refusing to run: MONGO_URI is not set."); process.exit(1); }
  const where = (() => { try { const u = new URL(process.env.MONGO_URI); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable MONGO_URI)"; } })();
  console.log(`database: ${where} (read only)`);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const r = await count(require("../models/User"));
    console.log(`would be locked out if the flag were on (admins excluded): ${r.wouldBeLockedOut}`);
    console.log(`  suspended, still running: ${r.suspendedRunning}`);
    console.log(`  suspended, expiry passed (treated as active): ${r.suspendedExpired}`);
    console.log(`  banned: ${r.banned}`);
    console.log("by role:");
    for (const [role, c] of Object.entries(r.byRole)) console.log(`  ${role}: suspended ${c.suspended}, expired ${c.suspendedExpired}, banned ${c.banned}`);
    console.log(`admins among them (never locked out): ${r.admins.length}`);
    for (const a of r.admins) console.log(`  ${a.id}  ${a.name}  (${a.accountStatus})`);
    console.log(`for information (not acted on): deactivated ${r.infoOnly.deactivated}, isBlocked ${r.infoOnly.isBlocked}`);
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(`failed: ${e.name}`); process.exit(1); });

module.exports = { count, LOCK };
