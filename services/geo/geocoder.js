// services/geo/geocoder.js
// Turns a brand/offer/branch address into a map point for "near me".
//
// Provider and key come from the environment, never from code:
//   GEOCODER=google            (only provider for now; default "google")
//   GEOCODER_API_KEY=...       (Google Geocoding API key)
//
// Rules:
//   • No key → geocoding is skipped and logged once. Nothing else changes.
//   • Saves never wait for geocoding: routes call geocodeInBackground() AFTER the
//     document is saved and the response is sent. Errors and timeouts (3 s) are
//     logged and the document simply stays without `geo`.
//   • A point set by hand (geoSource: 'manual') is never overwritten.
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
function buildAddress(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const v = String(p || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  if (!out.length) return "";
  if (!out.some((p) => /pakistan/i.test(p))) out.push("Pakistan");
  return out.join(", ");
}

// → { lng, lat } or null. Never throws.
async function geocodeAddress(address) {
  if (!address) return null;
  if (provider() !== "google") {
    console.warn(`[geo] unsupported GEOCODER "${provider()}", skipping`);
    return null;
  }
  if (!hasKey()) {
    if (!warnedNoKey) {
      console.warn("[geo] GEOCODER_API_KEY is not set, skipping geocoding");
      warnedNoKey = true;
    }
    return null;
  }
  try {
    const res = await axios.get(GOOGLE_URL, {
      params: { address, region: "pk", key: process.env.GEOCODER_API_KEY },
      timeout: TIMEOUT_MS,
    });
    const status = res.data?.status;
    const loc = res.data?.results?.[0]?.geometry?.location;
    if (status !== "OK" || !loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      console.warn(`[geo] no result (${status || "no status"}) for "${address}"`);
      return null;
    }
    return { lng: loc.lng, lat: loc.lat };
  } catch (e) {
    console.warn(`[geo] geocode failed for "${address}": ${e.code || e.message}`);
    return null;
  }
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
      { $unset: { geo: 1, geoSource: 1 }, $set: { geoUpdatedAt: new Date() } }
    );
  } catch (e) {
    console.warn(`[geo] could not clear point for ${Model.modelName} ${id}: ${e.message}`);
  }
}

// Fire-and-forget: call AFTER the document is saved. Never blocks, never throws.
// opts.clearOnFail: the address changed, so drop the old point if the new one fails.
function geocodeInBackground(Model, id, address, opts = {}) {
  if (!id) return;
  setImmediate(async () => {
    try {
      const point = address ? await geocodeAddress(address) : null;
      if (point) await saveGeo(Model, id, point);
      else if (opts.clearOnFail && (!address || hasKey())) await clearGeo(Model, id);
    } catch (e) {
      console.warn(`[geo] background geocode error: ${e.message}`);
    }
  });
}

module.exports = { buildAddress, geocodeAddress, saveGeo, clearGeo, geocodeInBackground, hasKey, provider };
