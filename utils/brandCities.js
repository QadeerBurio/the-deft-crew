// utils/brandCities.js
// Works out which cities a brand is in:
//   brand.city (set at signup, default Karachi) + the city of every active branch.
// Branches with no city field are matched by the city name inside their location text.

const Branch = require('../models/Branch');

const DEFAULT_CITY = 'Karachi';

const KNOWN_CITIES = [
  'Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan',
  'Hyderabad', 'Peshawar', 'Quetta', 'Sialkot', 'Gujranwala', 'Bahawalpur',
  'Sargodha', 'Sukkur', 'Larkana', 'Abbottabad', 'Gujrat', 'Sheikhupura',
  'Rahim Yar Khan', 'Jhang', 'Dera Ghazi Khan', 'Mardan', 'Chiniot',
];

const KNOWN_BY_LOWER = new Map(KNOWN_CITIES.map((c) => [c.toLowerCase(), c]));

// "  karachi " → "Karachi", "ISB" stays as typed but title-cased
function normalizeCity(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const clean = raw.split(',')[0].trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const known = KNOWN_BY_LOWER.get(clean.toLowerCase());
  if (known) return known;
  return clean.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Finds a known city name inside free text like "Block 5, Clifton, Karachi"
function cityFromText(text) {
  if (!text || typeof text !== 'string') return '';
  const lower = text.toLowerCase();
  for (const c of KNOWN_CITIES) {
    if (lower.includes(c.toLowerCase())) return c;
  }
  return '';
}

function uniqueCities(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const n = normalizeCity(c);
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

/**
 * brands: array of brand User docs (lean) with _id and city
 * returns Map<brandIdString, string[]>
 */
async function getBrandCitiesMap(brands) {
  const ids = brands.map((b) => b._id);
  const branches = ids.length
    ? await Branch.find({ brand: { $in: ids }, isActive: true })
        .select('brand city location isOnline isInStore')
        .lean()
    : [];

  const byBrand = new Map();
  for (const br of branches) {
    const key = br.brand.toString();
    if (!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key).push(br.city || cityFromText(br.location));
  }

  const result = new Map();
  for (const b of brands) {
    const key = b._id.toString();
    const cities = uniqueCities([
      b.city || cityFromText(b.address) || DEFAULT_CITY,
      ...(byBrand.get(key) || []),
    ]);
    result.set(key, cities.length ? cities : [DEFAULT_CITY]);
  }
  return result;
}

function matchesCity(cities, city) {
  if (!city || city.toLowerCase() === 'all') return true;
  const want = city.toLowerCase();
  return (cities || []).some((c) => c.toLowerCase() === want);
}

module.exports = {
  DEFAULT_CITY,
  KNOWN_CITIES,
  normalizeCity,
  cityFromText,
  getBrandCitiesMap,
  matchesCity,
};
