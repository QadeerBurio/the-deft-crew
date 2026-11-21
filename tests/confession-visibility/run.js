// Confession visibility and anonymity (upgrade/p4-1-safety, plan P4-1), on in-memory data. For everyone, flag or not:
//   - feed: confessions without a status (older) and "live" ones show; pending / hidden / removed don't (admins
//     included); a held ("pending") confession shows only to its author, with its status
//   - comments: pending / hidden comments show only to their writer (with status); others see live ones
//   - feed never carries authorId, reportedBy or statusReason
//   - like / comment on a hidden confession → 404
//   - my-confessions: another student's comment has user: null (same shape), my own keeps my name
//   - likes list: names only for the confession's author; everyone else gets likes: [] and the count
//   - a held / hidden confession can't be made a Daily Drop
//   - muted authors are left out of the feed for a viewer with confessionSafety on (and only then)
//   node tests/confession-visibility/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/social.routes"], ["/api/admin/engagement", "./routes/adminEngagement.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "DailyDrop"],
});
const { call, check, oid, user, token, fake, coll, reqS } = h;
const flags = reqS("./config/featureFlags");

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const ids = { A: oid(), B: oid(), C: oid(), admin: oid() };
fake.seed(coll("User"), [
  user(ids.A, "student", "Ayesha Author", { university: U }),
  user(ids.B, "student", "Bilal Reader", { university: U }),
  user(ids.C, "student", "Chand Commenter", { university: U }),
  user(ids.admin, "admin", "Admin One"),
]);
const T = { A: token(ids.A, "student"), B: token(ids.B, "student"), C: token(ids.C, "student"), admin: token(ids.admin, "admin") };
const now = Date.now();
const at = (m) => new Date(now - m * 60000);
const cid = { old: oid(), live: oid(), pending: oid(), hidden: oid(), removed: oid(), other: oid() };
const cm = { liveB: oid(), pendC: oid(), hidC: oid(), mineA: oid() };
fake.seed(coll("Confession"), [
  { _id: cid.old, authorId: ids.A, text: "older post, no status", university: U, visibility: "public", likes: 2, likedBy: [ids.B, ids.C], createdAt: at(60),
    comments: [
      { _id: cm.liveB, user: ids.B, text: "live comment by B", createdAt: at(50) },
      { _id: cm.pendC, user: ids.C, text: "held comment by C", status: "pending", createdAt: at(49) },
      { _id: cm.hidC, user: ids.C, text: "hidden comment by C", status: "hidden", createdAt: at(48) },
      { _id: cm.mineA, user: ids.A, text: "the author's own comment", createdAt: at(47) },
    ] },
  { _id: cid.live, authorId: ids.A, text: "live post", status: "live", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(40) },
  { _id: cid.pending, authorId: ids.A, text: "held post", status: "pending", statusReason: "moderation unavailable", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(30) },
  { _id: cid.hidden, authorId: ids.A, text: "hidden post", status: "hidden", reportedBy: [ids.B], reportCount: 1, university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(20) },
  { _id: cid.removed, authorId: ids.A, text: "removed post", status: "removed", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(10) },
  { _id: cid.other, authorId: ids.C, text: "post by C", university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(5) },
]);
const feed = async (tok) => { const r = await call("GET", "/api/social/confessions/feed?scope=all", { tok }); return { r, list: Array.isArray(r.json) ? r.json : [] }; };
const ids_ = (list) => list.map((c) => String(c._id));

(async () => {
  const server = h.start();

  let { r, list } = await feed(T.B);
  check("feed (another student): 200, a plain array", r.status === 200 && Array.isArray(r.json));
  check("…older (no status) and live confessions show", ids_(list).includes(String(cid.old)) && ids_(list).includes(String(cid.live)) && ids_(list).includes(String(cid.other)));
  check("…held, hidden and removed don't", !ids_(list).some((x) => [cid.pending, cid.hidden, cid.removed].map(String).includes(x)), ids_(list).join(","));
  const old = list.find((c) => String(c._id) === String(cid.old));
  check("…comments: only live ones for someone else (held / hidden comments of C left out)", old && old.comments.length === 2 && old.comments.every((c) => !/held|hidden/.test(c.text)), JSON.stringify(old?.comments));
  check("…no authorId, reportedBy or statusReason anywhere", !/authorId|reportedBy|statusReason/.test(r.text));

  ({ list } = await feed(T.A));
  check("feed (the author): their held post shows, with status pending", list.some((c) => String(c._id) === String(cid.pending) && c.status === "pending"));
  check("…hidden and removed still don't", !ids_(list).some((x) => [cid.hidden, cid.removed].map(String).includes(x)));

  ({ list } = await feed(T.C));
  const oldC = list.find((c) => String(c._id) === String(cid.old));
  const pc = oldC?.comments.find((c) => String(c._id) === String(cm.pendC));
  check("feed (commenter C): their own held comment shows with status pending", pc && pc.status === "pending" && pc.isMyComment === true, JSON.stringify(oldC?.comments));
  check("…their hidden comment shows to them with status hidden", oldC?.comments.some((c) => String(c._id) === String(cm.hidC) && c.status === "hidden"));
  check("…the others' comments carry no status", oldC?.comments.filter((c) => !c.isMyComment).every((c) => !("status" in c)));

  ({ list } = await feed(T.admin));
  check("feed (admin): held / hidden / removed left out too (they're on the Safety page)", !ids_(list).some((x) => [cid.pending, cid.hidden, cid.removed].map(String).includes(x)) && ids_(list).includes(String(cid.old)));

  r = await call("PUT", `/api/social/confessions/like/${cid.hidden}`, { tok: T.B });
  check("like a hidden confession → 404", r.status === 404, r.text);
  r = await call("POST", `/api/social/confessions/comment/${cid.removed}`, { tok: T.B, body: { text: "hi" } });
  check("comment on a removed confession → 404", r.status === 404, r.text);
  r = await call("PUT", `/api/social/confessions/like/${cid.other}`, { tok: T.B });
  check("like a confession with no status → 200 as before", r.status === 200, r.text);

  // my-confessions
  r = await call("GET", "/api/social/confessions/my-confessions", { tok: T.A });
  const mine = (r.json || []).find((c) => String(c._id) === String(cid.old));
  check("my-confessions: 200, my confessions incl. held / hidden (they're mine)", r.status === 200 && (r.json || []).length === 5);
  const byB = mine?.comments.find((c) => String(c._id) === String(cm.liveB));
  const byMe = mine?.comments.find((c) => String(c._id) === String(cm.mineA));
  check("…another student's comment: user null (was: their name and photo)", byB && byB.user === null, JSON.stringify(byB));
  check("…my own comment keeps my name", byMe && byMe.user && byMe.user.name === "Ayesha Author", JSON.stringify(byMe));
  check("…C's held / hidden comments aren't shown to the author", !mine?.comments.some((c) => [cm.pendC, cm.hidC].map(String).includes(String(c._id))));
  check("…no name of B or C anywhere in the reply", !/Bilal|Chand/.test(r.text));
  check("…no reportedBy", !/reportedBy/.test(r.text));

  // likes list (S3)
  r = await call("GET", `/api/social/confessions/likes/${cid.old}`, { tok: T.B });
  check("likes list, not the author: likes [] and count 2 (was: names and photos)", r.status === 200 && Array.isArray(r.json?.likes) && r.json.likes.length === 0 && r.json.count === 2 && !/Bilal|Chand/.test(r.text), r.text);
  r = await call("GET", `/api/social/confessions/likes/${cid.old}`, { tok: T.A });
  check("likes list, the author: the names (as before) and the count", r.status === 200 && r.json?.likes?.length === 2 && r.json.count === 2, r.text);
  r = await call("GET", `/api/social/confessions/likes/${cid.hidden}`, { tok: T.A });
  check("likes list of a hidden confession → 404", r.status === 404);

  // daily drop
  r = await call("POST", "/api/admin/engagement/drops", { tok: T.admin, body: { dayKey: "2026-12-01", type: "confession", contentRef: { kind: "confession", id: String(cid.hidden) } } });
  check("Daily Drop with a hidden confession → 400 with a reason", r.status === 400 && /held or hidden/.test(r.json?.message || ""), r.text);

  // mute (flag on for the viewer only)
  fake.STORE.get(coll("User")).find((u) => String(u._id) === String(ids.B)).mutedConfessionAuthors = [ids.C];
  ({ list } = await feed(T.B));
  check("muted author, flag off: still shown (no change without the flag)", ids_(list).includes(String(cid.other)));
  flags.applyAdminAccess("confessionSafety", String(ids.B), true);
  ({ list } = await feed(T.B));
  check("muted author, flag on: left out", !ids_(list).includes(String(cid.other)) && ids_(list).includes(String(cid.old)));
  flags.applyAdminAccess("confessionSafety", String(ids.B), null);

  h.finish(server);
})();
