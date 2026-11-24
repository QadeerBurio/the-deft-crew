// services/resumeOutcomes.js
// P3d outcome loop (owner #10 + P3d #7/#8): which resume template a student applied with, and what came of it.
//   The snapshot: JobApplication.resumeSource { kind: "tdc_resume", resumeId, templateId, at } written when a student
//   applies with "my tdc resume" (the template is read from the resume at that moment, so a later switch doesn't
//   change it). Older apps send nothing: no snapshot, nothing counted for them.
//   An application "got an interview" when any real record says so: its status (interview / hired), a scheduled
//   interview (CareerInterview), or a recorded outcome (CareerOutcome, not revoked). Hired: status hired or an outcome
//   "hired" (not revoked).
//   templateStats()   → [{ id, applications, interviews, hires }]   every template with at least one application
//   publicStats()     → only templates with >= 30 applications AND >= 10 interviews (owner P3d #7), with the rate;
//                       nothing below that is ever shown to students
// Computed from the records each time (cached 10 minutes): no stored totals to drift.
const MIN_APPLICATIONS = 30;
const MIN_INTERVIEWS = 10;
const TTL = 10 * 60 * 1000;
let cache = { at: 0, rows: null };

async function templateStats({ fresh = false } = {}) {
  if (!fresh && cache.rows && Date.now() - cache.at < TTL) return cache.rows;
  const JobApplication = require("../models/JobApplication");
  const CareerInterview = require("../models/CareerInterview");
  const CareerOutcome = require("../models/CareerOutcome");
  const apps = await JobApplication.find({ "resumeSource.kind": "tdc_resume" }).select("_id status resumeSource").lean();
  const ids = apps.map((a) => a._id);
  const [interviews, outcomes] = ids.length
    ? await Promise.all([
      CareerInterview.find({ application: { $in: ids } }).select("application").lean(),
      CareerOutcome.find({ application: { $in: ids }, verificationLevel: { $ne: "revoked" } }).select("application outcomeType").lean(),
    ])
    : [[], []];
  const interviewed = new Set(interviews.map((x) => String(x.application)));
  const hired = new Set();
  for (const o of outcomes) { interviewed.add(String(o.application)); if (o.outcomeType === "hired") hired.add(String(o.application)); }
  const by = new Map();
  for (const a of apps) {
    const id = String(a.resumeSource?.templateId || "");
    if (!id) continue;
    const row = by.get(id) || { id, applications: 0, interviews: 0, hires: 0 };
    const key = String(a._id);
    row.applications += 1;
    if (["interview", "hired"].includes(a.status) || interviewed.has(key)) row.interviews += 1;
    if (a.status === "hired" || hired.has(key)) row.hires += 1;
    by.set(id, row);
  }
  const rows = [...by.values()].sort((x, y) => y.applications - x.applications);
  cache = { at: Date.now(), rows };
  return rows;
}

const shown = (r) => r.applications >= MIN_APPLICATIONS && r.interviews >= MIN_INTERVIEWS;

async function publicStats(opts) {
  return (await templateStats(opts)).filter(shown).map((r) => ({ id: r.id, applications: r.applications, interviews: r.interviews, rate: Math.round((r.interviews / r.applications) * 100) }));
}

module.exports = { templateStats, publicStats, shown, MIN_APPLICATIONS, MIN_INTERVIEWS, _clear: () => { cache = { at: 0, rows: null }; } };
