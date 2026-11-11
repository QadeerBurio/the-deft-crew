// "A new Surprise Box near you" (models/SurplusAnnouncement.js, services/surplus/announcements.js): on a box's
// first publish, students with the flag, a push token and the same city get one push (at most one a day), through
// the REAL pushGateway (daily / weekly caps, quiet hours, the "deals" opt-out), plus an in-app note when sent.
// Never for a draft, a re-publish, a box that can't be ordered any more, a brand outside the pilot or blocked.
//   node tests/surplus-announce/run.js [serverDir]
// Real routes, services, gateway and models on a fake MongoDB; only Expo's send and the quiet-hours clock are
// stubbed. No database, no network, no .env.
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k)) delete process.env[k];
process.env.SURPLUS_CODE_SECRET = "test-only-surplus-code-secret-0123456789abcdef";

class Expo {
  static isExpoPushToken(t) { return /^ExponentPushToken\[.+\]$/.test(String(t)); }
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
const pushed = []; // what reached Expo
let quiet = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  if (resolved.endsWith(path.join("utils", "pushNotification.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, sendAllSafe: async (_x, messages) => { pushed.push(...messages); return messages.map((_, i) => ({ status: "ok", id: `t${pushed.length}-${i}` })); }, handleTickets: async () => {} };
  }
  if (resolved.endsWith(path.join("utils", "karachiTime.js"))) {
    const real = origLoad.apply(this, arguments);
    return { ...real, isQuietHour: () => quiet };
  }
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = async (url) => { throw new Error(`network blocked in test: ${url}`); };

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId, { unique: true, interleave: true });
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const coll = (name) => reqS(`./models/${name}`).collection.collectionName;
for (const m of ["User", "Branch", "SurplusListing", "SurplusOrder", "SurplusAnnouncement", "SurplusBrandBlock", "Notification", "EngagementProfile", "PushLog"]) reqS(`./models/${m}`);
const announcements = reqS("./services/surplus/announcements");
const sweep = reqS("./services/surplus/sweep");
const { dayKey } = reqS("./utils/karachiTime");

const app = express();
app.use(reqS("./utils/logSafety").requestId());
app.use(express.json());
app.use("/api/surplus", reqS("./routes/surplus.routes"));

const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["A", "Z", "A1", "Z1", "K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "L1", "admin"]) ids[k] = oid();
const tok = (k) => `ExponentPushToken[${k}]`;
const student = (k, location, extra = {}) => ({ _id: ids[k], name: `Student ${k}`, email: `${k}@test.local`, phone: "03001234567", role: "student", status: "Verified", accountStatus: "active", location, pushTokens: [{ token: tok(k), platform: "android", channels: "snd_v2", updatedAt: new Date() }], createdAt: new Date(), updatedAt: new Date(), ...extra });
fake.seed(coll("User"), [
  { _id: ids.A, name: "alpha", email: "a@test.local", role: "brand", brandName: "Alpha Bakery", brandApprovalStatus: "approved", status: "Verified", accountStatus: "active", createdAt: new Date() },
  { _id: ids.Z, name: "zeta", email: "z@test.local", role: "brand", brandName: "Zeta Cafe (not in the pilot)", brandApprovalStatus: "approved", status: "Verified", accountStatus: "active", createdAt: new Date() },
  { _id: ids.admin, name: "admin", email: "admin@test.local", role: "admin", createdAt: new Date() },
  student("K1", "Karachi, Pakistan"), student("K2", " karachi "), student("K3", "Karachi"), student("K4", "Karachi", { pushTokens: [] }),
  student("K5", "Karachi"), student("K6", "Karachi"), student("K7", "Karachi"), student("K8", "Karachi"), student("L1", "Lahore, Pakistan"),
  // K9 joins the pilot later (section 5): no push today yet, so the daily cap doesn't hide what quiet hours do
  student("K9", "Karachi"),
]);
fake.seed(coll("Branch"), [
  { _id: ids.A1, brand: ids.A, name: "Alpha Clifton", location: "Clifton street", city: "Karachi", isActive: true, geo: { type: "Point", coordinates: [67.03, 24.81] }, createdAt: new Date() },
  { _id: ids.Z1, brand: ids.Z, name: "Zeta Saddar", location: "Saddar street", city: "Karachi", isActive: true, createdAt: new Date() },
]);
// K5 turned "deals" off; K6 already had today's marketing push (daily cap)
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: ids.K5, level: { id: "member" }, points: { balance: 0 }, streak: { count: 0, best: 0, freezesLeft: 1 }, notifPrefs: { deals: false }, push: {} },
  { _id: oid(), user: ids.K6, level: { id: "member" }, points: { balance: 0 }, streak: { count: 0, best: 0, freezesLeft: 1 }, notifPrefs: { deals: true }, push: { lastPushDay: dayKey(), weekKey: "", sentThisWeek: 1 } },
]);
// in the pilot: brand A and every student but K3 (brand Z is not)
process.env.FLAG_SURPLUS_BOXES = `ids:${ids.A},${["K1", "K2", "K4", "K5", "K6", "K7", "K8", "L1"].map((k) => ids[k]).join(",")}`;
const jwtFor = (k, role) => jwt.sign({ id: String(ids[k]), role }, "test-only", { expiresIn: "1h" });

let PORT;
function call(method, url, { body, t } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (t) h.authorization = `Bearer ${t}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
const ann = (f = () => true) => rows("SurplusAnnouncement", f);
const annOf = (k) => ann((r) => same(r.student, ids[k]));
const pushedTo = (k) => pushed.filter((m) => m.to === tok(k));
// background queueing and delivery: wait until the rows stop changing and none is pending or being sent (at most 5 s)
const settle = async () => {
  let last = "", stable = 0;
  for (let i = 0; i < 250 && stable < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const busy = ann((x) => x.status === "sending" || (x.status === "pending" && new Date(x.nextAttemptAt) <= new Date())).length;
    const sig = `${ann().length}:${ann((x) => x.status === "sent").length}:${busy}:${pushed.length}`;
    stable = sig === last && !busy ? stable + 1 : 0;
    last = sig;
  }
};
const inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const box = (extra = {}) => ({ branchId: String(ids.A1), title: "Evening bakery box", allergenNotes: "contains gluten and dairy", quantityTotal: 5, listPrice: 1200, price: 450, pickupStart: inH(3), pickupEnd: inH(4), ...extra });

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const TA = jwtFor("A", "brand"), TZ = jwtFor("Z", "brand"), TADM = jwtFor("admin", "admin");
  quiet = false;

  console.log("── 1. only the first publish announces");
  let r = await call("POST", "/api/surplus/merchant/listings", { t: TA, body: box({ status: "draft" }) });
  const L1 = r.json?.data;
  await settle();
  check("a draft announces nothing", r.status === 201 && ann().length === 0, r.status);
  r = await call("PATCH", `/api/surplus/merchant/listings/${L1.id}`, { t: TA, body: { version: L1.version, status: "published" } });
  await settle();
  const who = (rs) => rs.map((x) => Object.keys(ids).find((k) => same(ids[k], x.student))).sort().join(",");
  check("publishing it: one row per student in Karachi with the flag and a push token (K1, K2 ' karachi ', K5, K6, K7, K8)", r.status === 200 && who(ann()) === "K1,K2,K5,K6,K7,K8", who(ann()));
  check("…not K3 (outside the pilot), K4 (no push token), L1 (Lahore)", annOf("K3").length === 0 && annOf("K4").length === 0 && annOf("L1").length === 0);

  console.log("── 2. delivered through the gateway: caps, opt-out; an in-app note when sent");
  check("K1, K2, K7, K8 got the push", ["K1", "K2", "K7", "K8"].every((k) => pushedTo(k).length === 1), pushed.map((m) => m.to).join(" "));
  check("…with the box, brand, price, pickup and branch; a tap opens the box", /A new Surprise Box near you/.test(pushedTo("K1")[0]?.title || "") && /Alpha Bakery: Evening bakery box, PKR 450\. Pick up .* at Alpha Clifton\./.test(pushedTo("K1")[0]?.body || "") && pushedTo("K1")[0]?.data?.screen === "SurpriseBoxes" && pushedTo("K1")[0]?.data?.params?.listingId === L1.id, JSON.stringify(pushedTo("K1")[0]));
  check("…no phone number or e-mail anywhere in it", !/0300|@test\.local/.test(JSON.stringify(pushed)));
  check("K5 (deals off) → skipped, nothing sent", pushedTo("K5").length === 0 && annOf("K5")[0].status === "skipped" && annOf("K5")[0].lastError === "pref_off", annOf("K5")[0]?.lastError);
  check("K6 (already had today's marketing push) → skipped: daily_cap", pushedTo("K6").length === 0 && annOf("K6")[0].status === "skipped" && annOf("K6")[0].lastError === "daily_cap", annOf("K6")[0]?.lastError);
  const notes = rows("Notification", (n) => n.metadata?.surplusListingId === L1.id);
  check("an in-app note for each push sent (4), none for the skipped ones", notes.length === 4 && !notes.some((n) => same(n.recipient, ids.K5) || same(n.recipient, ids.K6)), notes.length);
  check("the push counts toward the marketing cap (not essential)", rows("EngagementProfile", (p) => same(p.user, ids.K1))[0]?.push?.lastPushDay === dayKey());

  console.log("── 3. at most one a day; a re-publish announces nothing");
  r = await call("POST", "/api/surplus/merchant/listings", { t: TA, body: box({ title: "Lunch rice box", status: "published" }) });
  await settle();
  check("a second box the same day: no second row, no second push for anyone", r.status === 201 && ann().length === 6 && pushed.filter((m) => /Lunch rice box/.test(m.body)).length === 0, `${ann().length} rows`);
  const L1now = rows("SurplusListing", (l) => same(l._id, L1.id))[0];
  await call("PATCH", `/api/surplus/merchant/listings/${L1.id}`, { t: TA, body: { version: L1now.version, status: "paused" } });
  const L1p = rows("SurplusListing", (l) => same(l._id, L1.id))[0];
  const before = ann().length;
  await call("PATCH", `/api/surplus/merchant/listings/${L1.id}`, { t: TA, body: { version: L1p.version, status: "published" } });
  await settle();
  check("pause, then publish again: nothing new", ann().length === before);

  console.log("── 4. brands outside the pilot or blocked: nothing");
  fake.seed(coll("Branch"), []); // (Z's branch is seeded)
  const zr = await announcements.onPublished({ ...L1now, _id: oid(), brand: ids.Z, status: "published", publishedAt: new Date() });
  check("a brand outside the pilot → nothing queued", zr.queued === 0 && /outside the pilot/.test(zr.reason || ""), JSON.stringify(zr));
  fake.seed(coll("SurplusBrandBlock"), [{ _id: oid(), brand: ids.A, active: true, reason: "test", createdAt: new Date() }]);
  const br = await announcements.onPublished({ ...L1now, _id: oid(), status: "published", quantityAvailable: 5 }, { drainNow: false });
  check("a blocked brand → nothing queued", br.queued === 0 && /blocked/.test(br.reason || ""), JSON.stringify(br));
  rows("SurplusBrandBlock")[0].active = false;

  console.log("── 5. quiet hours wait for 09:00 (if the box can still be ordered then); a gone box is never announced");
  // tomorrow, 23:30 Karachi: a box for 10:00-12:00 the next morning
  const k = new Date(Date.now() + 5 * 3600e3);
  const at = (dayOffset, h, m = 0) => new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + dayOffset, h, m) - 5 * 3600e3);
  const night = at(1, 23, 30), morning = at(2, 9, 0);
  const lateBox = { _id: oid(), brand: ids.A, branch: ids.A1, title: "Breakfast box", price: 300, currency: "PKR", quantityAvailable: 4, status: "published", publishedAt: night, pickupStart: at(2, 10), pickupEnd: at(2, 12), orderCutoff: at(2, 11, 30), location: { city: "Karachi", branchName: "Alpha Clifton" } };
  fake.seed(coll("SurplusListing"), [lateBox]);
  process.env.FLAG_SURPLUS_BOXES += `,${ids.K9}`;
  quiet = true;
  const q = await announcements.onPublished(lateBox, { now: night, drainNow: false });
  const rowK7 = ann((x) => same(x.listing, lateBox._id) && same(x.student, ids.K9))[0];
  await announcements.deliver(rowK7._id, night);
  const deferred = ann((x) => same(x._id, rowK7._id))[0];
  check("published at 23:30 (quiet hours): queued for tomorrow's day, deferred to 09:00, nothing sent", q.queued >= 1 && deferred.status === "pending" && deferred.lastError === "quiet_hours" && new Date(deferred.nextAttemptAt).getTime() === morning.getTime() && pushed.filter((m) => /Breakfast box/.test(m.body)).length === 0, `${deferred.status} ${deferred.nextAttemptAt}`);
  quiet = false;
  const tick = await sweep.tick(morning);
  check("the sweep at 09:00 delivers it", ann((x) => same(x._id, rowK7._id))[0].status === "sent" && pushed.filter((m) => m.to === tok("K9") && /Breakfast box/.test(m.body)).length === 1 && tick.announcementsDelivered >= 1, JSON.stringify(tick) + " " + ann((x) => same(x._id, rowK7._id))[0].lastError);
  // a box whose orders close before 09:00: quiet hours mean no push at all
  const earlyBox = { ...lateBox, _id: oid(), title: "Midnight box", pickupStart: at(3, 23, 45), pickupEnd: at(4, 1), orderCutoff: at(4, 0, 30) };
  fake.seed(coll("SurplusListing"), [earlyBox]);
  quiet = true;
  await announcements.onPublished(earlyBox, { now: at(3, 23, 30), drainNow: false });
  for (const row of ann((x) => same(x.listing, earlyBox._id))) await announcements.deliver(row._id, at(3, 23, 31));
  quiet = false;
  const early = ann((x) => same(x.listing, earlyBox._id));
  // (K5 stays "pref_off": the opt-out is checked before quiet hours)
  check("quiet hours until the box's orders close → skipped, never sent", early.length >= 1 && early.every((x) => x.status === "skipped" && (/quiet hours/.test(x.lastError) || x.lastError === "pref_off")) && early.some((x) => /quiet hours/.test(x.lastError)) && pushed.filter((m) => /Midnight box/.test(m.body)).length === 0, JSON.stringify(early.map((x) => [x.status, x.lastError])));
  // sold out before delivery
  const soldBox = { ...lateBox, _id: oid(), title: "Sold box", pickupStart: at(4, 14), pickupEnd: at(4, 16), orderCutoff: at(4, 15, 30) };
  fake.seed(coll("SurplusListing"), [soldBox]);
  await announcements.onPublished(soldBox, { now: at(4, 12), drainNow: false });
  rows("SurplusListing", (l) => same(l._id, soldBox._id))[0].quantityAvailable = 0;
  for (const row of ann((x) => same(x.listing, soldBox._id))) await announcements.deliver(row._id, at(4, 12, 1));
  const sold = ann((x) => same(x.listing, soldBox._id));
  check("sold out before delivery → skipped, never sent", sold.length >= 1 && sold.every((x) => x.status === "skipped" && /no longer available/.test(x.lastError)) && pushed.filter((m) => /Sold box/.test(m.body)).length === 0, JSON.stringify(sold.map((x) => [x.status, x.lastError])));

  console.log("── 6. admin publish announces too; nothing for students outside the pilot");
  r = await call("POST", "/api/surplus/merchant/listings", { t: TA, body: box({ title: "Admin-published box", status: "draft" }) });
  const before6 = ann().length;
  r = await call("PATCH", `/api/surplus/admin/listings/${r.json.data.id}`, { t: TADM, body: { status: "published", version: r.json.data.version, reason: "publish for the brand" } });
  await settle();
  const newRows = ann().slice(before6);
  check("an admin publishing a draft announces like the brand's own: only K9 (joined the pilot later) gets today's row; the rest already had theirs", r.status === 200 && newRows.length === 1 && same(newRows[0].student, ids.K9), `${r.status} ${newRows.map((x) => x.student).join(",")}`);
  check("never a row for a student outside the pilot (K3) in any case", annOf("K3").length === 0);

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
