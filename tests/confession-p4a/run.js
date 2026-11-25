// P4a confessions (owner 24 Nov 2026), on in-memory data.
//   for everyone (no flag): a confession is at most 1,000 characters (400 TOO_LONG); an image only from our Cloudinary
//     account (400 BAD_IMAGE: another site, http, another Cloudinary account); our image is saved; the two unreachable
//     duplicate routes are gone and the reachable ones behave as before (likes: names only for the author)
//   confessionsV2 off: config / me too → 404; the feed ignores sort / tag and keeps the old shape; a post ignores tag /
//     mood / postAs
//   confessionsV2 on: config (visible tags, 3 prompts, the Dot moods, 500, handle off until approved); tag / mood kept
//     only when known; handles: anon. until approved, then stable, unique, verified tick; me too toggles (never who);
//     sort hot / top / new and the tag filter; handles never pass a filtered word, banned word or left-out number
//   admin settings: rename / hide / add tags (ids stay), at least one tag, prompts
//   node tests/confession-p4a/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"], ["/api/admin/safety", "./routes/adminSafety.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification"],
});
const { call, check, oid, user, token, fake, coll, rows, reqS } = h;
const fs = require("fs");
const path = require("path");

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const ids = { A: oid(), B: oid() };
fake.seed(coll("User"), [user(ids.A, "student", "Ayesha Author", { university: U }), user(ids.B, "student", "Bilal Reader", { university: U })]);
const T = { A: token(ids.A, "student"), B: token(ids.B, "student") };
const C1 = oid();
fake.seed(coll("Confession"), [{ _id: C1, authorId: ids.A, text: "a post", university: U, visibility: "public", likes: 1, likedBy: [ids.B], comments: [], createdAt: new Date() }]);
const OURS = "https://res.cloudinary.com/decaxpera/image/upload/v1700000000/tdc/abc.jpg";
const create = (tok, body) => call("POST", "/api/social/confessions/create", { tok, body });

(async () => {
  const server = h.start();
  console.log("-- for everyone: length and images");
  let r = await create(T.A, { text: "x".repeat(1001) });
  check("1,001 characters → 400 TOO_LONG with a sentence", r.status === 400 && r.json?.code === "TOO_LONG" && /1,000/.test(r.json.error));
  r = await create(T.A, { text: "y".repeat(1000) });
  check("1,000 characters → posted", r.status === 201, r.text.slice(0, 120));
  for (const [bad, why] of [["https://evil.example/a.jpg", "another site"], ["http://res.cloudinary.com/decaxpera/image/upload/a.jpg", "http"], ["https://res.cloudinary.com/someoneelse/image/upload/a.jpg", "another Cloudinary account"], ["javascript:alert(1)", "not a link"]]) {
    r = await create(T.A, { text: "with an image", image: bad });
    check(`image from ${why} → 400 BAD_IMAGE, nothing saved`, r.status === 400 && r.json?.code === "BAD_IMAGE" && !rows("Confession").some((c) => c.image === bad), `${r.status}`);
  }
  r = await create(T.A, { text: "with our image", image: OURS });
  check("an image from our Cloudinary account → posted with it", r.status === 201 && rows("Confession").some((c) => c.image === OURS));
  r = await create(T.A, { image: OURS });
  check("an image alone (no text) still works", r.status === 201);

  console.log("-- the duplicate routes");
  const src = fs.readFileSync(path.join(h.SERVER, "routes", "social.routes.js"), "utf8");
  check("GET /confessions/my-confessions and GET /confessions/likes/:id are each defined once", (src.match(/router\.get\('\/confessions\/my-confessions'/g) || []).length === 1 && (src.match(/router\.get\('\/confessions\/likes\/:id'/g) || []).length === 1);
  r = await call("GET", `/api/social/confessions/likes/${C1}`, { tok: T.B });
  check("likes for someone else: no names, the count (as before)", r.status === 200 && JSON.stringify(r.json.likes) === "[]" && r.json.count === 1);
  r = await call("GET", `/api/social/confessions/likes/${C1}`, { tok: T.A });
  check("likes for the author: the names", r.status === 200 && r.json.likes.length === 1 && r.json.likes[0].name === "Bilal Reader");
  r = await call("GET", "/api/social/confessions/my-confessions", { tok: T.A });
  check("my-confessions: the author's confessions, no authorId", r.status === 200 && Array.isArray(r.json) && r.json.length >= 1 && !/authorId/.test(r.text));

  console.log("-- confessionsV2 off");
  {
    let x = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
    check("config → 404", x.status === 404);
    x = await call("PUT", `/api/social/confessions/${C1}/metoo`, { tok: T.A });
    check("me too → 404", x.status === 404);
    x = await create(T.A, { text: "flag off post", tag: "rant", mood: "sus", postAs: "handle" });
    const d0 = rows("Confession").find((c) => String(c._id) === String(x.json?.confession?._id));
    check("a post ignores tag / mood / postAs", x.status === 201 && d0 && !d0.tag && !d0.mood && !d0.handle);
  }

  console.log("-- confessionsV2 on");
  process.env.FLAG_CONFESSIONS_V2 = `ids:${ids.A},${ids.B}`;
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
  const cfg = r.json || {};
  check("config: 9 visible tags, 3 prompts, the 8 Dot moods, 500 characters", r.status === 200 && cfg.tags.length === 9 && cfg.tags[0].id === "crush" && cfg.prompts.length === 3 && cfg.moods.join() === "excited,broke,panic,sus,shook,sleepy,cheeky,sorted" && cfg.maxLength === 500, r.text.slice(0, 200));
  check("…handle off without the confessionHandles flag (owner: its own flag)", cfg.handle.enabled === false && cfg.handle.handle === null && !rows("User").some((u) => u.confessionHandle));
  r = await create(T.A, { text: "a rant with a mood", tag: "rant", mood: "sus", postAs: "handle" });
  let doc = rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id));
  check("a post keeps a visible tag and a known mood; 'as @handle' stays anon. (confessionHandles off)", r.status === 201 && doc.tag === "rant" && doc.mood === "sus" && !doc.handle && r.json.confession.tag === "rant");
  r = await create(T.A, { text: "made-up tag", tag: "politics", mood: "angry" });
  doc = rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id));
  check("an unknown tag or mood is ignored (posted, without them)", r.status === 201 && !doc.tag && !doc.mood);

  console.log("-- handles (flag confessionHandles on; owner: switched on after approving the words)");
  const lists = reqS("./config/confessionHandles");
  const handles = reqS("./services/confessionHandles");
  process.env.FLAG_CONFESSION_HANDLES = "on";
  r = await create(T.A, { text: "posted as my handle", postAs: "handle" });
  doc = rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id));
  const mine = rows("User").find((u) => String(u._id) === String(ids.A)).confessionHandle;
  check("confessionHandles on: 'as @handle' → the student's handle on the post, with the verified tick (a verified student)", /^[a-z]+-[a-z]+-\d{3}$/.test(doc.handle || "") && doc.handle === mine && doc.handleVerified === true, JSON.stringify({ h: doc.handle, mine }));
  r = await create(T.A, { text: "again as my handle", postAs: "handle" });
  check("…the same handle next time (stable)", rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id)).handle === mine);
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
  check("config: enabled, my handle", r.json.handle.enabled === true && r.json.handle.handle === mine);
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T.B });
  const bh = r.json.handle.handle;
  check("another student gets a different handle", !!bh && bh !== mine);
  r = await create(T.A, { text: "fully anon this time" });
  check("not asked for: anon. (no handle)", !rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id)).handle);
  check("handles never pass a filtered word, a banned word or a left-out number", !handles.clean("brave-samosa-455") && !handles.clean("brave-samosa-786") && !handles.clean("brave-samosa-169") && !handles.clean("brave-samosa-313") && !handles.clean("brave-samosa-420") && !handles.clean("brave-samosa-666") && !handles.clean("brave-samosa-343", ["samosa"]) && handles.clean("brave-samosa-343"));
  let generatedOk = true;
  for (let i = 0; i < 3000; i++) { const c = handles.candidate(); if (!handles.clean(c)) { generatedOk = false; break; } }
  check("3,000 generated handles all pass the filter", generatedOk);
  delete process.env.FLAG_CONFESSION_HANDLES;

  console.log("-- me too");
  const feedOf = async (tok, q = "scope=all") => { const x = await call("GET", `/api/social/confessions/feed?${q}`, { tok }); return Array.isArray(x.json) ? x.json : []; };
  r = await call("PUT", `/api/social/confessions/${C1}/metoo`, { tok: T.B });
  check("me too → on, count 1", r.status === 200 && r.json.meToo === true && r.json.meTooCount === 1);
  let f1 = (await feedOf(T.B)).find((c) => String(c._id) === String(C1));
  check("feed: meTooCount 1 and meTooByCurrentUser for the one who tapped", f1.meTooCount === 1 && f1.meTooByCurrentUser === true);
  f1 = (await feedOf(T.A)).find((c) => String(c._id) === String(C1));
  check("…not for someone else; who tapped is never sent", f1.meTooByCurrentUser === false && !("meTooBy" in f1));
  r = await call("PUT", `/api/social/confessions/${C1}/metoo`, { tok: T.B });
  check("tap again → off, count 0", r.json.meToo === false && r.json.meTooCount === 0);
  const otherPost = oid(); const OU = oid();
  fake.seed(coll("Confession"), [{ _id: otherPost, authorId: ids.B, text: "other campus only", university: OU, visibility: "campus", likes: 0, likedBy: [], comments: [], createdAt: new Date() }]);
  r = await call("PUT", `/api/social/confessions/${otherPost}/metoo`, { tok: T.A });
  check("a campus-only post of another campus → 404", r.status === 404);

  console.log("-- sort and tags");
  const ago = (hours) => new Date(Date.now() - hours * 3600e3);
  const S = { fresh: oid(), popularOld: oid(), weekTop: oid(), tooOld: oid() };
  fake.seed(coll("Confession"), [
    { _id: S.fresh, authorId: ids.B, text: "fresh, a few likes", university: U, visibility: "public", likes: 3, likedBy: [], comments: [], createdAt: ago(1), tag: "food" },
    { _id: S.popularOld, authorId: ids.B, text: "6 days old, many likes", university: U, visibility: "public", likes: 40, likedBy: [], comments: [], createdAt: ago(6 * 24), tag: "rant" },
    { _id: S.weekTop, authorId: ids.B, text: "3 days old, most engaged", university: U, visibility: "public", likes: 50, meTooCount: 10, likedBy: [], comments: [], createdAt: ago(3 * 24), tag: "rant" },
    { _id: S.tooOld, authorId: ids.B, text: "20 days old, huge", university: U, visibility: "public", likes: 999, likedBy: [], comments: [], createdAt: ago(20 * 24) },
  ]);
  const order = (list) => list.map((c) => String(c._id));
  const top = order(await feedOf(T.A, "scope=all&sort=top"));
  check("top this week: the most engaged of the last 7 days first; older than a week left out", top[0] === String(S.weekTop) && top[1] === String(S.popularOld) && !top.includes(String(S.tooOld)), top.slice(0, 3).join());
  const hot = order(await feedOf(T.A, "scope=all&sort=hot"));
  check("hot: a fresh post with a few likes beats a 6-day-old one with many (fades with age); 20 days old left out", hot.indexOf(String(S.fresh)) < hot.indexOf(String(S.popularOld)) && !hot.includes(String(S.tooOld)));
  const page1 = order(await feedOf(T.A, "scope=all&sort=top&limit=1&page=1"));
  check("pages: limit 1, page 1 → the second", page1.length === 1 && page1[0] === String(S.popularOld));
  const rants = await feedOf(T.A, "scope=all&tag=rant");
  check("tag filter: only that tag", rants.length >= 2 && rants.every((c) => c.tag === "rant"));
  const newest = order(await feedOf(T.A, "scope=all&sort=new"));
  check("new: newest first (as today)", newest.indexOf(String(S.fresh)) < newest.indexOf(String(S.weekTop)));

  console.log("-- flag-off viewers");
  process.env.FLAG_CONFESSIONS_V2 = `ids:${ids.A}`;
  const offFeed = await call("GET", "/api/social/confessions/feed?scope=all&sort=top&tag=rant", { tok: T.B });
  check("sort / tag ignored, newest first, and no v2 field at all (the old shape)", Array.isArray(offFeed.json) && String(offFeed.json[0]._id) !== String(S.weekTop) && !/"(meTooCount|meTooByCurrentUser|handle|handleVerified|tag|mood)":/.test(offFeed.text));
  process.env.FLAG_CONFESSIONS_V2 = `ids:${ids.A},${ids.B}`;

  console.log("-- admin settings: tags and prompts");
  const ADM = oid(); fake.seed(coll("User"), [user(ADM, "admin", "Admin One")]);
  const TA = token(ADM, "admin");
  r = await call("PUT", "/api/admin/safety/settings", { tok: TA, body: { tags: [{ id: "crush", label: "crushes" }, { id: "rant", label: "rant", hidden: true }, { label: "Exam Stress" }], prompts: ["one", "two", "three", "four"] } });
  check("rename (the id stays), hide, add (id from the label); prompts saved", r.status === 200 && JSON.stringify(r.json.data.tags) === JSON.stringify([{ id: "crush", label: "crushes", hidden: false }, { id: "rant", label: "rant", hidden: true }, { id: "exam-stress", label: "Exam Stress", hidden: false }]) && r.json.data.prompts.length === 4, r.text.slice(0, 240));
  reqS("./services/safetySettings")._reset();
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
  check("the app sees the visible tags only (hidden ones aren't offered)", r.json.tags.map((t) => t.id).join() === "crush,exam-stress" && r.json.tags[0].label === "crushes");
  r = await create(T.A, { text: "hidden tag", tag: "rant" });
  check("a hidden tag can't be picked any more (ignored)", !rows("Confession").find((c) => String(c._id) === String(r.json?.confession?._id)).tag);
  r = await call("PUT", "/api/admin/safety/settings", { tok: TA, body: { tags: [] } });
  check("no tags at all → 400 NO_TAGS", r.status === 400 && (r.json?.error?.code === "NO_TAGS" || r.json?.code === "NO_TAGS"), r.text.slice(0, 160));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
