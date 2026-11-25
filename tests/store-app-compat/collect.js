// tests/store-app-compat/collect.js: the replies the live store app (APP cdf72e6, v1.2.2) reads, as shapes.
// For the crew, home, confessions, resume and profile screens: the same seed, the same requests (signed-in student,
// every upgrade flag off, as for every student today), and each reply turned into { "path": "type" }.
//   node tests/store-app-compat/collect.js <serverDir> <out.json>
// run.js compares the current server with shapes recorded from the server the store app was built against
// (tag pre-upgrade-2026-11-24): every field that server sent must still come, with the same type.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const fs = require("fs");
const serverDir = process.argv[2];
const out = process.argv[3];
const h = require("../hiring-fixes/harness")(serverDir, {
  extraRoutes: [
    ["/api/auth", "./routes/auth.routes"],
    ["/api/engagement", "./routes/engagement.routes"],
    ["/api/social", "./routes/social.routes"],
    ["/api/resume", "./routes/resume.routes"],
    ["/api/notification", "./routes/notification.routes"],
  ],
  models: ["Confession", "University", "Resume", "Notification", "Report"],
});
const { call, oid, user, token, fake, coll } = h;
// r10: COMPAT_LAUNCH=1 → every student has launchV2 (as in production since r10); set after the harness clears FLAG_*
if (process.env.COMPAT_LAUNCH === "1") process.env.FLAG_LAUNCH_V2 = "on";

const U = oid(); const S = oid(); const O = oid(); const R = oid(); const C1 = oid(); const C2 = oid();
const now = new Date("2026-11-20T10:00:00Z");
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
fake.seed(coll("User"), [
  user(S, "student", "Ayesha Khan", { university: U, referralCode: "AYESHA9", firstName: "Ayesha", lastName: "Khan", profileImage: "https://res.cloudinary.com/x/a.jpg", bio: "cs student" }),
  user(O, "student", "Bilal Reader", { university: U, referredBy: S }),
]);
fake.seed(coll("Confession"), [
  { _id: C1, text: "the canteen chai is a lifestyle", authorId: O, university: U, visibility: "public", likes: 2, likedBy: [S], comments: [{ _id: oid(), text: "same", user: S, createdAt: now }], createdAt: now },
  { _id: C2, text: "campus only post", authorId: S, university: U, visibility: "campus", likes: 0, likedBy: [], comments: [], createdAt: new Date(now - 6e4) },
]);
fake.seed(coll("Resume"), [{
  _id: R, user: S, title: "My resume", template: "modern_ats",
  personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92 300 0000000", city: "Karachi" },
  professionalSummary: { summary: "CS student." }, education: [{ institution: "Alpha University", degree: "BS", fieldOfStudy: "CS", startDate: "2022-09", endDate: "2026-06" }],
  workExperience: [], projects: [{ name: "Bus tracker", description: "- live bus map" }], skills: [{ name: "Python" }], certifications: [], languages: [], achievements: [],
  createdAt: now, updatedAt: now,
}]);

// a reply → { "a.b[].c": "string" | "number" | "boolean" | "null" | "object" | "array" } (arrays: every element merged)
function shape(v, p = "", acc = {}) {
  const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (p) acc[p] = acc[p] && acc[p] !== t ? `${acc[p]}|${t}` : t;
  if (t === "array") for (const x of v) shape(x, `${p}[]`, acc);
  else if (t === "object") for (const [k, x] of Object.entries(v)) shape(x, p ? `${p}.${k}` : k, acc);
  return acc;
}

const REQUESTS = [
  // profile / session
  ["GET", "/api/auth/me"],
  // the crew (Points.js) and home
  ["GET", "/api/engagement/me"], ["GET", "/api/engagement/home"], ["GET", "/api/engagement/referrals/me"],
  ["GET", "/api/engagement/referrals/leaderboard"], ["GET", "/api/engagement/streak/status"], ["GET", "/api/engagement/drops/today"],
  ["GET", "/api/engagement/badges"], ["GET", "/api/engagement/rewards"], ["GET", "/api/engagement/points/ledger"],
  ["GET", "/api/engagement/notification-prefs"], ["GET", "/api/notification/unread-count"],
  // confessions
  ["GET", "/api/social/confessions/feed?scope=all"], ["GET", "/api/social/confessions/feed?scope=campus"],
  // resume
  ["GET", "/api/resume"], ["GET", `/api/resume/${R}`],
];

(async () => {
  const server = h.start();
  const tok = token(S, "student");
  const result = {};
  for (const [m, url] of REQUESTS) {
    const key = `${m} ${url.replace(String(R), ":id")}`;
    const r = await call(m, url, { tok });
    result[key] = { status: r.status, shape: r.json === undefined ? {} : shape(r.json) };
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  server.close();
  process.exit(0);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
