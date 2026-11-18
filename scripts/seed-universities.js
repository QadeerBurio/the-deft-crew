// scripts/seed-universities.js — load the shared university list from seeds/universities-pk.json (HEC's recognised
// universities and degree awarding institutes; see the file's source / notes). Idempotent: run it again and nothing
// changes. Dry run by default: it prints what it would do. --apply writes.
//   node scripts/seed-universities.js            # dry run
//   node scripts/seed-universities.js --apply    # write
// What it does, per HEC entry:
//   - not in the database: added (approved, or hidden for a suspended institute)
//   - already there from an earlier seed run: aliases / HEC details added; an admin's edits (name, short name, city,
//     status) are kept
//   - an old signup entry with exactly this name (no status yet): it becomes this university (status + details);
//     its students stay where they are. Listed by name in the dry run.
// It never changes a user, an offer or a confession, and never deletes anything.
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "seeds", "universities-pk.json");

async function run({ apply = false, log = console.log } = {}) {
  const University = require("../models/University");
  const { keyOf, recount, bust } = require("../services/universities");
  const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
  const out = { add: [], adopt: [], update: [], unchanged: 0 };
  for (const s of seed.universities) {
    const existing = await University.findOne({ name: s.name });
    const hec = s.hec || {};
    if (!existing) {
      out.add.push(s.name);
      if (apply) await University.create({ name: s.name, shortName: s.shortName, city: s.city, province: s.province, sector: s.sector, aliases: s.aliases, key: keyOf(s.name), status: s.status, source: "seed", hec });
      continue;
    }
    if (!existing.status) {
      out.adopt.push(s.name);
      if (apply) {
        Object.assign(existing, { shortName: s.shortName, city: s.city, province: s.province, sector: s.sector, aliases: s.aliases, key: keyOf(s.name), status: s.status, source: "seed", hec });
        await existing.save();
      }
      continue;
    }
    // seeded before (or added by an admin): add what's missing, keep the admin's choices
    const aliases = [...new Set([...(existing.aliases || []), ...(s.aliases || [])])];
    const changes = {};
    if (aliases.length !== (existing.aliases || []).length) changes.aliases = aliases;
    for (const k of ["shortName", "city", "province", "sector"]) if (!existing[k] && s[k]) changes[k] = s[k];
    if (!existing.key) changes.key = keyOf(existing.name);
    if (!existing.hec?.page && hec.page) changes.hec = hec;
    if (!Object.keys(changes).length) { out.unchanged++; continue; }
    out.update.push(`${s.name} (${Object.keys(changes).join(", ")})`);
    if (apply) await University.updateOne({ _id: existing._id }, { $set: changes });
  }
  if (apply) {
    const touched = await University.find({ name: { $in: out.adopt } }).select("_id").lean();
    await recount(touched.map((u) => u._id));
    bust();
  }
  log(`${apply ? "APPLIED" : "DRY RUN (nothing written; add --apply to write)"}: ${seed.universities.length} in ${path.basename(SEED)} (${seed.source}, fetched ${seed.fetchedAt})`);
  log(`  add ${out.add.length} · adopt ${out.adopt.length} old signup entries with the same name · update ${out.update.length} · unchanged ${out.unchanged}`);
  if (out.adopt.length) log(`  adopted (old signup entry -> this HEC university): ${out.adopt.join("; ")}`);
  if (out.update.length) log(`  updated: ${out.update.slice(0, 40).join("; ")}${out.update.length > 40 ? " …" : ""}`);
  return out;
}

module.exports = { run, SEED };

if (require.main === module) {
  require("dotenv").config();
  const mongoose = require("mongoose");
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("MONGO_URI is not set"); process.exit(1); }
  mongoose.connect(uri)
    .then(() => run({ apply }))
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
