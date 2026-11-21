// N-4 one inbox (flag unifiedInbox, per account; upgrade/phase-n):
//   GET /api/notification/unified: flag off → 404; on → the bell and social lists merged, newest first, each item with
//     its source (bell / social) and tab (for_you / campus / system); chat messages left out (own badge); deleted bell
//     rows and other people's rows left out; read state per account; social sender as the social list shows it
//   GET /api/notification/unread-count?scope=all: on → bell + social with per-tab counts; off → the bell count as before
//   the old lists and counts are unchanged
//   node tests/unified-inbox/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/notification", "./routes/notification.routes"]],
  models: ["Notification", "SocialNotification"],
});
const { call, check, oid, user, token, fake, coll } = h;

const S = oid(); const B = oid(); const F = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Malik"), user(B, "student", "Bilal Ahmed"), user(F, "student", "Fahad Friend Khan", { username: "fahad", profileImage: "https://img/f.png" })]);
const T = { S: token(S, "student"), B: token(B, "student") };
const at = (min) => new Date(Date.now() - min * 60e3);
const bell = (who, type, title, min, extra = {}) => ({ _id: oid(), recipient: who, type, title, description: `${title} body`, mood: "sorted", readBy: [], deletedBy: [], metadata: { route: "Home" }, createdAt: at(min), updatedAt: at(min), ...extra });
const soc = (who, type, text, min, extra = {}) => ({ _id: oid(), recipient: who, sender: F, type, text, mood: "excited", readBy: [], status: "accepted", isProcessed: false, metadata: {}, createdAt: at(min), updatedAt: at(min), ...extra });
const ids = {};
const seedBell = [
  (ids.app = bell(S, "Application Status", "you're shortlisted", 1)),
  (ids.promo = bell(S, "Promotion", "50% off at cafe x", 3)),
  (ids.welcome = bell(S, "Welcome", "welcome to tdc", 50, { readBy: [S] })),
  (ids.deleted = bell(S, "Offer", "gone", 2, { deletedBy: [S] })),
  bell(B, "Promotion", "bilal's own", 4),
];
const post = oid();
const seedSocial = [
  (ids.like = soc(S, "like", "liked your post", 5, { postId: post })),
  (ids.req = soc(S, "request", "wants to connect", 6, { status: "pending" })),
  (ids.msg = soc(S, "message", "hey", 0.5)),
  soc(B, "like", "liked bilal's post", 7),
];
fake.seed(coll("Notification"), seedBell);
fake.seed(coll("SocialNotification"), seedSocial);

(async () => {
  const server = h.start();

  console.log("-- flag off");
  let r = await call("GET", "/api/notification/unified", { tok: T.S });
  check("unified: 404 with the flag off", r.status === 404);
  r = await call("GET", "/api/notification/unread-count?scope=all", { tok: T.S });
  check("unread-count?scope=all with the flag off: the bell count as before (2), no per-tab counts", r.status === 200 && r.json.count === 2 && !("unread" in r.json), r.text);

  console.log("-- flag on for S");
  process.env.FLAG_UNIFIED_INBOX = `ids:${S}`;
  r = await call("GET", "/api/notification/unified", { tok: T.S });
  const items = r.json.items || [];
  check("200 with items", r.status === 200 && Array.isArray(items), r.text.slice(0, 200));
  check("bell + social merged, newest first (message, deleted and other people's rows left out)",
    JSON.stringify(items.map((i) => i.id)) === JSON.stringify([ids.app, ids.promo, ids.like, ids.req, ids.welcome].map((x) => String(x._id))), items.map((i) => `${i.source}:${i.type}`).join(","));
  const byId = (x) => items.find((i) => i.id === String(x._id));
  check("tabs: your application → for you; a promotion → campus; welcome → system; social → for you",
    byId(ids.app).tab === "for_you" && byId(ids.promo).tab === "campus" && byId(ids.welcome).tab === "system" && byId(ids.like).tab === "for_you" && byId(ids.req).tab === "for_you");
  check("source and read state per account", byId(ids.app).source === "bell" && byId(ids.like).source === "social" && byId(ids.welcome).isRead === true && byId(ids.app).isRead === false);
  check("a social item: body, link to the post, the sender as the social list shows it", byId(ids.like).body === "liked your post" && byId(ids.like).link === `/post/${post}` && byId(ids.like).sender.name === "Fahad Friend Khan" && byId(ids.like).sender.firstName === "Fahad" && byId(ids.like).sender.username === "fahad");
  check("a connection request keeps its status (actions stay in the social screen)", byId(ids.req).status === "pending");
  check("a bell item keeps its link data (metadata.route)", byId(ids.app).metadata.route === "Home" && byId(ids.app).title === "you're shortlisted");
  check("unread: all 4 (for you 3, campus 1, system 0)", JSON.stringify(r.json.unread) === JSON.stringify({ all: 4, for_you: 3, campus: 1, system: 0 }), JSON.stringify(r.json.unread));
  r = await call("GET", "/api/notification/unread-count?scope=all", { tok: T.S });
  check("unread-count?scope=all: one number for both lists, with the tabs", r.json.count === 4 && r.json.unread.campus === 1, r.text);
  r = await call("GET", "/api/notification/unread-count", { tok: T.S });
  check("unread-count without scope: the bell count, as before (older apps)", r.json.count === 2 && !("unread" in r.json));
  r = await call("GET", "/api/notification/my-notifications", { tok: T.S });
  check("the old bell list is unchanged (bell rows only)", Array.isArray(r.json) && r.json.length === 3 && r.json.every((n) => n.type && !("source" in n)));
  r = await call("GET", "/api/notification/unified?limit=2", { tok: T.S });
  check("limit", r.json.items.length === 2 && r.json.unread.all === 4);
  r = await call("GET", "/api/notification/unified", { tok: T.B });
  check("another account without the flag: 404", r.status === 404);
  r = await call("GET", "/api/notification/unified");
  check("signed out: 401", r.status === 401);
  delete process.env.FLAG_UNIFIED_INBOX;
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
