// services/geo/geocoder.js
// Turns a brand/offer/branch address into a map point for "near me".
//
// Provider and key come from the environment, never from code:
//   GEOCODER=google            (only provider for now; default "google")
//   GEOCODER_API_KEY=...       (Google Geocoding API key)
//
// Rules:
//   • No key → geocoding is skipped and logged once. Nothing else changes.
//   • Saves never wait for geocoding: routes call geocode*InBackground() AFTER the
//     document is saved and the response is sent. Errors and timeouts (3 s) are
//     logged and the document simply stays without `geo`.
//   • A point set by hand (geoSource: 'manual') is never overwritten.
//   • Every address is sent with the brand's city and ", Pakistan", restricted to
//     Pakistan (components=country:PK). A result is rejected when:
//       - it is only a city, province/region or country (no neighbourhood or street), or
//       - the city Google matched is not the brand's city.
//     Accepted points store geoPrecision ('exact' | 'area') and geoCity.
const axios = require("axios");

const TIMEOUT_MS = 3000;
const GOOGLE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

let warnedNoKey = false;

function provider() {
  return String(process.env.GEOCODER || "google").toLowerCase();
}

function hasKey() {
  return !!process.env.GEOCODER_API_KEY;
}

// "Shop 4, DHA Phase 6" + "Karachi" → "Shop 4, DHA Phase 6, Karachi, Pakistan"
// (skips a part already contained in the address, e.g. "…, Karachi" + "Karachi")
function buildAddress(parts) {
  const out = [];
  for (const p of parts) {
    const v = String(p || "").trim();
    if (!v) continue;
    const joined = out.join(", ").toLowerCase();
    if (out.length && joined.includes(v.toLowerCase())) continue;
    out.push(v);
  }
  if (!out.length) return "";
  if (!out.some((p) => /pakistan/i.test(p))) out.push("Pakistan");
  return out.join(", ");
}

// ── city matching ──────────────────────────────────────────────────────────
const CITY_ALIASES = {
  islamabad: ["islamabad", "islamabad capital territory"],
  rawalpindi: ["rawalpindi", "rawalpindi cantonment"],
  karachi: ["karachi", "karachi city", "karachi division"],
  lahore: ["lahore", "lahore city", "lahore division", "lahore cantonment"],
};
const normCity = (c) =>
  String(c || "")
    .toLowerCase()
    .replace(/\b(city|district|division|cantonment|cantt)\b/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();

function sameCity(a, b) {
  const x = normCity(a);
  const y = normCity(b);
  if (!x || !y) return false;
  if (x === y) return true;
  for (const names of Object.values(CITY_ALIASES)) {
    const set = names.map(normCity);
    if (set.includes(x) && set.includes(y)) return true;
  }
  return false;
}

const VAGUE_TYPES = ["country", "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3", "locality", "colloquial_area", "postal_code"];
const EXACT_TYPES = ["street_address", "premise", "subpremise", "establishment", "point_of_interest", "plus_code", "intersection", "street_number", "food", "store", "restaurant", "cafe", "gym", "health"];

// Reads one Google result → { point, matchedCity, precision } or { reason }
function judgeResult(result, expectedCity) {
  const loc = result?.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return { reason: "no coordinates" };
  const types = result.types || [];
  const comps = result.address_components || [];
  const comp = (t) => comps.find((c) => (c.types || []).includes(t))?.long_name || "";
  const country = comps.find((c) => (c.types || []).includes("country"))?.short_name || "";
  if (country && country !== "PK") return { reason: `outside Pakistan (${country})` };

  // only a city / region / country, nothing more specific
  const specific = types.some((t) => !VAGUE_TYPES.includes(t) && t !== "political");
  if (!specific) {
    const what = types.includes("country") ? "country" : types.includes("locality") ? "city" : "region";
    return { reason: `too vague: matched only a ${what}` };
  }

  const matchedCity = comp("locality") || comp("administrative_area_level_3") || comp("administrative_area_level_2");
  if (expectedCity) {
    if (!matchedCity) return { reason: "no city in the result", matchedCity: "" };
    if (!sameCity(matchedCity, expectedCity) && !sameCity(comp("administrative_area_level_2"), expectedCity)) {
      return { reason: `city mismatch: matched ${matchedCity}, brand is in ${expectedCity}`, matchedCity };
    }
  }

  const exact =
    types.some((t) => EXACT_TYPES.includes(t)) ||
    ["ROOFTOP", "RANGE_INTERPOLATED"].includes(result.geometry?.location_type);
  return {
    point: { lng: loc.lng, lat: loc.lat },
    matchedCity: matchedCity || expectedCity || "",
    precision: exact ? "exact" : "area",
  };
}

// Full verdict, for the backfill report:
// → { status: 'ok', point, matchedCity, precision } | { status: 'rejected', reason, matchedCity? } | { status: 'error', reason }
// Never throws.
async function geocodeDetailed(address, { expectedCity } = {}) {
  if (!address) return { status: "rejected", reason: "no address" };
  if (provider() !== "google") return { status: "error", reason: `unsupported GEOCODER "${provider()}"` };
  if (!hasKey()) {
    if (!warnedNoKey) {
      console.warn("[geo] GEOCODER_API_KEY is not set, skipping geocoding");
      warnedNoKey = true;
    }
    return { status: "error", reason: "GEOCODER_API_KEY is not set" };
  }
  try {
    const res = await axios.get(GOOGLE_URL, {
      params: { address, region: "pk", components: "country:PK", key: process.env.GEOCODER_API_KEY },
      timeout: TIMEOUT_MS,
    });
    const status = res.data?.status;
    if (status === "ZERO_RESULTS") return { status: "rejected", reason: "no result" };
    if (status !== "OK") return { status: "error", reason: `google status ${status || "unknown"}` };
    const v = judgeResult(res.data?.results?.[0], expectedCity);
    if (v.point) return { status: "ok", ...v };
    return { status: "rejected", reason: v.reason, matchedCity: v.matchedCity };
  } catch (e) {
    return { status: "error", reason: `request failed: ${e.code || e.message}` };
  }
}

// → { lng, lat, precision, matchedCity } or null. Never throws.
async function geocodeAddress(address, opts = {}) {
  const v = await geocodeDetailed(address, opts);
  if (v.status !== "ok") {
    if (v.status === "rejected" || v.reason !== "GEOCODER_API_KEY is not set") {
      console.warn(`[geo] ${v.status} for "${address}": ${v.reason}`);
    }
    return null;
  }
  return { ...v.point, precision: v.precision, matchedCity: v.matchedCity };
}

// Stores the point on one document. Skips docs with geoSource 'manual'. Never throws.
async function saveGeo(Model, id, point) {
  if (!point) return false;
  try {
    const r = await Model.updateOne(
      { _id: id, geoSource: { $ne: "manual" } },
      {
        $set: {
          geo: { type: "Point", coordinates: [point.lng, point.lat] },
          geoSource: "geocoded",
          geoPrecision: point.precision || "area",
          geoCity: point.matchedCity || "",
          geoUpdatedAt: new Date(),
        },
      }
    );
    return (r.modifiedCount || r.nModified || 0) > 0;
  } catch (e) {
    console.warn(`[geo] could not save point for ${Model.modelName} ${id}: ${e.message}`);
    return false;
  }
}

// Removes an auto point (never a manual one). Used when an address changed but the
// new one could not be geocoded, so "near me" never shows a stale location.
async function clearGeo(Model, id) {
  try {
    await Model.updateOne(
      { _id: id, geoSource: { $ne: "manual" } },
      { $unset: { geo: 1, geoSource: 1, geoPrecision: 1, geoCity: 1 }, $set: { geoUpdatedAt: new Date() } }
    );
  } catch (e) {
    console.warn(`[geo] could not clear point for ${Model.modelName} ${id}: ${e.message}`);
  }
}

// The brand's city (User.city, role brand). '' when unknown. Never throws.
async function brandCity(brandId) {
  if (!brandId) return "";
  try {
    const User = require("../../models/User");
    const u = await User.findById(brandId).select("city").lean();
    return String(u?.city || "").trim();
  } catch {
    return "";
  }
}

// Fire-and-forget: call AFTER the document is saved. Never blocks, never throws.
// address: the address parts WITHOUT city, e.g. [offer.location] or [branch.location]
// opts.city: city to add and to check against (branch.city); otherwise the brand's city
// opts.brandId: brand to read the city from when opts.city is empty
// opts.clearOnFail: the address changed, so drop the old point if the new one fails.
function geocodeInBackground(Model, id, addressParts, opts = {}) {
  if (!id) return;
  setImmediate(async () => {
    try {
      const parts = (Array.isArray(addressParts) ? addressParts : [addressParts]).filter(Boolean);
      const city = String(opts.city || "").trim() || (await brandCity(opts.brandId));
      const address = parts.length ? buildAddress([...parts, city]) : "";
      const point = address ? await geocodeAddress(address, { expectedCity: city }) : null;
      if (point) await saveGeo(Model, id, point);
      else if (opts.clearOnFail && (!address || hasKey())) await clearGeo(Model, id);
    } catch (e) {
      console.warn(`[geo] background geocode error: ${e.message}`);
    }
  });
}

module.exports = {
  buildAddress,
  geocodeAddress,
  geocodeDetailed,
  judgeResult,
  sameCity,
  saveGeo,
  clearGeo,
  brandCity,
  geocodeInBackground,
  hasKey,
  provider,
};
