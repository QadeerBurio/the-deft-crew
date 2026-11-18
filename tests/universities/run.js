// The shared university list (feat/universities): search by name / short name / alias (approved only), students'
// "not listed" requests (pending, near-duplicates answered "did you mean", rate limited), signup with the list (and
// old app builds that send a typed name), the student's own university, admin add / edit / hide / approve / reject /
// merge (logged; merge moves students and keeps an alias), unmatched old names with match-to / add-as-new, the HEC
// seed script (dry run, apply, idempotent), and matching that never reads a university.
//   node tests/universities/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
process.env.RATE_LIMIT_UNIVERSITY_REQUEST_MAX = "5";
const h = require("../hiring-fixes/harness")(SERVER, {
  extraRoutes: [["/api/universities", "./routes/university.routes"], ["/api/admin/universities", "./routes/adminUniversities.routes"], ["/api/auth", "./routes/auth.routes"]],
  models: ["University", "Offer", "Confession", "AdminActionLog"],
});
const { reqS, call, check, rows, oid, user, token, fake, coll, mongoose } = h;
const University = reqS("./models/University");
const User = reqS("./models/User");
const unis = reqS("./services/universities");
const seedScript = reqS("./scripts/seed-universities");

const ids = { admin: oid(), s1: oid(), s2: oid(), s3: oid(), brand: oid() };
fake.seed(coll("User"), [user(ids.admin, "admin", "Admin One"), user(ids.brand, "brand", "Brand One")]);
const tok = { admin: token(ids.admin, "admin"), s1: token(ids.s1, "student"), s2: token(ids.s2, "student"), brand: token(ids.brand, "brand") };
const ip = (n) => ({ "x-forwarded-for": `10.0.0.${n}` });

(async () => {
  const server = h.start();
  h.app.set("trust proxy", true);

  console.log("── the seed (HEC list), before anything else exists");
  const seed = JSON.parse(fs.readFileSync(path.join(SERVER, "seeds", "universities-pk.json"), "utf8"));
  check(`seed file: ${seed.count} HEC entries, source and URL recorded`, seed.count === seed.universities.length && seed.count >= 280 && /hec\.gov\.pk/.test(seed.sourceUrl) && seed.universities.every((u) => u.name && u.city && u.province));
  check("seed file: names are unique; IoBM, IBA, FAST, NUST, LUMS have their short names", new Set(seed.universities.map((u) => u.name)).size === seed.count && ["IoBM", "IBA", "FAST", "NUST", "LUMS", "NED", "KU"].every((s) => seed.universities.some((u) => u.shortName === s)));
  // old signup entries (typed names, no status) and students on them, as in production today
  const legacy = { ned: oid(), iobmTypo: oid(), exact: oid() };
  fake.seed(coll("University"), [
    { _id: legacy.ned, name: "NED University of Engineering and Technology — Karachi" },
    { _id: legacy.iobmTypo, name: "iobm karachi" },
    { _id: legacy.exact, name: "Institute of Business Administration" }, // exactly the HEC name
  ]);
  const student = (id, name, uni, extra = {}) => user(id, "student", name, { university: uni, ...extra });
  fake.seed(coll("User"), [student(ids.s1, "Sana Ali", legacy.ned), student(ids.s2, "Ali Raza", legacy.ned), student(ids.s3, "Hira Khan", legacy.iobmTypo)]);
  const lines = [];
  let out = await seedScript.run({ apply: false, log: (l) => lines.push(l) });
  check("dry run: writes nothing, says what it would add and which old entry it adopts", rows("University").length === 3 && out.add.length === seed.count - 1 && out.adopt.join() === "Institute of Business Administration" && /DRY RUN/.test(lines[0]), JSON.stringify({ add: out.add.length, adopt: out.adopt }));
  out = await seedScript.run({ apply: true, log: () => {} });
  check("--apply: HEC universities added, the old exact-name entry adopted (same id, students stay)", rows("University", (u) => u.status === "approved").length >= 280 && rows("University", (u) => String(u._id) === String(legacy.exact))[0]?.status === "approved");
  check("…users are not touched by the seed", rows("User", (u) => String(u.university) === String(legacy.ned)).length === 2 && !rows("User").some((u) => u.universityName));
  out = await seedScript.run({ apply: true, log: () => {} });
  check("running it again changes nothing (idempotent)", out.add.length === 0 && out.adopt.length === 0 && out.update.length === 0, JSON.stringify({ a: out.add.length, d: out.adopt.length, u: out.update.slice(0, 3) }));
  check("the suspended institute is seeded hidden", rows("University", (u) => /^Global Institute, Lahore$/.test(u.name))[0]?.status === "hidden");

  console.log("── search (public, approved only)");
  unis.bust();
  const names = (r) => (r.json?.data || []).map((u) => u.name);
  let r = await call("GET", "/api/universities?search=iobm");
  check("short name 'iobm' finds the Institute of Business Management", r.status === 200 && names(r)[0] === "Institute of Business Management" && r.json.data[0].shortName === "IoBM" && r.json.data[0].city === "Karachi", JSON.stringify(r.json?.data?.slice(0, 2)));
  r = await call("GET", "/api/universities?search=" + encodeURIComponent("  Fast-NUCES "));
  check("alias, any case and spacing: 'Fast-NUCES' → National University of Computer & Emerging Sciences", names(r)[0] === "National University of Computer & Emerging Sciences", names(r).slice(0, 3).join(" | "));
  r = await call("GET", "/api/universities?search=karachi%20university");
  check("alias 'Karachi University' → University of Karachi", names(r)[0] === "University of Karachi", names(r).slice(0, 3).join(" | "));
  r = await call("GET", "/api/universities?search=" + encodeURIComponent("ned engineering"));
  check("words of the name: 'ned engineering' → NED University of Engineering & Technology", names(r)[0] === "NED University of Engineering & Technology", names(r).slice(0, 3).join(" | "));
  r = await call("GET", "/api/universities?search=global%20institute");
  check("hidden ones never show", !names(r).includes("Global Institute, Lahore"));
  r = await call("GET", "/api/universities?search=iobm%20karachi");
  check("old unmatched entries never show ('iobm karachi' typed at signup)", !names(r).includes("iobm karachi"));

  console.log("── 'my university isn't listed'");
  r = await call("POST", "/api/universities/request", { body: { name: "Inst. of Business Management", city: "Karachi" }, headers: ip(1) });
  check("a near-duplicate: 'did you mean Institute of Business Management?', nothing created", r.status === 200 && r.json.data.match?.name === "Institute of Business Management" && /Did you mean/.test(r.json.data.message) && !rows("University", (u) => u.status === "pending").length, r.text.slice(0, 200));
  r = await call("POST", "/api/universities/request", { body: { name: "Karachi Grammar College of Design", city: "Karachi" }, headers: ip(1) });
  const pendingId = r.json?.data?.university?.id;
  check("a new name: a pending entry the student can use now", r.status === 201 && r.json.data.university.status === "pending" && /pending review/.test(r.json.data.message), r.text.slice(0, 200));
  r = await call("POST", "/api/universities/request", { body: { name: "karachi grammar college of design", city: "Karachi" }, headers: ip(2) });
  check("the same request again: the same pending entry (no duplicate)", r.json?.data?.university?.id === pendingId && rows("University", (u) => u.status === "pending").length === 1);
  r = await call("POST", "/api/universities/request", { body: { name: "Ab", city: "" }, headers: ip(2) });
  check("too short / no city: a plain 400", r.status === 400 && ["NAME_REQUIRED", "CITY_REQUIRED"].includes(r.json.error.code));
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push((await call("POST", "/api/universities/request", { body: { name: `Test College ${i}`, city: "Hyderabad" }, headers: ip(9) })).status);
  check("rate limit: 5 an hour per device, the 6th is 429", burst.slice(0, 5).every((s) => s === 201) && burst[5] === 429, burst.join(","));
  const allow = reqS("./middleware/rejectGuestWrites");
  check("signed-out (signup) callers may send a request; nothing else under /universities", allow.allowed("POST", "/universities/request") && !allow.allowed("PUT", "/universities/mine"));

  console.log("── signup uses the list");
  const iobm = rows("University", (u) => u.name === "Institute of Business Management")[0];
  const signup = (body, n) => call("POST", "/api/auth/signup", { body: { role: "student", password: "Passw0rd!x", fullName: "New Student", city: "Karachi", phone: "0300" + String(1000000 + n), email: `new${n}@test.local`, ...body } });
  r = await signup({ universityId: String(iobm._id) }, 1);
  const u1 = rows("User", (u) => u.email === "new1@test.local")[0];
  check("signup with a university from the list: id and name stored", (r.status === 200 || r.status === 201) && String(u1?.university) === String(iobm._id) && u1.universityName === "Institute of Business Management", `${r.status} ${r.text.slice(0, 200)}`);
  r = await signup({ universityId: pendingId }, 2);
  const u2 = rows("User", (u) => u.email === "new2@test.local")[0];
  check("signup with the pending one the student just asked for: allowed, shows as their university", String(u2?.university) === pendingId && u2.universityName === "Karachi Grammar College of Design", `${r.status} ${r.text.slice(0, 150)}`);
  r = await signup({ universityId: String(legacy.iobmTypo) }, 3);
  check("signup with an old unmatched / hidden entry: refused", r.status === 400 && r.json?.code === "UNIVERSITY_NOT_AVAILABLE");
  const before = rows("University").length;
  r = await signup({ universityName: "NED University of Engineering and Technology City Campus — Karachi" }, 4);
  const u4 = rows("User", (u) => u.email === "new4@test.local")[0];
  check("an old app build sending the typed name: matched to the list (no new entry)", u4 && rows("University", (x) => String(x._id) === String(u4.university))[0]?.name === "NED University of Engineering & Technology" && rows("University").length === before, `${r.status} ${rows("University", (x) => String(x._id) === String(u4?.university))[0]?.name}`);

  console.log("── a student's own university (profile edit)");
  r = await call("PUT", "/api/universities/mine", { tok: tok.s1, body: { universityId: String(iobm._id) } });
  check("a student picks from the list: saved with the name", r.status === 200 && rows("User", (u) => String(u._id) === String(ids.s1))[0].universityName === "Institute of Business Management");
  r = await call("PUT", "/api/universities/mine", { tok: tok.s1, body: { universityId: String(legacy.ned) } });
  check("…not an old unmatched entry", r.status === 400);
  r = await call("PUT", "/api/universities/mine", { tok: tok.brand, body: { universityId: String(iobm._id) } });
  check("…and only students have one", r.status === 403);
  await call("PUT", "/api/universities/mine", { tok: tok.s1, body: { universityId: String(legacy.ned) } }); // back to the old one (refused) — re-point for the next part
  await User.collection.updateOne({ _id: ids.s1 }, { $set: { university: legacy.ned }, $unset: { universityName: "" } });

  console.log("── admin");
  r = await call("GET", "/api/admin/universities", { tok: tok.s2 });
  check("students can't open the admin list", r.status === 403);
  r = await call("GET", "/api/admin/universities?status=pending", { tok: tok.admin });
  check("pending requests first, with student counts", r.status === 200 && r.json.data[0].status === "pending" && r.json.data.find((x) => x.id === pendingId)?.students === 1, JSON.stringify(r.json?.data?.slice(0, 2)));
  r = await call("GET", "/api/admin/universities/pending-count", { tok: tok.admin });
  const pendingCount = r.json?.data?.pending;
  check("the menu badge count", pendingCount === 6, String(pendingCount));
  r = await call("GET", "/api/admin/universities?search=iobm&status=approved", { tok: tok.admin });
  check("search + status filter", r.json.data.length === 1 && r.json.data[0].shortName === "IoBM");
  r = await call("GET", "/api/admin/universities?city=Jamshoro", { tok: tok.admin });
  check("city filter", r.json.data.length > 0 && r.json.data.every((x) => x.city === "Jamshoro"));
  r = await call("POST", "/api/admin/universities", { tok: tok.admin, body: { name: "Test Institute of Design", shortName: "TID", city: "Lahore", aliases: "TID Lahore, Design Institute Lahore" } });
  const addedId = r.json?.data?.id;
  check("add: approved, with aliases", r.status === 201 && r.json.data.status === "approved" && r.json.data.aliases.length === 2);
  unis.bust();
  check("…and searchable right away", (await call("GET", "/api/universities?search=tid")).json.data[0]?.id === addedId);
  r = await call("PATCH", `/api/admin/universities/${addedId}`, { tok: tok.admin, body: { name: "Test Institute of Design & Media", city: "Lahore" } });
  check("edit", r.status === 200 && r.json.data.name === "Test Institute of Design & Media");
  r = await call("POST", `/api/admin/universities/${addedId}/hide`, { tok: tok.admin, body: {} });
  unis.bust();
  check("hide: not offered any more", r.json?.data?.status === "hidden" && !(await call("GET", "/api/universities?search=tid")).json.data.some((x) => x.id === addedId));
  r = await call("POST", `/api/admin/universities/${pendingId}/approve`, { tok: tok.admin, body: { shortName: "KGCD" } });
  check("approve a request (with a short name): approved, the student's name updated", r.status === 200 && r.json.data.status === "approved" && rows("User", (u) => u.email === "new2@test.local")[0].universityName === "Karachi Grammar College of Design");
  const p1 = rows("University", (u) => u.name === "Test College 0")[0];
  r = await call("POST", `/api/admin/universities/${p1._id}/reject`, { tok: tok.admin, body: {} });
  check("reject needs a reason", r.status === 400 && r.json.error.code === "REASON_REQUIRED");
  r = await call("POST", `/api/admin/universities/${p1._id}/reject`, { tok: tok.admin, body: { reason: "test entry" } });
  check("reject with a reason: hidden, reason kept", r.status === 200 && r.json.data.status === "hidden" && r.json.data.rejectReason === "test entry");
  // a pending request a student uses, rejected as a duplicate of a real one: "merge into existing"
  const p2 = rows("University", (u) => u.name === "Test College 1")[0];
  await User.collection.insertOne(student(oid(), "Zoya Test", p2._id));
  r = await call("POST", `/api/admin/universities/${p2._id}/reject`, { tok: tok.admin, body: { reason: "duplicate of IoBM", mergeInto: String(iobm._id) } });
  check("reject + merge into existing: the student moves, the name becomes an alias", r.status === 200 && rows("User", (u) => u.name === "Zoya Test")[0].universityName === "Institute of Business Management" && rows("University", (u) => String(u._id) === String(iobm._id))[0].aliases.includes("Test College 1"), r.text.slice(0, 200));

  console.log("── unmatched names (old typed text)");
  r = await call("GET", "/api/admin/universities/unmatched", { tok: tok.admin });
  const un = r.json?.data || [];
  const nedRow = un.find((x) => x.id === String(legacy.ned));
  check("grouped with counts and a suggestion: 'NED … — Karachi' (2 students) → NED University of Engineering & Technology", nedRow?.students === 2 && nedRow?.suggestion?.name === "NED University of Engineering & Technology", JSON.stringify(un.slice(0, 3)));
  check("…reading it changes nothing", rows("User", (u) => String(u.university) === String(legacy.ned)).length === 2 && !rows("University", (u) => String(u._id) === String(legacy.ned))[0].status);
  const nedId = nedRow.suggestion.id;
  const offerId = oid();
  await reqS("./models/Offer").collection.insertOne({ _id: offerId, title: "10% off", university: legacy.ned, createdAt: new Date() });
  r = await call("POST", `/api/admin/universities/unmatched/${legacy.ned}/match`, { tok: tok.admin, body: { toId: nedId } });
  check("match to …: both students (and an offer) move, the old text becomes an alias", r.status === 200 && rows("User", (u) => String(u.university) === nedId).length >= 3 && rows("User", (u) => u.name === "Sana Ali")[0].universityName === "NED University of Engineering & Technology" && String(rows("Offer", (o) => String(o._id) === String(offerId))[0].university) === nedId && rows("University", (u) => String(u._id) === nedId)[0].aliases.includes("NED University of Engineering and Technology — Karachi"), r.text.slice(0, 200));
  check("…the old entry is hidden and points at the new one", rows("University", (u) => String(u._id) === String(legacy.ned))[0].status === "hidden" && String(rows("University", (u) => String(u._id) === String(legacy.ned))[0].mergedInto) === nedId);
  r = await call("POST", `/api/admin/universities/unmatched/${legacy.iobmTypo}/add`, { tok: tok.admin, body: { name: "IoBM Karachi Campus Two", city: "Karachi" } });
  check("add as new: approved with the admin's name, its student follows", r.status === 200 && r.json.data.status === "approved" && rows("User", (u) => u.name === "Hira Khan")[0].universityName === "IoBM Karachi Campus Two");
  r = await call("POST", "/api/admin/universities/merge", { tok: tok.admin, body: { fromId: String(legacy.iobmTypo), toId: String(iobm._id) } });
  check("merge duplicates: students move, old name kept as an alias", r.status === 200 && rows("User", (u) => u.name === "Hira Khan")[0].universityName === "Institute of Business Management" && rows("University", (u) => String(u._id) === String(iobm._id))[0].aliases.includes("IoBM Karachi Campus Two"));
  r = await call("POST", "/api/admin/universities/merge", { tok: tok.admin, body: { fromId: String(iobm._id), toId: String(iobm._id) } });
  check("merging into itself: refused", r.status === 400);
  unis.bust();
  check("search finds a merged name through its alias", (await call("GET", "/api/universities?search=" + encodeURIComponent("IoBM Karachi Campus Two"))).json.data[0]?.name === "Institute of Business Management");

  console.log("── logged");
  const logs = rows("AdminActionLog", (l) => l.targetType === "University");
  const acts = new Set(logs.map((l) => l.action));
  check("every admin change is in the action log (add, edit, hide, approve, reject, match, add as new, merge)", ["university.add", "university.edit", "university.hide", "university.approve", "university.reject", "university.match", "university.add_unmatched", "university.merge"].every((a) => acts.has(a)), [...acts].join(","));
  check("…with the admin and the before / after", logs.every((l) => String(l.admin) === String(ids.admin) && l.after));
  check("…a merge records how many students moved", logs.some((l) => l.action === "university.match" && l.after?.moved?.students === 2));

  console.log("── matching never reads a university");
  const src = (f) => fs.readFileSync(path.join(SERVER, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const careerFiles = fs.readdirSync(path.join(SERVER, "services", "career")).filter((f) => f.endsWith(".js"));
  const leaks = careerFiles.filter((f) => /\buniversit/i.test(src(`services/career/${f}`).replace(/["'`][^"'`\n]*universit[^"'`\n]*["'`]/gi, "")));
  check("services/career/* has no code that reads a university", leaks.length === 0, leaks.join(","));
  const matching = reqS("./services/career/matchingService");
  const content = { skills: [{ name: "React" }, { name: "Node.js" }], workExperience: [], projects: [], education: [{ institution: "NED University", degree: "BS" }] };
  const a = matching.match({ skills: ["React", "Node.js", "SQL"], requirements: [] }, matching.profileOf({ content }));
  const b = matching.match({ skills: ["React", "Node.js", "SQL"], requirements: [] }, matching.profileOf({ content: { ...content, education: [{ institution: "LUMS", degree: "BS" }] } }));
  check("the same skills at two universities: the same match", a.relevance.score === b.relevance.score);

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
