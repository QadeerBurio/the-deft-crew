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
});

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
  if (adminId) set.updatedBy = adminId;
  const doc = await SafetySettings.findOneAndUpdate({ key: "confessions" }, { $set: set, $setOnInsert: { key: "confessions" } }, { upsert: true, new: true }).lean();
  cache = merge(doc);
  cachedAt = Date.now();
  return cache;
}

const _reset = () => { cache = null; cachedAt = 0; };

module.exports = { get, save, DEFAULTS, MODES, _reset };
