// Owner (after P3b): a social post's location is what the student's app sends, or none. The server never adds
// "Karachi" (it used to, for every post without a location). Older apps that send "Karachi" themselves still store
// it (their own value); the app no longer does.
//   node tests/post-location/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/social", "./routes/social.routes"]], models: ["Post"] });
const { call, check, oid, user, token, fake, coll, rows, same } = h;

const S = oid();
fake.seed(coll("User"), [user(S, "student", "Hina Ali", { location: "" })]);
const T = token(S, "student");

(async () => {
  const server = h.start();
  let r = await call("POST", "/api/social/create-post", { tok: T, body: { content: "exams are over!" } });
  let p = rows("Post", (x) => x.content === "exams are over!")[0];
  check("no location sent → none stored (no 'Karachi')", r.status === 201 && p && p.location === "", `${r.status} ${JSON.stringify(p?.location)}`);
  r = await call("POST", "/api/social/create-post", { tok: T, body: { content: "library is open", location: "  Lahore  " } });
  p = rows("Post", (x) => x.content === "library is open")[0];
  check("a location sent → stored (trimmed)", p && p.location === "Lahore");
  r = await call("POST", "/api/social/create-post", { tok: T, body: { content: "odd value", location: { city: "x" } } });
  p = rows("Post", (x) => x.content === "odd value")[0];
  check("anything but text → none", p && p.location === "");
  r = await call("POST", "/api/social/create-post", { tok: T, body: { content: "old app", location: "Karachi" } });
  p = rows("Post", (x) => x.content === "old app")[0];
  check("an older app's own 'Karachi' is kept (its value, not ours)", p && p.location === "Karachi");
  check("the reply is unchanged in shape", r.status === 201);
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
