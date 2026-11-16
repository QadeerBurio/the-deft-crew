// The metric-audit fixes (fix/metric-audit), on fixed in-memory data:
//   brand revenue (admin "brand revenue", the admin brand profile, the brand portal's "revenue from tdc" /
//   "students saved" / savings history, the metrics page): a store-webhook order once, unique students once across
//   brands, each promo code's own discount, deleted and test accounts left out, the same total everywhere;
//   card revenue "not tracked" (no payment amount exists); engagement: delivered pushes, used reward codes, codes
//   issued, students who invited someone, invited sign-ups, active users in the chosen range, test accounts out,
//   Karachi dates for exam mode and the weekly chart; user counts without suspended / test accounts.
//   node tests/metric-audit/run.js [serverDir]
// Against an older server (no services/brandSales.js) it only prints the numbers ("before"); against this branch it
// prints them and checks them ("after"). No database, no network, no .env.
const path = require("path");
const fs = require("fs");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const AFTER = fs.existsSync(path.join(SERVER, "services", "brandSales.js"));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "METRICS_TEST_EMAILS", "METRICS_TEST_USER_IDS"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];
process.env.METRICS_TEST_EMAIL_DOMAINS = "tdc.test"; // test accounts: e-mails at tdc.test

class Expo {
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "" }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {}, uploadOffer: multerLike },
  { get: (t, k) => (k in t ? t[k] : multerLike) }
);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
for (const m of ["User", "University", "Offer", "PromoCode", "RedemptionArchive", "PushLog", "EngagementProfile", "EngagementEvent", "RewardRedemption", "Reward", "UserBadge", "DailyDrop", "DropReaction", "PointsLedger", "Branch"]) reqS(`./models/${m}`);
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;

const app = express();
app.use(express.json());
const statuses = [];
app.use((req, res, next) => { res.on("finish", () => statuses.push({ url: req.originalUrl, status: res.statusCode })); next(); });
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/admin/engagement", reqS("./routes/adminEngagement.routes"));
app.use("/api/admin", reqS("./routes/admin.routes"));
app.use("/api/analytics", reqS("./routes/analytics.routes"));

// ---------- fixed data (dates relative to now, well inside the ranges) ----------
const oid = () => new mongoose.Types.ObjectId();
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
const ids = {};
for (const k of ["admin", "A", "B", "T", "s1", "s2", "s3", "s4", "s5", "s6", "e1", "e2", "t1", "ghost", "U", "o1", "o2", "o3", "p1", "p2", "p3", "p4", "rw"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name.toLowerCase()}@real.pk`, password: "x", role, status: "Verified", accountStatus: "active", createdAt: ago(100), updatedAt: new Date(), ...extra });
fake.seed(coll("University"), [{ _id: ids.U, name: "Uni" }]);
fake.seed(coll("User"), [
  user(ids.admin, "admin", "Admin"),
  user(ids.A, "brand", "Alpha", { brandName: "Alpha", brandApprovalStatus: "approved" }),
  user(ids.B, "brand", "Beta", { brandName: "Beta", brandApprovalStatus: "approved" }),
  user(ids.T, "brand", "QA", { email: "brand@tdc.test", brandName: "QA brand", brandApprovalStatus: "approved" }),
  user(ids.s1, "student", "Sana", { university: ids.U, referralCount: 5, paymentStatus: "Verified" }),
  user(ids.s2, "student", "Omar", { university: ids.U, referredBy: ids.s1, referralCount: 1, createdAt: ago(30), paymentStatus: "Verified" }),
  user(ids.s3, "student", "Hina", { university: ids.U, referredBy: ids.s1, createdAt: ago(5) }),
  user(ids.s4, "student", "Ali", { university: ids.U, referredBy: ids.s2 }),
  user(ids.s5, "student", "Tester", { email: "qa@tdc.test", referredBy: ids.s1, createdAt: ago(3), paymentStatus: "Verified" }),
  user(ids.s6, "student", "Sus", { accountStatus: "suspended" }),
  user(ids.e1, "employee", "HireCo", { referralCount: 2 }),
  user(ids.e2, "employee", "Banned", { accountStatus: "banned" }),
  user(ids.t1, "traveler", "Trips"),
]);
const USED_AT = ago(4); // when the store order's code was marked used; its redemption is written 300 ms later
const red = (student, bill, saved, extra = {}) => ({ _id: oid(), student, billAmount: bill, savedAmount: saved, redeemedAt: extra.promoCodeId ? new Date(USED_AT.getTime() + 300) : ago(4), ...extra });
fake.seed(coll("Offer"), [
  { _id: ids.o1, brand: ids.A, title: "Alpha 20%", discountPercentage: 20, status: "active", archivedAt: null, createdAt: ago(60), redemptions: [
    red(ids.s1, 1000, 200), // in store
    red(ids.s2, 2000, 400, { promoCode: "AAA1", promoCodeId: ids.p1, externalOrderId: "woo-1", source: "webhook" }), // a store order (its code is p1)
    red(ids.ghost, 500, 50), // a deleted student
    red(ids.s5, 800, 80), // a test student
  ] },
  { _id: ids.o2, brand: ids.B, title: "Beta 10%", discountPercentage: 10, status: "active", archivedAt: null, createdAt: ago(60), redemptions: [
    red(ids.s1, 600, 60), // the same student as at Alpha
    red(ids.s3, 300, 30, { promoCode: "BBB1", promoCodeId: ids.p3, externalOrderId: "shop-1" }),
  ] },
  { _id: ids.o3, brand: ids.T, title: "QA offer", discountPercentage: 0, status: "active", archivedAt: null, createdAt: ago(60), redemptions: [red(ids.s2, 9999, 0)] },
]);
const promo = (id, brand, student, code, amount, pct, offer) => ({ _id: id, code, offer, student, brand, discountPercentage: pct, offerTitle: "promo", brandName: "b", status: "used", usedAt: USED_AT, externalAmount: amount, externalProvider: "woocommerce", createdAt: ago(5), updatedAt: ago(4) });
fake.seed(coll("PromoCode"), [
  promo(ids.p1, ids.A, ids.s2, "AAA1", 2000, 20, ids.o1), // = the store order above
  promo(ids.p2, ids.A, ids.s3, "AAA2", 1000, 10, ids.o1), // an older code: used, no redemption written
  promo(ids.p3, ids.B, ids.s3, "BBB1", 300, 10, ids.o2), // = the store order above
  promo(ids.p4, ids.B, ids.s4, "BBB2", 1000, 30, ids.o2), // older, 30% (not the first code's 10%)
]);
fake.seed(coll("RedemptionArchive"), [
  { _id: oid(), kind: "redemption", deletionId: "del-1", redemptionId: oid(), offerId: oid(), student: ids.s4, billAmount: 400, savedAmount: 40, redeemedAt: ago(4) },
  { _id: oid(), kind: "brand-totals", deletionId: "del-1", totals: { totalRevenue: 360, totalBill: 400, totalSaved: 40, totalRedemptions: 1, uniqueStudents: 1 } },
]);
// engagement
const prof = (u, lastActiveDaysAgo, extra = {}) => ({ _id: oid(), user: u, sortedCount: 0, stats: { lastActiveAt: ago(lastActiveDaysAgo) }, streak: { count: 0, best: 0, examModeUntil: null }, createdAt: ago(100), ...extra });
fake.seed(coll("EngagementProfile"), [prof(ids.s1, 1), prof(ids.s2, 20), prof(ids.s3, 40), prof(ids.s4, 100), prof(ids.s5, 1)]);
const push = (u, extra) => ({ _id: oid(), user: u, type: "test", title: "t", sentAt: ago(2), createdAt: ago(2), status: "sent", deliveredAt: null, openedAt: null, receiptStatus: "pending", ...extra });
fake.seed(coll("PushLog"), [
  push(ids.s1, { deliveredAt: ago(2), receiptStatus: "ok", openedAt: ago(1) }), // delivered + opened
  push(ids.s2, {}), // sent, no receipt yet
  push(ids.s3, { status: "failed" }),
  push(ids.s4, { status: "queued" }),
  push(ids.s5, { deliveredAt: ago(2), receiptStatus: "ok", openedAt: ago(1) }), // a test account
]);
const code = (u, created, extra = {}) => ({ _id: oid(), user: u, reward: ids.rw, code: `C${Math.random()}`, costPoints: 10, status: "active", expiresAt: ago(-10), createdAt: ago(created), ...extra });
fake.seed(coll("RewardRedemption"), [
  code(ids.s1, 3, { status: "used", usedAt: ago(2) }), // taken and used in range
  code(ids.s2, 3), // taken, not used
  code(ids.s5, 3, { status: "used", usedAt: ago(2) }), // a test account
  code(ids.s3, 60, { status: "used", usedAt: ago(5) }), // taken long ago, used in range
]);

const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
let PORT;
const call = (url, tok) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port: PORT, path: url, headers: tok ? { authorization: `Bearer ${tok}` } : {} }, (res) => {
    let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
  }).on("error", (e) => resolve({ status: 0, text: String(e) }));
});
const results = [];
const check = (name, ok, detail = "") => { if (!AFTER) return; results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const N = {};
const note = (k, v) => { N[k] = v; console.log(`VALUE ${k} = ${JSON.stringify(v)}`); };
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const ADMIN = token(ids.admin, "admin"), BA = token(ids.A, "brand"), BB = token(ids.B, "brand");
  console.log(`-- ${AFTER ? "after (this branch)" : "before (older server: numbers only)"}`);

  // ===== brand revenue
  let r = await call("/api/offers/admin/brands-revenue", ADMIN);
  const S = r.json?.summary || {};
  const brand = (id) => (r.json?.brands || []).find((b) => String(b._id) === String(id));
  note("admin.summary.totalRevenue", S.totalRevenue); note("admin.summary.totalBill", S.totalBill); note("admin.summary.totalSaved", S.totalSaved);
  note("admin.summary.totalRedemptions", S.totalRedemptions); note("admin.summary.uniqueStudents", S.uniqueStudents); note("admin.summary.totalBrands", S.totalBrands);
  for (const [k, id] of [["Alpha", ids.A], ["Beta", ids.B], ["QA", ids.T]]) { const b = brand(id); note(`admin.${k}`, b ? { revenue: b.totalRevenue, bill: b.totalBill, saved: b.totalSaved, redemptions: b.totalRedemptions, students: b.uniqueStudents } : null); }
  note("admin.deletedBrands.totalRevenue", S.deletedBrands?.totalRevenue);
  check("admin brand revenue: Alpha 3300 (in-store 800 + store order 1600 once + older code 900; deleted and test students out)", brand(ids.A)?.totalRevenue === 3300 && brand(ids.A).totalRedemptions === 3 && brand(ids.A).uniqueStudents === 3, JSON.stringify(N["admin.Alpha"]));
  check("…Beta: the older code's saved amount uses its own 30% (300), not the first code's 10%", brand(ids.B)?.totalSaved === 390 && brand(ids.B).totalRevenue === 1510, JSON.stringify(N["admin.Beta"]));
  check("…a test brand isn't listed", !brand(ids.T) && S.totalBrands === 2);
  check("…totals: 5170 revenue, 7 sales, 4 different students (Sana used two brands: once)", S.totalRevenue === 5170 && S.totalRedemptions === 7 && S.uniqueStudents === 4 && S.totalSaved === 1130, JSON.stringify(S));
  check("…a deleted brand: its archived redemption (360)", S.deletedBrands?.totalRevenue === 360 && S.deletedBrands.count === 1);

  // the brand portal (dashboard + savings history) and the admin brand profile
  for (const [k, tok, id] of [["Alpha", BA, ids.A], ["Beta", BB, ids.B]]) {
    r = await call("/api/offers/savings-report", tok);
    const rows = Array.isArray(r.json) ? r.json : [];
    note(`brandPortal.${k}`, { rows: rows.length, revenueFromTdc: sum(rows, (x) => (x.bill || 0) - (x.saved || 0)), studentsSaved: sum(rows, (x) => x.saved || 0) });
    r = await call(`/api/offers/brand/${id}/redemptions`, ADMIN);
    note(`adminProfile.${k}`, r.json?.stats || null);
  }
  check("brand portal (Alpha): revenue from tdc 3300 and students saved 700 — the same as admin brand revenue", N["brandPortal.Alpha"].revenueFromTdc === 3300 && N["brandPortal.Alpha"].studentsSaved === 700 && N["brandPortal.Alpha"].rows === 3, JSON.stringify(N["brandPortal.Alpha"]));
  check("brand portal (Beta): 1510 / 390", N["brandPortal.Beta"].revenueFromTdc === 1510 && N["brandPortal.Beta"].studentsSaved === 390);
  check("admin brand profile = brand portal = brand revenue (Alpha 3300, 3 students; online 2, in store 1)", N["adminProfile.Alpha"]?.totalRevenue === 3300 && N["adminProfile.Alpha"].uniqueStudents === 3 && N["adminProfile.Alpha"].onlineCount === 2 && N["adminProfile.Alpha"].inStoreCount === 1, JSON.stringify(N["adminProfile.Alpha"]));
  r = await call("/api/offers/savings-report", BA);
  check("the store order is listed once, as online (Woo)", (r.json || []).filter((x) => x.bill === 2000).length === 1 && (r.json || []).find((x) => x.bill === 2000)?.platform === "woocommerce");

  // the metrics page: the same revenue
  r = await call("/api/analytics/admin/metrics?preset=30d", ADMIN);
  note("metrics.revenue", r.json?.data?.groups?.brands?.revenue?.value); note("metrics.redemptions", r.json?.data?.groups?.brands?.redemptions?.value);
  check("metrics page revenue = brand revenue total (5170, 7 sales): one version", N["metrics.revenue"] === 5170 && N["metrics.redemptions"] === 7);

  // card revenue
  r = await call("/api/admin/card-stats", ADMIN);
  note("cards.totalRevenue", r.json?.totalRevenue); note("cards.approvedTotal", r.json?.approvedTotal);
  check("card revenue: not tracked (no payment amount is recorded), not approved cards × 750", r.json?.totalRevenue === null && r.json?.revenueTracked === false && r.json?.approvedTotal === 2);

  // ===== user counts (dashboard): before = list lengths; after = the metrics call
  for (const role of ["student", "brand", "employee", "traveler"]) { r = await call(`/api/admin/users/${role}`, ADMIN); note(`users.list.${role}`, Array.isArray(r.json) ? r.json.length : r.json?.users?.length ?? null); }
  r = await call("/api/analytics/admin/metrics?preset=today", ADMIN);
  note("users.metrics", r.json?.data?.users || null);
  const U = r.json?.data?.users || {};
  check("user counts: students 4 active (suspended and test out), 5 including suspended", U.student?.active === 4 && U.student.includingSuspended === 5 && U.student.suspended === 1, JSON.stringify(U.student));
  check("…brands 2 (test brand out), employers 1 (+1 banned), travelers 1", U.brand?.active === 2 && U.employee?.active === 1 && U.employee.includingSuspended === 2 && U.traveler?.active === 1);

  // ===== engagement (last 2 weeks)
  r = await call("/api/admin/engagement/metrics?weeks=2", ADMIN);
  const E = r.json || {};
  for (const k of ["activeUsers", "pushSent", "pushOpened", "pushFailed", "pushQueued", "pushAwaitingReceipt", "rewardsRedeemed", "codesIssued", "totalReferrals", "studentsWhoInvited", "invitedSignups", "totalProfiles"]) note(`engagement.${k}`, E[k]);
  check("active users follow the range: 1 in 2 weeks (20- and 40-day-old activity and the test account out)", E.activeUsers === 1);
  check("push sent = delivered only: 1; failed 1, queued 1, sent without receipt 1; opened 1 (test account out)", E.pushSent === 1 && E.pushFailed === 1 && E.pushQueued === 1 && E.pushAwaitingReceipt === 1 && E.pushOpened === 1, JSON.stringify(E).slice(0, 300));
  check("rewards redeemed = codes used in the range: 2 (one taken long ago); codes issued 2 (test out)", E.rewardsRedeemed === 2 && E.codesIssued === 2);
  check("students who invited someone: 2 (Sana, Omar — from who signed up with their code, not the counter); invited sign-ups in range: 1", E.totalReferrals === 2 && E.studentsWhoInvited === 2 && E.invitedSignups === 1);
  check("profiles: test account out (4)", E.totalProfiles === 4);
  check("every changed number says what it counts", ["activeUsers", "pushSent", "rewardsRedeemed", "codesIssued", "totalReferrals", "invitedSignups", "examModeActive", "weeklyUsers"].every((k) => E.definitions?.[k]));
  r = await call("/api/admin/engagement/drilldown?kind=metric&key=pushSent&weeks=2", ADMIN);
  check("drilldown 'push sent' lists the delivered push only", r.json?.count === 1 && r.json.items[0]._id === String(ids.s1));
  r = await call("/api/admin/engagement/drilldown?kind=metric&key=rewardsRedeemed&weeks=2", ADMIN);
  check("drilldown 'rewards redeemed' lists the used codes (test account out)", r.json?.count === 2 && !r.json.items.some((i) => i._id === String(ids.s5)));
  r = await call("/api/admin/engagement/drilldown?kind=metric&key=totalReferrals&weeks=2", ADMIN);
  check("drilldown 'students who invited someone': Sana (2), Omar (1)", r.json?.count === 2 && /2 signed up/.test(r.json.items[0].detail));
  r = await call("/api/admin/engagement/drilldown?kind=metric&key=activeUsers&weeks=2", ADMIN);
  check("drilldown 'active users': the range, test accounts never listed", r.json?.count === 1);

  // ===== Karachi time (fixed clock)
  if (AFTER) {
    console.log("-- Karachi time (fixed clock)");
    const EM = reqS("./services/analytics/engagementMetrics");
    const at1am = new Date("2026-10-07T20:00:00Z"); // 01:00 on Oct 8 in Karachi
    const EP = reqS("./models/EngagementProfile");
    await EP.create([{ user: oid(), streak: { examModeUntil: "2026-10-07" } }, { user: oid(), streak: { examModeUntil: "2026-10-08" } }]);
    const oldFormula = at1am.toISOString().slice(0, 10);
    const before = await EP.countDocuments({ "streak.examModeUntil": { $gte: oldFormula } });
    const EE = reqS("./models/EngagementEvent");
    const real = EE.aggregate;
    let pipe = null;
    // Sunday Oct 4 and Monday Oct 5 in Karachi; Monday 02:00 Karachi is still Sunday in UTC
    EE.aggregate = (p) => { if (p[1]?.$group?._id?.$dateToString) { pipe = p; return Promise.resolve([{ _id: "2026-10-04", users: [ids.s1, ids.s2] }, { _id: "2026-10-05", users: [ids.s1, ids.s5] }]); } return Promise.resolve([]); };
    const d = await EM.engagementMetrics({ weeks: 2 }, { now: at1am });
    EE.aggregate = real;
    note("examMode.oldFormula", before); note("examMode.karachi", d.examModeActive);
    check("exam mode active uses the Karachi date: at 01:00 Oct 8 a mode until Oct 7 is over (old UTC formula still counted it)", d.examModeActive === 1 && before === 2, `${d.examModeActive} vs ${before}`);
    check("the weekly chart groups by the Karachi date in the database", pipe?.[1]?.$group?._id?.$dateToString?.timezone === "Asia/Karachi");
    note("weeklyUsers", d.weeklyUsers);
    check("…and folds Karachi days into Monday–Sunday weeks: week of Sep 28 = 2 users, week of Oct 5 = 1 (test account out)", d.weeklyUsers.length === 2 && d.weeklyUsers[0].weekStart === "2026-09-28" && d.weeklyUsers[0].users === 2 && d.weeklyUsers[1].weekStart === "2026-10-05" && d.weeklyUsers[1].users === 1 && d.weeklyUsers[1]._id.week === 41, JSON.stringify(d.weeklyUsers));
    check("the range is whole Karachi days: 2 weeks from Sep 25 to Oct 8", d.range.fromDay === "2026-09-25" && d.range.toDay === "2026-10-08");
    const { isoWeekOf } = EM;
    check("ISO weeks: Jan 1 2027 (Friday) is week 53 of 2026; Dec 28 2026 is week 53", isoWeekOf("2027-01-01").week === 53 && isoWeekOf("2027-01-01").year === 2026 && isoWeekOf("2026-12-28").week === 53);
    // brand sales: pure rules
    const { rowsFrom, figures } = reqS("./services/brandSales");
    const f = figures(rowsFrom([{ _id: "o", brand: "b", redemptions: [{ _id: "r", student: "s", billAmount: 100, savedAmount: 10, promoCode: "x1", redeemedAt: new Date() }] }], [{ _id: "p", brand: "b", code: "X1", student: "s", externalAmount: 100, discountPercentage: 10, usedAt: new Date() }]));
    check("a redemption that only carries the code (no promoCodeId) still matches its promo code (any case): one sale", f.totalRedemptions === 1 && f.totalRevenue === 90);
  }

  check("no 500s", !statuses.some((x) => x.status >= 500), statuses.filter((x) => x.status >= 500).map((x) => x.url).join(" "));
  console.log("NUMBERS " + JSON.stringify(N));
  server.close();
  if (!AFTER) { console.log("\n(before: numbers only)"); process.exit(0); }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
