// Business analytics (Sprint 6): each card reconciled with the records it comes from; claims, holds,
// scheduled interviews and accepted offers never counted as redemptions / orders / hires; date filter;
// cohorts under 5 students hidden; no student names; role checks (students get nothing new).
//   node tests/analytics/run.js [serverDir]
// and interleaving (simultaneous requests really interleave); no database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
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
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Offer", "RedemptionArchive", "LoyaltyLedger", "SurplusOrder", "SurplusInventoryHold", "CareerApplicationEvent", "EmployerCompanyVerification", "EmployerHiringTrial", "EmployerHiringBillingEvent"]) reqS(`./models/${m}`);

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

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "Bsmall", "E1", "E2", "admin", "S0"]) ids[k] = oid();
const students = Array.from({ length: 12 }, () => oid());
const NAMES = students.map((_, i) => `Zebulon${i}Qx`);
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.A, "brand", "alpha", { brandName: "Alpha Cafe" }), user(ids.Bsmall, "brand", "tiny", { brandName: "Tiny Shop" }),
  user(ids.E1, "employee", "hireco"), user(ids.E2, "employee", "otherco"), user(ids.admin, "admin", "admin"), user(ids.S0, "student", "Zebulon Student"),
  ...students.map((id, i) => user(id, "student", NAMES[i])),
]);
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
// Alpha: 8 students; students 0-2 redeem twice (repeat), 3-7 once; one redemption 60 days ago (out of range);
// 20 claims that never became redemptions
const red = (s, d, bill = 1000) => ({ _id: oid(), student: students[s], billAmount: bill, savedAmount: Math.round(bill * 0.2), redeemedAt: ago(d) });
const alphaRed = [red(0, 2), red(0, 5), red(1, 3), red(1, 4), red(2, 1), red(2, 9), red(3, 2), red(4, 2), red(5, 3), red(6, 3), red(7, 6), red(8, 60)];
const claims = Array.from({ length: 20 }, (_, i) => ({ user: students[i % 12], claimedAt: ago(1) }));
fake.seed(coll("Offer"), [
  { _id: oid(), brand: ids.A, title: "Alpha 20%", discountPercentage: 20, claimedBy: claims, redemptions: alphaRed.slice(0, 6), createdAt: ago(90) },
  { _id: oid(), brand: ids.A, title: "Alpha weekend", discountPercentage: 10, claimedBy: [], redemptions: alphaRed.slice(6), createdAt: ago(90) },
  // a small brand: 2 students (below the cohort threshold)
  { _id: oid(), brand: ids.Bsmall, title: "Tiny 15%", discountPercentage: 15, claimedBy: [], redemptions: [red(9, 2, 500), red(9, 3, 500), red(10, 4, 500)], createdAt: ago(90) },
]);
fake.seed(coll("RedemptionArchive"), [
  { _id: oid(), kind: "redemption", deletionId: "d1", student: students[11], billAmount: 800, savedAmount: 160, redeemedAt: ago(4) },
  { _id: oid(), kind: "redemption", deletionId: "d1", student: students[11], billAmount: 800, savedAmount: 160, redeemedAt: ago(45) },
  { _id: oid(), kind: "brand-totals", deletionId: "d1", totalRedemptions: 99, totalRevenue: 99999 },
]);
const led = (type, s, delta, visit, tier, d, brand = ids.A) => ({ _id: oid(), program: oid(), programVersion: 1, brand, student: students[s], type, visitsDelta: delta, redemptionId: oid(), visitNumber: visit, tierName: tier, idempotencyKey: `k${Math.random()}`, effectiveAt: ago(d) });
fake.seed(coll("LoyaltyLedger"), [
  led("CREDIT", 0, 1, 1, "Member", 5), led("CREDIT", 0, 1, 6, "Regular", 2), led("CREDIT", 1, 1, 1, "Member", 4), led("CREDIT", 1, 0, null, "", 3),
  led("CREDIT", 2, 1, 2, "Member", 1), led("CREDIT", 3, 1, 1, "Member", 2), led("CREDIT", 4, 1, 1, "Member", 2), led("REVERSAL", 4, -1, null, "", 1),
  led("CREDIT", 5, 1, 1, "Member", 70),
]);
const order = (s, state, d, extra = {}) => ({ _id: oid(), listing: oid(), brand: ids.A, branch: oid(), student: students[s], hold: oid(), idempotencyKey: `o${Math.random()}`, ref: `SB-${Math.random().toString(36).slice(2, 8)}`, qty: 1, priceSnapshot: { unitPrice: 450, listPrice: 1200, total: 450, currency: "PKR" }, paymentState: "unpaid", state, pickupStart: ago(d), pickupEnd: ago(d), pickupCodeHash: "h", pickupCodeNonce: "n", disclosures: {}, history: [], version: 1, createdAt: ago(d), ...extra });
fake.seed(coll("SurplusOrder"), [
  order(0, "COMPLETED", 2, { pickupCodeUsedAt: ago(2), paymentState: "paid_at_pickup" }), order(1, "COMPLETED", 3, { pickupCodeUsedAt: ago(3), paymentState: "paid_at_pickup", qty: 2, priceSnapshot: { unitPrice: 450, listPrice: 1200, total: 900, currency: "PKR" } }),
  order(2, "PICKUP_VERIFIED", 1, { pickupCodeUsedAt: ago(1) }), order(3, "NO_SHOW", 4), order(4, "CUSTOMER_CANCELLED", 5), order(5, "MERCHANT_CANCELLED", 5),
  order(6, "DISPUTED", 2, { stateBeforeDispute: "NO_SHOW" }), order(7, "ORDER_PLACED", 1), order(8, "COMPLETED", 50, { pickupCodeUsedAt: ago(50), paymentState: "paid_at_pickup" }),
]);
fake.seed(coll("SurplusInventoryHold"), Array.from({ length: 15 }, (_, i) => ({ _id: oid(), listing: oid(), brand: ids.A, student: students[i % 12], qty: 1, expiresAt: ago(1), state: "expired", idempotencyKey: `h${i}`, createdAt: ago(1) })));
// hiring: E1 has 3 applications: one hired (verified), one with a scheduled interview only, one offer accepted not confirmed
const ev = (app, seq, type, d, employer = ids.E1, extra = {}) => ({ _id: oid(), application: app, job: oid(), candidate: students[0], employer, seq, type, actorRole: "system", source: "app", idempotencyKey: `e${Math.random()}`, occurredAt: ago(d), metadata: {}, ...extra });
const a1 = oid(), a2 = oid(), a3 = oid(), a4 = oid();
fake.seed(coll("CareerApplicationEvent"), [
  ev(a1, 1, "APPLIED", 10), ev(a1, 2, "SHORTLISTED", 9), ev(a1, 3, "OFFER_SENT", 8), ev(a1, 4, "OFFER_ACCEPTED", 7), ev(a1, 5, "HIRE_CONFIRMED", 6),
  ev(a2, 1, "APPLIED", 10), ev(a2, 2, "INTERVIEW_INVITED", 9), ev(a2, 3, "INTERVIEW_ACCEPTED", 8),
  ev(a3, 1, "APPLIED", 10), ev(a3, 2, "OFFER_SENT", 9), ev(a3, 3, "OFFER_ACCEPTED", 8),
  ev(a4, 1, "APPLIED", 10, ids.E2), ev(a4, 2, "INTERVIEW_INVITED", 9, ids.E2), ev(a4, 3, "INTERVIEW_COMPLETED", 3, ids.E2),
]);
fake.seed(coll("EmployerCompanyVerification"), [
  { _id: oid(), employerUserId: ids.E1, companyGroupKey: "reg:1", companyName: "Hire Co", registrationType: "ntn", ntnOrSecp: "12345678", businessEmailDomain: "hireco.pk", website: "hireco.pk", status: "approved", history: [], createdAt: ago(20), updatedAt: ago(20) },
  { _id: oid(), employerUserId: ids.E2, companyGroupKey: "reg:2", companyName: "Other Co", registrationType: "ntn", ntnOrSecp: "87654321", businessEmailDomain: "otherco.pk", website: "otherco.pk", status: "duplicate_review", history: [], createdAt: ago(5), updatedAt: ago(5) },
]);
fake.seed(coll("EmployerHiringTrial"), [{ _id: oid(), companyGroupKey: "reg:1", activatedBy: ids.E1, eligibilityStatus: "used", verifiedAt: ago(20), entitlementCount: 1, consumedCount: 1, consumedByApplicationId: a1, consumedAt: ago(6), fraudReviewStatus: "none", policyVersion: "fhf-2026-11", version: 2, history: [], createdAt: ago(19) }]);
fake.seed(coll("EmployerHiringBillingEvent"), [
  { _id: oid(), companyGroupKey: "reg:1", employerUserId: ids.E1, applicationId: a1, eventType: "free_hire_consumed", feeWaived: true, amount: 0, currency: "PKR", policyVersion: "fhf-2026-11", idempotencyKey: "hire:1", createdAt: ago(6) },
  { _id: oid(), companyGroupKey: "reg:1", employerUserId: ids.E1, applicationId: oid(), eventType: "hire_billable_pending_pricing", feeWaived: false, amount: null, currency: "PKR", policyVersion: "fhf-2026-11", idempotencyKey: "hire:2", createdAt: ago(2) },
]);
const token = (id, role) => jwt.sign({ id: String(id), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { tok } = {}) {
  return new Promise((resolve) => {
    const h = tok ? { authorization: `Bearer ${tok}` } : {};
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = { admin: token(ids.admin, "admin"), A: token(ids.A, "brand"), B: token(ids.Bsmall, "brand"), E1: token(ids.E1, "employee"), E2: token(ids.E2, "employee"), S: token(ids.S0, "student") };
  let r;
  const from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const q = `?from=${from}&to=${to}`;

  console.log("-- access");
  for (const [url, ok] of [["/api/analytics/admin/overview", "admin"], ["/api/analytics/brands/me", "A"], ["/api/analytics/employers/me", "E1"]]) {
    r = await call("GET", url, { tok: T.S });
    check(`a student gets nothing new: ${url} -> 403`, r.status === 403);
    r = await call("GET", url);
    check(`a guest: ${url} -> 401`, r.status === 401);
    r = await call("GET", url, { tok: T[ok] });
    check(`the right role: ${url} -> 200`, r.status === 200, r.text.slice(0, 120));
  }
  r = await call("GET", "/api/analytics/admin/overview", { tok: T.A });
  check("a brand can't open the admin overview", r.status === 403);
  r = await call("GET", "/api/analytics/admin/overview?from=2026-12-01&to=2026-01-01", { tok: T.admin });
  check("a range that ends before it starts: 400", r.status === 400);

  console.log("-- admin overview reconciles with the records");
  r = await call("GET", `/api/analytics/admin/overview${q}`, { tok: T.admin });
  const o = r.json.data;
  // discounts: Alpha 11 in range (one is 60 days old), Tiny 3, archive 1 in range (one at 45 days)
  check("redemptions = brand-confirmed redemptions in range (11 + 3 + 1 archived); 20 claims not counted", o.discounts.redemptions === 15 && o.discounts.archivedRedemptions === 1, JSON.stringify(o.discounts).slice(0, 200));
  check("unique students = distinct students in those redemptions (Alpha 0-7, Tiny 9-10, archive 11)", o.discounts.uniqueStudents === 11);
  check("bill and savings totals = the sum of those redemptions", o.discounts.billTotal === 11 * 1000 + 3 * 500 + 800 && o.discounts.savedTotal === 11 * 200 + 3 * 100 + 160);
  check("repeat rate: student-brand pairs with 2+ redemptions (Alpha 0,1,2 + Tiny 9) / all pairs, with the denominator", o.discounts.repeatCustomers === 4 && o.discounts.studentBrandPairs === 11 && o.discounts.repeatRatePct === 36.4);
  check("per brand: Alpha shown, Tiny (2 students) hidden", o.discounts.topBrands.length === 1 && o.discounts.topBrands[0].name === "Alpha Cafe" && o.discounts.topBrands[0].redemptions === 11 && o.discounts.brandsHidden === 1);
  check("the deleted brands' 'brand-totals' rows aren't counted as redemptions", o.discounts.redemptions < 99);
  check("loyalty: counted visits 6 (one not counted, one out of range), 1 reversal, net 5", o.loyalty.countedVisits === 6 && o.loyalty.creditsNotCounted === 1 && o.loyalty.reversals === 1 && o.loyalty.netVisits === 5, JSON.stringify(o.loyalty).slice(0, 200));
  check("loyalty tiers: each member's highest tier (1 Regular, 4 Member)", o.loyalty.membersByTier?.Regular === 1 && o.loyalty.membersByTier?.Member === 4);
  const sb = o.surpriseBox;
  check("Surprise Box: 8 orders in range (15 expired holds not counted, one order out of range)", sb.ordersPlaced === 8 && sb.boxesOrdered === 9, JSON.stringify(sb).slice(0, 200));
  check("verified pickups = orders with a verified code (3), collected at pickup = marked paid (1,350)", sb.verifiedPickups === 3 && sb.collectedAtPickup === 1350);
  check("no-shows count a disputed no-show too (2); cancellations by side; pickup rate over orders not cancelled (3/6)", sb.noShows === 2 && sb.cancelledByStudent === 1 && sb.cancelledByBrand === 1 && sb.pickupRateDenominator === 6 && sb.pickupRatePct === 50);
  const h = o.hiring.counts;
  check("hiring: verified hires = confirmed hires only (1); an accepted offer and a scheduled interview aren't hires", h.verifiedHires === 1 && h.offersAccepted === 2 && h.interviewsAccepted === 1, JSON.stringify(h));
  check("hiring: a completed interview counts only when recorded completed (1, other employer)", h.interviewsCompleted === 1);
  const em = o.employers;
  check("employers: verified 1, suspected duplicates 1, trials used 1, free hires 1, pending pricing 1", em.companiesVerified === 1 && em.suspectedDuplicates === 1 && em.trialsUsed === 1 && em.freeHiresConsumed === 1 && em.hiresPendingPricing === 1);
  check("revenue: no pricing, so paying employers 0, fees 0, trial-to-paid not measurable", em.payingEmployers === 0 && em.feesCollected === 0 && em.trialToPaidPct === null);
  check("every card explains what it counts", ["discounts", "loyalty", "surpriseBox", "employers"].every((k) => o[k].definitions && Object.keys(o[k].definitions).length));

  console.log("-- date filter");
  const wide = (await call("GET", `/api/analytics/admin/overview?from=${new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10)}&to=${to}`, { tok: T.admin })).json.data;
  check("a 90-day range includes the older records (Alpha's 60-day redemption, the 45-day archive, the 50-day order)", wide.discounts.redemptions === 17 && wide.surpriseBox.ordersPlaced === 9 && wide.loyalty.countedVisits === 7);

  console.log("-- brand insights");
  r = await call("GET", `/api/analytics/brands/me${q}`, { tok: T.A });
  const bi = r.json.data;
  check("brand: its own redemptions only (11), repeat customers 3 of 8 students", bi.discounts.redemptions === 11 && bi.discounts.uniqueStudents === 8 && bi.discounts.repeatCustomers === 3 && bi.discounts.repeatRatePct === 37.5);
  check("brand: its own Surprise Box and loyalty figures", bi.surpriseBox.ordersPlaced === 8 && bi.loyalty.countedVisits === 6);
  r = await call("GET", `/api/analytics/brands/me${q}`, { tok: T.B });
  check("a brand with fewer than 5 students: student counts and repeat figures hidden", r.json.data.discounts.redemptions === 3 && r.json.data.discounts.uniqueStudents === null && r.json.data.discounts.repeatCustomers === null && /fewer than 5/.test(r.json.data.discounts.note));
  check("a brand never sees another brand's figures", !r.text.includes("Alpha"));

  console.log("-- employer results");
  r = await call("GET", `/api/analytics/employers/me${q}`, { tok: T.E1 });
  check("employer: its own funnel (3 applications, 1 verified hire)", r.json.data.hiring.counts.applications === 3 && r.json.data.hiring.counts.verifiedHires === 1);
  check("employer outside the First Hire Free pilot: no trial block", r.json.data.trial === null);
  process.env.FLAG_EMPLOYER_FIRST_HIRE_FREE = `ids:${ids.E1}`;
  r = await call("GET", `/api/analytics/employers/me${q}`, { tok: T.E1 });
  check("employer in the pilot: the trial summary (Used) next to the funnel", r.json.data.trial?.status === "used" && r.json.data.trial.summary && /coming soon/.test(r.json.data.trial.furtherHires), r.text.slice(0, 200));
  r = await call("GET", `/api/analytics/employers/me${q}`, { tok: T.E2 });
  check("another employer sees only its own (1 application, 0 hires)", r.json.data.hiring.counts.applications === 1 && r.json.data.hiring.counts.verifiedHires === 0);

  console.log("-- privacy");
  const all = responses.map((x) => x.text).join(" ");
  check("no student names in any reply", !NAMES.some((n) => all.includes(n)) && !all.includes("Zebulon"));
  check("no registration numbers or e-mails in analytics replies", !all.includes("12345678") && !all.includes("@test.local"));
  check("no 500s", !responses.some((x) => x.status >= 500), responses.filter((x) => x.status >= 500).map((x) => x.url + x.text.slice(0, 80)).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
