// P4b confessions (owner 25 Nov 2026), on in-memory data with a fake AI and a fake push sender.
//   flags off: poll / follow → 404, save → 404 without confessionsV2; a poll in a post is ignored; no poll / following /
//     saved fields for flag-off viewers
//   polls (confessionsV2 + confessionPolls): 2-4 different options of up to 60 characters, a question needed; the
//     options go through the pre-post check with the text; vote, change, same again = no change; the counts and my
//     vote are sent, who voted never; another campus's campus-only post → 404
//   follow (confessionFollow): the author follows their own; a live reply pushes to followers: never a name or any
//     text, not to the one who replied, not after mute, once per 30 minutes, not for a held reply, not with the
//     confessions switch off, not to a follower without the flag
//   save (confessionsV2): saved: true in the feed, ?saved=1 lists them, unsave, a hidden one drops out
//   node tests/confession-p4b/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "ConfessionFollow", "SavedItem", "EngagementProfile"],
});
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;

const U = oid(); const OU = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }, { _id: OU, name: "Other University", status: "approved" }]);
const ids = { A: oid(), B: oid(), C: oid(), D: oid(), N: oid() };
fake.seed(coll("User"), [
  user(ids.A, "student", "Ayesha Author", { university: U }), user(ids.B, "student", "Bilal Reader", { university: U }),
  user(ids.C, "student", "Chand Quiet", { university: U }), user(ids.D, "student", "Dua Elsewhere", { university: OU }),
  user(ids.N, "student", "Noor NoFlag", { university: U }),
]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: ids.C, notifPrefs: { confessions: false } }]);
const T = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, token(v, "student")]));
const CC = reqS("./services/confessionCheck");
let aiDown = false;
CC._setClientForTests({
  moderations: { create: async ({ input }) => { if (aiDown) throw new Error("down"); return { results: [{ flagged: false, categories: {} }] }; } },
  chat: { completions: { create: async () => { if (aiDown) throw new Error("down"); return { choices: [{ message: { content: JSON.stringify({ religion: false, politics: false, ethnic_or_sectarian: false, sexual_or_vulgar: false, threat: false, quote: "" }) } }] }; } } },
});
const pushes = [];
reqS("./utils/pushNotification").sendToUser = async (userId, title, body, data) => { pushes.push({ to: String(userId), title, body, data }); return { sent: true }; };
const create = (tok, body) => call("POST", "/api/social/confessions/create", { tok, body });
const feed = async (tok, q = "scope=all&sort=new") => { const r = await call("GET", `/api/social/confessions/feed?${q}`, { tok }); return Array.isArray(r.json) ? r.json : []; };
const doc = (id) => rows("Confession", (c) => same(c._id, id))[0];
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const allIds = Object.values(ids).filter((x) => x !== ids.N).join(",");

(async () => {
  const server = h.start();
  const C0 = oid();
  fake.seed(coll("Confession"), [{ _id: C0, authorId: ids.A, text: "a plain post", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: new Date() }]);

  console.log("-- flags off");
  let r = await call("PUT", `/api/social/confessions/${C0}/poll`, { tok: T.A, body: { option: 0 } });
  check("poll vote → 404", r.status === 404);
  r = await call("PUT", `/api/social/confessions/${C0}/follow`, { tok: T.A, body: { on: true } });
  check("follow → 404", r.status === 404);
  r = await call("PUT", `/api/social/confessions/${C0}/save`, { tok: T.A, body: { on: true } });
  check("save without confessionsV2 → 404", r.status === 404);
  r = await create(T.A, { text: "which is better?", poll: { options: ["chai", "coffee"] } });
  check("a poll in a post is ignored (posted without it)", r.status === 201 && !doc(r.json.confession._id).poll);
  process.env.FLAG_CONFESSIONS_V2 = `ids:${allIds}`;
  r = await create(T.A, { text: "v2 only, no polls flag", poll: { options: ["a", "b"] } });
  check("confessionsV2 without confessionPolls: still ignored", r.status === 201 && !doc(r.json.confession._id).poll);
  r = await call("PUT", `/api/social/confessions/${C0}/poll`, { tok: T.A, body: { option: 0 } });
  check("…and voting → 404", r.status === 404);

  console.log("-- polls");
  process.env.FLAG_CONFESSION_POLLS = `ids:${allIds}`;
  for (const [poll, why] of [[{ options: ["only one"] }, "one option"], [{ options: ["a", "b", "c", "d", "e"] }, "five options"], [{ options: ["same", "Same"] }, "the same option twice"], [{ options: ["x".repeat(61), "y"] }, "an option over 60 characters"], ["chai,coffee", "not a list"]]) {
    r = await create(T.A, { text: "a question?", poll });
    check(`${why} → 400 BAD_POLL with a sentence`, r.status === 400 && r.json?.code === "BAD_POLL" && !!r.json.error, r.text.slice(0, 120));
  }
  r = await create(T.A, { text: "", image: "https://res.cloudinary.com/decaxpera/image/upload/v1/q.jpg", poll: { options: ["a", "b"] } });
  check("a poll without the question (an image only) → 400 BAD_POLL", r.status === 400 && r.json?.code === "BAD_POLL", r.text.slice(0, 120));
  r = await create(T.A, { text: "chai or coffee before class?", poll: { options: ["  chai ", "coffee", "neither"] } });
  const P = r.json?.confession?._id;
  check("posted with the poll (trimmed, counts at 0)", r.status === 201 && JSON.stringify(doc(P).poll) === JSON.stringify({ options: ["chai", "coffee", "neither"], counts: [0, 0, 0] }), JSON.stringify(doc(P)?.poll));
  process.env.FLAG_CONFESSION_SAFETY = `ids:${ids.A}`;
  r = await create(T.A, { text: "a clean question?", poll: { options: ["fine", "you chutiya"] } });
  check("an option with a banned word → 422 NEEDS_EDIT (options go through the pre-post check)", r.status === 422 && r.json?.code === "NEEDS_EDIT", r.text.slice(0, 160));
  delete process.env.FLAG_CONFESSION_SAFETY;
  r = await call("PUT", `/api/social/confessions/${P}/poll`, { tok: T.B, body: { option: 0 } });
  check("vote → my vote and the counts", r.status === 200 && r.json.poll.myVote === 0 && r.json.poll.total === 1 && r.json.poll.options[0].votes === 1);
  r = await call("PUT", `/api/social/confessions/${P}/poll`, { tok: T.B, body: { option: 1 } });
  check("change the vote → moved (no double count)", r.json.poll.myVote === 1 && r.json.poll.total === 1 && r.json.poll.options[0].votes === 0 && r.json.poll.options[1].votes === 1);
  r = await call("PUT", `/api/social/confessions/${P}/poll`, { tok: T.B, body: { option: 1 } });
  check("the same vote again → unchanged", r.json.poll.total === 1);
  r = await call("PUT", `/api/social/confessions/${P}/poll`, { tok: T.C, body: { option: 1 } });
  r = await call("PUT", `/api/social/confessions/${P}/poll`, { tok: T.C, body: { option: 7 } });
  check("an option that doesn't exist → 400", r.status === 400 && r.json?.code === "BAD_OPTION");
  const pf = (await feed(T.A)).find((c) => String(c._id) === String(P));
  check("feed: the poll with counts, my vote (none for the author), never who voted", pf.poll.total === 2 && pf.poll.options[1].votes === 2 && pf.poll.myVote === null && !("pollVoters" in pf) && !JSON.stringify(pf).includes(String(ids.B)));
  const campusPoll = oid();
  fake.seed(coll("Confession"), [{ _id: campusPoll, authorId: ids.A, text: "campus only?", university: U, visibility: "campus", poll: { options: ["a", "b"], counts: [0, 0] }, likes: 0, likedBy: [], comments: [], createdAt: new Date() }]);
  r = await call("PUT", `/api/social/confessions/${campusPoll}/poll`, { tok: T.D, body: { option: 0 } });
  check("another campus's campus-only poll → 404", r.status === 404);

  console.log("-- follow and reply pushes");
  process.env.FLAG_CONFESSION_FOLLOW = `ids:${allIds}`;
  r = await create(T.A, { text: "followed by its author" });
  const F = r.json.confession._id;
  await tick();
  check("the author follows their own confession", rows("ConfessionFollow").some((x) => same(x.user, ids.A) && same(x.confession, F) && x.on === true && x.author === true));
  let ff = (await feed(T.A)).find((c) => String(c._id) === String(F));
  check("feed: following for the author", ff.following === true);
  ff = (await feed(T.B)).find((c) => String(c._id) === String(F));
  check("…not for someone else", ff.following === false);
  r = await call("PUT", `/api/social/confessions/${F}/follow`, { tok: T.C, body: { on: true } });
  r = await call("PUT", `/api/social/confessions/${F}/follow`, { tok: T.N, body: { on: true } });
  check("a student without confessionFollow can't follow (404)", r.status === 404);
  fake.seed(coll("ConfessionFollow"), [{ _id: oid(), user: ids.N, confession: F, on: true, author: false, lastPushAt: null, createdAt: new Date() }]); // as if followed before the flag went off
  pushes.length = 0;
  r = await call("POST", `/api/social/confessions/comment/${F}`, { tok: T.B, body: { text: "a reply from bilal" } });
  await tick(80);
  check("a live reply → a push to the author", r.status === 200 && pushes.some((p) => p.to === String(ids.A)), JSON.stringify(pushes.map((p) => p.to)));
  const p0 = pushes.find((p) => p.to === String(ids.A));
  check("…never a name or any text: 'new reply on a confession you follow', the confession sound, opens the post", p0 && p0.title === "new reply on a confession you follow" && p0.body === "" && !/bilal|reply from|followed by/i.test(JSON.stringify(p0)) && p0.data.type === "confession_follow" && p0.data.soundKey === "tdc_push_confession" && p0.data.params.postId === String(F));
  check("…not to the one who replied, not with the confessions switch off (C), not without the flag (N)", !pushes.some((p) => [ids.B, ids.C, ids.N].map(String).includes(p.to)), JSON.stringify(pushes.map((p) => p.to)));
  pushes.length = 0;
  r = await call("POST", `/api/social/confessions/comment/${F}`, { tok: T.B, body: { text: "another reply" } });
  await tick(80);
  check("a second reply within 30 minutes → no second push", pushes.length === 0, JSON.stringify(pushes));
  rows("ConfessionFollow").forEach((x) => { x.lastPushAt = null; });
  r = await call("PUT", `/api/social/confessions/${F}/follow`, { tok: T.A, body: { on: false } });
  check("the author mutes it → following false", r.status === 200 && r.json.following === false);
  pushes.length = 0;
  r = await call("POST", `/api/social/confessions/comment/${F}`, { tok: T.B, body: { text: "after the mute" } });
  await tick(80);
  check("muted → no push", !pushes.some((p) => p.to === String(ids.A)));
  await call("PUT", `/api/social/confessions/${F}/follow`, { tok: T.A, body: { on: true } });
  rows("ConfessionFollow").forEach((x) => { x.lastPushAt = null; });
  process.env.FLAG_CONFESSION_SAFETY = `ids:${ids.B}`;
  aiDown = true;
  pushes.length = 0;
  r = await call("POST", `/api/social/confessions/comment/${F}`, { tok: T.B, body: { text: "held because the check is down" } });
  await tick(80);
  check("a held reply (check unavailable) → no push", r.json?.held === true && pushes.length === 0, `${r.text.slice(0, 100)} ${JSON.stringify(pushes)}`);
  aiDown = false;
  delete process.env.FLAG_CONFESSION_SAFETY;

  console.log("-- save");
  r = await call("PUT", `/api/social/confessions/${C0}/save`, { tok: T.B, body: { on: true } });
  check("save → saved", r.status === 200 && r.json.saved === true && rows("SavedItem").some((x) => same(x.user, ids.B) && x.kind === "confession" && same(x.refId, C0)));
  r = await call("PUT", `/api/social/confessions/${C0}/save`, { tok: T.B, body: { on: true } });
  check("save again → still one", rows("SavedItem").filter((x) => same(x.user, ids.B) && same(x.refId, C0)).length === 1);
  let list = await feed(T.B);
  check("feed: saved true on it, false on others", list.find((c) => String(c._id) === String(C0)).saved === true && list.find((c) => String(c._id) === String(F)).saved === false);
  list = await feed(T.B, "scope=all&sort=new&saved=1");
  check("?saved=1 → only my saved confessions", list.length === 1 && String(list[0]._id) === String(C0));
  doc(C0).status = "hidden";
  list = await feed(T.B, "scope=all&sort=new&saved=1");
  check("a saved confession that is hidden now drops out", list.length === 0);
  doc(C0).status = "live";
  r = await call("PUT", `/api/social/confessions/${C0}/save`, { tok: T.B, body: { on: false } });
  check("unsave → gone", r.json.saved === false && !rows("SavedItem").some((x) => same(x.user, ids.B) && same(x.refId, C0)));
  r = await call("PUT", `/api/social/confessions/${campusPoll}/save`, { tok: T.D, body: { on: true } });
  check("another campus's campus-only post can't be saved (404)", r.status === 404);

  console.log("-- flag-off viewers");
  process.env.FLAG_CONFESSIONS_V2 = `ids:${ids.A}`;
  const off = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.B });
  check("no poll, following or saved for a viewer without confessionsV2", Array.isArray(off.json) && !/"(poll|following|saved|pollVoters)":/.test(off.text));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
