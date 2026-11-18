// Fast matching of the admin's "unmatched names" (feat/uni-match): every old typed name gets the most likely official
// university with a confidence (high / medium / low / none) and alternatives, high first; typical variants (IOBM, iobm
// karachi, Inst of Business Mgmt, NED Univ, Karachi University, typos) are high and right; reading changes nothing;
// the counts (unmatched names, students, matched today); bulk match moves students, offers and confessions, keeps the
// old spelling as an alias (later signups with it match by themselves), logs each one; refusals and partial failures.
//   node tests/universities-match/run.js [serverDir]
const path = require("path");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const h = require("../hiring-fixes/harness")(SERVER, {
  extraRoutes: [["/api/universities", "./routes/university.routes"], ["/api/admin/universities", "./routes/adminUniversities.routes"], ["/api/auth", "./routes/auth.routes"]],
  models: ["University", "Offer", "Confession", "AdminActionLog"],
});
const { reqS, call, check, rows, oid, user, token, fake, coll } = h;
const unis = reqS("./services/universities");
const matcher = reqS("./services/universityMatch");
const seedScript = reqS("./scripts/seed-universities");

const ids = { admin: oid(), brand: oid(), student: oid() };
fake.seed(coll("User"), [user(ids.admin, "admin", "Admin One"), user(ids.brand, "brand", "Brand One"), user(ids.student, "student", "Student One")]);
const tok = { admin: token(ids.admin, "admin"), brand: token(ids.brand, "brand"), student: token(ids.student, "student") };

(async () => {
  const server = h.start();
  await seedScript.run({ apply: true, log: () => {} });
  unis.bust();
  const list = await unis.approved();
  const byName = (n) => rows("University", (u) => u.name === n)[0];

  console.log("── suggestions for typical variants (the HEC list)");
  const want = {
    "IOBM": "Institute of Business Management",
    "iobm karachi": "Institute of Business Management",
    "Inst of Business Mgmt": "Institute of Business Management",
    "NED Univ": "NED University of Engineering & Technology",
    "Karachi University": "University of Karachi",
    // tolerant of case, spacing, punctuation, "— Karachi" / campus words, typos and word order
    "  iObM   KARACHI ": "Institute of Business Management",
    "Insitute of Busness Managment": "Institute of Business Management",
    "NED University of Engineering and Technology — Karachi": "NED University of Engineering & Technology",
    "Univercity of Karachi": "University of Karachi",
    "Inst. of Business Admin, Karachi": "Institute of Business Administration",
    "Bahria Univ Karachi Campus": "Bahria University",
    "UET Lahore": "University of Engineering & Technology, Lahore",
    "LUMS": "Lahore University of Management Sciences",
    "szabist": "Shaheed Zulfikar Ali Bhutto Institute of Science & Technology",
  };
  for (const [typed, name] of Object.entries(want)) {
    const s = matcher.suggest(typed, list, { view: unis.view });
    check(`'${typed}' → ${name}: high`, s.confidence === "high" && s.match?.name === name, JSON.stringify({ c: s.confidence, m: s.match?.name, score: s.score, alt: s.alternatives.slice(0, 2).map((a) => a.name) }));
  }
  let s = matcher.suggest("UET", list, { view: unis.view });
  check("'UET' alone (Lahore or Peshawar?): medium, with the other one as an alternative", s.confidence === "medium" && /University of Engineering & Technology/.test(s.match?.name) && s.alternatives.some((a) => /University of Engineering & Technology/.test(a.name) && a.name !== s.match.name), JSON.stringify({ c: s.confidence, m: s.match?.name }));
  s = matcher.suggest("Govt College Lahore", list, { view: unis.view });
  check("'Govt College Lahore': a suggestion (Government College University, Lahore), not high", s.match?.name === "Government College University, Lahore" && s.confidence !== "high" && s.confidence !== "none", JSON.stringify({ c: s.confidence, m: s.match?.name, score: s.score }));
  s = matcher.suggest("Karachi", list, { view: unis.view });
  check("a city alone ('Karachi'): low at most", ["low", "none"].includes(s.confidence), s.confidence);
  s = matcher.suggest("Some College Nobody Knows", list, { view: unis.view });
  check("a name that matches nothing: none, no suggestion", s.confidence === "none" && s.match === null, JSON.stringify({ c: s.confidence, score: s.score }));
  s = matcher.suggest("Iqra University", list, { view: unis.view });
  check("an exact name beats a one-letter neighbour (Iqra vs Isra): high, Iqra University", s.confidence === "high" && s.match?.name === "Iqra University");
  check("no name / punctuation only: none", matcher.suggest("", list).confidence === "none" && matcher.suggest(" -- ", list).confidence === "none");
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) matcher.suggest(`Some Typed College ${i} of Karachi`, list, { view: unis.view });
  const ms = Date.now() - t0;
  check(`fast: 300 names against ${list.length} universities in ${ms} ms (< 3000)`, ms < 3000);

  console.log("── the unmatched names, grouped");
  const typed = ["IOBM", "iobm karachi", "Inst of Business Mgmt", "NED Univ", "Karachi University", "UET", "Govt College Lahore", "Some College Nobody Knows"];
  const legacy = Object.fromEntries(typed.map((n) => [n, oid()]));
  fake.seed(coll("University"), typed.map((n) => ({ _id: legacy[n], name: n })));
  const students = [];
  typed.forEach((n, i) => { for (let k = 0; k <= i % 3; k++) { const id = oid(); students.push(id); fake.seed(coll("User"), [user(id, "student", `Student ${i}-${k}`, { university: legacy[n], universityName: n })]); } });
  const studentsOn = (n) => rows("User", (u) => String(u.university) === String(legacy[n])).length;
  const offerId = oid(); const confId = oid();
  await reqS("./models/Offer").collection.insertOne({ _id: offerId, title: "10% off", university: legacy["IOBM"], createdAt: new Date() });
  await reqS("./models/Confession").collection.insertOne({ _id: confId, text: "hello", university: legacy["NED Univ"], createdAt: new Date() });
  // a match logged yesterday (23:30 in Pakistan) does not count as today
  const yesterday = new Date(unis.startOfTodayPK().getTime() - 30 * 60e3);
  await reqS("./models/AdminActionLog").collection.insertOne({ admin: ids.admin, action: "university.match", targetType: "University", targetId: String(oid()), at: yesterday });

  const snapshot = () => JSON.stringify(["University", "User", "Offer", "Confession", "AdminActionLog"].map((c) => rows(c)));
  const before = snapshot();
  let r = await call("GET", "/api/admin/universities/unmatched", { tok: tok.admin });
  const un = r.json?.data || [];
  const row = (n) => un.find((x) => x.name === n);
  check("GET /unmatched: every unmatched name with students, a confidence and alternatives", r.status === 200 && un.length === typed.length && un.every((x) => ["high", "medium", "low", "none"].includes(x.confidence) && Array.isArray(x.alternatives) && typeof x.students === "number"), r.text.slice(0, 300));
  const order = { high: 0, medium: 1, low: 2, none: 3 };
  check("…high first, then medium, low, none", un.every((x, i) => i === 0 || order[un[i - 1].confidence] <= order[x.confidence]), un.map((x) => x.confidence).join(","));
  const five = ["IOBM", "iobm karachi", "Inst of Business Mgmt", "NED Univ", "Karachi University"];
  check("…the five typical variants are high and point at the right university", five.every((n) => row(n)?.confidence === "high" && row(n).suggestion?.name === want[n]), JSON.stringify(five.map((n) => [n, row(n)?.confidence, row(n)?.suggestion?.name])));
  check("…'UET' is medium with a suggestion and alternatives", row("UET")?.confidence === "medium" && row("UET").suggestion && row("UET").alternatives.length > 0);
  check("…'Some College Nobody Knows' is none (add as new or pick one)", row("Some College Nobody Knows")?.confidence === "none" && row("Some College Nobody Knows").suggestion === null);
  r = await call("GET", "/api/admin/universities/unmatched/summary", { tok: tok.admin });
  const studentTotal = typed.reduce((a, n) => a + studentsOn(n), 0);
  check(`counts: ${typed.length} unmatched names, ${studentTotal} students, 0 matched today (yesterday's doesn't count)`, r.status === 200 && r.json.data.unmatched === typed.length && r.json.data.students === studentTotal && r.json.data.matchedToday === 0, JSON.stringify(r.json?.data));
  await call("GET", "/api/admin/universities/unmatched", { tok: tok.admin });
  check("nothing changes without a click: reading the suggestions and counts (twice) wrote nothing", snapshot() === before);
  r = await call("GET", "/api/admin/universities/unmatched", { tok: tok.student });
  const r2 = await call("GET", "/api/admin/universities/unmatched/summary", { tok: tok.brand });
  check("students and brands can't see them", r.status === 403 && r2.status === 403, `${r.status} ${r2.status}`);

  console.log("── bulk match (one click)");
  r = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.student, body: { items: [{ id: String(legacy.IOBM), toId: row("IOBM").suggestion.id }] } });
  check("students can't bulk match", r.status === 403 && snapshot() === before);
  r = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.admin, body: { items: [] } });
  const r3 = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.admin, body: { items: Array.from({ length: 201 }, () => ({ id: String(oid()), toId: String(oid()) })) } });
  check("nothing selected, or more than 200: refused, nothing changes", r.status === 400 && r3.status === 400 && snapshot() === before);
  const moving = five.reduce((a, n) => a + studentsOn(n), 0);
  const items = five.map((n) => ({ id: row(n).id, toId: row(n).suggestion.id }));
  r = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.admin, body: { items } });
  const d = r.json?.data || {};
  check(`all 5 selected matched, ${moving} students moved`, r.status === 200 && d.matched === 5 && d.students === moving && d.failed.length === 0, r.text.slice(0, 300));
  const iobm = byName("Institute of Business Management"); const ned = byName("NED University of Engineering & Technology"); const ku = byName("University of Karachi");
  check("students now belong to the official university, with its name", five.every((n) => studentsOn(n) === 0) && rows("User", (u) => String(u.university) === String(iobm._id)).length === ["IOBM", "iobm karachi", "Inst of Business Mgmt"].reduce((a, n) => a + 1 + (typed.indexOf(n) % 3), 0) && rows("User", (u) => String(u.university) === String(iobm._id)).every((u) => u.universityName === "Institute of Business Management"));
  check("the offer and the confession moved too", String(rows("Offer", (o) => String(o._id) === String(offerId))[0].university) === String(iobm._id) && String(rows("Confession", (o) => String(o._id) === String(confId))[0].university) === String(ned._id));
  check("each old spelling is now an alias of the official one", ["iobm karachi", "Inst of Business Mgmt"].every((a) => byName("Institute of Business Management").aliases.includes(a)) && byName("NED University of Engineering & Technology").aliases.includes("NED Univ"));
  check("the old entries are hidden and point at the official one", five.every((n) => { const e = rows("University", (u) => String(u._id) === String(legacy[n]))[0]; return e.status === "hidden" && String(e.mergedInto) === row(n).suggestion.id; }));
  check("studentCount updated on the official universities", byName("University of Karachi").studentCount === rows("User", (u) => String(u.university) === String(ku._id)).length && byName("Institute of Business Management").studentCount === rows("User", (u) => String(u.university) === String(iobm._id)).length && ku.studentCount > 0);
  const logs = rows("AdminActionLog", (l) => l.action === "university.match" && /bulk match \(5 selected\)/.test(l.reason || ""));
  check("logged: one 'university.match' row per name, by this admin, with students moved and the reason 'bulk match'", logs.length === 5 && logs.every((l) => String(l.admin) === String(ids.admin) && l.after?.moved && typeof l.after.moved.students === "number") && new Set(logs.map((l) => l.targetId)).size === 5);
  r = await call("GET", "/api/admin/universities/unmatched/summary", { tok: tok.admin });
  check("counts after: 3 unmatched names left, their students, 5 matched today", r.json.data.unmatched === 3 && r.json.data.matchedToday === 5 && r.json.data.students === studentTotal - moving, JSON.stringify(r.json.data));
  r = await call("GET", "/api/admin/universities/unmatched", { tok: tok.admin });
  check("…and the list shows only the 3 left", (r.json?.data || []).map((x) => x.name).sort().join("|") === ["Govt College Lahore", "Some College Nobody Knows", "UET"].join("|"));

  console.log("── future signups with an old spelling match by themselves");
  unis.bust();
  const countBefore = rows("University").length;
  r = await call("POST", "/api/auth/signup", { body: { role: "student", password: "Passw0rd!x", fullName: "Later Student", city: "Karachi", phone: "03001234567", email: "later@test.local", universityName: "Inst of Business Mgmt" } });
  const later = rows("User", (u) => u.email === "later@test.local")[0];
  check("signup typing 'Inst of Business Mgmt' → Institute of Business Management, no new entry", later && String(later.university) === String(iobm._id) && rows("University").length === countBefore, `${r.status} ${r.text.slice(0, 150)}`);
  r = await call("GET", "/api/universities?search=" + encodeURIComponent("iobm karachi"));
  check("the dropdown search finds it by the old spelling too", r.json?.data?.[0]?.name === "Institute of Business Management");

  console.log("── refusals and partial failures");
  const hidden = rows("University", (u) => u.status === "hidden" && !u.mergedInto)[0];
  const snap2 = snapshot();
  r = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.admin, body: { items: [{ id: String(legacy.IOBM), toId: String(iobm._id) }, { id: String(legacy.UET), toId: String(hidden._id) }, { id: String(legacy["Govt College Lahore"]), toId: String(legacy["Some College Nobody Knows"]) }] } });
  const fails = Object.fromEntries((r.json?.data?.failed || []).map((f) => [f.id, f.code]));
  check("an already matched name, a hidden target, an unmatched target: each refused, nothing matched, nothing changed", r.status === 200 && r.json.data.matched === 0 && fails[String(legacy.IOBM)] === "NOT_UNMATCHED" && fails[String(legacy.UET)] === "TARGET_NOT_LISTED" && fails[String(legacy["Govt College Lahore"])] === "TARGET_NOT_LISTED" && snapshot() === snap2, JSON.stringify(r.json?.data));
  const gcu = byName("Government College University, Lahore");
  r = await call("POST", "/api/admin/universities/unmatched/match-bulk", { tok: tok.admin, body: { items: [{ id: String(legacy["Govt College Lahore"]), toId: String(gcu._id) }, { id: String(legacy["Govt College Lahore"]), toId: String(gcu._id) }, { id: "nope", toId: String(gcu._id) }] } });
  check("one good, one listed twice, one bad id: the good one is matched, the others are reported", r.json?.data?.matched === 1 && r.json.data.failed.map((f) => f.code).sort().join(",") === "DUPLICATE,NOT_FOUND" && byName("Government College University, Lahore").aliases.includes("Govt College Lahore"), JSON.stringify(r.json?.data?.failed));
  r = await call("POST", `/api/admin/universities/unmatched/${legacy.UET}/match`, { tok: tok.admin, body: { toId: String(hidden._id) } });
  check("single match into a hidden university: refused", r.status === 400 && !rows("University", (u) => String(u._id) === String(legacy.UET))[0].status);
  r = await call("POST", `/api/admin/universities/unmatched/${legacy.UET}/match`, { tok: tok.admin, body: { toId: String(byName("University of Engineering & Technology, Lahore")._id) } });
  check("single match (a medium one, picked by the admin) still works and is logged", r.status === 200 && rows("AdminActionLog", (l) => l.action === "university.match" && l.targetId === String(legacy.UET)).length === 1);
  r = await call("GET", "/api/admin/universities/unmatched/summary", { tok: tok.admin });
  check("counts: 1 left, 7 matched today", r.json.data.unmatched === 1 && r.json.data.matchedToday === 7, JSON.stringify(r.json.data));

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
