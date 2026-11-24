// P4c confessions (owner 25 Nov 2026), on in-memory data with a fake push sender.
//   share (confessionsV2 + confessionShare): flags off → 404; public + live + no open report → the gettdc.pk/c/<id> link
//     (a report on a comment doesn't block); campus-only → 409 CAMPUS_ONLY; an open report → 409 UNDER_REVIEW; held →
//     404; another campus's campus-only post → 404; the feed's shareable follows the same rules
//   the page /c/<id>: text only (no handle, image, campus, replies), noindex / no-store / no referrer / a CSP without
//     scripts, "read the replies in the app" (tdcapp://confession/<id>); "not available" for never shared, now
//     campus-only, hidden, an open report, the sharer's flag off, unknown or malformed ids; rate-limited per visitor,
//     the real visitor behind the portal only with PORTAL_PROXY_SECRET
//   recap: a campus with >= 5 live confessions in 7 days (held / hidden and older ones don't count); numbers only;
//     the top one's likes; opens the top one; students without the flags or with the confessions switch off: none;
//     another campus under 5: none; Sunday 18:30 Karachi, once a week (JobLock)
//   node tests/confession-p4c/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/c", "./routes/publicConfession.routes"], ["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "ConfessionFollow", "SavedItem", "EngagementProfile"],
});
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;
const fs = require("fs");
const path = require("path");

const U = oid(); const OU = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }, { _id: OU, name: "Other University", status: "approved" }]);
const ids = { A: oid(), B: oid(), C: oid(), D: oid(), N: oid() };
fake.seed(coll("User"), [
  user(ids.A, "student", "Ayesha Author", { university: U }), user(ids.B, "student", "Bilal Sharer", { university: U }),
  user(ids.C, "student", "Chand Quiet", { university: U }), user(ids.D, "student", "Dua Elsewhere", { university: OU }),
  user(ids.N, "student", "Noor NoFlag", { university: U }),
]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: ids.C, notifPrefs: { confessions: false } }]);
const T = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, token(v, "student")]));
const now = Date.now();
const at = (hoursAgo) => new Date(now - hoursAgo * 3600e3);
const P = { pub: oid(), campus: oid(), held: oid(), reported: oid(), commentReported: oid(), otherCampus: oid() };
fake.seed(coll("Confession"), [
  { _id: P.pub, authorId: ids.A, text: "a public confession with a secret", handle: "brave-kitab-512", image: "https://res.cloudinary.com/decaxpera/image/upload/v1/x.jpg", university: U, visibility: "public", likes: 9, likedBy: [], comments: [{ _id: oid(), user: ids.C, text: "a reply that must not show", createdAt: at(1) }], createdAt: at(2) },
  { _id: P.campus, authorId: ids.A, text: "campus only", university: U, visibility: "campus", likes: 3, likedBy: [], comments: [], createdAt: at(3) },
  { _id: P.held, authorId: ids.B, text: "held one", status: "pending", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(4) },
  { _id: P.reported, authorId: ids.A, text: "reported one", university: U, visibility: "public", likes: 1, likedBy: [], comments: [], createdAt: at(5) },
  { _id: P.commentReported, authorId: ids.A, text: "only a comment of it is reported", university: U, visibility: "public", likes: 2, likedBy: [], comments: [], createdAt: at(6) },
  { _id: P.otherCampus, authorId: ids.D, text: "other campus only", university: OU, visibility: "campus", likes: 0, likedBy: [], comments: [], createdAt: at(7) },
]);
fake.seed(coll("Report"), [
  { _id: oid(), reportedBy: ids.C, contentType: "Confession", contentId: P.reported, reason: "Spam", status: "pending", createdAt: new Date() },
  { _id: oid(), reportedBy: ids.C, contentType: "Confession", contentId: P.commentReported, commentId: oid(), reason: "Spam", status: "pending", createdAt: new Date() },
]);
const share = (tok, id) => call("POST", `/api/social/confessions/${id}/share`, { tok });
const doc = (id) => rows("Confession", (c) => same(c._id, id))[0];
const BROWSER = "Mozilla/5.0 Chrome/126";
const page = (id, headers = {}) => call("GET", `/c/${id}`, { headers: { "user-agent": BROWSER, "x-forwarded-for": "203.0.113.70", ...headers } });
const notAvailable = (r) => r.status === 404 && /this confession isn.t available/.test(r.text);
const everyone = Object.values(ids).filter((x) => x !== ids.N).join(",");

(async () => {
  const server = h.start();
  console.log("-- share: flags");
  let r = await share(T.B, P.pub);
  check("flags off → 404", r.status === 404);
  process.env.FLAG_CONFESSIONS_V2 = `ids:${everyone}`;
  r = await share(T.B, P.pub);
  check("confessionsV2 alone → 404", r.status === 404);
  process.env.FLAG_CONFESSION_SHARE = `ids:${everyone}`;

  console.log("-- share: the rules");
  r = await share(T.B, P.pub);
  check("public + live + no open report → the gettdc.pk/c/<id> link and the text", r.status === 200 && r.json.url === `https://gettdc.pk/c/${P.pub}` && r.json.text === "a public confession with a secret", r.text.slice(0, 160));
  check("…marked shared (first time), by whom kept on the server only", !!doc(P.pub).sharedAt && same(doc(P.pub).sharedBy, ids.B) && doc(P.pub).shareCount === 1);
  r = await share(T.A, P.campus);
  check("campus-only → 409 CAMPUS_ONLY with a sentence", r.status === 409 && r.json.code === "CAMPUS_ONLY" && /stay on campus/.test(r.json.error));
  r = await share(T.A, P.reported);
  check("an open report on it → 409 UNDER_REVIEW", r.status === 409 && r.json.code === "UNDER_REVIEW");
  r = await share(T.A, P.commentReported);
  check("a report on one of its comments doesn't block it", r.status === 200);
  r = await share(T.A, P.held);
  check("held → 404", r.status === 404);
  r = await share(T.A, P.otherCampus);
  check("another campus's campus-only post → 404", r.status === 404);
  const feed = await call("GET", "/api/social/confessions/feed?scope=campus&sort=new", { tok: T.A });
  const sh = Object.fromEntries((feed.json || []).map((c) => [String(c._id), c.shareable]));
  check("feed: shareable for the public live one, not campus-only / reported", sh[String(P.pub)] === true && sh[String(P.campus)] === false && sh[String(P.reported)] === false && sh[String(P.commentReported)] === true, JSON.stringify(sh));
  check("…never who shared it", !/sharedBy/.test(feed.text));

  console.log("-- the page");
  r = await page(P.pub);
  check("200, the text", r.status === 200 && /a public confession with a secret/.test(r.text));
  check("text only: no handle, image, campus or replies", !/brave-kitab|cloudinary|Alpha University|a reply that must not show/.test(r.text));
  check("headers: noindex, no-store, no referrer, a CSP without scripts", r.headers["x-robots-tag"] === "noindex, nofollow" && r.headers["cache-control"] === "no-store" && r.headers["referrer-policy"] === "no-referrer" && /default-src 'none'/.test(r.headers["content-security-policy"]) && !/script/.test(r.headers["content-security-policy"]) && /<meta name="robots" content="noindex, nofollow">/.test(r.text));
  check("'read the replies in the app' → tdcapp://confession/<id>", r.text.includes(`href="tdcapp://confession/${P.pub}"`));
  const neverShared = oid();
  fake.seed(coll("Confession"), [{ _id: neverShared, authorId: ids.A, text: "public, never shared", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(30 * 24) }]);
  check("never shared → not available", notAvailable(await page(neverShared)));
  doc(P.pub).visibility = "campus";
  check("made campus-only since → not available", notAvailable(await page(P.pub)));
  doc(P.pub).visibility = "public";
  doc(P.pub).status = "hidden";
  check("hidden since → not available", notAvailable(await page(P.pub)));
  doc(P.pub).status = "live";
  const rep = oid();
  fake.seed(coll("Report"), [{ _id: rep, reportedBy: ids.C, contentType: "Confession", contentId: P.pub, reason: "Spam", status: "under_review", createdAt: new Date() }]);
  check("an open report since → not available", notAvailable(await page(P.pub)));
  rows("Report", (x) => same(x._id, rep))[0].status = "resolved";
  check("…the report resolved → back", (await page(P.pub)).status === 200);
  process.env.FLAG_CONFESSION_SHARE = `ids:${ids.A}`;
  check("the sharer's confessionShare off → not available", notAvailable(await page(P.pub)));
  process.env.FLAG_CONFESSION_SHARE = `ids:${everyone}`;
  check("unknown / malformed id → not available", notAvailable(await page(oid())) && notAvailable(await call("GET", "/c/not-an-id", { headers: { "user-agent": BROWSER } })));

  console.log("-- the page behind the portal: rate limit per visitor");
  const SECRET = "test-only-portal-proxy-secret-0123456789";
  process.env.PORTAL_PROXY_SECRET = SECRET;
  process.env.RATE_LIMIT_CONFESSION_PAGE_MAX = "2";
  const via = (ip) => page(P.pub, { "x-forwarded-for": "76.76.21.21", "x-tdc-proxy": SECRET, "x-tdc-visitor-ip": ip });
  const a = []; for (let i = 0; i < 3; i++) a.push((await via("198.18.5.1")).status);
  const b = (await via("198.18.5.2")).status;
  check("visitor A: 2 a minute, the 3rd → 429; visitor B (same edge address) still gets it", JSON.stringify(a) === "[200,200,429]" && b === 200, `${a} / ${b}`);
  delete process.env.RATE_LIMIT_CONFESSION_PAGE_MAX; delete process.env.PORTAL_PROXY_SECRET;

  console.log("-- weekly recap");
  // U: 6 live this week (top: 9 likes), plus held and older ones that don't count; OU: under 5
  fake.seed(coll("Confession"), [
    { _id: oid(), authorId: ids.B, text: "x1", university: U, visibility: "public", likes: 0, createdAt: at(30) },
    { _id: oid(), authorId: ids.B, text: "x2", university: U, visibility: "public", likes: 0, createdAt: at(40) },
    { _id: oid(), authorId: ids.B, text: "too old", university: U, visibility: "public", likes: 99, createdAt: at(8 * 24) },
    { _id: oid(), authorId: ids.B, text: "hidden", status: "hidden", university: U, visibility: "public", likes: 50, createdAt: at(10) },
    { _id: oid(), authorId: ids.D, text: "o1", university: OU, visibility: "public", likes: 0, createdAt: at(5) },
  ]);
  process.env.FLAG_CONFESSION_RECAP = `ids:${everyone}`;
  const pushes = [];
  const recap = reqS("./services/confessionRecap");
  const out = await recap.run({ now: new Date(now), send: async (to, title, body, data) => { pushes.push({ to: String(to), title, body, data }); return { sent: true }; } });
  const uRow = out.campuses.find((c) => c.university === String(U));
  check("Alpha: 6 live confessions this week (held, hidden and older left out)", uRow && uRow.confessions === 6 && uRow.topLikes === 9, JSON.stringify(out.campuses));
  check("Other University (under 5): no recap", !out.campuses.some((c) => c.university === String(OU)) && !pushes.some((p) => p.to === String(ids.D)));
  const pa = pushes.find((p) => p.to === String(ids.A));
  check("numbers only: 'your campus this week' · '6 confessions this week. the top one got 9 likes. tap to read.'", pa && pa.title === "your campus this week" && pa.body === "6 confessions this week. the top one got 9 likes. tap to read." && !/secret|confession with|campus only|x1/.test(JSON.stringify(pa)));
  check("…opens the top one (the most liked), the confession sound, type confession_recap", pa.data.params.postId === String(P.pub) && pa.data.type === "confession_recap" && pa.data.soundKey === "tdc_push_confession");
  check("not with the confessions switch off (C), not without the flag (N)", !pushes.some((p) => p.to === String(ids.C) || p.to === String(ids.N)));
  check("no top-one sentence when it has no likes; one confession / like in the singular", recap.message(5, 0) === "5 confessions this week. tap to read." && recap.message(6, 1) === "6 confessions this week. the top one got 1 like. tap to read.");
  const sched = fs.readFileSync(path.join(h.SERVER, "services", "engagement", "schedular.js"), "utf8");
  check("scheduled Sunday 18:30 Karachi, once a week across servers (JobLock)", /'30 18 \* \* 0'[\s\S]{0,120}lock\('confession_recap', weekKey\(\)\)[\s\S]{0,200}require\('\.\.\/confessionRecap'\)\.run\(\)/.test(sched));
  const budget = reqS("./services/pushBudget");
  check("the recap is a broadcast in the push budget", budget.classify("confession_recap") === "broadcast");
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
