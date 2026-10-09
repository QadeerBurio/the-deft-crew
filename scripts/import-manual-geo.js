// scripts/import-manual-geo.js
// Sets "near me" map points by hand from a CSV you fill in yourself.
//
//   node scripts/import-manual-geo.js <file.csv> --dry-run   # validate + show what would change, NEVER writes
//   node scripts/import-manual-geo.js <file.csv>             # write
//
// CSV header (one row per point):
//   id,lat,lng,city,note
//     id    a Branch id, an Offer id, or a brand (User) id.
//           A brand id sets the point on all of that brand's in-store OFFERS
//           (branches have their own addresses; give branch ids for those).
//     lat   latitude, e.g. 24.8031
//     lng   longitude, e.g. 67.0652
//     city  optional, stored as geoCity (e.g. Karachi)
//     note  optional, ignored (for you)
//
// Every point must be inside Pakistan (lat 23.5–37.2, lng 60.8–77.9); rows outside are
// rejected. Written points get geoSource "manual" and geoPrecision "exact", so the
// geocoder and the backfill never overwrite them.
//
// Needs MONGO_URI.
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { useServerDns } = require("../config/dns");
const Branch = require("../models/Branch");
const Offer = require("../models/Offer");
const User = require("../models/User");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run") || args.includes("--dry");
const file = args.find((a) => !a.startsWith("--"));

const PK = { latMin: 23.5, latMax: 37.2, lngMin: 60.8, lngMax: 77.9 };
const insidePakistan = (lat, lng) => lat >= PK.latMin && lat <= PK.latMax && lng >= PK.lngMin && lng <= PK.lngMax;

// minimal CSV parser (quoted cells, commas inside quotes)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

async function main() {
  if (!file) {
    console.error("Usage: node scripts/import-manual-geo.js <file.csv> [--dry-run]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  if (col("id") < 0 || col("lat") < 0 || col("lng") < 0) {
    console.error('The CSV needs a header with at least: id,lat,lng (optional: city,note)');
    process.exit(1);
  }

  // validate everything first; nothing is written if any row is invalid
  const items = [];
  const problems = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const id = String(r[col("id")] || "").trim();
    const lat = Number(r[col("lat")]);
    const lng = Number(r[col("lng")]);
    const city = col("city") > -1 ? String(r[col("city")] || "").trim() : "";
    if (!mongoose.Types.ObjectId.isValid(id)) return problems.push(`line ${line}: "${id}" is not a valid id`);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return problems.push(`line ${line}: lat/lng must be numbers`);
    if (!insidePakistan(lat, lng)) {
      const swapped = insidePakistan(lng, lat) ? " (looks like lat and lng are swapped)" : "";
      return problems.push(`line ${line}: ${lat}, ${lng} is outside Pakistan${swapped}`);
    }
    items.push({ line, id, lat, lng, city });
  });
  if (problems.length) {
    console.error(`${problems.length} invalid row(s); nothing was written:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error("Refusing to run: MONGO_URI is not set.");
    process.exit(1);
  }
  useServerDns(); // same resolvers as server.js, so the mongodb+srv lookup works
  await connectDB();

  let written = 0;
  const unknown = [];
  for (const it of items) {
    const set = {
      geo: { type: "Point", coordinates: [it.lng, it.lat] },
      geoSource: "manual",
      geoPrecision: "exact",
      geoUpdatedAt: new Date(),
      ...(it.city ? { geoCity: it.city } : {}),
    };
    const branch = await Branch.findById(it.id).select("_id name").lean();
    const offer = branch ? null : await Offer.findById(it.id).select("_id title").lean();
    const brand = branch || offer ? null : await User.findOne({ _id: it.id, role: "brand" }).select("_id name").lean();

    let targets = [];
    if (branch) targets = [{ Model: Branch, _id: branch._id, label: `branch "${branch.name}"` }];
    else if (offer) targets = [{ Model: Offer, _id: offer._id, label: `offer "${offer.title}"` }];
    else if (brand) {
      const offers = await Offer.find({ brand: brand._id, isInStore: true }).select("_id title").lean();
      targets = offers.map((o) => ({ Model: Offer, _id: o._id, label: `offer "${o.title}" (brand ${brand.name})` }));
      if (!targets.length) unknown.push(`line ${it.line}: brand ${brand.name} has no in-store offers`);
    } else {
      unknown.push(`line ${it.line}: no branch, offer or brand with id ${it.id}`);
    }

    for (const t of targets) {
      console.log(`  ${DRY ? "would set" : "set"} ${t.label} → ${it.lat}, ${it.lng}${it.city ? ` (${it.city})` : ""}`);
      if (!DRY) {
        await t.Model.updateOne({ _id: t._id }, { $set: set });
        written++;
      }
    }
  }

  if (unknown.length) console.log(`\nNot found:\n  ${unknown.join("\n  ")}`);
  console.log(DRY ? `\n[dry run] nothing written.` : `\n${written} point(s) written with geoSource "manual".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Import error:", e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
