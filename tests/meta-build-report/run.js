// Which builds carry the Meta IDs (chore/meta-build-guard), on in-memory data:
//   - POST /api/app/meta-build: public; a valid report counts once per (platform, version, build, enabled); nothing
//     else is stored (no user, device or ad id even if sent); bad reports 400; 20 per address per hour, then 429
//   - GET /api/app/meta-builds: admins only; the builds newest first and the ones reporting Meta off
//   node tests/meta-build-report/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["MetaBuildReport"] });
const { call, check, rows, oid, user, token, fake, coll } = h;

const ids = { S: oid(), A: oid() };
fake.seed(coll("User"), [user(ids.S, "student", "Student One"), user(ids.A, "admin", "Admin One")]);
const T = { S: token(ids.S, "student"), A: token(ids.A, "admin") };
const report = (body, ip = "203.0.113.7") => call("POST", "/api/app/meta-build", { body, headers: { "x-forwarded-for": ip } });

(async () => {
  const server = h.start();
  let r = await report({ platform: "android", appVersion: "1.2.1", build: "90", enabled: true });
  check("a report needs no sign-in: 204", r.status === 204, `${r.status} ${r.text}`);
  await report({ platform: "android", appVersion: "1.2.1", build: "90", enabled: true }, "203.0.113.8");
  await report({ platform: "ios", appVersion: "1.2.1", build: "90", enabled: false }, "203.0.113.9");
  const all = rows("MetaBuildReport");
  check("one row per platform + version + build + enabled, counting installs", all.length === 2 && all.find((x) => x.platform === "android").count === 2 && all.find((x) => x.platform === "ios").count === 1, JSON.stringify(all));
  r = await report({ platform: "android", appVersion: "1.2.1", build: "90", enabled: true, userId: String(ids.S), adId: "abc-123", email: "s@x.pk" }, "203.0.113.10");
  check("extra fields (user, ad id, email) are never stored", r.status === 204 && !JSON.stringify(rows("MetaBuildReport")).match(/abc-123|s@x\.pk|userId|adId|email/));
  for (const [what, body] of [["an unknown platform", { platform: "web", appVersion: "1.2.1", build: "90", enabled: true }], ["a bad version", { platform: "ios", appVersion: "1.2", build: "90", enabled: true }], ["a non-numeric build", { platform: "ios", appVersion: "1.2.1", build: "x1", enabled: true }], ["enabled not a boolean", { platform: "ios", appVersion: "1.2.1", build: "90", enabled: "yes" }], ["no body", undefined]]) {
    r = await report(body, "203.0.113.11");
    check(`${what}: 400`, r.status === 400, `${r.status}`);
  }
  let limited = 0;
  for (let i = 0; i < 22; i++) { r = await report({ platform: "ios", appVersion: "9.9.9", build: "1", enabled: true }, "198.51.100.77"); if (r.status === 429) limited++; }
  check("more than 20 reports an hour from one address: 429", limited === 2, `${limited}`);
  r = await report({ platform: "ios", appVersion: "9.9.9", build: "1", enabled: true }, "198.51.100.78");
  check("another address isn't limited", r.status === 204);

  r = await call("GET", "/api/app/meta-builds");
  check("the list signed out: 401", r.status === 401);
  r = await call("GET", "/api/app/meta-builds", { tok: T.S });
  check("the list as a student: 403", r.status === 403);
  r = await call("GET", "/api/app/meta-builds", { tok: T.A });
  check("the list as an admin: the builds, and the iOS 1.2.1 (90) build with Meta off", r.status === 200 && r.json.builds.length === 3 && r.json.metaOff.length === 1 && r.json.metaOff[0].platform === "ios" && r.json.metaOff[0].build === "90", r.text.slice(0, 300));
  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
