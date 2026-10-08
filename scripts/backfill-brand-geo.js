// scripts/backfill-brand-geo.js
// One-time fill of map points for "near me": geocodes every in-store Branch and Offer
// address that has no `geo` yet. Never touches geoSource "manual".
//
//   node scripts/backfill-brand-geo.js --dry-run   # list what would be geocoded, no API calls
//   node scripts/backfill-brand-geo.js             # geocode and save
//   node scripts/backfill-brand-geo.js --limit 20  # only the first 20 addresses
//
// Needs MONGO_URI and GEOCODER_API_KEY (GEOCODER=google). Refuses to run without a key
// unless --dry-run. About 5 requests per second.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Branch = require("../models/Branch");
const Offer = require("../models/Offer");
const { buildAddress, geocodeAddress, saveGeo, hasKey, provider } = require("../services/geo/geocoder");

const DRY = process.argv.includes("--dry-run") || process.argv.includes("--dry");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Math.max(1, parseInt(process.argv[limitArg + 1], 10) || 0) : Infinity;
const DELAY_MS = 200; // ≈ 5 requests / second

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const missingGeo = { $or: [{ geo: { $exists: false } }, { "geo.coordinates": { $exists: false } }] };
const notManual = { geoSource: { $ne: "manual" } };

async function main() {
  if (!DRY) {
    if (provider() !== "google") {
      console.error(`Refusing to run: GEOCODER is "${provider()}", only "google" is supported.`);
      process.exit(1);
    }
    if (!hasKey()) {
      console.error(
        "Refusing to run: GEOCODER_API_KEY is not set.\n" +
          "Add it to the server environment (see .env.example), or use --dry-run to only list addresses."
      );
      process.exit(1);
    }
  }
  if (!process.env.MONGO_URI) {
    console.error("Refusing to run: MONGO_URI is not set.");
    process.exit(1);
  }

  await connectDB();

  // Build the 2dsphere indexes if they don't exist yet (no-op when they do)
  if (!DRY) {
    await Branch.createIndexes();
    await Offer.createIndexes();
  }

  const branches = await Branch.find({ isInStore: true, location: { $nin: [null, ""] }, ...notManual, ...missingGeo })
    .select("_id name location city")
    .lean();
  const offers = await Offer.find({ isInStore: true, location: { $nin: [null, ""] }, ...notManual, ...missingGeo })
    .select("_id title location")
    .lean();

  const jobs = [
    ...branches.map((b) => ({ Model: Branch, id: b._id, label: `branch "${b.name}"`, address: buildAddress([b.location, b.city]) })),
    ...offers.map((o) => ({ Model: Offer, id: o._id, label: `offer "${o.title || o._id}"`, address: buildAddress([o.location]) })),
  ]
    .filter((j) => j.address)
    .slice(0, LIMIT);

  console.log(`${DRY ? "[dry run] " : ""}${jobs.length} addresses without a map point (${branches.length} branches, ${offers.length} offers).`);

  const done = [];
  const failed = [];
  for (const job of jobs) {
    if (DRY) {
      console.log(`  would geocode ${job.label}: ${job.address}`);
      continue;
    }
    const point = await geocodeAddress(job.address);
    if (point && (await saveGeo(job.Model, job.id, point))) {
      done.push(job);
      console.log(`  ok   ${job.label}`);
    } else {
      failed.push(job);
      console.log(`  FAIL ${job.label}: ${job.address}`);
    }
    await sleep(DELAY_MS);
  }

  if (!DRY) {
    console.log(`\nSummary: ${done.length} done, ${failed.length} failed.`);
    if (failed.length) {
      console.log("Failed addresses (fix the address, or set geo by hand with geoSource \"manual\"):");
      failed.forEach((j) => console.log(`  - ${j.label}: ${j.address}`));
    }
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Backfill error:", e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
