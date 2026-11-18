// services/universityMatch.js — "which official university does this typed name mean?" for the admin's unmatched
// names (feat/uni-match). Read only: it scores, it never writes. The admin decides (one click, or a bulk click).
//   suggest(text, list, { city })   -> { match, confidence: high | medium | low | none, score, reason, alternatives }
//   prepare(list)                     the approved list with its match data (cached per list)
// A university is compared through its name, short name, aliases and initials ("IoBM", "Inst of Business Mgmt",
// "iobm karachi" -> Institute of Business Management), tolerant of case, spacing, punctuation, abbreviations,
// common typos (one or two letters), word order and city / campus words ("… — Karachi", "Karachi University").
// Confidence:
//   high    nearly the same name (score >= 0.9) and no other university close behind (>= 0.1 ahead)
//   medium  score >= 0.72, or a near-exact name that two universities share
//   low     score >= 0.5
//   none    nothing likely: suggestion empty (the admin adds it as new or picks one)
const STOP = new Set(["the", "of", "and", "for", "in", "at", "pakistan", "pk"]);
// short forms students type
const ABBR = {
  inst: "institute", instt: "institute", institue: "institute", univ: "university", uni: "university", unv: "university", varsity: "university",
  engg: "engineering", eng: "engineering", engr: "engineering", tech: "technology", technol: "technology", mgmt: "management", mgt: "management",
  sci: "sciences", science: "sciences", intl: "international", int: "international", govt: "government", gov: "government", med: "medical",
  coll: "college", clg: "college", dept: "department", natl: "national", nat: "national", admin: "administration",
  khi: "karachi", lhr: "lahore", isb: "islamabad", isl: "islamabad", pwr: "peshawar", hyd: "hyderabad", rwp: "rawalpindi", fsd: "faisalabad",
};
// words that say little about which university (they count for less)
const GENERIC = new Set(["university", "institute", "college", "school", "academy", "campus", "sciences", "technology", "engineering",
  "studies", "centre", "center", "women", "national", "international", "government", "federal", "medical", "pakistan", "department"]);
const CAMPUS = new Set(["main", "city", "north", "south", "east", "west", "new", "old", "campus", "branch", "sub", "road", "gulshan", "clifton", "defence"]);
const LIGHT = 0.35; // weight of a generic / city / campus word

/** "NED Univ. of Engg & Tech — Karachi" -> ["ned", "university", "engineering", "technology", "karachi"] */
function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter(Boolean)
    .map((w) => ABBR[w] || w)
    .filter((w) => !STOP.has(w));
}
const compactOf = (ws) => ws.join("");
// initials, with and without the little words ("Institute of Business Management" -> "iobm", "ibm")
function initialsOf(text) {
  const raw = String(text || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const all = raw.map((w) => w[0]).join("");
  const main = raw.filter((w) => !STOP.has(w)).map((w) => w[0]).join("");
  return [all, main].filter((x) => x.length >= 2);
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// how alike two words are: same 1; a typo (1 letter in 4+, 2 in 8+) or an abbreviation (start of the other, 4+) 0.9
function wordSim(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  if (short.length >= 4 && long.startsWith(short)) return 0.9;
  if (short.length >= 4) {
    const max = long.length >= 8 ? 2 : 1;
    if (lev(a, b, max) <= max) return 0.9;
    // swapped letters ("Univeristy")
    if (a.length === b.length && [...a].sort().join("") === [...b].sort().join("") && lev(a, b, 2) <= 2) return 0.9;
  }
  return 0;
}

function makeWeigher(cityWords) {
  return (w) => (GENERIC.has(w) || CAMPUS.has(w) || cityWords.has(w) ? LIGHT : 1);
}
// weighted, typo-tolerant overlap of the typed words (indexes into t.sims) and a name's words (vocabulary ids), 0..1,
// and whether every important word on both sides matched. t.sims[i][id] = how alike typed word i and vocabulary word id.
function overlap(T, B, t, vw) {
  if (!T.length || !B.length) return { score: 0, allKey: false };
  let got = 0; let total = 0; let keys = 0; let keyMissing = false;
  for (const i of T) {
    const row = t.sims[i]; const w = t.weights[i];
    let best = 0;
    for (const id of B) { const s = row[id]; if (s > best) { best = s; if (best === 1) break; } }
    got += w * best; total += w;
    if (w === 1) { keys++; if (best < 0.9) keyMissing = true; }
  }
  const keysA = keys; keys = 0;
  for (const id of B) {
    const w = vw[id];
    let best = 0;
    for (const i of T) { const s = t.sims[i][id]; if (s > best) { best = s; if (best === 1) break; } }
    got += w * best; total += w;
    if (w === 1) { keys++; if (best < 0.9) keyMissing = true; }
  }
  return { score: got / total, allKey: keysA > 0 && keys > 0 && !keyMissing };
}

// the approved list with match data, built once per list (the list itself is cached for a minute)
const prepared = new WeakMap();
function prepare(list) {
  if (prepared.has(list)) return prepared.get(list);
  const cityWords = new Set();
  const cityPhrases = new Set();
  for (const u of list) {
    const ws = words(u.city);
    if (ws.length) { cityPhrases.add(ws.join(" ")); if (ws.length === 1) cityWords.add(ws[0]); }
  }
  ["karachi", "lahore", "islamabad", "rawalpindi", "peshawar", "quetta", "hyderabad", "multan", "faisalabad"].forEach((c) => { cityWords.add(c); cityPhrases.add(c); });
  const phrases = [...cityPhrases].sort((a, b) => b.length - a.length);
  // the name without city and campus words, unless nothing telling would be left ("University of Karachi")
  const core = (ws) => {
    let s = ` ${ws.join(" ")} `;
    for (const p of phrases) s = s.split(` ${p} `).join(" ");
    const left = s.trim().split(" ").filter((w) => w && !CAMPUS.has(w));
    return left.some((w) => !GENERIC.has(w)) ? left : ws;
  };
  const weight = makeWeigher(cityWords);
  // every word in the list gets an id (typed words are compared with each vocabulary word once per name)
  const vocab = new Map();
  const idOf = (w) => { if (!vocab.has(w)) vocab.set(w, vocab.size); return vocab.get(w); };
  const unis = list.map((u) => {
    const names = [u.name, u.shortName, ...(u.aliases || [])].filter(Boolean);
    const forms = names.map((n) => { const ws = words(n); const c = core(ws); return { text: n, ws, core: c, compact: compactOf(ws), coreCompact: compactOf(c), wsIds: ws.map(idOf), coreIds: c.map(idOf) }; });
    const initials = new Set([...names.filter((n) => n.length >= 3).flatMap(initialsOf), ...(u.shortName ? [compactOf(words(u.shortName))] : [])]);
    return { u, forms, initials, city: words(u.city).join(" ") };
  });
  const vocabWords = [...vocab.keys()];
  const vw = Float64Array.from(vocabWords, weight);
  const out = { unis, core, weight, cityWords, vocabWords, vw };
  prepared.set(list, out);
  return out;
}

const why = {
  exact: "same name", short: "short name / initials", alias: "a known other name", words: "nearly the same words", key: "every important word matches",
};
function scoreOne(t, p, typedCity, vw) {
  let best = { score: 0, reason: "", exact: false };
  const take = (score, reason, exact = false) => { if (score > best.score || (score === best.score && exact && !best.exact)) best = { score, reason, exact }; };
  for (const [i, f] of p.forms.entries()) {
    const kind = i === 0 ? why.exact : f.text === p.u.shortName ? why.short : why.alias;
    if (f.compact && (f.compact === t.compact || f.coreCompact === t.coreCompact || f.compact === t.coreCompact)) { take(1, kind, true); continue; }
    const o1 = overlap(t.coreIdx, f.coreIds, t, vw);
    const o2 = overlap(t.wsIdx, f.wsIds, t, vw);
    const o = o1.score >= o2.score ? o1 : o2;
    take(o.score, why.words);
    if (o1.allKey || o2.allKey) take(0.92, why.key);
  }
  // initials: "iobm", "neduet", "ku" (one typed word only, 2-8 letters)
  if (t.core.length === 1 && /^[a-z]{2,8}$/.test(t.core[0]) && p.initials.has(t.core[0])) take(0.95, why.short, true);
  // the same city (typed, or the entry's own): tells two campuses / namesakes apart, never makes a match on its own
  best.sameCity = !!(best.score > 0 && p.city && (typedCity === p.city || ` ${t.ws.join(" ")} `.includes(` ${p.city} `)));
  return best;
}

const round = (x) => Math.round(x * 100) / 100;
/** the most likely official university for a typed name, with a confidence level and a few alternatives */
function suggest(text, list, { city = "", view = (u) => u } = {}) {
  const p = prepare(list);
  const ws = words(text);
  const empty = { match: null, confidence: "none", score: 0, reason: "", alternatives: [] };
  if (!ws.length) return empty;
  const core = p.core(ws);
  const typedWords = [...new Set([...ws, ...core])];
  const sims = typedWords.map((w) => Float64Array.from(p.vocabWords, (v) => wordSim(w, v)));
  const t = { ws, core, compact: compactOf(ws), coreCompact: compactOf(core), sims, weights: typedWords.map(p.weight),
    wsIdx: ws.map((w) => typedWords.indexOf(w)), coreIdx: core.map((w) => typedWords.indexOf(w)) };
  const typedCity = words(city).join(" ");
  const scored = [];
  for (const one of p.unis) { const s = scoreOne(t, one, typedCity, p.vw); if (s.score >= 0.3) scored.push({ ...s, u: one.u }); }
  // exact names first, then the same city, then the score
  const rank = (x) => x.score + (x.exact ? 1 : 0) + (x.sameCity ? 0.02 : 0);
  scored.sort((a, b) => rank(b) - rank(a) || (b.u.studentCount || 0) - (a.u.studentCount || 0) || a.u.name.localeCompare(b.u.name));
  const [top, next] = scored;
  if (!top) return empty;
  // two decimals, so 0.8999… from adding weights counts as 0.9
  top.score = round(top.score);
  if (next) next.score = round(next.score);
  const gap = round(top.score - (next?.score || 0));
  let confidence = "none";
  let close = !!next && gap < 0.1 && top.score >= 0.9;
  if (top.exact) {
    // one university has exactly this name / short name / alias / initials: high, unless another has it too and
    // the city doesn't settle it ("UET" alone: Lahore or Peshawar?)
    const tie = next && next.exact && !(top.sameCity && !next.sameCity);
    confidence = tie ? "medium" : "high";
    close = !!tie;
  } else if (top.score >= 0.9 && gap >= 0.1) confidence = "high";
  else if (top.score >= 0.72) confidence = "medium";
  else if (top.score >= 0.5) confidence = "low";
  const alternatives = scored.slice(confidence === "none" ? 0 : 1, 6).map((x) => ({ ...view(x.u), score: round(x.score) }));
  if (confidence === "none") return { ...empty, score: round(top.score), alternatives };
  return { match: view(top.u), confidence, score: round(top.score), reason: close ? `${top.reason}, but also close to ${next.u.name}` : top.reason, alternatives };
}

module.exports = { suggest, prepare, words, wordSim, initialsOf };
