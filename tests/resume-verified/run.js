// P3d "verified by tdc" (flags resumeV2 + resumeVerified): GET /api/resume/verified-facts, settings.verifiedLine
//   flags: off → 404; resumeV2 alone → 404; guests → 401
//   facts: only what tdc checked: a verified student (status "Verified") at the university; an issued ambassador
//     certificate / founder card with its verify link (one per role); not: a draft or revoked credential, a letter or
//     badge, an unverified account, another student's credentials
//   settings.verifiedLine: off by default; true / false saved; anything else ignored (never a failed save); the
//     other settings (track) untouched
//   the shared renderer prints the line only when facts are passed (the five unchanged otherwise)
//   node tests/resume-verified/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resumeFinish.routes"], ["/api/resume", "./routes/resume.routes"]], models: ["Resume", "Credential"] });
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;

const S = oid(); const U = oid(); const O = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Malik", { universityName: "Sample University" }),
  user(U, "student", "Unverified Student", { status: "Not Verified", universityName: "Sample University" }),
  user(O, "student", "Other Student"),
]);
const C1 = oid(); const C2 = oid();
fake.seed(coll("Credential"), [
  { _id: C1, user: S, type: "certificate", status: "issued", issuedAt: new Date("2026-01-10") },
  { _id: oid(), user: S, type: "certificate", status: "issued", issuedAt: new Date("2026-05-10") }, // a second one: one line per role
  { _id: C2, user: S, type: "founder_card", status: "revoked", issuedAt: new Date("2026-02-10") },
  { _id: oid(), user: S, type: "letter", status: "issued", issuedAt: new Date("2026-03-10") },
  { _id: oid(), user: S, type: "badge", status: "issued", issuedAt: new Date("2026-03-10") },
  { _id: oid(), user: U, type: "founder_card", status: "draft", issuedAt: new Date("2026-03-10") },
  { _id: oid(), user: O, type: "founder_card", status: "issued", issuedAt: new Date("2026-03-10") },
]);
const R = oid();
fake.seed(coll("Resume"), [{ _id: R, user: S, personalInfo: { firstName: "Sana" }, settings: { track: "fresher" }, education: [], skills: [], workExperience: [], projects: [], certifications: [], languages: [], achievements: [], interests: [], references: [], createdAt: new Date(), updatedAt: new Date() }]);
const T = { S: token(S, "student"), U: token(U, "student"), O: token(O, "student") };
const doc = () => rows("Resume", (x) => same(x._id, R))[0];

(async () => {
  const server = h.start();
  console.log("-- flags");
  let r = await call("GET", "/api/resume/verified-facts", { tok: T.S });
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${U},${O}`;
  r = await call("GET", "/api/resume/verified-facts", { tok: T.S });
  check("resumeV2 alone → 404", r.status === 404);
  process.env.FLAG_RESUME_VERIFIED = `ids:${S},${U},${O}`;
  r = await call("GET", "/api/resume/verified-facts", {});
  check("signed out → 401", r.status === 401);

  console.log("-- facts");
  r = await call("GET", "/api/resume/verified-facts", { tok: T.S });
  const f = r.json?.data?.facts || [];
  check("a verified student at the university", f[0]?.kind === "student" && f[0].text === "verified student at Sample University" && !f[0].url, JSON.stringify(f));
  check("the issued ambassador certificate, once, with its verify link (the first issued)", f.filter((x) => x.kind === "ambassador").length === 1 && f[1]?.text === "campus ambassador" && f[1].url === `https://gettdc.pk/verify/${C1}`, JSON.stringify(f));
  check("not: a revoked founder card, a letter, a badge", f.length === 2 && !f.some((x) => x.kind === "founder"));
  r = await call("GET", "/api/resume/verified-facts", { tok: T.U });
  check("an unverified account with a draft card → no facts at all", r.status === 200 && JSON.stringify(r.json.data.facts) === "[]", r.text);
  r = await call("GET", "/api/resume/verified-facts", { tok: T.O });
  check("another student: only their own (a verified student, their founder card)", r.json.data.facts.length === 2 && r.json.data.facts[1].kind === "founder" && !r.json.data.facts.some((x) => String(x.url || "").includes(String(C1))), JSON.stringify(r.json.data.facts));

  console.log("-- settings.verifiedLine");
  check("off by default (the model)", reqS("./models/Resume").schema.path("settings.verifiedLine").defaultValue === false);
  r = await call("PUT", `/api/resume/${R}`, { tok: T.S, body: { settings: { verifiedLine: true } } });
  check("true is saved; the track stays", r.status === 200 && doc().settings.verifiedLine === true && doc().settings.track === "fresher", JSON.stringify(doc().settings));
  r = await call("PUT", `/api/resume/${R}`, { tok: T.S, body: { settings: { verifiedLine: "yes" } } });
  check("'yes' is ignored (never a failed save)", r.status === 200 && doc().settings.verifiedLine === true);
  r = await call("PUT", `/api/resume/${R}`, { tok: T.S, body: { settings: { verifiedLine: false } } });
  check("false is saved", r.status === 200 && doc().settings.verifiedLine === false);

  console.log("-- the shared renderer");
  const render = reqS("./utils/resumeRender");
  const plain = render.renderResumeHTML({ personalInfo: { firstName: "Sana" } }, "modern_ats", {});
  const withLine = render.renderResumeHTML({ personalInfo: { firstName: "Sana" } }, "modern_ats", {}, false, { verified: f });
  check("with facts: one line in the header, the verify link as text", /<div class="verified"[^>]*>✓ verified by tdc: verified student at Sample University · campus ambassador \(<a href="https:\/\/gettdc\.pk\/verify\/[0-9a-f]{24}"[^>]*>gettdc\.pk\/verify\/[0-9a-f]{24}<\/a>\)<\/div>/.test(withLine), withLine.slice(withLine.indexOf("<header>"), withLine.indexOf("</header>")));
  check("without facts (or an empty list): exactly the old HTML", render.renderResumeHTML({ personalInfo: { firstName: "Sana" } }, "modern_ats", {}, false, { verified: [] }) === plain && !/verified by tdc/.test(plain));
  check("facts are escaped", !/<script>/.test(render.renderResumeHTML({}, "modern_ats", {}, false, { verified: [{ text: "<script>x</script>", url: "javascript:alert(1)\"" }] })));
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
