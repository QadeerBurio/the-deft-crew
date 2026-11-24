// services/safetySettings.js
// The confession safety settings (models/SafetySettings.js) with defaults, cached for 30 s (the server that saves a
// change applies it at once).
const SafetySettings = require("../models/SafetySettings");

const MODES = ["off", "observe", "enforce"];
const DEFAULTS = Object.freeze({
  // enforce = the checks act for accounts with the confessionSafety flag (as signed off in P4-1)
  mode: "enforce",
  reportThreshold: 3,
  bannedWords: [],
  // Pakistani helplines (plan §12 #18). The owner call-tests each before launch; editable in admin.
  helplines: [
    { name: "national mental health helpline", number: "1166", note: "" },
    { name: "Umang Pakistan", number: "0311-7786264", note: "24/7" },
    { name: "Rozan", number: "0800-22-444", note: "" },
    { name: "emergency", number: "1122", note: "rescue" },
    { name: "police", number: "15", note: "" },
  ],
  suspendOnSingleEvidenceReport: false,
  // P4-3: one tag per post (owner list); the admin can add, rename (the id stays) or hide them
  tags: ["crush", "rant", "academics", "hostel", "food", "career", "wholesome", "question", "funny"].map((id) => ({ id, label: id, hidden: false })),
  // P4-4: "not sure where to start?" chips; 3 a week, rotated (promptsThisWeek)
  prompts: [
    "a hostel story nobody believes", "the class you'd drop if you could", "something you'll never say out loud",
    "the canteen order you're known for", "a group project confession", "the best advice a senior gave you",
    "what you'd tell yourself in first year", "the deadline you almost missed", "a small win this week",
  ],
});

const TAG_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** P4-4: this week's 3 prompt chips (the list rotates by Karachi week; the same 3 for everyone that week) */
function promptsThisWeek(settings, now = Date.now()) {
  const list = settings?.prompts?.length ? settings.prompts : DEFAULTS.prompts;
  const week = Math.floor((now + 5 * 3600e3 + 3 * 864e5) / (7 * 864e5)); // weeks start on Monday, Karachi time
  const start = (week * 3) % list.length;
  return [0, 1, 2].map((i) => list[(start + i) % list.length]).filter((p, i, a) => a.indexOf(p) === i);
}

let cache = null;
let cachedAt = 0;
const TTL = 30 * 1000;

function merge(doc) {
  const d = doc || {};
  return {
    mode: MODES.includes(d.mode) ? d.mode : DEFAULTS.mode,
    reportThreshold: Number.isInteger(d.reportThreshold) && d.reportThreshold > 0 ? d.reportThreshold : DEFAULTS.reportThreshold,
    bannedWords: Array.isArray(d.bannedWords) ? d.bannedWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean) : [...DEFAULTS.bannedWords],
    helplines: Array.isArray(d.helplines) && d.helplines.length ? d.helplines.map((x) => ({ name: x.name || "", number: x.number || "", note: x.note || "" })) : DEFAULTS.helplines.map((x) => ({ ...x })),
    suspendOnSingleEvidenceReport: typeof d.suspendOnSingleEvidenceReport === "boolean" ? d.suspendOnSingleEvidenceReport : DEFAULTS.suspendOnSingleEvidenceReport,
    tags: Array.isArray(d.tags) && d.tags.length ? d.tags.filter((t) => t && TAG_ID.test(String(t.id || ""))).map((t) => ({ id: String(t.id), label: String(t.label || t.id).slice(0, 24), hidden: t.hidden === true })) : DEFAULTS.tags.map((t) => ({ ...t })),
    prompts: Array.isArray(d.prompts) && d.prompts.length ? d.prompts.map((p) => String(p).trim()).filter(Boolean) : [...DEFAULTS.prompts],
  };
}

/** The settings now (defaults when nothing is saved, or when the database can't be read). */
async function get() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const doc = await SafetySettings.findOne({ key: "confessions" }).lean();
    cache = merge(doc);
  } catch (e) {
    console.warn(`[safety] settings not read, using the last / default ones (${e.name})`);
    cache = cache || merge(null);
  }
  cachedAt = Date.now();
  return cache;
}

/** Save (admin). patch: any of the fields; returns the merged settings. */
async function save(patch, adminId) {
  const set = {};
  if (patch.mode !== undefined) { if (!MODES.includes(patch.mode)) throw Object.assign(new Error(`mode: ${MODES.join(" | ")}`), { code: "BAD_MODE" }); set.mode = patch.mode; }
  if (patch.reportThreshold !== undefined) set.reportThreshold = Math.max(1, Math.min(50, parseInt(patch.reportThreshold, 10) || DEFAULTS.reportThreshold));
  if (patch.bannedWords !== undefined) set.bannedWords = (Array.isArray(patch.bannedWords) ? patch.bannedWords : String(patch.bannedWords).split(/[,\n]/)).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 500);
  if (patch.helplines !== undefined) set.helplines = (Array.isArray(patch.helplines) ? patch.helplines : []).slice(0, 12).map((x) => ({ name: String(x?.name || "").slice(0, 80), number: String(x?.number || "").slice(0, 40), note: String(x?.note || "").slice(0, 120) })).filter((x) => x.number);
  if (patch.suspendOnSingleEvidenceReport !== undefined) set.suspendOnSingleEvidenceReport = !!patch.suspendOnSingleEvidenceReport;
  if (patch.tags !== undefined) {
    const seen = new Set();
    set.tags = (Array.isArray(patch.tags) ? patch.tags : []).slice(0, 30).map((t) => ({ id: String(t?.id || t?.label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24), label: String(t?.label || t?.id || "").trim().slice(0, 24), hidden: t?.hidden === true }))
      .filter((t) => TAG_ID.test(t.id) && t.label && !seen.has(t.id) && seen.add(t.id));
    if (!set.tags.length) throw Object.assign(new Error("keep at least one tag (hide the others)"), { code: "NO_TAGS" });
  }
  if (patch.prompts !== undefined) set.prompts = (Array.isArray(patch.prompts) ? patch.prompts : String(patch.prompts).split(/\n/)).map((p) => String(p).trim().slice(0, 80)).filter(Boolean).slice(0, 40);
  if (adminId) set.updatedBy = adminId;
  const doc = await SafetySettings.findOneAndUpdate({ key: "confessions" }, { $set: set, $setOnInsert: { key: "confessions" } }, { upsert: true, new: true }).lean();
  cache = merge(doc);
  cachedAt = Date.now();
  return cache;
}

const _reset = () => { cache = null; cachedAt = 0; };

module.exports = { get, save, promptsThisWeek, DEFAULTS, MODES, TAG_ID, _reset };
