// services/analytics/adminMetrics.js
// The one calculation behind the admin "metrics" and "overview" pages (feat/admin-approvals-metrics). Every metric has
// one definition (shown in the portal's "i" tooltip), a value for the chosen range and, where the records allow it,
// the previous period of the same length and the change.
//
// Range: presets today | 7d | 30d | month | custom (from / to, YYYY-MM-DD), in Karachi time (UTC+5, whole days).
// "Previous period": the same number of days immediately before.
//
// Excluded everywhere, the same way:
//   - deleted accounts: their user record is gone (services/accountDeletion.js replaces their id with a random
//     placeholder stored nowhere), so a row counts only if its student / author / brand account still exists
//   - test accounts: identified by Railway variables (no schema field): METRICS_TEST_EMAILS (comma list),
//     METRICS_TEST_EMAIL_DOMAINS (e.g. "tdc.test,example.com"), METRICS_TEST_USER_IDS. Not set = nobody excluded.
//
// Builds on businessAnalytics (redemptions = brand-confirmed bills, loyalty from the ledger, Surprise Box orders,
// the hiring funnel from timeline events) so the numbers agree with the rest of the portal.
const mongoose = require("mongoose");
const User = require("../../models/User");
const Offer = require("../../models/Offer");
const RedemptionArchive = require("../../models/RedemptionArchive");
const LoyaltyLedger = require("../../models/LoyaltyLedger");
const LoyaltyReward = require("../../models/LoyaltyReward");
const SurplusListing = require("../../models/SurplusListing");
const SurplusOrder = require("../../models/SurplusOrder");
const Job = require("../../models/Job");
const JobApplication = require("../../models/JobApplication");
const Post = require("../../models/Post");
const Confession = require("../../models/Confession");
const PushLog = require("../../models/PushLog");
const EngagementProfile = require("../../models/EngagementProfile");
const EmployerCompanyVerification = require("../../models/EmployerCompanyVerification");
const CareerRatingReport = require("../../models/CareerRatingReport");
const { dayKey } = require("../../utils/karachiTime");

const DAY = 864e5;
const PKT = 5 * 3600e3;
const MIN_COHORT = 5;
const PRESETS = ["today", "7d", "30d", "month", "custom"];
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));

// ---------- the range ----------
const karachiMidnight = (d) => { const k = dayKey(d); return new Date(`${k}T00:00:00+05:00`); };
const endOfKarachiDay = (d) => new Date(karachiMidnight(d).getTime() + DAY - 1);
/** { preset, from, to, days, previous: { from, to } } (Karachi whole days); throws 400 on a bad range */
function rangeOf(q = {}, now = new Date()) {
  const preset = PRESETS.includes(q.preset) ? q.preset : q.from || q.to ? "custom" : "30d";
  const bad = (m, code = "INVALID_RANGE") => Object.assign(new Error(m), { status: 400, code });
  let from; let to = endOfKarachiDay(now);
  if (preset === "today") from = karachiMidnight(now);
  else if (preset === "7d") from = new Date(karachiMidnight(now).getTime() - 6 * DAY);
  else if (preset === "30d") from = new Date(karachiMidnight(now).getTime() - 29 * DAY);
  else if (preset === "month") from = new Date(`${dayKey(now).slice(0, 7)}-01T00:00:00+05:00`);
  else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ""))) throw bad("custom needs from and to as YYYY-MM-DD");
    from = new Date(`${q.from}T00:00:00+05:00`);
    to = new Date(`${q.to}T23:59:59.999+05:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw bad("from must be a date on or before to");
  }
  const days = Math.round((to.getTime() + 1 - from.getTime()) / DAY);
  if (days > 366) throw bad("the range can be at most a year", "RANGE_TOO_LONG");
  const previous = { from: new Date(from.getTime() - days * DAY), to: new Date(from.getTime() - 1) };
  return { preset, from, to, days, previous };
}

// ---------- who counts ----------
const listEnv = (k) => String(process.env[k] || "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
/** the test-account rule from the Railway variables (no schema field) */
function testRule() {
  return { emails: new Set(listEnv("METRICS_TEST_EMAILS")), domains: listEnv("METRICS_TEST_EMAIL_DOMAINS").map((d) => d.replace(/^@/, "")), ids: new Set(listEnv("METRICS_TEST_USER_IDS")) };
}
const isTestUser = (u, rule) => {
  const email = String(u?.email || "").toLowerCase();
  return rule.ids.has(String(u?._id).toLowerCase()) || (email && (rule.emails.has(email) || rule.domains.some((d) => email.endsWith(`@${d}`))));
};
/** a Mongo filter for real accounts (not test) on the User collection */
function realUserFilter(rule) {
  const nor = [];
  if (rule.ids.size) nor.push({ _id: { $in: [...rule.ids].filter(isId) } });
  if (rule.emails.size) nor.push({ email: { $in: [...rule.emails] } });
  for (const d of rule.domains) nor.push({ email: { $regex: `@${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
  return nor.length ? { $nor: nor } : {};
}
/**
 * From some account ids (students, authors, brands), the ones that still exist and aren't test accounts. Rows whose
 * account was deleted (a placeholder id) or is a test account are then left out of every count.
 */
async function liveIds(ids, rule) {
  const uniq = [...new Set(ids.map(String).filter(isId))];
  if (!uniq.length) return new Set();
  const users = await User.find({ _id: { $in: uniq } }).select("_id email").lean();
  return new Set(users.filter((u) => !isTestUser(u, rule)).map((u) => String(u._id)));
}

// ---------- one metric ----------
const change = (value, previous) => (previous == null ? null : { delta: value - previous, pct: previous ? Math.round(((value - previous) / previous) * 1000) / 10 : null });
const metric = (value, previous, definition, opts = {}) => ({ value, previous: previous ?? null, change: change(value, previous ?? null), definition, ...opts });
const snapshot = (value, definition) => ({ value, previous: null, change: null, definition, snapshot: true });

// ---------- the figures for one window (the current one, then the previous one) ----------
async function windowFigures(r, rule) {
  const within = { $gte: r.from, $lte: r.to };
  // students
  const signups = await User.countDocuments({ role: "student", createdAt: within, ...realUserFilter(rule) });
  // brand-confirmed redemptions (live brands + archived ones of deleted brands), only of existing, real students
  const offers = await Offer.find({ "redemptions.redeemedAt": within }).select("brand redemptions").lean();
  let rows = [];
  for (const o of offers) for (const x of o.redemptions || []) if (x.redeemedAt >= r.from && x.redeemedAt <= r.to) rows.push({ brand: String(o.brand), student: String(x.student), bill: x.billAmount || 0, saved: x.savedAmount || 0, at: x.redeemedAt });
  const archived = await RedemptionArchive.find({ kind: "redemption", redeemedAt: within }).select("student billAmount savedAmount redeemedAt").lean();
  rows.push(...archived.map((x) => ({ brand: "deleted", student: String(x.student), bill: x.billAmount || 0, saved: x.savedAmount || 0, at: x.redeemedAt })));
  const liveStudents = await liveIds(rows.map((x) => x.student), rule);
  const realBrands = await liveIds(rows.map((x) => x.brand).filter(isId), rule); // brands that exist and aren't test
  rows = rows.filter((x) => liveStudents.has(x.student) && (x.brand === "deleted" || realBrands.has(x.brand)));
  const newlyApproved = await User.countDocuments({ role: "brand", brandApprovedAt: within, ...realUserFilter(rule) });
  // loyalty (the ledger)
  const ledger = await LoyaltyLedger.find({ effectiveAt: within }).select("brand student type visitsDelta").lean();
  const ledgerLive = await liveIds(ledger.map((x) => x.student), rule);
  const counted = ledger.filter((x) => ledgerLive.has(String(x.student)) && x.type === "CREDIT" && x.visitsDelta > 0);
  const reversed = ledger.filter((x) => ledgerLive.has(String(x.student)) && x.type === "REVERSAL" && x.visitsDelta < 0);
  const rewardsEarnedRows = await LoyaltyReward.find({ earnedAt: within, status: { $ne: "void" } }).select("student").lean();
  const rewardsUsedRows = await LoyaltyReward.find({ usedAt: within, status: "used" }).select("student").lean();
  const rewardLive = await liveIds([...rewardsEarnedRows, ...rewardsUsedRows].map((x) => x.student), rule);
  // Surprise Box
  const listings = await SurplusListing.find({ createdAt: within }).select("brand quantityTotal").lean();
  const listingLive = await liveIds(listings.map((x) => x.brand), rule);
  const orders = await SurplusOrder.find({ createdAt: within }).select("student qty state stateBeforeDispute pickupCodeUsedAt").lean();
  const orderLive = await liveIds(orders.map((x) => x.student), rule);
  const realOrders = orders.filter((o) => orderLive.has(String(o.student)));
  const was = (o, s) => o.state === s || o.stateBeforeDispute === s;
  // careers
  const jobs = await Job.find({ createdAt: within }).select("postedBy isExternal").lean();
  const jobPosters = await liveIds(jobs.map((j) => j.postedBy).filter(Boolean), rule);
  const realJobs = jobs.filter((j) => j.isExternal || !j.postedBy || jobPosters.has(String(j.postedBy)));
  const apps = await JobApplication.find({ appliedAt: within }).select("userId").lean();
  const appLive = await liveIds(apps.map((a) => a.userId), rule);
  const funnel = (await require("../career/careerAnalyticsService").funnel({ from: r.from, to: r.to })).counts || {};
  // engagement
  const posts = await Post.find({ createdAt: within }).select("user").lean();
  const confessions = await Confession.find({ createdAt: within }).select("user").lean();
  const opens = await PushLog.find({ openedAt: within }).select("user").lean();
  const engLive = await liveIds([...posts, ...confessions, ...opens].map((x) => x.user), rule);
  return {
    students: { signups },
    brands: { newlyApproved, redemptions: rows.length, revenue: rows.reduce((s, x) => s + (x.bill - x.saved), 0), rows },
    loyalty: { members: new Set(counted.map((x) => `${x.brand}:${x.student}`)).size, visits: counted.length - reversed.length, rewardsEarned: rewardsEarnedRows.filter((x) => rewardLive.has(String(x.student))).length, rewardsUsed: rewardsUsedRows.filter((x) => rewardLive.has(String(x.student))).length },
    surpriseBox: { boxesListed: listings.filter((l) => listingLive.has(String(l.brand))).reduce((s, l) => s + (l.quantityTotal || 0), 0), orders: realOrders.length, pickups: realOrders.filter((o) => !!o.pickupCodeUsedAt).length, noShows: realOrders.filter((o) => was(o, "NO_SHOW")).length },
    careers: { jobs: realJobs.length, applications: apps.filter((a) => appLive.has(String(a.userId))).length, interviews: funnel.interviewsCompleted || 0, hires: funnel.verifiedHires || 0, funnel },
    engagement: { posts: posts.filter((p) => engLive.has(String(p.user))).length, confessions: confessions.filter((c) => engLive.has(String(c.user))).length, pushOpens: opens.filter((o) => engLive.has(String(o.user))).length },
  };
}

// ---------- as of now (snapshots) ----------
async function snapshotFigures(rule, now = new Date()) {
  const real = realUserFilter(rule);
  const activeSince = (days) => new Date(now.getTime() - days * DAY);
  const profiles = await EngagementProfile.find({ "stats.lastActiveAt": { $gte: activeSince(30) } }).select("user stats.lastActiveAt").lean();
  const students = new Map((await User.find({ _id: { $in: profiles.map((p) => p.user) }, role: "student", ...real }).select("_id university").lean()).map((u) => [String(u._id), u]));
  const active = profiles.filter((p) => students.has(String(p.user)));
  return {
    verified: await User.countDocuments({ role: "student", status: "Verified", ...real }),
    active7: active.filter((p) => new Date(p.stats.lastActiveAt) >= activeSince(7)).length,
    active30: active.length,
    activeByUniversity: active.reduce((m, p) => { const u = students.get(String(p.user))?.university; if (u) m.set(String(u), (m.get(String(u)) || 0) + 1); return m; }, new Map()),
    approvedBrands: await User.countDocuments({ role: "brand", brandApprovalStatus: "approved", ...real }),
    activeOffers: await Offer.countDocuments({ status: "active", archivedAt: null }),
  };
}

// ---------- needs your action (now) ----------
async function needsAction(rule, now = new Date()) {
  const real = realUserFilter(rule);
  let hireDisputes = null;
  try {
    const { pilotConfigured } = require("../../config/featureFlags");
    if (pilotConfigured("careerTimeline")) {
      const CareerApplicationEvent = require("../../models/CareerApplicationEvent");
      const timeline = require("../career/careerTimelineService");
      const appIds = await CareerApplicationEvent.distinct("application", { type: "HIRE_DISPUTED" });
      const events = appIds.length ? await CareerApplicationEvent.find({ application: { $in: appIds } }).sort({ seq: 1 }).lean() : [];
      const apps = await JobApplication.find({ _id: { $in: appIds } }).select("status").lean();
      hireDisputes = apps.filter((a) => timeline.fold(events.filter((e) => String(e.application) === String(a._id)), a.status).hire.dispute === "open").length;
    }
  } catch (e) { console.warn("[metrics] hire disputes not counted:", e?.message); }
  return {
    brandApprovals: await User.countDocuments({ role: "brand", brandApprovalStatus: "pending", ...real }),
    studentVerifications: await User.countDocuments({ role: "student", status: { $ne: "Verified" }, ...real }),
    companyVerifications: await EmployerCompanyVerification.countDocuments({ status: "pending" }),
    hireDisputes,
    ratingsReports: await CareerRatingReport.countDocuments({ status: "open" }),
    failedPushes: await PushLog.countDocuments({ status: "failed", sentAt: { $gte: new Date(now.getTime() - 7 * DAY) } }),
  };
}

// ---------- per day (charts) ----------
async function series(r, rows, rule) {
  const days = [];
  for (let t = r.from.getTime(); t <= r.to.getTime(); t += DAY) days.push(dayKey(new Date(t + 1)));
  const signups = await User.find({ role: "student", createdAt: { $gte: r.from, $lte: r.to }, ...realUserFilter(rule) }).select("createdAt").lean();
  const by = (list, at) => { const m = new Map(days.map((d) => [d, 0])); for (const x of list) { const k = dayKey(new Date(at(x))); if (m.has(k)) m.set(k, m.get(k) + 1); } return days.map((d) => ({ day: d, count: m.get(d) })); };
  return { signups: by(signups, (x) => x.createdAt), redemptions: by(rows, (x) => x.at) };
}

/** Everything the metrics and overview pages show. q: { preset, from, to } */
async function adminMetrics(q = {}, { now = new Date() } = {}) {
  const r = rangeOf(q, now);
  const rule = testRule();
  const [cur, prev, snap, action] = await Promise.all([windowFigures(r, rule), windowFigures(r.previous, rule), snapshotFigures(rule, now), needsAction(rule, now)]);
  // top 5 brands by redemptions (brands with at least MIN_COHORT distinct students), top 5 universities by active students
  const byBrand = new Map();
  for (const x of cur.brands.rows) if (x.brand !== "deleted") { const b = byBrand.get(x.brand) || { redemptions: 0, students: new Set() }; b.redemptions += 1; b.students.add(x.student); byBrand.set(x.brand, b); }
  const brandNames = new Map((await User.find({ _id: { $in: [...byBrand.keys()] } }).select("brandName name").lean()).map((u) => [String(u._id), u.brandName || u.name || "brand"]));
  const topBrands = [...byBrand.entries()].filter(([, b]) => b.students.size >= MIN_COHORT).map(([id, b]) => ({ id, name: brandNames.get(id) || "brand", redemptions: b.redemptions })).sort((a, b) => b.redemptions - a.redemptions).slice(0, 5);
  const University = mongoose.models.University || require("../../models/University");
  const uniEntries = [...snap.activeByUniversity.entries()].filter(([, n]) => n >= MIN_COHORT).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const uniNames = new Map((await University.find({ _id: { $in: uniEntries.map(([id]) => id) } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const topUniversities = uniEntries.map(([id, n]) => ({ id, name: uniNames.get(id) || "university", activeStudents: n }));
  const f = cur.careers.funnel;
  const D = {
    signups: "student accounts created in the range (Karachi days), not deleted, not test accounts",
    verified: "student accounts verified now (all time), not test accounts; no history, so no previous period",
    active7: "students active in the last 7 days (as of now: last activity in the app), not test accounts",
    active30: "students active in the last 30 days (as of now), not test accounts",
    approvedBrands: "brand accounts approved now (all time); no history, so no previous period",
    newlyApproved: "brands approved in the range",
    activeOffers: "offers live now (not archived)",
    redemptions: "bills the brand confirmed in the range (QR / promo verify, store orders; deleted brands' redemptions included), by existing, non-test students; claims are not redemptions",
    revenue: "money students paid brands through tdc in the range: bill minus the tdc discount, on confirmed redemptions (tdc takes no commission)",
    members: "student-brand pairs with a counted loyalty visit in the range",
    visits: "loyalty visits counted in the range minus visits reversed",
    rewardsEarned: "loyalty rewards earned in the range (not voided)",
    rewardsUsed: "loyalty rewards used at the brand in the range",
    boxesListed: "Surprise Boxes brands listed in the range (quantity)",
    orders: "Surprise Box orders placed in the range (holds and views aren't orders)",
    pickups: "orders placed in the range whose pickup code the brand verified",
    noShows: "orders placed in the range marked as not collected",
    jobs: "jobs posted in the range (by existing employers; imported external jobs included)",
    applications: "job applications sent in the range by existing, non-test students",
    interviews: "applications from the range with a completed interview (hiring timeline)",
    hires: "applications from the range with a verified hire (hiring timeline)",
    posts: "social posts created in the range",
    confessions: "confessions posted in the range",
    pushOpens: "push notifications opened in the range",
  };
  const groups = {
    students: {
      signups: metric(cur.students.signups, prev.students.signups, D.signups),
      verified: snapshot(snap.verified, D.verified),
      active7: snapshot(snap.active7, D.active7),
      active30: snapshot(snap.active30, D.active30),
    },
    brands: {
      approvedBrands: snapshot(snap.approvedBrands, D.approvedBrands),
      newlyApproved: metric(cur.brands.newlyApproved, prev.brands.newlyApproved, D.newlyApproved),
      activeOffers: snapshot(snap.activeOffers, D.activeOffers),
      redemptions: metric(cur.brands.redemptions, prev.brands.redemptions, D.redemptions),
      revenue: metric(cur.brands.revenue, prev.brands.revenue, D.revenue, { unit: "PKR" }),
    },
    loyalty: Object.fromEntries(["members", "visits", "rewardsEarned", "rewardsUsed"].map((k) => [k, metric(cur.loyalty[k], prev.loyalty[k], D[k])])),
    surpriseBox: Object.fromEntries(["boxesListed", "orders", "pickups", "noShows"].map((k) => [k, metric(cur.surpriseBox[k], prev.surpriseBox[k], D[k])])),
    careers: Object.fromEntries(["jobs", "applications", "interviews", "hires"].map((k) => [k, metric(cur.careers[k], prev.careers[k], D[k])])),
    engagement: Object.fromEntries(["posts", "confessions", "pushOpens"].map((k) => [k, metric(cur.engagement[k], prev.engagement[k], D[k])])),
  };
  return {
    range: { preset: r.preset, from: r.from, to: r.to, days: r.days, fromDay: dayKey(r.from), toDay: dayKey(r.to) },
    previous: { from: r.previous.from, to: r.previous.to, fromDay: dayKey(r.previous.from), toDay: dayKey(r.previous.to) },
    timeZone: "Asia/Karachi",
    exclusions: { deleted: "accounts whose user record no longer exists", test: { configured: rule.emails.size + rule.domains.length + rule.ids.size > 0, how: "Railway variables METRICS_TEST_EMAILS, METRICS_TEST_EMAIL_DOMAINS, METRICS_TEST_USER_IDS" } },
    groups,
    series: await series(r, cur.brands.rows, rule),
    topBrands, topUniversities, minCohort: MIN_COHORT,
    funnel: { applications: f.applications || 0, shortlisted: f.shortlisted || 0, interviews: f.interviewsCompleted || 0, offers: f.offersAccepted || 0, hires: f.verifiedHires || 0 },
    needsAction: action,
  };
}

module.exports = { adminMetrics, rangeOf, testRule, isTestUser, realUserFilter, PRESETS, MIN_COHORT };
