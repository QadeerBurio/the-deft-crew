// services/resumeSettings.js — the resume settings (models/ResumeSettings.js) with defaults, cached for 30 s.
//   get()                    → { hiddenTemplates: [ids] }
//   save(patch, adminId)     hiddenTemplates: known template ids only (config/resumeTemplates.js), no repeats
const ResumeSettings = require("../models/ResumeSettings");
const { TEMPLATE_IDS } = require("../config/resumeTemplates");

const TTL = 30 * 1000;
let cache = null;
let cachedAt = 0;

const merge = (doc) => ({ hiddenTemplates: Array.isArray(doc?.hiddenTemplates) ? doc.hiddenTemplates.filter((id) => TEMPLATE_IDS.includes(id)) : [] });

async function get() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const doc = await ResumeSettings.findOne({ key: "resume" }).lean();
    cache = merge(doc);
  } catch {
    cache = cache || merge(null);
  }
  cachedAt = Date.now();
  return cache;
}

/** throws { status: 400, message } when the patch isn't valid */
async function save(patch, adminId) {
  const set = {};
  if (patch && patch.hiddenTemplates !== undefined) {
    if (!Array.isArray(patch.hiddenTemplates)) throw Object.assign(new Error("hiddenTemplates must be a list"), { status: 400 });
    const ids = [...new Set(patch.hiddenTemplates.map((x) => String(x || "")))];
    const unknown = ids.filter((id) => !TEMPLATE_IDS.includes(id));
    if (unknown.length) throw Object.assign(new Error(`unknown template: ${unknown.join(", ")}`), { status: 400 });
    set.hiddenTemplates = ids;
  }
  if (adminId) set.updatedBy = adminId;
  const doc = await ResumeSettings.findOneAndUpdate({ key: "resume" }, { $set: set, $setOnInsert: { key: "resume" } }, { upsert: true, new: true }).lean();
  cache = merge(doc);
  cachedAt = Date.now();
  return cache;
}

module.exports = { get, save, _reset: () => { cache = null; cachedAt = 0; } };
