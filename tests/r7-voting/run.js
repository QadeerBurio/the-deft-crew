// r7, plan P4-3: confession voting (confessionsVoting, under confessionsV2), used only for auto-hide, on in-memory data
// with the real routes:
//   flag off (or confessionsV2 off): PUT /confessions/:id/vote → 404, the feed has no myVote
//   on: up / down / null, one vote per student (changing it moves it), my own vote in the feed (myVote), never counts or
//   voters; not on your own confession (400); bad value → 400; 10 down and at least 2× up → hidden ("hidden by down
//   votes"), into the Safety "held" queue, out of the feed; an admin's approve is final (more down votes don't hide it)
//   node tests/r7-voting/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"], ["/api/admin/safety", "./routes/adminSafety.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "AdminActionLog", "SavedItem"],
});
const { call, check, oid, user, token, fake, coll, rows, same } = h;
const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const A = oid(); // the author
const S = Array.from({ length: 14 }, () => oid()); // voters
const ADM = oid();
fake.seed(coll("User"), [user(A, "student", "Ayesha Author", { university: U }), ...S.map((id, i) => user(id, "student", `Student ${i}`, { university: U })), user(ADM, "admin", "Ada Admin")]);
const T = (id) => token(id, "student");
const C1 = oid(); const C2 = oid();
const now = new Date();
fake.seed(coll("Confession"), [
  { _id: C1, text: "a confession people will vote on", authorId: A, university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: now },
  { _id: C2, text: "a second one", authorId: A, university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: new Date(now - 1000) },
]);
const vote = (id, c, v) => call("PUT", `/api/social/confessions/${c}/vote`, { tok: T(id), body: { vote: v } });
const feed = async (id) => { const r = await call("GET", "/api/social/confessions/feed?scope=all&sort=new", { tok: T(id) }); return Array.isArray(r.json) ? r.json : []; };
const doc = (c) => rows("Confession", (x) => same(x._id, c))[0] || {};
const all = S.map(String).join(",");

(async () => {
  const server = h.start();
  process.env.FLAG_CONFESSIONS_V2 = `ids:${all},${A}`;
  delete process.env.FLAG_CONFESSIONS_VOTING;

  let r = await vote(S[0], C1, "down");
  check("confessionsVoting off: the vote route is absent (404)", r.status === 404);
  let list = await feed(S[0]);
  check("…and the feed has no myVote", list.length === 2 && list.every((c) => !("myVote" in c)));

  process.env.FLAG_CONFESSIONS_VOTING = `ids:${all},${A}`;
  r = await vote(S[0], C1, "sideways");
  check("a bad value: 400", r.status === 400);
  r = await vote(A, C1, "up");
  check("the author can't vote on their own confession (400 OWN_CONFESSION)", r.status === 400 && r.json?.code === "OWN_CONFESSION");
  r = await vote(S[0], C1, "up");
  check("up → { vote: up }, nothing else in the reply", r.status === 200 && JSON.stringify(r.json) === '{"vote":"up"}', JSON.stringify(r.json));
  r = await vote(S[0], C1, "down");
  check("changing it moves it (one vote per student)", r.json?.vote === "down" && (doc(C1).voteUp || []).length === 0 && (doc(C1).voteDown || []).length === 1);
  list = await feed(S[0]);
  const mine = list.find((c) => same(c._id, C1));
  check("the feed: my own vote only (myVote), no counts, no voters", mine?.myVote === "down" && list.find((c) => same(c._id, C2))?.myVote === null && list.every((c) => !("voteUp" in c) && !("voteDown" in c) && !("voteUpCount" in c) && !("voteDownCount" in c)), JSON.stringify(mine && Object.keys(mine)));
  const other = (await feed(S[1])).find((c) => same(c._id, C1));
  check("…another student sees none (myVote null)", other?.myVote === null);
  check("…the author's own confessions carry no myVote (no arrows on your own post)", (await feed(A)).every((c) => !("myVote" in c)));
  r = await vote(S[0], C1, null);
  check("null takes the vote back", r.json?.vote === null && (doc(C1).voteDown || []).length === 0);

  // 5 up, then down votes: 9 down is not enough; the 10th hides it (10 ≥ 2 × 5)
  for (let i = 0; i < 5; i++) await vote(S[i], C1, "up");
  for (let i = 5; i < 14; i++) await vote(S[i], C1, "down");
  check("5 up, 9 down: still live", !doc(C1).status || doc(C1).status === "live");
  await vote(S[0], C1, "down"); // 4 up, 10 down
  check("4 up, 10 down: hidden, reason 'hidden by down votes'", doc(C1).status === "hidden" && doc(C1).statusReason === "hidden by down votes", JSON.stringify({ s: doc(C1).status, r: doc(C1).statusReason }));
  list = await feed(S[1]);
  check("…out of the feed", !list.some((c) => same(c._id, C1)));
  r = await call("GET", "/api/admin/safety/queue?tab=held", { tok: token(ADM, "admin") });
  const held = (r.json?.data?.items || []).find((x) => x.confessionId === String(C1));
  check("…in the admin Safety 'held' queue with the reason", held && held.statusReason === "hidden by down votes", JSON.stringify(r.json?.data?.items?.map((x) => x.statusReason)));
  r = await call("POST", `/api/admin/safety/confession/${C1}/resolve`, { tok: token(ADM, "admin"), body: { action: "approve", note: "fine" } });
  check("the admin approves it: live again", r.status === 200 && doc(C1).status === "live");
  await vote(S[1], C1, "down"); await vote(S[2], C1, "down");
  check("an admin's approve is final: more down votes don't hide it", doc(C1).status === "live");

  delete process.env.FLAG_CONFESSIONS_VOTING;
  r = await vote(S[3], C2, "down");
  check("flag off again: 404 (nothing changes)", r.status === 404 && !(doc(C2).voteDown || []).length);
  delete process.env.FLAG_CONFESSIONS_V2;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
