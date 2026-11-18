// services/universities.js — the shared university list (models/University.js): search, requests, matching
// typed names, merging duplicates and the admin's "unmatched names". Matching (careers) never calls this.
//   keyOf(text)                 the name normalised for matching
//   search(q, { limit })        approved universities whose name / short name / aliases match (case and space don't matter)
//   bestMatch(text, city?)      the approved university a typed name most likely means, or null ("did you mean …?")
//   request({ name, city, userId })  a student's "my university isn't listed": the match if there is one, else a pending entry
//   displayName(user)           the name to show for a student (shared list first, the old text as a fallback)
//   unmatched()                 the old typed names students have, grouped with counts and a suggested match
//   merge(fromId, toId)         every student / offer / confession moves to `toId`; `from`'s name becomes an alias
//   recount(ids)                studentCount for these universities
const mongoose = require("mongoose");
const University = require("../models/University");

const STOP = new Set(["the", "of", "and", "for", "in", "at", "pakistan", "pk"]);
const CAMPUS = /\b(main|city|north|south|east|west|new|old|gulshan|clifton|airport|defence|road|link|m-9|campus|branch|sub-campus)\b/g;

/** "NED University of Engg. & Tech — Karachi" -> "ned university engg tech karachi" */
function keyOf(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[—–-]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter((w) => w && !STOP.has(w)).join(" ");
}
// the same name without campus / city words, for "did you mean"
const coreOf = (text, city = "") => {
  const cityWords = new Set(keyOf(city).split(" ").filter(Boolean));
  return keyOf(text).replace(CAMPUS, " ").split(/\s+/).filter((w) => w && !cityWords.has(w)).join(" ");
};
// short forms students type ("Inst. of Business Mgmt", "Univ of Engg & Tech")
const ABBR = { inst: "institute", instt: "institute", univ: "university", uni: "university", engg: "engineering", eng: "engineering", tech: "technology", mgmt: "management", sci: "sciences", science: "sciences", intl: "international", govt: "government", med: "medical", coll: "college" };
const tokens = (k) => new Set(String(k || "").split(" ").filter(Boolean).map((w) => ABBR[w] || w));
// share of words in common; a word also counts when one is the start of the other ("comput" / "computer")
const jaccard = (a, b) => {
  const A = [...tokens(a)]; const B = [...tokens(b)];
  if (!A.length || !B.length) return 0;
  const same = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)));
  const n = A.filter((x) => B.some((y) => same(x, y))).length;
  return n / (A.length + B.length - n);
};

// approved entries, in memory (a few hundred rows): search stays fast without a text index
let cache = null;
let cacheAt = 0;
const TTL = 5 * 60 * 1000;
async function approved() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const rows = await University.find({ status: "approved" }).select("name shortName city province aliases key studentCount").lean();
  cache = rows.map((u) => ({ ...u, keys: [keyOf(u.name), keyOf(u.shortName), ...(u.aliases || []).map(keyOf)].filter(Boolean), compact: [u.name, u.shortName, ...(u.aliases || [])].map((x) => keyOf(x).replace(/ /g, "")) }));
  cacheAt = Date.now();
  return cache;
}
const bust = () => { cache = null; };

const view = (u) => ({ id: String(u._id), name: u.name, shortName: u.shortName || "", city: u.city || "", status: u.status || "unmatched" });

async function search(q, { limit = 20 } = {}) {
  const list = await approved();
  const k = keyOf(q);
  if (!k) return list.slice().sort((a, b) => (b.studentCount || 0) - (a.studentCount || 0) || a.name.localeCompare(b.name)).slice(0, limit).map(view);
  const compact = k.replace(/ /g, "");
  const words = k.split(" ");
  const scored = [];
  for (const u of list) {
    let s = 0;
    if (u.compact.some((c) => c === compact)) s = 100; // "iobm", "fast nuces", "lums"
    else if (u.compact.some((c) => c.startsWith(compact))) s = 80;
    else if (u.keys.some((key) => words.every((w) => key.split(" ").some((t) => t.startsWith(w))))) s = 60; // every word starts a word
    else if (u.compact.some((c) => c.includes(compact)) || keyOf(u.city).startsWith(k)) s = 40;
    if (s) scored.push({ u, s });
  }
  return scored.sort((a, b) => b.s - a.s || (b.u.studentCount || 0) - (a.u.studentCount || 0) || a.u.name.localeCompare(b.u.name)).slice(0, limit).map((x) => view(x.u));
}

/** the approved university a typed name most likely is (name, short name, alias, or nearly the same words) */
async function bestMatch(text, city = "") {
  const list = await approved();
  const k = keyOf(text);
  if (!k) return null;
  const compact = k.replace(/ /g, "");
  const exact = list.find((u) => u.compact.includes(compact));
  if (exact) return exact;
  const core = coreOf(text, city);
  let best = null;
  let bestScore = 0;
  for (const u of list) {
    for (const key of u.keys) {
      const sc = Math.max(jaccard(core, coreOf(key, u.city)), jaccard(k, key));
      const sameCity = city && keyOf(city) === keyOf(u.city);
      const score = sc + (sameCity ? 0.1 : 0);
      if (score > bestScore) { bestScore = score; best = u; }
    }
  }
  return bestScore >= 0.75 ? best : null;
}

/** "my university isn't listed": the match if it's really there, else a pending entry (one per name) */
async function request({ name, city, userId = null }) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 150);
  const cleanCity = String(city || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (clean.length < 3) throw Object.assign(new Error("Type your university's full name"), { status: 400, code: "NAME_REQUIRED" });
  if (!cleanCity) throw Object.assign(new Error("Add the city"), { status: 400, code: "CITY_REQUIRED" });
  const match = await bestMatch(clean, cleanCity);
  if (match) return { match: view(match), created: false };
  const key = keyOf(clean);
  // the same request twice (or by two students): one pending entry
  const existing = await University.findOne({ $or: [{ key, status: "pending" }, { name: clean }] }).lean();
  if (existing && existing.status !== "hidden") return { university: view(existing), created: false };
  if (existing) return { university: view(existing), created: false, hidden: true };
  try {
    const u = await University.create({ name: clean, city: cleanCity, key, status: "pending", source: "student", requestedBy: mongoose.Types.ObjectId.isValid(String(userId || "")) ? userId : null });
    return { university: view(u), created: true };
  } catch (e) {
    if (e?.code !== 11000) throw e;
    return { university: view(await University.findOne({ name: clean }).lean()), created: false };
  }
}

/** the name to show for a student: the shared list's, else the text they signed up with */
function displayName(user) {
  const u = user?.university;
  if (u && typeof u === "object" && u.name) return u.name;
  return user?.universityName || "";
}

/** students per university, for these ids (or all) */
async function countsFor(ids = null) {
  const User = mongoose.model("User");
  const filter = { role: "student", university: ids ? { $in: ids.map((x) => new mongoose.Types.ObjectId(String(x))) } : { $ne: null } };
  const m = new Map();
  for (const u of await User.find(filter).select("university").lean()) { const k = String(u.university); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}
async function recount(ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return;
  const m = await countsFor(list);
  await Promise.all(list.map((id) => University.updateOne({ _id: id }, { $set: { studentCount: m.get(id) || 0 } })));
}

/** old typed names (signup entries without a status) that students use, with counts and a suggestion */
async function unmatched() {
  const rows = await University.find({ $or: [{ status: { $exists: false } }, { status: null }] }).select("name city").lean();
  if (!rows.length) return [];
  const counts = await countsFor(rows.map((r) => r._id));
  const out = [];
  for (const r of rows) {
    const students = counts.get(String(r._id)) || 0;
    const s = await bestMatch(r.name, r.city);
    out.push({ id: String(r._id), name: r.name, students, suggestion: s ? view(s) : null });
  }
  return out.sort((a, b) => b.students - a.students || a.name.localeCompare(b.name));
}

/** move everything from one entry to another; the old name stays findable as an alias */
async function merge(fromId, toId) {
  if (String(fromId) === String(toId)) throw Object.assign(new Error("Pick a different university to merge into"), { status: 400, code: "SAME_UNIVERSITY" });
  const [from, to] = await Promise.all([University.findById(fromId), University.findById(toId)]);
  if (!from || !to) throw Object.assign(new Error("University not found"), { status: 404, code: "NOT_FOUND" });
  if (to.status === "hidden") throw Object.assign(new Error("Merge into a university that is shown, not a hidden one"), { status: 400, code: "TARGET_HIDDEN" });
  const User = mongoose.model("User");
  const moved = {};
  moved.students = (await User.updateMany({ university: from._id }, { $set: { university: to._id, universityName: to.name } })).modifiedCount || 0;
  for (const m of ["Offer", "Confession"]) {
    const Model = mongoose.models[m] || require(`../models/${m}`);
    moved[m.toLowerCase() + "s"] = (await Model.updateMany({ university: from._id }, { $set: { university: to._id } })).modifiedCount || 0;
  }
  const aliases = new Set([...(to.aliases || []), from.name, ...(from.aliases || [])].filter((a) => a && a !== to.name));
  to.aliases = [...aliases].slice(0, 60);
  if (to.status !== "approved" && from.status === "approved") to.status = "approved";
  await to.save();
  from.status = "hidden";
  from.mergedInto = to._id;
  await from.save();
  await recount([from._id, to._id]);
  bust();
  return { from: view(from), to: view(to), moved };
}

module.exports = { keyOf, coreOf, search, bestMatch, request, displayName, unmatched, merge, recount, countsFor, view, bust, approved };
