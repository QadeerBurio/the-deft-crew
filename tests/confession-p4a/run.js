// P4a confessions (owner 24 Nov 2026), on in-memory data.
//   for everyone (no flag): a confession is at most 1,000 characters (400 TOO_LONG); an image only from our Cloudinary
//     account (400 BAD_IMAGE: another site, http, another Cloudinary account); our image is saved; the two unreachable
//     duplicate routes are gone and the reachable ones behave as before (likes: names only for the author)
//   node tests/confession-p4a/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/social.routes"]],
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
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
