// Admin metrics + brand approvals (feat/admin-approvals-metrics), on fixed in-memory data:
//   metrics: Karachi day boundaries (a sign-up at 00:30 Karachi counts that day, one at 00:10 the next day doesn't),
//   deleted accounts (a placeholder id that no longer exists) and test accounts (METRICS_TEST_* variables) left out
//   everywhere, the previous period and the change, snapshots, top 5 lists (cohorts under 5 hidden), "needs your
//   action" counts, presets, bad ranges, admin only.
//   brand approvals: search (brand / owner / email / phone / city / category, any case, regex characters safe),
//   filters, sort, 25 per page, tab counts; approve / reject (reason required) / request info (reason required,
//   notifies, status unchanged) / bulk with one reason — each logged with the admin; admin only; /approved and
//   /stats reachable again.
//   node tests/admin-metrics/run.js [serverDir]
// No database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "METRICS_TEST_EMAILS", "METRICS_TEST_EMAIL_DOMAINS", "METRICS_TEST_USER_IDS"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
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
  { cloudinary: { config: () => ({ cloud_name: "testcloud" }), uploader: { destroy: async () => ({ result: "ok" }) }, url: () => "" }, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
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
const MODELS = ["User", "University", "Offer", "Branch", "RedemptionArchive", "LoyaltyLedger", "LoyaltyReward", "SurplusListing", "SurplusOrder", "Job", "JobApplication", "Post", "Confession", "PushLog", "EngagementProfile", "EmployerCompanyVerification", "CareerRatingReport", "CareerApplicationEvent", "AdminActionLog", "Notification"];
for (const m of MODELS) reqS(`./models/${m}`);
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
const rows = (name) => fake.dump ? fake.dump(coll(name)) : null;

const responses = [];
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => { responses.push({ url: req.originalUrl, status: res.statusCode, text: typeof body === "string" ? body : JSON.stringify(body) }); return send(body); };
  next();
});
app.use("/api/analytics", reqS("./routes/analytics.routes"));
app.use("/api/brand-approval", reqS("./routes/brandApproval.routes"));

// ---------- fixed data ----------
const oid = () => new mongoose.Types.ObjectId();
const K = (s) => new Date(`${s}+05:00`); // a Karachi wall-clock time
const ids = {};
for (const k of ["admin", "admin2", "s1", "s2", "s3", "s4", "s5", "s6", "A", "C", "T", "P", "R", "E", "U1", "U2", "ghost", "offerA", "offerC", "offerT", "offerX"]) ids[k] = oid();
const crew = Array.from({ length: 5 }, () => oid()); // s7..s11: 5 students at U2 who redeem at brand C
const bulk = Array.from({ length: 26 }, () => oid()); // pending brands for paging
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name.toLowerCase().replace(/\W+/g, "")}@real.pk`, password: "x", role, status: "Verified", accountStatus: "active", createdAt: K("2026-08-01T12:00:00"), updatedAt: new Date(), ...extra });
const brand = (id, brandName, extra = {}) => user(id, "brand", `${brandName} Owner`, { brandName, city: "Karachi", category: "Food", logo: "", brandApprovalStatus: "approved", ...extra });
fake.seed(coll("University"), [{ _id: ids.U1, name: "Uni One" }, { _id: ids.U2, name: "Uni Two" }]);
fake.seed(coll("User"), [
  user(ids.admin, "admin", "Ayesha Admin"), user(ids.admin2, "admin", "Bilal Admin"),
  user(ids.s1, "student", "Sana", { createdAt: K("2026-10-01T00:30:00"), university: ids.U1 }), // Karachi Oct 1 (UTC Sept 30)
  user(ids.s2, "student", "Omar", { createdAt: K("2026-10-07T23:30:00"), university: ids.U1, status: "Pending" }),
  user(ids.s3, "student", "Hina", { createdAt: K("2026-10-08T00:10:00"), status: "Not Verified" }), // Karachi Oct 8 (UTC Oct 7): out
  user(ids.s4, "student", "Ali", { createdAt: K("2026-09-25T12:00:00") }), // previous period
  user(ids.s5, "student", "Tester", { email: "qa1@tdc.test", createdAt: K("2026-10-03T12:00:00") }), // a test account
  user(ids.s6, "student", "Fatima", { createdAt: K("2026-10-02T12:00:00") }),
  ...crew.map((id, i) => user(id, "student", `Crew${i}`, { university: ids.U2 })),
  brand(ids.A, "Alpha Cafe", { brandApprovedAt: K("2026-10-02T10:00:00") }),
  brand(ids.C, "Crust Pizza", { city: "Lahore", brandApprovedAt: K("2026-08-02T10:00:00"), createdAt: K("2026-07-01T10:00:00") }),
  brand(ids.T, "QA Brand", { email: "brand@tdc.test" }),
  brand(ids.P, "Pending Perfumes", { name: "Zara Khan", email: "zara@perf.pk", phone: "03211234567", category: "Fashion", brandApprovalStatus: "pending", createdAt: K("2026-10-05T10:00:00") }),
  brand(ids.R, "Rejected Rugs", { city: "Islamabad", category: "Home", brandApprovalStatus: "rejected", brandRejectedAt: K("2026-09-01T10:00:00"), brandApprovalNote: "blurry logo", createdAt: K("2026-06-01T10:00:00") }),
  ...bulk.map((id, i) => brand(id, `Bulk Brand ${String(i).padStart(2, "0")}`, { brandApprovalStatus: "pending", createdAt: K(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00`) })),
  user(ids.E, "employee", "HireCo"),
]);
const red = (student, at, bill, saved) => ({ _id: oid(), student, billAmount: bill, savedAmount: saved, redeemedAt: K(at) });
fake.seed(coll("Offer"), [
  { _id: ids.offerA, brand: ids.A, title: "Alpha 20%", status: "active", archivedAt: null, createdAt: K("2026-08-01T10:00:00"), claimedBy: [{ user: ids.s3, claimedAt: K("2026-10-03T10:00:00") }], redemptions: [
    red(ids.s1, "2026-10-02T13:00:00", 1000, 200), red(ids.s2, "2026-10-03T13:00:00", 500, 100), red(ids.ghost, "2026-10-03T14:00:00", 999, 0),
    red(ids.s5, "2026-10-04T13:00:00", 700, 70), red(ids.s6, "2026-09-26T13:00:00", 400, 40),
    red(ids.s1, "2026-10-07T23:50:00", 300, 0), red(ids.s1, "2026-10-08T00:05:00", 5000, 0),
  ] },
  { _id: ids.offerC, brand: ids.C, title: "Crust 10%", status: "active", archivedAt: null, createdAt: K("2026-08-01T10:00:00"), redemptions: crew.map((s, i) => red(s, `2026-10-0${2 + i}T15:00:00`, 100, 10)) },
  { _id: ids.offerT, brand: ids.T, title: "QA offer", status: "active", archivedAt: null, createdAt: K("2026-08-01T10:00:00"), redemptions: [red(ids.s6, "2026-10-02T15:00:00", 9000, 900)] },
  { _id: ids.offerX, brand: ids.A, title: "Old Alpha", status: "archived", archivedAt: K("2026-09-01T10:00:00"), createdAt: K("2026-07-01T10:00:00"), redemptions: [] },
]);
fake.seed(coll("Branch"), [
  { _id: oid(), brand: ids.A, name: "Alpha Clifton", city: "Karachi", isActive: true, createdAt: new Date() },
  { _id: oid(), brand: ids.A, name: "Alpha DHA", city: "Karachi", isActive: true, createdAt: new Date() },
  { _id: oid(), brand: ids.P, name: "Perfumes Dolmen", city: "Karachi", isActive: true, createdAt: new Date() },
]);
fake.seed(coll("RedemptionArchive"), [
  { _id: oid(), kind: "redemption", deletionId: "d1", redemptionId: oid(), student: ids.s2, billAmount: 600, savedAmount: 100, redeemedAt: K("2026-10-05T12:00:00") },
  { _id: oid(), kind: "brand-totals", deletionId: "d1", totalRedemptions: 99 },
]);
const led = (type, student, delta, at, b = ids.A) => ({ _id: oid(), program: oid(), programVersion: 1, brand: b, student, type, visitsDelta: delta, redemptionId: oid(), idempotencyKey: `k${Math.random()}`, effectiveAt: K(at) });
fake.seed(coll("LoyaltyLedger"), [
  led("CREDIT", ids.s1, 1, "2026-10-02T13:00:00"), led("CREDIT", ids.s2, 1, "2026-10-03T13:00:00"), led("CREDIT", ids.s2, 0, "2026-10-03T14:00:00"),
  led("REVERSAL", ids.s2, -1, "2026-10-04T10:00:00"), led("CREDIT", ids.ghost, 1, "2026-10-03T13:00:00"), led("CREDIT", ids.s6, 1, "2026-09-26T13:00:00"),
]);
fake.seed(coll("LoyaltyReward"), [
  { _id: oid(), program: oid(), brand: ids.A, student: ids.s1, status: "available", earnedAt: K("2026-10-03T10:00:00"), usedAt: null, cycleKey: "1" },
  { _id: oid(), program: oid(), brand: ids.A, student: ids.s2, status: "void", earnedAt: K("2026-10-04T10:00:00"), usedAt: null, cycleKey: "2" },
  { _id: oid(), program: oid(), brand: ids.A, student: ids.s1, status: "used", earnedAt: K("2026-09-20T10:00:00"), usedAt: K("2026-10-05T10:00:00"), cycleKey: "3" },
]);
fake.seed(coll("SurplusListing"), [
  { _id: oid(), brand: ids.A, branch: oid(), quantityTotal: 10, createdAt: K("2026-10-02T09:00:00") },
  { _id: oid(), brand: ids.T, branch: oid(), quantityTotal: 99, createdAt: K("2026-10-02T09:00:00") },
]);
const order = (student, state, at, extra = {}) => ({ _id: oid(), listing: oid(), brand: ids.A, branch: oid(), student, qty: 1, state, createdAt: K(at), ...extra });
fake.seed(coll("SurplusOrder"), [
  order(ids.s1, "COMPLETED", "2026-10-02T10:00:00", { pickupCodeUsedAt: K("2026-10-02T18:00:00") }),
  order(ids.s2, "NO_SHOW", "2026-10-03T10:00:00"), order(ids.s6, "DISPUTED", "2026-10-04T10:00:00", { stateBeforeDispute: "NO_SHOW" }),
  order(ids.ghost, "COMPLETED", "2026-10-04T10:00:00", { pickupCodeUsedAt: K("2026-10-04T18:00:00") }),
]);
fake.seed(coll("Job"), [
  { _id: oid(), title: "Barista", postedBy: ids.E, isExternal: false, createdAt: K("2026-10-03T10:00:00") },
  { _id: oid(), title: "Imported", postedBy: null, isExternal: true, createdAt: K("2026-10-04T10:00:00") },
  { _id: oid(), title: "Gone employer", postedBy: ids.ghost, isExternal: false, createdAt: K("2026-10-04T10:00:00") },
]);
const appHire = oid(), appDispute = oid();
fake.seed(coll("JobApplication"), [
  { _id: appHire, userId: ids.s1, jobId: oid(), status: "accepted", appliedAt: K("2026-10-03T10:00:00") },
  { _id: oid(), userId: ids.ghost, jobId: oid(), status: "pending", appliedAt: K("2026-10-03T10:00:00") },
  { _id: oid(), userId: ids.s3, jobId: oid(), status: "pending", appliedAt: K("2026-10-08T00:20:00") },
  { _id: appDispute, userId: ids.s6, jobId: oid(), status: "accepted", appliedAt: K("2026-09-01T10:00:00") },
]);
const ev = (application, seq, type, at) => ({ _id: oid(), application, job: oid(), candidate: ids.s1, employer: ids.E, seq, type, actorRole: "system", source: "app", idempotencyKey: `e${Math.random()}`, occurredAt: K(at), metadata: {} });
fake.seed(coll("CareerApplicationEvent"), [
  ev(appHire, 1, "APPLIED", "2026-10-03T10:00:00"), ev(appHire, 2, "INTERVIEW_INVITED", "2026-10-03T11:00:00"), ev(appHire, 3, "INTERVIEW_ACCEPTED", "2026-10-03T12:00:00"),
  ev(appHire, 4, "INTERVIEW_COMPLETED", "2026-10-04T12:00:00"), ev(appHire, 5, "OFFER_SENT", "2026-10-05T12:00:00"), ev(appHire, 6, "OFFER_ACCEPTED", "2026-10-05T13:00:00"), ev(appHire, 7, "HIRE_CONFIRMED", "2026-10-06T12:00:00"),
  ev(appDispute, 1, "APPLIED", "2026-09-01T10:00:00"), ev(appDispute, 2, "OFFER_SENT", "2026-09-02T10:00:00"), ev(appDispute, 3, "OFFER_ACCEPTED", "2026-09-02T11:00:00"), ev(appDispute, 4, "HIRE_CONFIRMED", "2026-09-03T10:00:00"), ev(appDispute, 5, "HIRE_DISPUTED", "2026-09-04T10:00:00"),
]);
fake.seed(coll("Post"), [{ _id: oid(), user: ids.s1, createdAt: K("2026-10-02T10:00:00") }, { _id: oid(), user: ids.ghost, createdAt: K("2026-10-02T10:00:00") }, { _id: oid(), user: ids.s5, createdAt: K("2026-10-02T10:00:00") }, { _id: oid(), user: ids.s1, createdAt: K("2026-09-28T10:00:00") }]);
fake.seed(coll("Confession"), [{ _id: oid(), user: ids.s2, university: ids.U1, createdAt: K("2026-10-02T10:00:00") }]);
const NOW = K("2026-10-07T12:00:00");
const DAY = 864e5;
fake.seed(coll("PushLog"), [
  { _id: oid(), user: ids.s1, status: "sent", sentAt: K("2026-10-02T10:00:00"), openedAt: K("2026-10-02T10:05:00"), createdAt: K("2026-10-02T10:00:00") },
  { _id: oid(), user: ids.s2, status: "failed", sentAt: new Date(NOW - 2 * DAY), openedAt: null, createdAt: new Date(NOW - 2 * DAY) },
  { _id: oid(), user: ids.s2, status: "failed", sentAt: new Date(NOW - 10 * DAY), openedAt: null, createdAt: new Date(NOW - 10 * DAY) },
]);
const prof = (u, daysAgo) => ({ _id: oid(), user: u, stats: { lastActiveAt: new Date(NOW - daysAgo * DAY) } });
fake.seed(coll("EngagementProfile"), [prof(ids.s1, 2), prof(ids.s2, 10), prof(ids.s6, 40), prof(ids.s5, 1), prof(ids.ghost, 1), ...crew.map((c) => prof(c, 3))]);
fake.seed(coll("EmployerCompanyVerification"), [{ _id: oid(), employerUserId: ids.E, status: "pending", history: [] }, { _id: oid(), employerUserId: oid(), status: "approved", history: [] }]);
fake.seed(coll("CareerRatingReport"), [{ _id: oid(), status: "open" }, { _id: oid(), status: "kept" }]);

const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });
let PORT;
function call(method, url, { tok, body } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) };
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const same = (a, b) => String(a) === String(b);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { admin: token(ids.admin, "admin"), admin2: token(ids.admin2, "admin"), S: token(ids.s1, "student"), B: token(ids.A, "brand") };
  const M = reqS("./services/analytics/adminMetrics");
  let r;

  console.log("-- ranges (Karachi)");
  const at1am = new Date("2026-10-07T20:00:00Z"); // 01:00 on Oct 8 in Karachi
  let g = M.rangeOf({ preset: "today" }, at1am);
  check("today at 01:00 Karachi (20:00 UTC the day before) is the Karachi day: Oct 8 00:00 +05:00", g.from.toISOString() === "2026-10-07T19:00:00.000Z" && g.days === 1, g.from.toISOString());
  g = M.rangeOf({ preset: "7d" }, at1am);
  check("7d = 7 whole Karachi days (Oct 2–8); previous = Sept 25–Oct 1", g.days === 7 && g.from.toISOString() === "2026-10-01T19:00:00.000Z" && g.previous.from.toISOString() === "2026-09-24T19:00:00.000Z" && g.previous.to.toISOString() === "2026-10-01T18:59:59.999Z");
  g = M.rangeOf({ preset: "month" }, at1am);
  check("this month starts Oct 1 00:00 Karachi", g.from.toISOString() === "2026-09-30T19:00:00.000Z" && g.days === 8);
  g = M.rangeOf({ preset: "30d" }, at1am);
  check("30d = 30 days", g.days === 30);
  g = M.rangeOf({ from: "2026-10-01", to: "2026-10-07" });
  check("custom Oct 1–7: 7 days, previous Sept 24–30", g.preset === "custom" && g.days === 7 && g.previous.from.toISOString() === "2026-09-23T19:00:00.000Z");
  for (const [q, label] of [[{ preset: "custom", from: "2026-10-07", to: "2026-10-01" }, "ends before it starts"], [{ preset: "custom", from: "nope", to: "2026-10-01" }, "not a date"], [{ preset: "custom", from: "2024-01-01", to: "2026-01-01" }, "over a year"]]) {
    let code = null; try { M.rangeOf(q); } catch (e) { code = e.status; }
    check(`a bad custom range (${label}) → 400`, code === 400);
  }

  console.log("-- metrics (test accounts not configured: only deleted accounts left out)");
  let d = await M.adminMetrics({ from: "2026-10-01", to: "2026-10-07" }, { now: NOW });
  check("sign-ups: 4 in Karachi Oct 1–7 (00:30 Oct 1 in; 00:10 Oct 8 out); the test account counts while not configured", d.groups.students.signups.value === 4, JSON.stringify(d.groups.students.signups));
  check("exclusions say how test accounts are found, and that none are configured", d.exclusions.test.configured === false && /METRICS_TEST_EMAILS/.test(d.exclusions.test.how));

  process.env.METRICS_TEST_EMAIL_DOMAINS = "tdc.test";
  d = await M.adminMetrics({ from: "2026-10-01", to: "2026-10-07" }, { now: NOW });
  const G = d.groups;
  console.log("-- metrics (METRICS_TEST_EMAIL_DOMAINS=tdc.test)");
  check("students: sign-ups 3 (test account out), previous 1 (Sept 25), change +2 (+200%)", G.students.signups.value === 3 && G.students.signups.previous === 1 && G.students.signups.change.delta === 2 && G.students.signups.change.pct === 200, JSON.stringify(G.students.signups));
  check("students: verified now 8 (10 real students, 2 not verified); a snapshot with no previous period", G.students.verified.value === 8 && G.students.verified.previous === null && G.students.verified.snapshot === true, JSON.stringify(G.students.verified));
  check("students: active 7 days = 6, 30 days = 7 (deleted profile, test account and 40-day-old activity out)", G.students.active7.value === 6 && G.students.active30.value === 7, `${G.students.active7.value}/${G.students.active30.value}`);
  check("brands: approved now 2 (the test brand out); newly approved in range 1", G.brands.approvedBrands.value === 2 && G.brands.newlyApproved.value === 1 && G.brands.newlyApproved.previous === 0, JSON.stringify([G.brands.approvedBrands.value, G.brands.newlyApproved]));
  check("brands: live offers 3 (archived out)", G.brands.activeOffers.value === 3, String(G.brands.activeOffers.value));
  check("brands: redemptions 9 — deleted student, test student, test brand, 00:05 Oct 8 and Sept 26 out; 23:50 Oct 7 and a deleted brand's archived one in; the claim isn't one", G.brands.redemptions.value === 9 && G.brands.redemptions.previous === 1, JSON.stringify(G.brands.redemptions));
  check("brands: revenue = bill − discount = 800 + 400 + 300 + 500 + 5×90 = 2450 PKR; previous 360", G.brands.revenue.value === 2450 && G.brands.revenue.previous === 360 && G.brands.revenue.unit === "PKR", JSON.stringify(G.brands.revenue));
  check("loyalty: members 2, visits 1 (2 counted − 1 reversed; the 0-visit credit and the deleted student out); previous 1 / 1", G.loyalty.members.value === 2 && G.loyalty.visits.value === 1 && G.loyalty.members.previous === 1 && G.loyalty.visits.previous === 1, JSON.stringify([G.loyalty.members, G.loyalty.visits].map((x) => [x.value, x.previous])));
  check("loyalty: rewards earned 1 (voided out), used 1", G.loyalty.rewardsEarned.value === 1 && G.loyalty.rewardsUsed.value === 1);
  check("Surprise Box: 10 boxes listed (test brand's 99 out), 3 orders, 1 pickup, 2 no-shows (one disputed) — deleted student's order out", G.surpriseBox.boxesListed.value === 10 && G.surpriseBox.orders.value === 3 && G.surpriseBox.pickups.value === 1 && G.surpriseBox.noShows.value === 2, JSON.stringify(Object.fromEntries(Object.entries(G.surpriseBox).map(([k, v]) => [k, v.value]))));
  check("careers: 2 jobs (external in, deleted employer out), 1 application (deleted student and Oct 8 00:20 out), 1 interview, 1 hire", G.careers.jobs.value === 2 && G.careers.applications.value === 1 && G.careers.interviews.value === 1 && G.careers.hires.value === 1, JSON.stringify(Object.fromEntries(Object.entries(G.careers).map(([k, v]) => [k, v.value]))));
  check("engagement: posts 1 (deleted + test out; previous 1), confessions 1, push opens 1", G.engagement.posts.value === 1 && G.engagement.posts.previous === 1 && G.engagement.confessions.value === 1 && G.engagement.pushOpens.value === 1);
  check("every metric has a definition (the 'i' tooltip)", Object.values(G).every((grp) => Object.values(grp).every((m) => typeof m.definition === "string" && m.definition.length > 10)));
  check("top brands: Crust Pizza (5 students, 5 redemptions); Alpha hidden (under 5 students)", d.topBrands.length === 1 && same(d.topBrands[0].id, ids.C) && d.topBrands[0].redemptions === 5 && d.topBrands[0].name === "Crust Pizza", JSON.stringify(d.topBrands));
  check("top universities: Uni Two (5 active); Uni One hidden (under 5)", d.topUniversities.length === 1 && d.topUniversities[0].name === "Uni Two" && d.topUniversities[0].activeStudents === 5, JSON.stringify(d.topUniversities));
  check("series: 7 Karachi days; sign-ups Oct 1 = 1, Oct 7 = 1; redemptions Oct 7 = 1 (the 23:50 one)", d.series.signups.length === 7 && d.series.signups[0].day === "2026-10-01" && d.series.signups[0].count === 1 && d.series.signups[6].count === 1 && d.series.redemptions[6].count === 1, JSON.stringify(d.series.signups));
  check("series totals match the cards (one calculation)", d.series.signups.reduce((s, x) => s + x.count, 0) === G.students.signups.value && d.series.redemptions.reduce((s, x) => s + x.count, 0) === G.brands.redemptions.value);
  check("hiring funnel: 1 application → 1 interview → 1 offer → 1 hire", d.funnel.interviews === 1 && d.funnel.offers === 1 && d.funnel.hires === 1, JSON.stringify(d.funnel));
  const N = d.needsAction;
  check("needs your action: 27 pending brands, 2 student verifications, 1 company verification, 1 open hire dispute, 1 ratings report, 1 failed push (last 7 days)", N.brandApprovals === 27 && N.studentVerifications === 2 && N.companyVerifications === 1 && N.hireDisputes === 1 && N.ratingsReports === 1 && N.failedPushes === 1, JSON.stringify(N));
  check("range labels in Karachi days", d.range.fromDay === "2026-10-01" && d.range.toDay === "2026-10-07" && d.previous.fromDay === "2026-09-24" && d.previous.toDay === "2026-09-30" && d.timeZone === "Asia/Karachi");

  process.env.METRICS_TEST_USER_IDS = String(ids.s1);
  d = await M.adminMetrics({ from: "2026-10-01", to: "2026-10-07" }, { now: NOW });
  check("METRICS_TEST_USER_IDS: listing a student removes their sign-up and redemptions", d.groups.students.signups.value === 2 && d.groups.brands.redemptions.value === 7, `${d.groups.students.signups.value} / ${d.groups.brands.redemptions.value}`);
  delete process.env.METRICS_TEST_USER_IDS;
  process.env.METRICS_TEST_EMAILS = "sana@real.pk";
  d = await M.adminMetrics({ from: "2026-10-01", to: "2026-10-07" }, { now: NOW });
  check("METRICS_TEST_EMAILS: the same, by e-mail", d.groups.students.signups.value === 2);
  delete process.env.METRICS_TEST_EMAILS;

  console.log("-- metrics endpoint");
  r = await call("GET", "/api/analytics/admin/metrics?preset=7d", { tok: T.S });
  check("a student → 403", r.status === 403);
  r = await call("GET", "/api/analytics/admin/metrics?preset=7d", { tok: T.B });
  check("a brand → 403", r.status === 403);
  r = await call("GET", "/api/analytics/admin/metrics?preset=7d");
  check("signed out → 401", r.status === 401);
  r = await call("GET", "/api/analytics/admin/metrics?from=2026-10-01&to=2026-10-07", { tok: T.admin });
  check("admin → 200 with the same figures as the service", r.status === 200 && r.json.data.groups.brands.redemptions.value === 9 && r.json.data.groups.students.signups.value === 3, r.text.slice(0, 200));
  r = await call("GET", "/api/analytics/admin/metrics?from=2026-10-07&to=2026-10-01", { tok: T.admin });
  check("a bad range → 400 INVALID_RANGE", r.status === 400 && r.json.error.code === "INVALID_RANGE");
  const metricText = responses.filter((x) => x.url.includes("/admin/metrics")).map((x) => x.text).join(" ");
  check("no student names or e-mails in metrics replies", !/Sana|Omar|Fatima|@real\.pk|@tdc\.test/.test(metricText));

  console.log("-- brand approvals: list");
  const list = async (qs) => (await call("GET", `/api/brand-approval?${qs}`, { tok: T.admin })).json;
  r = await call("GET", "/api/brand-approval", { tok: T.S });
  check("a student → 403", r.status === 403);
  let j = await list("");
  check("25 per page, 31 brands, 2 pages", j.brands.length === 25 && j.total === 31 && j.pages === 2 && j.limit === 25, `${j.brands?.length} ${j.total}`);
  check("tab counts: all 31, pending 27, approved 3, rejected 1", j.counts.all === 31 && j.counts.pending === 27 && j.counts.approved === 3 && j.counts.rejected === 1, JSON.stringify(j.counts));
  check("newest first", j.brands[0].brandName === "Pending Perfumes");
  j = await list("page=2");
  check("page 2: the last 6", j.brands.length === 6 && j.page === 2);
  const row = (await list("q=perfumes")).brands[0];
  check("a row has logo, name, category, city, joined date, branches 1, offers 0, status", row && "logo" in row && row.category === "Fashion" && row.city === "Karachi" && row.createdAt && row.branchesCount === 1 && row.offersCount === 0 && row.brandApprovalStatus === "pending", JSON.stringify(row));
  const alpha = (await list("q=alpha")).brands[0];
  check("Alpha: 2 branches, 1 live offer (archived one not counted)", alpha.branchesCount === 2 && alpha.offersCount === 1);
  for (const [q, want, label] of [["ZARA", ids.P, "owner name, any case"], ["zara%40perf", ids.P, "email"], ["0321123", ids.P, "phone"], ["lahore", ids.C, "city"], ["fashion", ids.P, "category"], ["crust", ids.C, "brand name"]]) {
    j = await list(`q=${q}`);
    check(`search by ${label} ("${decodeURIComponent(q)}")`, j.brands.length === 1 && same(j.brands[0]._id, want), j.brands.map((b) => b.brandName).join());
  }
  j = await list("q=" + encodeURIComponent("(.*"));
  check("regex characters are searched literally (no error, no match-all)", j.brands.length === 0 && j.success === true);
  j = await list("q=bulk&status=pending");
  check("search + status: 26 pending 'bulk' brands; tab counts follow the search (approved 0)", j.total === 26 && j.counts.pending === 26 && j.counts.approved === 0 && j.counts.all === 26, JSON.stringify(j.counts));
  j = await list("status=approved&city=lahore");
  check("filter: approved in Lahore → Crust Pizza", j.total === 1 && same(j.brands[0]._id, ids.C));
  j = await list("category=Home");
  check("filter: category Home → Rejected Rugs", j.total === 1 && same(j.brands[0]._id, ids.R));
  j = await list("joinedFrom=2026-10-01&joinedTo=2026-10-31");
  check("filter: joined in October (Karachi) → Pending Perfumes only", j.total === 1 && same(j.brands[0]._id, ids.P), j.brands.map((b) => b.brandName).join());
  r = await call("GET", "/api/brand-approval?joinedFrom=yesterday", { tok: T.admin });
  check("a bad date → 400", r.status === 400 && r.json.code === "INVALID_DATE");
  j = await list("sort=name&status=approved");
  check("sort by name: Alpha, Crust, QA", j.brands.map((b) => b.brandName).join() === "Alpha Cafe,Crust Pizza,QA Brand");
  j = await list("sort=oldest");
  check("sort oldest first: Rejected Rugs (June)", j.brands[0].brandName === "Rejected Rugs");
  check("filter options: cities and categories", j.options.cities.includes("Lahore") && j.options.categories.includes("Fashion"));
  r = await call("GET", "/api/brand-approval/approved");
  check("/approved is reachable again (public, no email / phone)", r.status === 200 && Array.isArray(r.json.brands) && r.json.brands.length === 3 && !/email|phone/.test(JSON.stringify(r.json.brands)), r.text.slice(0, 120));
  r = await call("GET", "/api/brand-approval/stats", { tok: T.admin });
  check("/stats is reachable again (admin)", r.status === 200 && r.json.stats.pending === 27);
  r = await call("GET", "/api/brand-approval/stats", { tok: T.S });
  check("/stats: a student → 403", r.status === 403);

  console.log("-- brand approvals: actions");
  const logRows = () => fake.find ? null : null; void logRows;
  const AdminActionLog = reqS("./models/AdminActionLog");
  const Notification = reqS("./models/Notification");
  const User = reqS("./models/User");
  r = await call("PUT", `/api/brand-approval/${ids.P}/status`, { tok: T.S, body: { status: "approved" } });
  check("a student can't approve → 403", r.status === 403);
  r = await call("POST", `/api/brand-approval/${ids.P}/request-info`, { tok: T.B, body: { reason: "send your NTN" } });
  check("a brand can't request info → 403", r.status === 403);
  r = await call("PUT", "/api/brand-approval/bulk-status", { tok: T.S, body: { brandIds: [String(ids.P)], status: "approved" } });
  check("a student can't bulk approve → 403", r.status === 403);
  r = await call("PUT", `/api/brand-approval/${ids.P}/status`, { tok: T.admin, body: { status: "rejected" } });
  check("reject without a reason → 400 REASON_REQUIRED, nothing changed or logged", r.status === 400 && r.json.code === "REASON_REQUIRED" && (await User.findById(ids.P).lean()).brandApprovalStatus === "pending" && (await AdminActionLog.countDocuments({})) === 0);
  r = await call("POST", `/api/brand-approval/${ids.P}/request-info`, { tok: T.admin, body: { reason: "  " } });
  check("request info without a reason → 400", r.status === 400 && r.json.code === "REASON_REQUIRED");
  r = await call("POST", `/api/brand-approval/${ids.P}/request-info`, { tok: T.admin, body: { reason: "Please upload a clearer logo" } });
  let L = await AdminActionLog.find({ targetId: String(ids.P) }).lean();
  let notes = await Notification.find({ recipient: ids.P }).lean();
  check("request info: status unchanged, logged with the admin and reason, brand notified with the reason", r.status === 200 && r.json.brand.brandApprovalStatus === "pending" && L.length === 1 && L[0].action === "brand.request_info" && same(L[0].admin, ids.admin) && L[0].reason === "Please upload a clearer logo" && L[0].targetType === "Brand" && notes.length === 1 && /clearer logo/.test(notes[0].description), JSON.stringify(L));
  r = await call("PUT", `/api/brand-approval/${ids.P}/status`, { tok: T.admin2, body: { status: "rejected", reason: "Logo is still unreadable" } });
  check("reject with a reason → the updated row comes back (list updates without a reload)", r.status === 200 && r.json.brand.brandApprovalStatus === "rejected" && r.json.brand.brandRejectedAt);
  r = await call("PUT", `/api/brand-approval/${ids.P}/status`, { tok: T.admin, body: { status: "approved" } });
  check("approve (no reason needed)", r.status === 200 && r.json.brand.brandApprovalStatus === "approved" && r.json.brand.brandApprovedAt && !r.json.brand.brandRejectedAt);
  L = await AdminActionLog.find({ targetId: String(ids.P) }).sort({ at: 1 }).lean();
  check("each action logged: request info, reject (by the second admin, pending → rejected), approve (rejected → approved)", L.length === 3 && L[1].action === "brand.reject" && same(L[1].admin, ids.admin2) && L[1].before.brandApprovalStatus === "pending" && L[1].after.brandApprovalStatus === "rejected" && L[2].action === "brand.approve" && L[2].before.brandApprovalStatus === "rejected", JSON.stringify(L.map((x) => [x.action, x.before, x.after])));
  r = await call("GET", `/api/brand-approval/${ids.P}`, { tok: T.admin });
  const h = r.json.history || [];
  check("detail: business details, 1 branch, offers list, history newest first with admin names and reasons", r.status === 200 && r.json.brand.brandName === "Pending Perfumes" && r.json.branches.length === 1 && Array.isArray(r.json.offers) && h.length === 3 && h[0].action === "brand.approve" && h.some((x) => x.action === "brand.reject" && x.admin.name === "Bilal Admin" && x.reason === "Logo is still unreadable"), JSON.stringify(h).slice(0, 300));
  check("detail has no password", !("password" in r.json.brand));
  r = await call("GET", `/api/brand-approval/${ids.R}`, { tok: T.admin });
  check("an earlier rejection (before logging) shows as history with its date and note, no admin", r.json.history.length === 1 && r.json.history[0].legacy === true && r.json.history[0].reason === "blurry logo" && r.json.history[0].admin === null);
  r = await call("GET", `/api/brand-approval/${oid()}`, { tok: T.admin });
  check("an unknown brand → 404", r.status === 404);
  r = await call("GET", "/api/brand-approval/not-an-id", { tok: T.admin });
  check("a malformed id → 404 (not 500)", r.status === 404);

  console.log("-- brand approvals: bulk");
  r = await call("PUT", "/api/brand-approval/bulk-status", { tok: T.admin, body: { brandIds: [String(bulk[0]), String(bulk[1])], status: "rejected" } });
  check("bulk reject without a reason → 400", r.status === 400 && r.json.code === "REASON_REQUIRED");
  r = await call("PUT", "/api/brand-approval/bulk-status", { tok: T.admin, body: { brandIds: [String(bulk[0]), String(bulk[1]), String(ids.s1)], status: "rejected", reason: "Duplicate sign-ups" } });
  L = await AdminActionLog.find({ action: "brand.reject", reason: "Duplicate sign-ups" }).lean();
  check("bulk reject 2 brands with one reason (a student id ignored): 2 log rows, 2 notifications, rows returned", r.status === 200 && r.json.updatedCount === 2 && r.json.brands.every((b) => b.brandApprovalStatus === "rejected") && L.length === 2 && (await Notification.countDocuments({ recipient: { $in: [bulk[0], bulk[1]] } })) === 2 && (await User.findById(ids.s1).lean()).brandApprovalStatus == null, r.text.slice(0, 200));
  r = await call("PUT", "/api/brand-approval/bulk-status", { tok: T.admin, body: { brandIds: bulk.slice(2, 5).map(String), status: "approved" } });
  check("bulk approve 3 → 3 logged", r.status === 200 && r.json.updatedCount === 3 && (await AdminActionLog.countDocuments({ action: "brand.approve" })) === 4);
  r = await call("PUT", "/api/brand-approval/bulk-status", { tok: T.admin, body: { brandIds: Array.from({ length: 101 }, () => String(oid())), status: "approved" } });
  check("more than 100 at once → 400", r.status === 400);
  j = await list("status=pending");
  check("tab counts after the actions: pending 21 (27 − 1 − 2 − 3)", j.counts.pending === 21, JSON.stringify(j.counts));

  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url + x.text.slice(0, 80)).join(" | "));
  void rows;
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
