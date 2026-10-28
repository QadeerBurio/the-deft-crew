// Social pushes (feat/social-push): settings, recipients, privacy, grouping, quiet hours,
// switches, daily ceiling, create routes.
//   node tests/social-push/run.js [serverDir]
// Real routes, models and push helpers; only MongoDB (the in-memory layer from
// tests/hide-user-secrets/fake-mongo.js), Expo (a fake that records every request), e-mail and
// outgoing HTTP are replaced. No database, no network, no .env (dotenv is stubbed; run it from a
// folder without one).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "SOCIAL_PUSH_POSTS", "SOCIAL_PUSH_CONFESSIONS", "SOCIAL_PUSH_SKILLSHARE", "SOCIAL_PUSH_DAILY_MAX", "EXPO_ACCESS_TOKEN"]) delete process.env[k];

// ---------- fake Expo: records every request ----------
const expo = { requests: [], delayMs: 0, dead: new Set() };
class Expo {
  constructor() {}
  static isExpoPushToken(t) { return typeof t === "string" && t.startsWith("ExponentPushToken["); }
  chunkPushNotifications(ms) { const out = []; for (let i = 0; i < ms.length; i += 100) out.push(ms.slice(i, i + 100)); return out; }
  async sendPushNotificationsAsync(ms) {
    expo.requests.push(ms.map((m) => ({ ...m })));
    if (expo.delayMs) await new Promise((r) => setTimeout(r, expo.delayMs));
    return ms.map((m, i) => (expo.dead.has(m.to) ? { status: "error", message: "dead", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `t${expo.requests.length}-${i}` }));
  }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);
const express = reqS("express");
const jwt = reqS("jsonwebtoken");
reqS("./models/University");
const quiet = { log: console.log, warn: console.warn, error: console.error };
const logs = [];
console.log = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) quiet.log(...a); };
console.warn = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) quiet.warn(...a); };
console.error = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) quiet.error(...a); };

const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json());
app.use("/api/engagement", reqS("./routes/engagement.routes"));
app.use("/api/social", reqS("./routes/social.routes"));
app.use("/api/listings", reqS("./routes/listing.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const U1 = oid(), U2 = oid();
fake.seed("universities", [{ _id: U1, name: "Alpha University" }, { _id: U2, name: "Beta Institute" }]);
const ids = {};
const tok = (name) => `ExponentPushToken[${name}]`;
const person = (key, role, name, uni, extra = {}) => {
  ids[key] = oid();
  return { _id: ids[key], name, email: `${key}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", ...(uni ? { university: uni } : {}), pushTokens: [{ token: tok(key), channels: "snd_v2" }], createdAt: new Date(), ...extra };
};
fake.seed("users", [
  person("ali", "student", "Ali Khan", U1),
  person("sara", "student", "Sara Ahmed", U1),
  person("hina", "student", "Hina", U1),
  person("omar", "student", "Omar Farooq", U2),
  person("noUni", "student", "Zara", null),
  person("noToken", "student", "Bilal", U1, { pushTokens: [] }),
  person("brand", "brand", "Brand Co", null),
  person("admin", "admin", "Admin", null),
]);
const T = (key) => jwt.sign({ id: String(ids[key]), role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });

// ---------- helpers ----------
let base;
function request(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const started = Date.now();
    const r = http.request(base + url, { method, headers }, (res) => {
      let text = ""; res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text, ms: Date.now() - started }); });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; quiet.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${String(detail).slice(0, 400)}` : ""}`); };

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    // ═════ 1. settings ═════
    quiet.log("── 1. settings: posts, confessions, skillshare");
    let r = await request("GET", "/api/engagement/notification-prefs", { token: T("ali") });
    check("no profile yet: every switch reads as on, the three new ones included", r.status === 200 && ["posts", "confessions", "skillshare", "deals", "social"].every((k) => r.json?.[k] === true), r.text);
    r = await request("PUT", "/api/engagement/notification-prefs", { token: T("ali"), body: { posts: false, confessions: true, skillshare: false, bogus: false } });
    check("a student without a profile can now save switches (was a silent no-op)", r.status === 200 && r.json?.posts === false && r.json?.skillshare === false && r.json?.confessions === true, r.text);
    check("unknown keys are ignored", !("bogus" in (r.json || {})));
    r = await request("GET", "/api/engagement/notification-prefs", { token: T("ali") });
    check("saved values read back", r.json?.posts === false && r.json?.skillshare === false && r.json?.streaks === true);
    // an old profile without the new keys
    fake.seed("engagementprofiles", [{ _id: oid(), user: ids.sara, notifPrefs: { streaks: true, dailyDrop: false, deals: true, jobsScholarships: true, social: true } }]);
    r = await request("GET", "/api/engagement/notification-prefs", { token: T("sara") });
    check("an old profile without the new keys reads them as on, keeps its own values", r.json?.posts === true && r.json?.confessions === true && r.json?.skillshare === true && r.json?.dailyDrop === false, r.text);
    // put Ali back to all on for the next sections
    await request("PUT", "/api/engagement/notification-prefs", { token: T("ali"), body: { posts: true, skillshare: true } });

    // ═════ 2. recipients, texts, bulk send ═════
    quiet.log("── 2. recipients, texts and the bulk send");
    const sp = reqS("./services/socialPush");
    const names = (list) => list.map((u) => Object.keys(ids).find((k) => String(ids[k]) === String(u._id))).sort();
    let rec = await sp.findRecipients("post", { excludeUserIds: [ids.ali] });
    check("posts: every student with a token except the author; no brand, admin or token-less student", JSON.stringify(names(rec)) === JSON.stringify(["hina", "noUni", "omar", "sara"]), names(rec).join(","));
    fake.seed("engagementprofiles", [{ _id: oid(), user: ids.hina, notifPrefs: { posts: false, confessions: true, skillshare: true } }]);
    rec = await sp.findRecipients("post", { excludeUserIds: [ids.ali] });
    check("a student who turned posts off gets nothing; profile-less students count as on", JSON.stringify(names(rec)) === JSON.stringify(["noUni", "omar", "sara"]), names(rec).join(","));
    rec = await sp.findRecipients("confession", { universityId: U1, excludeUserIds: [ids.sara] });
    check("confessions: only students of the author's university (Alpha), author excluded", JSON.stringify(names(rec)) === JSON.stringify(["ali", "hina"]), names(rec).join(","));
    check("confessions: other universities (Omar) and students without one (Zara) get nothing", !names(rec).includes("omar") && !names(rec).includes("noUni"));
    rec = await sp.findRecipients("confession", { universityId: null, excludeUserIds: [] });
    check("confessions: an author without a university reaches nobody", rec.length === 0);

    let c = sp.buildContent("post", [{ id: "p1", firstName: "Sara Ahmed", text: "  exam   timetable is out!\nsee the notice board near the library for the full list of rooms " }]);
    check("post: \"<first name> posted on campus\" + the text, one line, max 60 chars", c.title === "Sara posted on campus" && c.body.length <= 60 && c.body.startsWith("exam timetable is out! see") && c.body.endsWith("…") && c.data.route === "PostDetailScreen" && c.data.params.postId === "p1", JSON.stringify(c));
    c = sp.buildContent("post", [{ id: "p2", firstName: "Ali", text: "", hasImage: true }]);
    check("post with only a photo: \"shared a photo\"", c.body === "shared a photo");
    c = sp.buildContent("post", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    check("combined: \"4 new posts on campus\", opens the feed", c.title === "4 new posts on campus" && c.data.route === "FeedScreen" && c.data.params.tab === "Feed");
    c = sp.buildContent("listing", [{ id: "l1", title: "Guitar lessons for beginners, weekends only, bring your own guitar please" }]);
    check("listing: \"new skillshare listing: <title, max 60>\", opens the listing", c.title.startsWith("new skillshare listing: Guitar lessons") && c.title.length <= "new skillshare listing: ".length + 60 && c.data.route === "ListingDetail" && c.data.params.id === "l1");
    c = sp.buildContent("listing", [{ id: "a" }, { id: "b" }]);
    check("combined listings open skillshare", c.title === "2 new skillshare listings" && c.data.route === "Dashboard");
    c = sp.buildContent("confession", [{ id: "c1" }]);
    check("confession: fixed text, opens the confessions feed at that confession", c.title === "new confession on campus. tap to read." && c.body === "" && c.data.route === "FeedScreen" && c.data.params.tab === "Confession" && c.data.params.postId === "c1");

    // the bulk send: 250 extra students → 3 Expo requests of at most 100; dead token removed
    const many = Array.from({ length: 250 }, (_, i) => ({ _id: oid(), name: `S${i}`, role: "student", university: U2, pushTokens: [{ token: tok(`many${i}`), channels: "snd_v2" }] }));
    fake.seed("users", many);
    expo.dead.add(tok("many7"));
    expo.requests.length = 0;
    rec = await sp.findRecipients("listing", { excludeUserIds: [ids.ali] });
    const res = await sp.sendToStudents("listing", [{ id: "l9", title: "Calculus tutoring" }], rec);
    check(`bulk: ${rec.length} students in ${expo.requests.length} Expo requests of at most 100`, expo.requests.length === Math.ceil(res.devices / 100) && expo.requests.every((q) => q.length <= 100) && res.devices === rec.length, `${expo.requests.map((q) => q.length)}`);
    check("one message per device, title with the mood emoji, Android channel and tap data", expo.requests[0][0].title.includes("new skillshare listing: Calculus tutoring") && /^tdc2_/.test(expo.requests[0][0].channelId) && expo.requests[0][0].data.route === "ListingDetail");
    await tick(30);
    const deadLeft = fake.STORE.get("users").find((u) => (u.pushTokens || []).some((t) => t.token === tok("many7")));
    check("a dead token (DeviceNotRegistered) is removed from its student", !deadLeft && res.failed === 1 && res.reached.length === rec.length - 1);
    fake.STORE.set("users", fake.STORE.get("users").filter((u) => !/^S\d+$/.test(u.name)));
    expo.dead.clear();

    // ═════ 3. grouping, flood guard, quiet hours ═════
    quiet.log("── 3. one push per 5 minutes per kind (per university for confessions); quiet hours");
    const at = (iso) => new Date(iso);
    const min = (d, m) => new Date(d.getTime() + m * 60000);
    const resetGroups = () => { fake.STORE.set("socialpushgroups", []); expo.requests.length = 0; };
    const titles = () => expo.requests.map((q) => q[0]?.title || "");
    const seedPost = (author) => { const id = oid(); fake.seed("posts", [{ _id: id, author: ids[author], content: "x", createdAt: new Date() }]); return id; };
    const seedConf = (author, uni) => { const id = oid(); fake.seed("confessions", [{ _id: id, authorId: ids[author], text: "secret", university: uni, createdAt: new Date() }]); return id; };
    const seedListing = (author, status = "open") => { const id = oid(); fake.seed("listings", [{ _id: id, ownerId: ids[author], type: "paid", title: "t", description: "d", status }]); return id; };

    resetGroups();
    const noon = at("2026-10-28T07:00:00Z"); // 12:00 Karachi
    await sp.enqueue("post", { id: seedPost("ali"), authorId: ids.ali, authorName: "Ali Khan", text: "first" }, { now: noon });
    check("the first post sends at once", expo.requests.length === 1 && titles()[0].includes("Ali posted on campus"), titles().join(" | "));
    await sp.enqueue("post", { id: seedPost("sara"), authorId: ids.sara, authorName: "Sara", text: "second" }, { now: min(noon, 1) });
    await sp.enqueue("post", { id: seedPost("omar"), authorId: ids.omar, authorName: "Omar", text: "third" }, { now: min(noon, 2) });
    check("posts within 5 minutes wait (no second push)", expo.requests.length === 1);
    await sp.flushDue({ now: min(noon, 4) });
    check("still nothing at +4 min", expo.requests.length === 1);
    await sp.flushDue({ now: min(noon, 5) });
    check("at +5 min one combined push: \"2 new posts on campus\"", expo.requests.length === 2 && titles()[1].includes("2 new posts on campus"), titles().join(" | "));
    const combinedTo = expo.requests[1].map((m) => m.to);
    check("authors of anything in the combined push get nothing (Sara, Omar)", !combinedTo.includes(tok("sara")) && !combinedTo.includes(tok("omar")) && combinedTo.includes(tok("ali")));

    // confessions: per university, separately (a second Beta student, so Beta has someone to tell)
    resetGroups();
    const betaId = oid();
    fake.seed("users", [{ _id: betaId, name: "Beta Two", role: "student", university: U2, pushTokens: [{ token: tok("beta2"), channels: "snd_v2" }] }]);
    await sp.enqueue("confession", { id: seedConf("ali", U1), authorId: ids.ali, universityId: U1 }, { now: noon });
    await sp.enqueue("confession", { id: seedConf("omar", U2), authorId: ids.omar, universityId: U2 }, { now: min(noon, 1) });
    check("confessions at two universities: each its own push, not combined", expo.requests.length === 2);
    await sp.enqueue("confession", { id: seedConf("sara", U1), authorId: ids.sara, universityId: U1 }, { now: min(noon, 2) });
    check("a second Alpha confession within 5 minutes waits", expo.requests.length === 2);
    const r3 = await sp.enqueue("confession", { id: oid(), authorId: ids.noUni, universityId: null }, { now: noon });
    check("a confession without a university is never queued", r3.queued === false && r3.reason === "no_university");

    // quiet hours: night items go together at 09:00 Karachi
    resetGroups();
    const night = at("2026-10-28T19:30:00Z"); // 00:30 Karachi
    for (let i = 0; i < 3; i++) await sp.enqueue("listing", { id: seedListing("ali"), authorId: ids.ali, title: `L${i}` }, { now: min(night, i * 20) });
    check("night (00:30–01:10): nothing sent", expo.requests.length === 0);
    const g = fake.STORE.get("socialpushgroups").find((x) => x.status === "open");
    check("they wait for 09:00 Karachi (04:00 UTC)", g && new Date(g.sendAfter).toISOString() === "2026-10-29T04:00:00.000Z", g && new Date(g.sendAfter).toISOString());
    await sp.flushDue({ now: at("2026-10-29T03:59:00Z") });
    check("08:59: still nothing", expo.requests.length === 0);
    await sp.flushDue({ now: at("2026-10-29T04:00:00Z") });
    check("09:00: one combined push \"3 new skillshare listings\"", expo.requests.length === 1 && titles()[0].includes("3 new skillshare listings"), titles().join(" | "));
    check("quietEnd from 23:30 Karachi is 09:00 the next day", sp.quietEnd(at("2026-10-28T18:30:00Z")).toISOString() === "2026-10-29T04:00:00.000Z");

    // deleted items and closed listings are left out; nothing left → no push
    resetGroups();
    const gone = seedPost("ali");
    await sp.enqueue("post", { id: seedPost("sara"), authorId: ids.sara, authorName: "Sara", text: "a" }, { now: noon });
    await sp.enqueue("post", { id: gone, authorId: ids.ali, authorName: "Ali", text: "b" }, { now: min(noon, 1) });
    fake.STORE.set("posts", fake.STORE.get("posts").filter((p) => String(p._id) !== String(gone)));
    await sp.flushDue({ now: min(noon, 5) });
    check("a post deleted before its push is not counted (no \"2 new posts\")", expo.requests.length === 1, titles().join(" | "));
    const dropped = fake.STORE.get("socialpushgroups").find((x) => x.status === "dropped");
    check("a group with nothing left is dropped, not sent", dropped && dropped.reason === "items_gone");
    resetGroups();
    const closed = seedListing("ali", "closed");
    await sp.enqueue("listing", { id: closed, authorId: ids.ali, title: "closed one" }, { now: noon });
    check("a listing that is no longer open sends nothing", expo.requests.length === 0);

    // two timers at once: one push
    resetGroups();
    const pA = seedPost("ali");
    await sp.enqueue("post", { id: pA, authorId: ids.ali, authorName: "Ali", text: "x" }, { now: noon });
    await sp.enqueue("post", { id: seedPost("sara"), authorId: ids.sara, authorName: "Sara", text: "y" }, { now: min(noon, 1) });
    await Promise.all([sp.flushDue({ now: min(noon, 6) }), sp.flushDue({ now: min(noon, 6) })]);
    check("two timers running at once still send the group once", expo.requests.length === 2, `${expo.requests.length}`);
  } catch (e) {
    fail++; quiet.log("FAIL  (stopped)", e?.stack || e);
  }
  quiet.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
