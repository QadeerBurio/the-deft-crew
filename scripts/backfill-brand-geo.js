// scripts/backfill-brand-geo.js
// Map points for "near me": geocodes in-store Branch and Offer addresses with the
// brand's city + ", Pakistan" (restricted to Pakistan) and writes a CSV report.
//
//   node scripts/backfill-brand-geo.js --dry-run            # geocode + report only, NEVER writes to the database
//   node scripts/backfill-brand-geo.js                      # geocode, save accepted rows, report
//   options:
//     --report <file>        report path (default reports/geo-backfill-<time>.csv)
//     --limit <n>            only the first n addresses
//     --include-geocoded     also re-check rows that already have an automatic point
//
// Report columns: type, id, brand, brand_city, address, lat, lng, matched_city,
//                 precision, status (ok | rejected | error), reason, note
// The real run saves only "ok" rows and never touches geoSource "manual".
// "note" flags suspected data-entry errors (e.g. a brand address that is the
// agency's own office address).
//
// Needs MONGO_URI and GEOCODER_API_KEY (GEOCODER=google). About 5 requests per second.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { useServerDns } = require("../config/dns");
const Branch = require("../models/Branch");
const Offer = require("../models/Offer");
const User = require("../models/User");
const { buildAddress, geocodeDetailed, saveGeo, hasKey, provider } = require("../services/geo/geocoder");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run") || args.includes("--dry");
const INCLUDE_GEOCODED = args.includes("--include-geocoded");
const argVal = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};
const LIMIT = argVal("--limit") ? Math.max(1, parseInt(argVal("--limit"), 10) || 0) : Infinity;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const REPORT = argVal("--report") || path.join("reports", `geo-backfill-${DRY ? "dryrun-" : ""}${stamp}.csv`);
const DELAY_MS = 200; // ≈ 5 requests / second

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notManual = { geoSource: { $ne: "manual" } };
const missingGeo = { $or: [{ geo: { $exists: false } }, { "geo.coordinates": { $exists: false } }] };

// Our own office (The Deft Crew). A brand address that matches it is almost
// certainly a data-entry error (e.g. Oceanic Pharma's branch).
const OFFICE_PATTERNS = [/deft\s*crew/i, /48-?\s*c[, ]+lane\s*8/i, /khayaban-?e-?ittehad[^,]*,?\s*bukhari/i];
const officeNote = (address) =>
  OFFICE_PATTERNS.some((re) => re.test(address || ""))
    ? "suspected data-entry error: matches the agency office address"
    : "";

const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLUMNS = ["type", "id", "brand", "brand_city", "address", "lat", "lng", "matched_city", "precision", "status", "reason", "note"];

async function main() {
  if (provider() !== "google") {
    console.error(`Refusing to run: GEOCODER is "${provider()}", only "google" is supported.`);
    process.exit(1);
  }
  if (!hasKey()) {
    console.error(
      "Refusing to run: GEOCODER_API_KEY is not set (the dry run also geocodes, to fill the report).\n" +
        "Set it in the environment you run this from (see .env.example)."
    );
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("Refusing to run: MONGO_URI is not set.");
    process.exit(1);
  }

  useServerDns(); // same resolvers as server.js, so the mongodb+srv lookup works
  await connectDB();

  // Build the 2dsphere indexes if they don't exist yet (no-op when they do). Real run only.
  if (!DRY) {
    await Branch.createIndexes();
    await Offer.createIndexes();
  }

  const which = INCLUDE_GEOCODED ? notManual : { ...notManual, ...missingGeo };
  const branches = await Branch.find({ isInStore: true, location: { $nin: [null, ""] }, ...which })
    .select("_id name location city brand")
    .lean();
  const offers = await Offer.find({ isInStore: true, location: { $nin: [null, ""] }, ...which })
    .select("_id title location brand")
    .lean();
  const manualCount =
    (await Branch.countDocuments({ geoSource: "manual" })) + (await Offer.countDocuments({ geoSource: "manual" }));

  const brandIds = [...new Set([...branches, ...offers].map((d) => String(d.brand)).filter(Boolean))];
  const brands = await User.find({ _id: { $in: brandIds } }).select("_id name city").lean();
  const brandById = new Map(brands.map((b) => [String(b._id), b]));

  const jobs = [
    ...branches.map((b) => {
      const brand = brandById.get(String(b.brand)) || {};
      const city = String(b.city || brand.city || "").trim();
      return { Model: Branch, type: "branch", id: b._id, brand: brand.name || "", city, raw: b.location, address: buildAddress([b.location, city]) };
    }),
    ...offers.map((o) => {
      const brand = brandById.get(String(o.brand)) || {};
      const city = String(brand.city || "").trim();
      return { Model: Offer, type: "offer", id: o._id, brand: brand.name || "", city, raw: o.location, address: buildAddress([o.location, city]) };
    }),
  ]
    .filter((j) => j.address)
    .slice(0, LIMIT);

  console.log(
    `${DRY ? "[dry run — no database writes] " : ""}${jobs.length} addresses (${branches.length} branches, ${offers.length} offers); ` +
      `${manualCount} manual points left untouched.`
  );

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  const rows = [COLUMNS.join(",")];
  const count = { ok: 0, rejected: 0, error: 0, saved: 0, notSaved: 0 };

  for (const job of jobs) {
    const v = await geocodeDetailed(job.address, { expectedCity: job.city });
    count[v.status] = (count[v.status] || 0) + 1;
    let reason = v.reason || "";
    if (!DRY && v.status === "ok") {
      const saved = await saveGeo(job.Model, job.id, { ...v.point, precision: v.precision, matchedCity: v.matchedCity });
      if (saved) count.saved++;
      else {
        count.notSaved++;
        reason = "not saved (manual point set meanwhile, or unchanged)";
      }
    }
    rows.push(
      [
        job.type,
        job.id,
        job.brand,
        job.city,
        job.address,
        v.point?.lat ?? "",
        v.point?.lng ?? "",
        v.matchedCity || "",
        v.precision || "",
        v.status,
        reason,
        officeNote(job.raw),
      ]
        .map(csvCell)
        .join(",")
    );
    console.log(`  ${v.status.padEnd(8)} ${job.type} ${job.brand} — ${v.status === "ok" ? `${v.precision}, ${v.matchedCity}` : reason}`);
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(REPORT, rows.join("\n") + "\n");
  console.log(
    `\nSummary: ${count.ok} ok, ${count.rejected} rejected, ${count.error} errors` +
      (DRY ? " (dry run: nothing saved)" : `; ${count.saved} saved, ${count.notSaved} not saved`) +
      `.\nReport: ${REPORT}`
  );
  const flagged = rows.filter((r) => r.includes("suspected data-entry error")).length;
  if (flagged) console.log(`${flagged} address(es) flagged as suspected data-entry errors — see the "note" column.`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Backfill error:", e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
