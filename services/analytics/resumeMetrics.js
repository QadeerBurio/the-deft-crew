// services/analytics/resumeMetrics.js
// P3d (owner P3d #8): the read-only resume metrics table for admins (analytics.view). Real counts from the records:
//   per template: resumes using it now, applications sent with it ("my tdc resume"), interviews, hires, and whether
//   the gallery may show its interview rate yet (>= 30 applications and >= 10 interviews, services/resumeOutcomes.js)
//   public pages: how many are on, and their views in total
// Template ids are read as the renderer reads them (older ids map to the five), so "classic" counts as Classic.
const render = require("../../utils/resumeRender");
const outcomes = require("../resumeOutcomes");

async function resumeMetrics() {
  const Resume = require("../../models/Resume");
  const [byTemplate, apps, pages] = await Promise.all([
    Resume.aggregate([{ $group: { _id: "$template", n: { $sum: 1 } } }]),
    outcomes.templateStats({ fresh: true }),
    Resume.aggregate([{ $match: { "publicPage.on": true } }, { $group: { _id: null, n: { $sum: 1 }, views: { $sum: "$publicPage.views" } } }]),
  ]);
  const names = new Map([...render.TEMPLATES.map((t) => [t.id, t.name]), ...render.LIBRARY.map((t) => [t.id, t.name])]);
  const rows = new Map([...names.keys()].map((id) => [id, { id, name: names.get(id), resumes: 0, applications: 0, interviews: 0, hires: 0, rateShown: false }]));
  for (const g of byTemplate || []) {
    const id = render.templateOf(g._id).id;
    if (rows.has(id)) rows.get(id).resumes += Number(g.n) || 0;
  }
  for (const a of apps) {
    const row = rows.get(a.id) || rows.set(a.id, { id: a.id, name: a.id, resumes: 0, applications: 0, interviews: 0, hires: 0, rateShown: false }).get(a.id);
    Object.assign(row, { applications: a.applications, interviews: a.interviews, hires: a.hires, rateShown: outcomes.shown(a) });
  }
  const p = (pages || [])[0] || {};
  return {
    templates: [...rows.values()].sort((x, y) => y.resumes - x.resumes || y.applications - x.applications),
    publicPages: { on: Number(p.n) || 0, views: Number(p.views) || 0 },
    minimum: { applications: outcomes.MIN_APPLICATIONS, interviews: outcomes.MIN_INTERVIEWS },
  };
}

module.exports = { resumeMetrics };
