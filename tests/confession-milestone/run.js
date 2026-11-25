// P5b (flag celebrationsPlus): a confession's author is told once when it first reaches 10 likes — an in-app popup
// with no names, no confession text and no push; on in-memory data with the real like route.
//   the 10th like → one "confession_likes" popup on the author's queue; the liker's reply is unchanged
//   an unlike + like again, an 11th like, a burst of likes: no second popup (likes10CelebratedAt, atomic)
//   the author without the flag: no popup and nothing marked (a later 10th like with the flag still counts)
//   node tests/confession-milestone/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/social.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "EngagementProfile"],
});
const { call, check, oid, user, token, fake, coll, rows, same } = h;

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const A = oid(); const N = oid();
const likers = Array.from({ length: 14 }, () => oid());
fake.seed(coll("User"), [user(A, "student", "Ayesha Author", { university: U }), user(N, "student", "Noor NoFlag", { university: U }), ...likers.map((id, i) => user(id, "student", `Liker ${i}`, { university: U }))]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: A, pendingPopups: [] }, { _id: oid(), user: N, pendingPopups: [] }]);
const C1 = oid(); const C2 = oid();
const now = new Date();
fake.seed(coll("Confession"), [
  { _id: C1, authorId: A, text: "a secret only the author knows", university: U, visibility: "public", likes: 8, likedBy: likers.slice(0, 8), comments: [], createdAt: now },
  { _id: C2, authorId: N, text: "another secret", university: U, visibility: "public", likes: 9, likedBy: likers.slice(0, 9), comments: [], createdAt: now },
]);
const T = (id) => token(id, "student");
const popupsOf = (id) => (rows("EngagementProfile", (p) => same(p.user, id))[0]?.pendingPopups || []).filter((p) => p.kind === "confession_likes");
const conf = (id) => rows("Confession", (c) => same(c._id, id))[0];
const settle = () => new Promise((r) => setTimeout(r, 150));
const like = (cid, who) => call("PUT", `/api/social/confessions/like/${cid}`, { tok: T(who) });

(async () => {
  const server = h.start();
  process.env.FLAG_CELEBRATIONS_PLUS = `ids:${A}`;

  let r = await like(C1, likers[8]); await settle();
  check("9th like: no popup", r.status === 200 && r.json.likes === 9 && popupsOf(A).length === 0);
  r = await like(C1, likers[9]); await settle();
  check("10th like: the liker's reply is unchanged ({ likes, liked })", r.status === 200 && JSON.stringify(Object.keys(r.json).sort()) === '["liked","likes"]' && r.json.likes === 10 && r.json.liked === true, JSON.stringify(r.json));
  const p = popupsOf(A);
  check("…the author gets one 'confession_likes' popup", p.length === 1 && p[0].line === "10 people liked your confession." && p[0].cta?.route === "FeedScreen" && p[0].cta?.params?.postId === String(C1), JSON.stringify(p));
  check("…no names and no confession text in it", !JSON.stringify(p).includes("secret") && !JSON.stringify(p).includes("Liker"));
  check("…marked on the confession", !!conf(C1).likes10CelebratedAt);

  await like(C1, likers[9]); await like(C1, likers[9]); await settle(); // unlike, like again
  await like(C1, likers[10]); await settle(); // 11th
  check("unlike + like again, an 11th like: still one popup", popupsOf(A).length === 1, String(popupsOf(A).length));

  // a burst: reset the confession to 9 likes with no marker, then 3 likes at once
  const c1 = conf(C1); c1.likes = 9; c1.likedBy = likers.slice(0, 9); delete c1.likes10CelebratedAt;
  const ep = rows("EngagementProfile", (x) => same(x.user, A))[0]; ep.pendingPopups = [];
  await Promise.all([like(C1, likers[11]), like(C1, likers[12]), like(C1, likers[13])]); await settle();
  check("a burst of likes past 10: one popup", popupsOf(A).length === 1, String(popupsOf(A).length));

  // the author without the flag
  r = await like(C2, likers[9]); await settle();
  check("author without the flag: the like works, no popup, nothing marked", r.status === 200 && r.json.likes === 10 && popupsOf(N).length === 0 && !conf(C2).likes10CelebratedAt);
  process.env.FLAG_CELEBRATIONS_PLUS = `ids:${A},${N}`;
  r = await like(C2, likers[10]); await settle();
  check("…once they have it, the next like (past 10) still celebrates, once", popupsOf(N).length === 1);

  const field = h.reqS("./models/Confession").schema.path("likes10CelebratedAt");
  check("Confession.likes10CelebratedAt: optional, never sent (select: false)", field && field.instance === "Date" && field.options.select === false);
  delete process.env.FLAG_CELEBRATIONS_PLUS;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
