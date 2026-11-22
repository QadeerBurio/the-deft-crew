// Staging seed (upgrade/p0-safety, plan P0-2), on in-memory data: scripts/seed-staging.js
//   - refuses unless APP_ENV=staging, the database name contains "staging" and SEED_PASSWORD is set; production-like
//     strings are refused
//   - a dry run writes nothing; --apply creates 3 universities, 20 students, 10 confessions, 5 resumes
//   - a second run creates nothing new
//   - only made-up data: @staging.test e-mails, "Test Student NN", hashed passwords, nothing read from .env
//   node tests/seed-staging/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["University", "Confession", "Resume"] });
const { SERVER, reqS, check, rows } = h;
const S = reqS("./scripts/seed-staging.js");
const models = { University: reqS("./models/University"), User: reqS("./models/User"), Confession: reqS("./models/Confession"), Resume: reqS("./models/Resume") };
const hash = async (pw) => `hashed:${pw.length}`;

(async () => {
  const ok = { APP_ENV: "staging", MONGO_URI: "mongodb+srv://u:p@staging-cluster.example.net/tdc_staging?retryWrites=true", SEED_PASSWORD: "test-pass-123" };
  check("staging env + staging database + password → allowed", S.refusal(ok) === null, S.refusal(ok));
  check("APP_ENV missing → refused", /APP_ENV/.test(S.refusal({ ...ok, APP_ENV: "" }) || ""));
  check("APP_ENV=production → refused", /APP_ENV/.test(S.refusal({ ...ok, APP_ENV: "production" }) || ""));
  check("production-like database name → refused", /staging/.test(S.refusal({ ...ok, MONGO_URI: "mongodb+srv://u:p@prod.example.net/The_deft_crew?x=1" }) || ""));
  check("staging only in the host, not the database → refused", /database name/.test(S.refusal({ ...ok, MONGO_URI: "mongodb+srv://u:p@staging.example.net/tdc" }) || ""));
  check("no database name → refused", /database name/.test(S.refusal({ ...ok, MONGO_URI: "mongodb+srv://u:p@staging.example.net/" }) || ""));
  check("no MONGO_URI → refused", /MONGO_URI/.test(S.refusal({ ...ok, MONGO_URI: "" }) || ""));
  check("no or short SEED_PASSWORD → refused", /SEED_PASSWORD/.test(S.refusal({ ...ok, SEED_PASSWORD: "" }) || "") && /SEED_PASSWORD/.test(S.refusal({ ...ok, SEED_PASSWORD: "short" }) || ""));
  check("the refusal never repeats the connection string", !/u:p@/.test(S.refusal({ ...ok, APP_ENV: "x" }) || ""));

  const counts = () => ({ u: rows("University").length, s: rows("User").length, c: rows("Confession").length, r: rows("Resume").length });
  const before = counts();
  const dry = await S.seed(models, { apply: false, password: "test-pass-123", hash });
  check("dry run: plans 3 / 20 / 10 / 5", JSON.stringify(dry.create) === JSON.stringify({ universities: 3, students: 20, confessions: 10, resumes: 5 }), JSON.stringify(dry));
  check("…and writes nothing", JSON.stringify(counts()) === JSON.stringify(before));

  const first = await S.seed(models, { apply: true, password: "test-pass-123", hash });
  const after = counts();
  check("apply: creates 3 universities, 20 students, 10 confessions, 5 resumes", after.u === before.u + 3 && after.s === before.s + 20 && after.c === before.c + 10 && after.r === before.r + 5, JSON.stringify({ before, after, first }));
  const users = rows("User");
  check("every student: @staging.test e-mail, 'Test Student NN', role student, verified, a university", users.length === 20 && users.every((u) => /^student\d{2}@staging\.test$/.test(u.email) && /^Test Student \d{2}$/.test(u.name) && u.role === "student" && u.emailVerified === true && u.university));
  check("passwords stored hashed (never the plain password)", users.every((u) => u.password === "hashed:13"));
  check("students spread over the 3 test universities", new Set(users.map((u) => String(u.university))).size === 3);
  const conf = rows("Confession");
  check("confessions: each has an author, a university and a seed tag", conf.length === 10 && conf.every((c) => c.authorId && c.university && /\(seed \d+\)$/.test(c.text)));
  const res = rows("Resume");
  check("resumes: empty, fresher, experienced, two partial", ["seed: empty", "seed: fresher", "seed: experienced", "seed: partial-a", "seed: partial-b"].every((n) => res.some((r) => r.name === n)));
  const exp = res.find((r) => r.name === "seed: experienced"); const fr = res.find((r) => r.name === "seed: fresher"); const em = res.find((r) => r.name === "seed: empty");
  check("…the experienced one has work experience, the fresher none, the empty one nothing", exp?.workExperience?.length === 1 && !(fr?.workExperience?.length) && !(em?.education?.length) && !(em?.skills?.length));

  const again = await S.seed(models, { apply: true, password: "test-pass-123", hash });
  check("second run creates nothing new", JSON.stringify(again.create) === JSON.stringify({ universities: 0, students: 0, confessions: 0, resumes: 0 }) && JSON.stringify(counts()) === JSON.stringify(after), JSON.stringify(again));

  const src = fs.readFileSync(path.join(SERVER, "scripts/seed-staging.js"), "utf8");
  check("the script never loads dotenv (a production .env can't be picked up)", !/require\(["']dotenv["']\)/.test(src));
  check("it never prints MONGO_URI itself", !/console\.(log|error)\([^)]*process\.env\.MONGO_URI/.test(src));

  const failed = h.results.filter((x) => !x).length;
  console.log(`\n${h.results.length - failed}/${h.results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
