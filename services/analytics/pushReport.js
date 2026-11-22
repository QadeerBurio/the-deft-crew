// services/analytics/pushReport.js
// Plan N-6 (owner): the push report in admin, from real data only. Built on tracked PushLog rows (pushOpenTracking:
// the push carried its row id, so an open and a receipt can be recorded) and notif_opt_out events (a switch turned
// off, a quieter mode, the phone's permission taken away; written only for tracked accounts).
//   per type: sent, delivered, opened, opt-outs within 24 h of a push of that type; rates only from
//   PUSH_REPORT_MIN_SENT sends (default 50) of a type, otherwise null ("not enough data yet", never 0%)
//   review: a type with enough data and an open rate under 3%, or opt-outs on 2% or more of its pushes
//   per day: sent / delivered / opened per type
const DAY_MS = 24 * 60 * 60 * 1000;
const intEnv = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def; };
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * models: { PushLog, EngagementEvent } (tests pass their own) → the report
 */
async function pushReport({ days = 14, now = new Date(), models = null } = {}) {
  const PushLog = models?.PushLog || require("../../models/PushLog");
  const EngagementEvent = models?.EngagementEvent || require("../../models/EngagementEvent");
  const d = Math.max(1, Math.min(90, Number(days) || 14));
  const since = new Date(now.getTime() - d * DAY_MS);
  const minSent = intEnv("PUSH_REPORT_MIN_SENT", 50);
  const flags = require("../../config/featureFlags");

  const rows = await PushLog.find({ tracked: true, sentAt: { $gte: since }, status: "sent" })
    .select("user type sentAt deliveredAt openedAt").lean();
  const byType = new Map();
  const byDay = new Map();
  const { dayKey } = require("../../utils/karachiTime");
  for (const r of rows) {
    const t = r.type || "unknown";
    if (!byType.has(t)) byType.set(t, { type: t, sent: 0, delivered: 0, opened: 0, optOuts24h: 0 });
    const x = byType.get(t);
    x.sent += 1; if (r.deliveredAt) x.delivered += 1; if (r.openedAt) x.opened += 1;
    const k = `${dayKey(new Date(r.sentAt))}|${t}`;
    if (!byDay.has(k)) byDay.set(k, { day: dayKey(new Date(r.sentAt)), type: t, sent: 0, delivered: 0, opened: 0 });
    const y = byDay.get(k);
    y.sent += 1; if (r.deliveredAt) y.delivered += 1; if (r.openedAt) y.opened += 1;
  }

  // opt-outs: attributed to the type of the student's last tracked push in the 24 h before
  const optOuts = await EngagementEvent.find({ name: "notif_opt_out", createdAt: { $gte: since } }).select("user createdAt").lean();
  const pushesOf = new Map();
  for (const r of rows) { const u = String(r.user); if (!pushesOf.has(u)) pushesOf.set(u, []); pushesOf.get(u).push(r); }
  let unattributed = 0;
  for (const o of optOuts) {
    const at = new Date(o.createdAt).getTime();
    const before = (pushesOf.get(String(o.user)) || []).filter((r) => { const s = new Date(r.sentAt).getTime(); return s <= at && at - s <= DAY_MS; });
    if (!before.length) { unattributed++; continue; }
    const last = before.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
    byType.get(last.type || "unknown").optOuts24h += 1;
  }

  const types = [...byType.values()].map((x) => {
    const enough = x.sent >= minSent;
    const openRate = enough ? pct(x.opened, x.sent) : null;
    const deliveredRate = enough ? pct(x.delivered, x.sent) : null;
    const optOutRate = enough ? pct(x.optOuts24h, x.sent) : null;
    const review = enough && (openRate < 3 || optOutRate >= 2);
    return { ...x, enough, openRate, deliveredRate, optOutRate, review };
  }).sort((a, b) => b.sent - a.sent);

  return {
    days: d, since, minSent,
    tracking: { configured: flags.pilotConfigured("pushOpenTracking"), trackedPushes: rows.length },
    enoughData: types.some((t) => t.enough),
    types,
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.sent - a.sent)),
    optOuts: { total: optOuts.length, unattributed },
  };
}

module.exports = { pushReport };
