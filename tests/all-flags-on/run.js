// r8 (owner): every upgrade flag on together, for a signed-in student, on in-memory data with the real routes: every
// read the app makes (crew, home, engagement, confessions, resume, notifications, flags) and the main writes answer
// without a server error, the flags endpoint reports every client flag on, and the harness's leak scan finds no hidden
// user field in any reply. Then every flag off again: the same reads still answer (the store app's view).
//   node tests/all-flags-on/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [
    ["/api/app", "./routes/appFlags.routes"], ["/api/crew", "./routes/crew.routes"], ["/api/engagement", "./routes/engagement.routes"],
    ["/api/notification", "./routes/notification.routes"], ["/api/social", "./routes/confessionSafety.routes"],
    ["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"],
    ["/api/resume", "./routes/resumeFinish.routes"], ["/api/resume", "./routes/resume.routes"],
  ],
  models: ["Confession", "University", "Resume", "Notification", "Report", "SafetySettings", "SavedItem", "ResumeSettings"],
});
const { call, check, oid, user, token, fake, coll, reqS } = h;
const { FLAGS } = reqS("./config/featureFlags");
const GRANTABLE = Object.entries(FLAGS).filter(([, d]) => d.grant).map(([k]) => k);
const envOf = (name) => `FLAG_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

const U = oid(); const S = oid(); const O = oid(); const R = oid(); const C1 = oid();
const now = new Date();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan", { university: U, referralCode: "AYESHA9", isVerified: true, createdAt: new Date(now - 30 * 864e5) }), user(O, "student", "Bilal Reader", { university: U })]);
fake.seed(coll("Confession"), [{ _id: C1, text: "the canteen chai is a lifestyle", authorId: O, university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: now }]);
fake.seed(coll("Resume"), [{ _id: R, user: S, title: "My resume", template: "campus", personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com" }, education: [{ institution: "Alpha University", degree: "BS", fieldOfStudy: "CS" }], projects: [{ name: "Bus tracker" }], skills: [{ name: "Python" }], workExperience: [], certifications: [], languages: [], achievements: [], customStyles: { headingIcons: true }, createdAt: now, updatedAt: now }]);

const READS = [
  "/api/app/flags/me", "/api/crew/config", "/api/crew/invitation", "/api/crew/applications/me", "/api/crew/campus-count", "/api/crew/me", "/api/crew/daily-card", "/api/crew/squad",
  "/api/engagement/me", "/api/engagement/home", "/api/engagement/next-action", "/api/engagement/badges", "/api/engagement/points/ledger", "/api/engagement/rewards",
  "/api/engagement/notification-prefs", "/api/engagement/streak/status", "/api/engagement/drops/today", "/api/engagement/referrals/me", "/api/engagement/referrals/leaderboard",
  "/api/notification/my-notifications", "/api/notification/unified", "/api/notification/unread-count",
  "/api/social/confessions/feed?scope=all&sort=hot", "/api/social/confessions/feed?scope=campus&sort=new", "/api/social/confessions/v2/config", "/api/social/confessions/safety/me",
  "/api/resume", `/api/resume/${R}`, "/api/resume/templates/hidden", "/api/resume/verified-facts", `/api/resume/${R}/public-page`, "/api/resume/template-outcomes",
];

(async () => {
  const server = h.start();
  const tok = token(S, "student");
  for (const f of GRANTABLE) process.env[envOf(f)] = "on";
  check(`setup: ${GRANTABLE.length} grantable flags, all on`, GRANTABLE.length >= 48);
  const errors = [];
  for (const url of READS) {
    const r = await call("GET", url, { tok });
    if (r.status >= 500 || r.status === 0) errors.push(`${r.status} GET ${url}`);
  }
  check(`all flags on: ${READS.length} reads answer, no server error`, errors.length === 0, errors.join(" | "));
  const flags = (await call("GET", "/api/app/flags/me", { tok })).json || {};
  const clientFlags = GRANTABLE.filter((f) => FLAGS[f].client);
  const notOn = clientFlags.filter((f) => flags[f] !== true);
  check(`…the app sees every client flag on (${clientFlags.length})`, notOn.length === 0, notOn.join(","));

  // the main writes, with everything on
  const writes = [
    ["POST", "/api/social/confessions/rules/accept", {}],
    ["POST", "/api/social/confessions/create", { text: "a small win this week: passed my quiz", visibility: "public", tag: "wholesome", mood: "sorted", postAs: "handle", poll: { options: ["yes", "no"] } }],
    ["PUT", `/api/social/confessions/${C1}/metoo`, {}],
    ["PUT", `/api/social/confessions/${C1}/vote`, { vote: "up" }],
    ["PUT", `/api/social/confessions/${C1}/follow`, { on: true }],
    ["PUT", `/api/social/confessions/${C1}/save`, { on: true }],
    ["PUT", `/api/resume/${R}/public-page`, { on: true }],
    ["POST", "/api/engagement/goals", { goals: ["save_money", "get_hired"] }],
  ];
  const wErrors = [];
  for (const [m, url, body] of writes) {
    const r = await call(m, url, { tok, body });
    if (r.status >= 500 || r.status === 0) wErrors.push(`${r.status} ${m} ${url} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  check(`…the main writes (${writes.length}: post with tag / mood / handle / poll, me too, vote, follow, save, public page, goals) answer, no server error`, wErrors.length === 0, wErrors.join(" | "));
  const feed = (await call("GET", "/api/social/confessions/feed?scope=all&sort=new", { tok })).json;
  check("…the feed still reads after those writes", Array.isArray(feed) && feed.length >= 1);

  for (const f of GRANTABLE) delete process.env[envOf(f)];
  const offErrors = [];
  for (const url of READS) {
    const r = await call("GET", url, { tok });
    if (r.status >= 500 || r.status === 0) offErrors.push(`${r.status} GET ${url}`);
  }
  check("every flag off again: the same reads answer, no server error (flag-gated ones 404 as designed)", offErrors.length === 0, offErrors.join(" | "));
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
