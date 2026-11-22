// scripts/count-admins.js
// READ ONLY (owner, before Phase A). How many admin accounts exist, when each was created, when it was last active
// (if known), and whether it is listed in SUPER_ADMIN_IDS (SEC-2). Login times are not recorded yet: Phase A's admin
// session record adds them. Prints account ids (needed to fill SUPER_ADMIN_IDS), never names, e-mails, phones or
// MONGO_URI (host and database only). Never writes.
//   MONGO_URI=<the database> node scripts/count-admins.js
const mongoose = require("mongoose");

/** models: { User, EngagementProfile } → { total, admins: [{ id, createdAt, lastActiveAt, status, superAdmin }] } */
async function count({ User, EngagementProfile }, superIds = new Set()) {
  const admins = await User.find({ role: "admin" }).select("_id createdAt accountStatus").sort({ createdAt: 1 }).lean();
  const profiles = await EngagementProfile.find({ user: { $in: admins.map((a) => a._id) } }).select("user stats.lastActiveAt").lean();
  const lastActive = new Map(profiles.map((p) => [String(p.user), p.stats?.lastActiveAt || null]));
  return {
    total: admins.length,
    admins: admins.map((a) => ({
      id: String(a._id),
      createdAt: a.createdAt || null,
      lastActiveAt: lastActive.get(String(a._id)) || null,
      status: a.accountStatus || "active",
      superAdmin: superIds.has(String(a._id).toLowerCase()),
    })),
  };
}

async function main() {
  require("dotenv").config();
  if (!process.env.MONGO_URI) { console.error("Refusing to run: MONGO_URI is not set."); process.exit(1); }
  const where = (() => { try { const u = new URL(process.env.MONGO_URI); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable MONGO_URI)"; } })();
  console.log(`database: ${where} (read only)`);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const r = await count({ User: require("../models/User"), EngagementProfile: require("../models/EngagementProfile") }, require("../services/superAdmin").ids());
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "unknown");
    console.log(`admin accounts: ${r.total} (login times are not recorded yet; "last active" is app activity, if any)`);
    for (const a of r.admins) console.log(`  ${a.id}  created ${day(a.createdAt)}  last active ${day(a.lastActiveAt)}  ${a.status}${a.superAdmin ? "  SUPER_ADMIN_IDS" : ""}`);
    console.log(`in SUPER_ADMIN_IDS: ${r.admins.filter((a) => a.superAdmin).length}`);
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(`failed: ${e.name}`); process.exit(1); });

module.exports = { count };
