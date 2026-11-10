// Surprise Box (Sprint 5): concurrent holds never oversell, expired holds release stock, one order per
// duplicate request, pickup codes single-use and only for the listing's own brand and branch, cancellation
// windows, the no-show sweep, reminders, disputes, admin blocking, flag off = unchanged, leak scan.
//   node tests/surplus/run.js [serverDir]
// and interleaving (simultaneous requests really interleave); no database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.SURPLUS_CODE_SECRET = "test-only-surplus-code-secret-0123456789abcdef"; // the pickup-code secret (not JWT_SECRET)
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
for (const m of ["User", "Branch", "Notification", "DomainEvent", "SurplusListing", "SurplusInventoryHold", "SurplusOrder", "SurplusSupportCase", "SurplusNotificationOutbox", "SurplusBrandBlock"]) reqS(`./models/${m}`);
const notifications = reqS("./services/surplus/notifications");
const sweep = reqS("./services/surplus/sweep");
const pickupCode = reqS("./services/surplus/pickupCode");
const pushes = [];
notifications.providers.push = async (row) => { pushes.push(row); return { status: "sent" }; };

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "pushTokens", "idCardFront", "idCardBack", "livePicture", "email", "phone", "pickupCodeHash", "pickupCodeNonce", "activeSlot", "idempotencyKey"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    let keys = new Set();
    try { keys = keysIn(JSON.parse(text)); } catch {}
    const leaks = HIDDEN.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[/.test(text)) leaks.push("secret value");
    // a pickup code only ever reaches the student who ordered (never a brand or admin reply)
    if (!req.originalUrl.startsWith("/api/surplus/orders") && !req.originalUrl.startsWith("/api/surplus/holds") && /TDCBOX1:/.test(text)) leaks.push("pickup QR in a non-student reply");
    responses.push({ url: req.originalUrl, status: res.statusCode, leaks, text });
    return send(body);
  };
  next();
});
app.use("/api/app", reqS("./routes/appFlags.routes"));
app.use("/api/surplus", reqS("./routes/surplus.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "B", "C", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "admin", "A1", "A2", "B1", "C1"]) ids[k] = oid();
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name.replace(/ /g, "")}@test.local`, phone: "03001234567", password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", brandApprovalStatus: role === "brand" ? "approved" : undefined, createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  user(ids.A, "brand", "alpha", { brandName: "Alpha Bakery", logo: "https://cdn.test/a.png" }), user(ids.B, "brand", "beta", { brandName: "Beta Cafe" }), user(ids.C, "brand", "gamma", { brandName: "Gamma Grill" }),
  ...["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"].map((k) => user(ids[k], "student", `Student ${k}`)), user(ids.admin, "admin", "admin"),
]);
const branch = (id, brand, name, coords) => ({ _id: id, brand, name, location: `${name} street`, city: "Karachi", isActive: true, geo: { type: "Point", coordinates: coords }, createdAt: new Date() });
fake.seed(coll("Branch"), [branch(ids.A1, ids.A, "Alpha Clifton", [67.03, 24.81]), branch(ids.A2, ids.A, "Alpha DHA", [67.07, 24.80]), branch(ids.B1, ids.B, "Beta Gulshan", [67.09, 24.92]), branch(ids.C1, ids.C, "Gamma Saddar", [67.02, 24.86])]);
const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const doc = (Model, id) => rows(Model, (x) => same(x._id, id))[0];
let keyN = 0;
const key = () => `k-${++keyN}-${Date.now()}`;
const B = "/api/surplus";
const H = 3600e3, MIN = 60e3;
const inH = (h) => new Date(Date.now() + h * H).toISOString();

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const T = Object.fromEntries(["A", "B", "C", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"].map((k) => [k, token(k, /^S/.test(k) ? "student" : "brand")]));
  T.admin = token("admin", "admin");
  let r;
  const listingBody = (extra = {}) => ({ branchId: String(ids.A1), title: "Evening bakery box", description: "Breads and pastries left at closing", allergenNotes: "contains gluten and dairy; may contain nuts", allergens: ["gluten", "dairy"], quantityTotal: 5, listPrice: 1200, price: 450, pickupStart: inH(3), pickupEnd: inH(4), status: "published", ...extra });

  // ---------- flag off ----------
  delete process.env.FLAG_SURPLUS_BOXES;
  r = await call("GET", `${B}/listings`, { tok: T.S1 });
  check("flag off: student listings are 404 SURPLUS_OFF", r.status === 404 && r.json?.error?.code === "SURPLUS_OFF");
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody() });
  check("flag off: a brand can't create a listing (404)", r.status === 404);
  r = await call("GET", `${B}/admin/cases`, { tok: T.admin });
  check("flag off (not configured): admin pages are 404 too", r.status === 404);
  r = await call("GET", "/api/app/flags/me", { tok: T.S1 });
  check("flag off: /flags/me says surplusBoxes false", JSON.stringify(r.json).includes('"surplusBoxes":false'));
  check("flag off: nothing written", rows("SurplusListing").length === 0 && rows("SurplusInventoryHold").length === 0);

  process.env.FLAG_SURPLUS_BOXES = `ids:${ids.A},${ids.B},${["S1", "S2", "S3", "S4", "S5", "S7", "S8", "S9"].map((k) => ids[k]).join(",")}`;
  r = await call("GET", "/api/app/flags/me", { tok: T.S1 });
  check("pilot student: /flags/me says surplusBoxes true", JSON.stringify(r.json).includes('"surplusBoxes":true'));
  r = await call("GET", `${B}/listings`, { tok: T.S6 });
  check("a student outside the pilot still gets 404", r.status === 404);
  r = await call("GET", `${B}/listings`);
  check("guest: 401", r.status === 401);
  r = await call("POST", `${B}/merchant/listings`, { tok: T.S1, body: listingBody() });
  check("a student can't use merchant routes (403)", r.status === 403);
  r = await call("POST", `${B}/holds`, { tok: T.A, body: { listingId: String(ids.A1), qty: 1, idempotencyKey: key() } });
  check("a brand can't hold boxes (403)", r.status === 403);

  // ---------- merchant listings ----------
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ branchId: String(ids.B1) }) });
  check("a listing at another brand's branch: 403 WRONG_BRANCH", r.status === 403 && r.json.error.code === "WRONG_BRANCH");
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ allergenNotes: "" }) });
  check("no allergen notes: 400 ALLERGENS_REQUIRED", r.status === 400 && r.json.error.code === "ALLERGENS_REQUIRED");
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ bestBefore: inH(3.5) }) });
  check("food that expires before pickup ends: 400 UNSAFE_BEST_BEFORE", r.status === 400 && r.json.error.code === "UNSAFE_BEST_BEFORE");
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ price: 1500 }) });
  check("price above the usual price: 400", r.status === 400 && r.json.error.code === "INVALID_PRICE");
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ pickupStart: inH(3), pickupEnd: inH(20) }) });
  check("a pickup window over 12 hours: 400", r.status === 400);
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ title: "Last box", quantityTotal: 1 }) });
  check("create: 201, published, location from the branch, cutoff 30 min before the end", r.status === 201 && r.json.data.status === "published" && r.json.data.branch.name === "Alpha Clifton" && new Date(r.json.data.pickupEnd) - new Date(r.json.data.orderCutoff) === 30 * MIN, r.text.slice(0, 200));
  const L1 = r.json.data.id;
  const L2 = (await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ title: "Three boxes", quantityTotal: 3 }) })).json.data.id;
  const L3 = (await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ title: "Lunch box", quantityTotal: 10, branchId: String(ids.A2) }) })).json.data.id;
  const L4 = (await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ title: "Soon box", quantityTotal: 10, pickupStart: new Date(Date.now() + 20 * MIN).toISOString(), pickupEnd: inH(2), orderCutoff: inH(1.5) }) })).json.data.id;
  const L5 = (await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody({ title: "Spare box", quantityTotal: 5 }) })).json.data.id;
  const LB = (await call("POST", `${B}/merchant/listings`, { tok: T.B, body: listingBody({ title: "Beta box", branchId: String(ids.B1), quantityTotal: 4 }) })).json.data.id;
  fake.seed(coll("SurplusListing"), [{ _id: oid(), brand: ids.C, branch: ids.C1, title: "Gamma (not in pilot)", allergenNotes: "none known", quantityTotal: 3, quantityAvailable: 3, listPrice: 900, price: 300, currency: "PKR", pickupStart: new Date(Date.now() + 3 * H), pickupEnd: new Date(Date.now() + 4 * H), orderCutoff: new Date(Date.now() + 3.5 * H), status: "published", version: 1, location: { city: "Karachi", branchName: "Gamma Saddar" }, createdAt: new Date() }]);
  r = await call("PATCH", `${B}/merchant/listings/${L2}`, { tok: T.B, body: { version: 1, title: "mine now" } });
  check("another brand can't edit the listing (404)", r.status === 404);
  r = await call("GET", `${B}/merchant/listings`, { tok: T.B });
  check("a brand sees only its own listings", r.json.data.listings.length === 1 && r.json.data.listings[0].id === LB);

  // ---------- student browsing ----------
  r = await call("GET", `${B}/listings?lat=24.81&lng=67.03`, { tok: T.S1 });
  const titles = r.json.data.listings.map((l) => l.title);
  check("browse: pilot brands' boxes, not a brand outside the pilot", titles.includes("Last box") && titles.includes("Beta box") && !titles.includes("Gamma (not in pilot)"), titles.join());
  const last = r.json.data.listings.find((l) => l.id === L1);
  check("browse: price vs usual price, stock left, pickup time, distance", last.price === 450 && last.listPrice === 1200 && last.quantityLeft === 1 && last.pickupStart && last.distanceKm === 0);
  r = await call("GET", `${B}/listings/${L1}`, { tok: T.S1 });
  const d = r.json.data.disclosures;
  check("detail: every disclosure before confirming (contents may vary, allergens, window, cancellation, pay at pickup)", d.contentsMayVary === true && /Contents may vary/.test(d.contentsNote) && d.allergens.includes("gluten") && /gluten/.test(d.allergenNotes) && d.pickupStart && d.pickupEnd && /30 minutes before pickup/.test(d.cancellationRule) && /at pickup/.test(d.payment) && d.cancelUntil);

  // ---------- holds: concurrency ----------
  const five = ["S1", "S2", "S3", "S4", "S5"];
  const race = await Promise.all(five.map((s) => call("POST", `${B}/holds`, { tok: T[s], body: { listingId: L1, qty: 1, idempotencyKey: key() } })));
  const won = race.filter((x) => x.status === 201);
  check("the last box, 5 students at once: exactly one hold, the rest SOLD_OUT", won.length === 1 && race.filter((x) => x.json?.error?.code === "SOLD_OUT").length === 4, race.map((x) => x.status).join(","));
  check("stock is 0 and the listing shows sold out (never negative)", doc("SurplusListing", L1).quantityAvailable === 0 && doc("SurplusListing", L1).status === "sold_out");
  const race2 = await Promise.all(five.map((s, i) => call("POST", `${B}/holds`, { tok: T[s], body: { listingId: L2, qty: i < 2 ? 2 : 1, idempotencyKey: key() } })));
  const heldQty = race2.filter((x) => x.status === 201).reduce((n, x) => n + x.json.data.hold.qty, 0);
  check("3 boxes, 5 students asking for 2,2,1,1,1 at once: never more than 3 held", heldQty <= 3 && heldQty + doc("SurplusListing", L2).quantityAvailable === 3, `${heldQty} held, ${doc("SurplusListing", L2).quantityAvailable} left`);
  const winner = five[race.findIndex((x) => x.status === 201)];
  const holdL1 = won[0].json.data.hold;
  check("the hold lasts 10 minutes and carries the disclosures", Math.abs(new Date(holdL1.expiresAt) - Date.now() - 10 * MIN) < 5000 && won[0].json.data.disclosures?.allergenNotes);
  const k1 = key();
  const dupe = await Promise.all([1, 2].map(() => call("POST", `${B}/holds`, { tok: T.S7, body: { listingId: L3, qty: 1, idempotencyKey: k1 } })));
  check("the same hold tap twice at once: one hold", dupe.every((x) => [200, 201].includes(x.status)) && dupe[0].json.data.hold.id === dupe[1].json.data.hold.id && rows("SurplusInventoryHold", (h) => h.idempotencyKey === k1).length === 1 && doc("SurplusListing", L3).quantityAvailable === 9);
  r = await call("POST", `${B}/holds`, { tok: T.S7, body: { listingId: L3, qty: 1, idempotencyKey: key() } });
  check("a second hold on the same box: 409 HOLD_EXISTS", r.status === 409 && r.json.error.code === "HOLD_EXISTS");
  r = await call("POST", `${B}/holds`, { tok: T.S8, body: { listingId: L3, qty: 3, idempotencyKey: key() } });
  check("more than 2 boxes per listing: 400", r.status === 400 && r.json.error.code === "INVALID_QTY");

  // ---------- expired hold releases stock ----------
  const s7hold = rows("SurplusInventoryHold", (h) => h.idempotencyKey === k1)[0];
  s7hold.expiresAt = new Date(Date.now() - 1000);
  r = await call("POST", `${B}/orders`, { tok: T.S7, body: { holdId: String(s7hold._id), idempotencyKey: key(), acceptedTerms: true } });
  check("confirming after the 10 minutes: 409 HOLD_EXPIRED", r.status === 409 && r.json.error.code === "HOLD_EXPIRED");
  check("the expired hold gave its box back", doc("SurplusInventoryHold", s7hold._id).state === "expired" && doc("SurplusListing", L3).quantityAvailable === 10);
  const l1hold = rows("SurplusInventoryHold", (h) => same(h._id, holdL1.id))[0];
  l1hold.expiresAt = new Date(Date.now() - 1000);
  const tick1 = await sweep.tick();
  check("the sweep releases expired holds: the last box is back on sale", tick1.holdsReleased >= 1 && doc("SurplusListing", L1).quantityAvailable === 1 && doc("SurplusListing", L1).status === "published", JSON.stringify(tick1));

  // ---------- orders ----------
  const h1 = (await call("POST", `${B}/holds`, { tok: T.S1, body: { listingId: L1, qty: 1, idempotencyKey: key() } })).json.data.hold;
  r = await call("POST", `${B}/orders`, { tok: T.S1, body: { holdId: h1.id, idempotencyKey: key() } });
  check("confirming without accepting the food and pickup terms: 400", r.status === 400 && r.json.error.code === "TERMS_REQUIRED");
  const ok1 = key();
  const confirms = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", `${B}/orders`, { tok: T.S1, body: { holdId: h1.id, idempotencyKey: ok1, acceptedTerms: true } })));
  check("5 confirms at once with one key: one order", new Set(confirms.map((x) => x.json?.data?.id)).size === 1 && rows("SurplusOrder", (o) => same(o.student, ids.S1)).length === 1, confirms.map((x) => x.status).join(","));
  r = await call("POST", `${B}/orders`, { tok: T.S1, body: { holdId: h1.id, idempotencyKey: key(), acceptedTerms: true } });
  check("the same hold with another key: the same order", r.status === 200 && r.json.data.id === confirms[0].json.data.id);
  const o1 = confirms.find((x) => x.status === 201).json.data;
  check("order: ORDER_PLACED, pay 450 at pickup, 6-character code and QR", o1.state === "ORDER_PLACED" && o1.payment.note === "Pay PKR 450 at pickup" && /^[A-Z2-9]{6}$/.test(o1.pickup.code) && o1.pickup.qr === `TDCBOX1:${o1.id}:${o1.pickup.code}`);
  const storedO1 = doc("SurplusOrder", o1.id);
  check("only the code's hash is stored, never the code", storedO1.pickupCodeHash === pickupCode.hashOf(o1.pickup.code) && !JSON.stringify(fake.STORE.get(coll("SurplusOrder"))).includes(`"${o1.pickup.code}"`));
  check("the order keeps what the student accepted", storedO1.disclosures.acceptedAt && /gluten/.test(storedO1.disclosures.allergenNotes) && storedO1.priceSnapshot.total === 450);
  r = await call("GET", `${B}/orders/${o1.id}`, { tok: T.S1 });
  check("the student sees the code again later", r.json.data.pickup.code === o1.pickup.code);
  r = await call("GET", `${B}/orders/${o1.id}`, { tok: T.S2 });
  check("another student can't see the order (404)", r.status === 404);

  // one active order per brand (also when two holds race)
  r = await call("POST", `${B}/holds`, { tok: T.S1, body: { listingId: L3, qty: 1, idempotencyKey: key() } });
  check("a second active order with the same brand: 409 ACTIVE_ORDER_WITH_BRAND", r.status === 409 && r.json.error.code === "ACTIVE_ORDER_WITH_BRAND");
  r = await call("POST", `${B}/holds`, { tok: T.S1, body: { listingId: LB, qty: 2, idempotencyKey: key() } });
  check("another brand is fine", r.status === 201);
  const hB = r.json.data.hold;
  const s9a = (await call("POST", `${B}/holds`, { tok: T.S9, body: { listingId: L5, qty: 1, idempotencyKey: key() } }));
  const s9b = (await call("POST", `${B}/holds`, { tok: T.S9, body: { listingId: L3, qty: 1, idempotencyKey: key() } }));
  const l3Before = doc("SurplusListing", L3).quantityAvailable;
  if (s9a.status === 201 && s9b.status === 201) {
    const both = await Promise.all([s9a, s9b].map((h) => call("POST", `${B}/orders`, { tok: T.S9, body: { holdId: h.json.data.hold.id, idempotencyKey: key(), acceptedTerms: true } })));
    const placed = both.filter((x) => x.status === 201);
    check("two holds with one brand confirmed at once: one order, the other 409 and its box goes back", placed.length === 1 && both.some((x) => x.json?.error?.code === "ACTIVE_ORDER_WITH_BRAND"), both.map((x) => x.status).join(","));
    const lostListing = placed[0].json.data.listingId === L5 ? L3 : L5;
    check("the losing hold's stock was restored", lostListing === L3 ? doc("SurplusListing", L3).quantityAvailable === l3Before + 1 : doc("SurplusListing", L5).quantityAvailable === 5);
  } else check("two holds with one brand confirmed at once (setup)", false, `${s9a.status} ${s9b.status} ${s9a.text.slice(0, 80)}`);

  // ---------- merchant moves ----------
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.B, body: { to: "CONFIRMED", version: 1 } });
  check("another brand can't move the order (404)", r.status === 404);
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.A, body: { to: "READY_FOR_PICKUP", version: 1 } });
  check("skipping confirm: 409 INVALID_TRANSITION", r.status === 409 && r.json.error.code === "INVALID_TRANSITION");
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.A, body: { to: "CONFIRMED", version: 99 } });
  check("a stale version: 409", r.status === 409 && r.json.error.code === "STALE_VERSION");
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.A, body: { to: "CONFIRMED", version: 1 } });
  check("confirm: 200, the student's first name only, no contact details", r.status === 200 && r.json.data.state === "CONFIRMED" && r.json.data.student.firstName === "Student" && !/test\.local|0300/.test(r.text));
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.A, body: { to: "PREPARING", version: 2 } });
  r = await call("POST", `${B}/merchant/orders/${o1.id}/transition`, { tok: T.A, body: { to: "READY_FOR_PICKUP", version: 3 } });
  check("preparing, then ready for pickup", r.status === 200 && r.json.data.state === "READY_FOR_PICKUP" && r.json.data.next.join() === "MERCHANT_CANCELLED");
  r = await call("GET", `${B}/merchant/orders?scope=live`, { tok: T.B });
  check("a brand's board shows only its own orders", r.json.data.every((o) => o.listingId === LB) && !r.text.includes(o1.id));

  // ---------- verify pickup ----------
  const pick = (brand, body) => call("POST", `${B}/merchant/verify-pickup`, { tok: T[brand], body });
  r = await pick("B", { code: o1.pickup.code, branchId: String(ids.B1), markPaid: true });
  check("another brand can't verify the code (not found)", r.status === 404 && r.json.error.code === "CODE_NOT_FOUND");
  r = await pick("A", { code: o1.pickup.code, branchId: String(ids.B1), markPaid: true });
  check("a branch that isn't the brand's: 403", r.status === 403 && r.json.error.code === "WRONG_BRANCH");
  r = await pick("A", { code: o1.pickup.code, branchId: String(ids.A2), markPaid: true });
  check("the brand's other branch: 403 WRONG_BRANCH", r.status === 403 && r.json.error.code === "WRONG_BRANCH");
  storedO1.pickupStart = new Date(Date.now() + 2 * H);
  r = await pick("A", { code: o1.pickup.code, branchId: String(ids.A1), markPaid: true });
  check("long before the window: 409 TOO_EARLY", r.status === 409 && r.json.error.code === "TOO_EARLY");
  storedO1.pickupStart = new Date(Date.now() - 10 * MIN);
  const two = await Promise.all([1, 2].map(() => pick("A", { code: o1.pickup.code.toLowerCase(), branchId: String(ids.A1), markPaid: true })));
  check("the right brand at the right branch: verified and completed, paid at pickup (once, even with two taps)", two.filter((x) => x.status === 200).length === 1 && two.some((x) => x.json?.error?.code === "CODE_USED") && doc("SurplusOrder", o1.id).state === "COMPLETED" && doc("SurplusOrder", o1.id).paymentState === "paid_at_pickup", two.map((x) => x.status).join(","));
  r = await pick("A", { code: o1.pickup.code, branchId: String(ids.A1), markPaid: true });
  check("the code can't be used again: 409 CODE_USED", r.status === 409 && r.json.error.code === "CODE_USED");
  r = await call("GET", `${B}/orders/${o1.id}`, { tok: T.S1 });
  check("after pickup the student no longer gets a code", r.json.data.pickup === null && r.json.data.state === "COMPLETED");

  // QR, expiry, brute force
  const hS2 = (await call("POST", `${B}/holds`, { tok: T.S2, body: { listingId: L3, qty: 2, idempotencyKey: key() } })).json.data.hold;
  const o2 = (await call("POST", `${B}/orders`, { tok: T.S2, body: { holdId: hS2.id, idempotencyKey: key(), acceptedTerms: true } })).json.data;
  doc("SurplusOrder", o2.id).pickupStart = new Date(Date.now() - 5 * MIN);
  r = await call("POST", `${B}/merchant/orders/${o2.id}/verify-pickup`, { tok: T.A, body: { qr: o2.pickup.qr, branchId: String(ids.A2), markPaid: false } });
  check("QR at the right branch, not yet paid: PICKUP_VERIFIED", r.status === 200 && r.json.data.state === "PICKUP_VERIFIED" && r.json.data.paymentState === "unpaid");
  r = await call("POST", `${B}/merchant/orders/${o2.id}/transition`, { tok: T.A, body: { to: "COMPLETED", version: r.json.data.version } });
  check("completing needs 'paid at pickup'", r.status === 400 && r.json.error.code === "PAYMENT_NOT_MARKED");
  r = await call("POST", `${B}/merchant/orders/${o2.id}/transition`, { tok: T.A, body: { to: "COMPLETED", version: doc("SurplusOrder", o2.id).version, markPaid: true } });
  check("then completed and paid", r.status === 200 && r.json.data.state === "COMPLETED" && r.json.data.paymentState === "paid_at_pickup");
  const hS3 = (await call("POST", `${B}/holds`, { tok: T.S3, body: { listingId: L3, qty: 1, idempotencyKey: key() } })).json.data.hold;
  const o3 = (await call("POST", `${B}/orders`, { tok: T.S3, body: { holdId: hS3.id, idempotencyKey: key(), acceptedTerms: true } })).json.data;
  doc("SurplusOrder", o3.id).pickupStart = new Date(Date.now() - 2 * H);
  doc("SurplusOrder", o3.id).pickupEnd = new Date(Date.now() - MIN);
  r = await pick("A", { code: o3.pickup.code, branchId: String(ids.A2), markPaid: true });
  check("after the window ends the code has expired: 409 CODE_EXPIRED", r.status === 409 && r.json.error.code === "CODE_EXPIRED");

  // ---------- no-show sweep + reminders ----------
  const t2 = await sweep.tick();
  const o3doc = doc("SurplusOrder", o3.id);
  check("the sweep marks the uncollected order NO_SHOW (recorded, nothing else)", o3doc.state === "NO_SHOW" && o3doc.activeSlot === undefined && t2.noShows >= 1, JSON.stringify(t2));
  const o3rows = rows("SurplusNotificationOutbox", (x) => same(x.order, o3.id) && x.eventType === "NO_SHOW").length;
  await sweep.tick();
  check("a second sweep changes nothing (no duplicate no-show or notifications)", doc("SurplusOrder", o3.id).version === o3doc.version && rows("SurplusNotificationOutbox", (x) => same(x.order, o3.id) && x.eventType === "NO_SHOW").length === o3rows && o3rows === 3);
  r = await call("POST", `${B}/holds`, { tok: T.S3, body: { listingId: L2, qty: 1, idempotencyKey: key() } });
  check("a no-show isn't a ban: the student can order from the brand again", r.status === 201 || r.json?.error?.code === "SOLD_OUT", r.text.slice(0, 100));
  if (r.status === 201) await call("DELETE", `${B}/holds/${r.json.data.hold.id}`, { tok: T.S3 });
  const hS4 = (await call("POST", `${B}/holds`, { tok: T.S4, body: { listingId: L4, qty: 1, idempotencyKey: key() } })).json.data.hold;
  const o4 = (await call("POST", `${B}/orders`, { tok: T.S4, body: { holdId: hS4.id, idempotencyKey: key(), acceptedTerms: true } })).json.data;
  await sweep.tick(); await sweep.tick();
  const rem = rows("SurplusNotificationOutbox", (x) => same(x.order, o4.id) && x.eventType === "REMINDER");
  check("pickup in 20 minutes: one reminder per channel, queued once", rem.length === 2 && rem.every((x) => x.status === "sent"), rem.map((x) => x.status).join());

  doc("SurplusListing", L1).pickupEnd = new Date(Date.now() - MIN);
  await sweep.tick();
  check("the sweep closes a listing whose pickup window has ended", doc("SurplusListing", L1).status === "closed");

  // ---------- cancellation windows ----------
  r = await call("POST", `${B}/orders/${o4.id}/cancel`, { tok: T.S4 });
  check("cancelling 20 minutes before pickup: 409 CANCEL_WINDOW_PASSED", r.status === 409 && r.json.error.code === "CANCEL_WINDOW_PASSED");
  const hS5 = (await call("POST", `${B}/holds`, { tok: T.S5, body: { listingId: L3, qty: 2, idempotencyKey: key() } })).json.data.hold;
  const o5 = (await call("POST", `${B}/orders`, { tok: T.S5, body: { holdId: hS5.id, idempotencyKey: key(), acceptedTerms: true } })).json.data;
  const beforeCancel = doc("SurplusListing", L3).quantityAvailable;
  r = await call("POST", `${B}/orders/${o5.id}/cancel`, { tok: T.S5 });
  check("cancelling 3 hours before pickup: CUSTOMER_CANCELLED, both boxes back on sale, the brand told", r.status === 200 && r.json.data.state === "CUSTOMER_CANCELLED" && doc("SurplusListing", L3).quantityAvailable === beforeCancel + 2 && rows("SurplusNotificationOutbox", (x) => same(x.order, o5.id) && x.eventType === "CUSTOMER_CANCELLED" && same(x.recipient, ids.A)).length === 1, `${r.status} ${r.text.slice(0, 160)} left=${doc("SurplusListing", L3).quantityAvailable} before=${beforeCancel} rows=${rows("SurplusNotificationOutbox", (x) => same(x.order, o5.id)).map((x) => x.eventType + ":" + x.channel).join(",")}`);
  r = await call("POST", `${B}/merchant/orders/${o4.id}/transition`, { tok: T.A, body: { to: "MERCHANT_CANCELLED", version: 1 } });
  check("a brand cancel needs a reason", r.status === 400 && r.json.error.code === "REASON_REQUIRED");
  r = await call("POST", `${B}/merchant/orders/${o4.id}/transition`, { tok: T.A, body: { to: "MERCHANT_CANCELLED", version: 1, reason: "oven broke, no bread today" } });
  check("the brand cancels any time (even 20 minutes before); the student is told why", r.status === 200 && r.json.data.state === "MERCHANT_CANCELLED" && rows("SurplusNotificationOutbox", (x) => same(x.order, o4.id) && x.eventType === "MERCHANT_CANCELLED" && same(x.recipient, ids.S4) && /oven broke/.test(x.payload.body)).length === 2, `${r.status} ${r.text.slice(0, 160)} rows=${rows("SurplusNotificationOutbox", (x) => same(x.order, o4.id)).map((x) => x.eventType + ":" + x.channel).join(",")}`);

  // ---------- disputes ----------
  r = await call("POST", `${B}/support-cases`, { tok: T.S2, body: { orderId: o1.id, reason: "food_safety" } });
  check("a case on someone else's order: 404", r.status === 404);
  r = await call("POST", `${B}/support-cases`, { tok: T.S1, body: { orderId: o1.id, reason: "food_safety", description: "the bread was mouldy", evidence: ["https://photos.test/1.jpg", "javascript:alert(1)"] } });
  check("a case within 24 hours of pickup: 201, the order DISPUTED (its state before kept), only https evidence", r.status === 201 && doc("SurplusOrder", o1.id).state === "DISPUTED" && doc("SurplusOrder", o1.id).stateBeforeDispute === "COMPLETED" && r.json.data.evidence.length === 1, r.text.slice(0, 200));
  const case1 = r.json.data.id;
  r = await call("POST", `${B}/support-cases`, { tok: T.S1, body: { orderId: o1.id, reason: "other" } });
  check("one case per order: 409", r.status === 409 && r.json.error.code === "CASE_EXISTS");
  doc("SurplusOrder", o2.id).pickupCodeUsedAt = new Date(Date.now() - 25 * H);
  r = await call("POST", `${B}/support-cases`, { tok: T.S2, body: { orderId: o2.id, reason: "not_as_described" } });
  check("more than 24 hours after pickup: 409 DISPUTE_WINDOW_PASSED", r.status === 409 && r.json.error.code === "DISPUTE_WINDOW_PASSED");
  const sB = (await call("POST", `${B}/orders`, { tok: T.S1, body: { holdId: hB.id, idempotencyKey: key(), acceptedTerms: true } })).json.data;
  r = await call("POST", `${B}/support-cases`, { tok: T.S1, body: { orderId: sB.id, reason: "other" } });
  check("a case on an order still awaiting pickup: 409 NOT_DISPUTABLE", r.status === 409 && r.json.error.code === "NOT_DISPUTABLE");
  r = await call("POST", `${B}/support-cases`, { tok: T.S3, body: { orderId: o3.id, reason: "wrong_no_show", description: "I was there at 6" } });
  check("a no-show can be disputed within 24 hours", r.status === 201);
  r = await call("GET", `${B}/admin/cases`, { tok: T.A });
  check("a brand can't open admin pages (403)", r.status === 403);
  r = await call("GET", `${B}/admin/cases`, { tok: T.admin });
  check("admin: open cases with the order and both sides", r.status === 200 && r.json.data.length === 2 && r.json.data.some((c) => c.order?.stateBefore === "COMPLETED" && c.brand?.name === "Alpha Bakery"));
  r = await call("POST", `${B}/admin/cases/${case1}/decide`, { tok: T.admin, body: { decision: "upheld" } });
  check("a decision needs a note", r.status === 400);
  r = await call("POST", `${B}/admin/cases/${case1}/decide`, { tok: T.admin, body: { decision: "upheld", note: "photos show mould; brand warned" } });
  check("admin decides: upheld (recorded; nothing refunded, no money passed through tdc)", r.status === 200 && r.json.data.status === "decided" && r.json.data.decision === "upheld");
  check("…and in the admin action log, the note as the reason", rows("AdminActionLog", (x) => x.action === "surplus.case.decide" && x.targetId === String(case1) && x.after.decision === "upheld" && x.reason === "photos show mould; brand warned" && same(x.admin, ids.admin)).length === 1);
  r = await call("POST", `${B}/admin/cases/${case1}/decide`, { tok: T.admin, body: { decision: "not_upheld", note: "changed my mind" } });
  check("a decided case can't be decided again", r.status === 409);
  r = await call("GET", `${B}/orders/${o1.id}`, { tok: T.S1 });
  check("the student sees the decision on the order", r.json.data.supportCase?.decision === "upheld" && /mould/.test(r.json.data.supportCase.note));

  // ---------- admin: no-shows, blocking a brand ----------
  r = await call("GET", `${B}/admin/no-shows`, { tok: T.admin });
  check("admin: repeat no-shows listed for review, nobody banned", r.status === 200 && r.json.data.students.some((s) => s.studentId === String(ids.S3) && s.count === 1) && /nobody is banned/.test(r.json.data.note));
  r = await call("GET", `${B}/admin/brands`, { tok: T.admin });
  check("admin: brands with upheld cases first", r.json.data[0].name === "Alpha Bakery" && r.json.data[0].upheldCases === 1);
  r = await call("POST", `${B}/admin/brands/${ids.A}/block`, { tok: T.admin, body: { blocked: true } });
  check("blocking needs a reason", r.status === 400);
  r = await call("POST", `${B}/admin/brands/${ids.A}/block`, { tok: T.admin, body: { blocked: true, reason: "repeated food safety cases" } });
  check("admin blocks the brand's listings", r.status === 200 && r.json.data.blocked === true && rows("SurplusListing", (l) => same(l.brand, ids.A) && ["published", "sold_out"].includes(l.status)).length === 0);
  check("…logged as surplus.brand.block with the reason; refused decisions weren't logged", rows("AdminActionLog", (x) => x.action === "surplus.brand.block" && x.targetId === String(ids.A) && x.after.blocked === true && x.reason === "repeated food safety cases").length === 1 && rows("AdminActionLog", (x) => x.action === "surplus.case.decide").length === 1);
  r = await call("GET", `${B}/listings`, { tok: T.S7 });
  check("blocked: its boxes disappear for students", !r.json.data.listings.some((l) => l.brand.id === String(ids.A)));
  r = await call("POST", `${B}/holds`, { tok: T.S7, body: { listingId: L3, qty: 1, idempotencyKey: key() } });
  check("blocked: holds refused", r.status === 404);
  r = await call("POST", `${B}/merchant/listings`, { tok: T.A, body: listingBody() });
  check("blocked: the brand can't publish (403 BRAND_BLOCKED)", r.status === 403 && r.json.error.code === "BRAND_BLOCKED");
  r = await call("POST", `${B}/admin/brands/${ids.A}/block`, { tok: T.admin, body: { blocked: false } });
  check("lifting it: the listings come back paused (the brand republishes)", r.status === 200 && doc("SurplusListing", L3).status === "paused");

  // ---------- listing edits ----------
  const l3 = (await call("GET", `${B}/merchant/listings`, { tok: T.A })).json.data.listings.find((l) => l.id === L3);
  r = await call("PATCH", `${B}/merchant/listings/${L3}`, { tok: T.A, body: { version: l3.version, allergenNotes: "none" } });
  check("after orders, the disclosures can't change: 409 DISCLOSURES_LOCKED", r.status === 409 && r.json.error.code === "DISCLOSURES_LOCKED");
  const sold = l3.quantityTotal - l3.quantityLeft;
  r = await call("PATCH", `${B}/merchant/listings/${L3}`, { tok: T.A, body: { version: l3.version, quantityTotal: sold - 1 } });
  check("quantity can't go below what's held or ordered", r.status === 409 && r.json.error.code === "BELOW_SOLD");
  r = await call("PATCH", `${B}/merchant/listings/${L3}`, { tok: T.A, body: { version: l3.version, quantityTotal: l3.quantityTotal + 5, status: "published" } });
  check("adding boxes and republishing", r.status === 200 && r.json.data.quantityLeft === l3.quantityLeft + 5 && r.json.data.status === "published");
  r = await call("PATCH", `${B}/merchant/listings/${L3}`, { tok: T.A, body: { version: l3.version, status: "paused" } });
  check("a stale listing version: 409", r.status === 409);

  // ---------- summary, notifications ----------
  r = await call("GET", `${B}/merchant/summary`, { tok: T.A });
  check("today's summary: orders, to collect, collected at pickup, no-shows", r.status === 200 && typeof r.json.data.toCollectAtPickup === "number" && r.json.data.collectedAtPickup >= 0 && "noShows" in r.json.data, r.text.slice(0, 200));
  const placedRows = rows("SurplusNotificationOutbox", (x) => same(x.order, o1.id) && x.eventType === "ORDER_PLACED");
  check("order placed: student push + in-app, brand in-app", placedRows.length === 3 && placedRows.filter((x) => same(x.recipient, ids.A)).length === 1 && placedRows.filter((x) => x.channel === "push").length === 1);
  const before = rows("SurplusNotificationOutbox").length;
  await notifications.onOrderEvent(doc("SurplusOrder", o1.id), "ORDER_PLACED", { drainNow: false });
  check("re-queuing the same event adds nothing (outbox keys are unique)", rows("SurplusNotificationOutbox").length === before);
  const allText = rows("SurplusNotificationOutbox").map((x) => JSON.stringify(x.payload)).join(" ");
  check("notifications carry no contact details and no pickup code", !/test\.local|0300/.test(allText) && !allText.includes(o1.pickup.code) && !allText.includes("TDCBOX1"));
  const tapRows = rows("SurplusNotificationOutbox", (x) => same(x.order, o1.id));
  check("a student's notification opens the order (screen SurpriseBoxes + orderId), never an offer", tapRows.filter((x) => same(x.recipient, ids.S1)).every((x) => x.payload.data.screen === "SurpriseBoxes" && x.payload.data.params?.orderId === o1.id && !x.payload.data.offerId) && tapRows.some((x) => same(x.recipient, ids.S1)));
  check("a brand's notification carries no app screen (orders live in the portal)", tapRows.filter((x) => same(x.recipient, ids.A)).every((x) => !x.payload.data.screen && !x.payload.data.offerId));
  check("the in-app rows carry the same tap target", rows("Notification", (n) => n.metadata?.surplusOrderId === o1.id && same(n.recipient, ids.S1)).every((n) => n.metadata.screen === "SurpriseBoxes" && n.metadata.params?.orderId === o1.id));
  check("in-app notifications use an existing type (schema unchanged)", rows("Notification", (n) => n.metadata?.surplusOrderId).every((n) => n.type === "Offer"));

  // ---------- SURPLUS_CODE_SECRET ----------
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.join(" ")); };
  const SECRET = process.env.SURPLUS_CODE_SECRET;
  const c1 = pickupCode.codeFor("6ae9c1c1c1c1c1c1c1c1c1c1", "nonce-1");
  process.env.JWT_SECRET = "a-different-jwt-secret";
  const c2 = pickupCode.codeFor("6ae9c1c1c1c1c1c1c1c1c1c1", "nonce-1");
  process.env.JWT_SECRET = "test-only";
  process.env.SURPLUS_CODE_SECRET = `${SECRET}-rotated`;
  const c3 = pickupCode.codeFor("6ae9c1c1c1c1c1c1c1c1c1c1", "nonce-1");
  process.env.SURPLUS_CODE_SECRET = SECRET;
  check("the code comes from SURPLUS_CODE_SECRET, not JWT_SECRET", c1 === c2 && c1 !== c3);
  const lbLeft = doc("SurplusListing", LB).quantityAvailable;
  const preHold = (await call("POST", `${B}/holds`, { tok: T.S8, body: { listingId: LB, qty: 1, idempotencyKey: key() } })).json?.data?.hold;
  delete process.env.SURPLUS_CODE_SECRET;
  r = await call("POST", `${B}/holds`, { tok: T.S2, body: { listingId: LB, qty: 1, idempotencyKey: key() } });
  check("no SURPLUS_CODE_SECRET: holds refused (503 SURPLUS_NOT_CONFIGURED), stock untouched", r.status === 503 && r.json.error.code === "SURPLUS_NOT_CONFIGURED" && doc("SurplusListing", LB).quantityAvailable === lbLeft - 1, r.text.slice(0, 120));
  check("no SURPLUS_CODE_SECRET: a clear error in the logs", errors.some((e) => /\[surplus\] SURPLUS_CODE_SECRET is not set/.test(e) && /never taken from JWT_SECRET/.test(e)), errors.join(" | ").slice(0, 200));
  r = await call("POST", `${B}/orders`, { tok: T.S8, body: { holdId: preHold?.id, idempotencyKey: key(), acceptedTerms: true } });
  check("no SURPLUS_CODE_SECRET: orders refused, no order made, the hold isn't consumed (it expires and gives its box back)", r.status === 503 && r.json.error.code === "SURPLUS_NOT_CONFIGURED" && !rows("SurplusOrder", (o) => same(o.student, ids.S8)).length && doc("SurplusInventoryHold", preHold.id).state === "active");
  r = await call("GET", `${B}/orders/${sB.id}`, { tok: T.S1 });
  check("no SURPLUS_CODE_SECRET: an existing order still loads, its code shown as unavailable (no 500, no fallback)", r.status === 200 && r.json.data.pickup?.unavailable === true && r.json.data.pickup.code === null);
  process.env.SURPLUS_CODE_SECRET = "too-short-secret";
  r = await call("POST", `${B}/holds`, { tok: T.S2, body: { listingId: LB, qty: 1, idempotencyKey: key() } });
  check("a secret shorter than 32 characters is refused too", r.status === 503 && r.json.error.code === "SURPLUS_NOT_CONFIGURED");
  process.env.SURPLUS_CODE_SECRET = SECRET;
  r = await call("POST", `${B}/orders`, { tok: T.S8, body: { holdId: preHold.id, idempotencyKey: key(), acceptedTerms: true } });
  check("with the secret back, the same hold becomes an order with its code", r.status === 201 && /^[A-Z2-9]{6}$/.test(r.json.data.pickup.code));
  r = await call("GET", `${B}/orders/${sB.id}`, { tok: T.S1 });
  check("and the earlier order shows its code again", /^[A-Z2-9]{6}$/.test(r.json.data.pickup?.code || ""));
  console.error = origError;

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, no contact details, code hashes or pickup codes outside the student's own order`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).slice(0, 5).join(" | "));
  const unexpected = (x) => x.status >= 500 && !(x.status === 503 && /SURPLUS_NOT_CONFIGURED/.test(x.text)); // 503: the intended "secret not set" refusal
  check("no 500s", !responses.some(unexpected), responses.filter(unexpected).map((x) => x.url + " " + x.text.slice(0, 80)).join(" | "));

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
