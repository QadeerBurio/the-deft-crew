// The shared university list (feat/universities, fix/universities-rules): the full list A–Z (approved only) and search by
// name / short name / alias; students can NOT add universities (no request route); signup with the list, offline with a
// bundled name, and old app builds; the student's own university; admin add / edit / hide / show / merge (logged; merge
// moves students and keeps an alias), no approve / reject / badge; unmatched old names with match-to / add-as-new; the
// HEC seed script (dry run, apply, idempotent); matching that never reads a university.
//   node tests/universities/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
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

  console.log("── the full list (public, approved only, A–Z) and search");
  unis.bust();
  const names = (r) => (r.json?.data || []).map((u) => u.name);
  let r = await call("GET", "/api/universities");
  const full = r.json?.data || [];
  const approvedCount = rows("University", (u) => u.status === "approved").length;
  check(`no search: every approved university (${full.length}), A–Z, with short name, city and aliases`, r.status === 200 && full.length === approvedCount && full.length >= 280 && full.every((u, i) => i === 0 || full[i - 1].name.localeCompare(u.name) <= 0) && full.some((u) => u.shortName === "IoBM" && u.city === "Karachi" && Array.isArray(u.aliases)), `${full.length} of ${approvedCount}`);
  check("…never hidden or old unmatched entries", !names(r).includes("Global Institute, Lahore") && !names(r).includes("iobm karachi") && !names(r).includes("NED University of Engineering and Technology — Karachi"));
  r = await call("GET", "/api/universities?search=iobm");
  check("search: short name 'iobm' → Institute of Business Management", r.status === 200 && names(r)[0] === "Institute of Business Management", JSON.stringify(r.json?.data?.slice(0, 2)));
  r = await call("GET", "/api/universities?search=" + encodeURIComponent("  Fast-NUCES "));
  check("search: alias, any case and spacing ('Fast-NUCES')", names(r)[0] === "National University of Computer & Emerging Sciences", names(r).slice(0, 3).join(" | "));
  r = await call("GET", "/api/universities?search=karachi%20university");
  check("search: alias 'Karachi University' → University of Karachi", names(r)[0] === "University of Karachi");

  console.log("── students can't add universities");
  r = await call("POST", "/api/universities/request", { body: { name: "Karachi Grammar College of Design", city: "Karachi" }, headers: ip(1) });
  check("POST /api/universities/request is gone (signed out)", r.status === 404 && !rows("University", (u) => u.name === "Karachi Grammar College of Design").length, `${r.status}`);
  r = await call("POST", "/api/universities/request", { tok: tok.s2, body: { name: "Karachi Grammar College of Design", city: "Karachi" } });
  check("…and for a signed-in student", r.status === 404 && !rows("University", (u) => u.name === "Karachi Grammar College of Design").length);
  r = await call("POST", "/api/admin/universities", { tok: tok.s2, body: { name: "Student Made College", city: "Karachi" } });
  check("students can't use the admin add either", r.status === 403 && !rows("University", (u) => u.name === "Student Made College").length);
  const allow = reqS("./middleware/rejectGuestWrites");
  check("signed-out callers can't write anything under /universities", !allow.allowed("POST", "/universities/request") && !allow.allowed("PUT", "/universities/mine"));

  console.log("── signup uses the list");
  const iobm = rows("University", (u) => u.name === "Institute of Business Management")[0];
  const signup = (body, n) => call("POST", "/api/auth/signup", { body: { role: "student", password: "Passw0rd!x", fullName: "New Student", city: "Karachi", phone: "0300" + String(1000000 + n), email: `new${n}@test.local`, ...body } });
  r = await signup({ universityId: String(iobm._id) }, 1);
  const u1 = rows("User", (u) => u.email === "new1@test.local")[0];
  check("signup with a university from the list: id and name stored", (r.status === 200 || r.status === 201) && String(u1?.university) === String(iobm._id) && u1.universityName === "Institute of Business Management", `${r.status} ${r.text.slice(0, 200)}`);
  r = await signup({ universityName: "Institute of Business Management" }, 2);
  const u2 = rows("User", (u) => u.email === "new2@test.local")[0];
  check("signup offline (a name from the app's bundled list, no id): matched to the same university", String(u2?.university) === String(iobm._id) && u2.universityName === "Institute of Business Management", `${r.status} ${r.text.slice(0, 150)}`);
  r = await signup({ universityId: String(legacy.iobmTypo) }, 3);
  check("signup with an old unmatched / hidden entry's id: refused", r.status === 400 && r.json?.code === "UNIVERSITY_NOT_AVAILABLE");
  const before = rows("University").length;
  r = await signup({ universityName: "NED University of Engineering and Technology City Campus — Karachi" }, 4);
  const u4 = rows("User", (u) => u.email === "new4@test.local")[0];
  check("an old app build's typed name: matched to the list (no new entry)", u4 && rows("University", (x) => String(x._id) === String(u4.university))[0]?.name === "NED University of Engineering & Technology" && rows("University").length === before);
  r = await signup({ universityName: "Some College Nobody Knows" }, 5);
  const u5 = rows("User", (u) => u.email === "new5@test.local")[0];
  const e5 = rows("University", (x) => String(x._id) === String(u5?.university))[0];
  check("an old build's name that matches nothing: signup works, kept as an unmatched name (not added to the list)", u5 && e5?.name === "Some College Nobody Knows" && !e5.status && !names(await call("GET", "/api/universities")).includes("Some College Nobody Knows"), `${r.status} ${JSON.stringify(e5)}`);

  console.log("── a student's own university (profile edit)");
  r = await call("PUT", "/api/universities/mine", { tok: tok.s1, body: { universityId: String(iobm._id) } });
  check("a student picks from the list: saved with the name", r.status === 200 && rows("User", (u) => String(u._id) === String(ids.s1))[0].universityName === "Institute of Business Management");
  r = await call("PUT", "/api/universities/mine", { tok: tok.s1, body: { universityId: String(legacy.ned) } });
  check("…not an old unmatched entry", r.status === 400);
  r = await call("PUT", "/api/universities/mine", { tok: tok.brand, body: { universityId: String(iobm._id) } });
  check("…and only students have one", r.status === 403);
  await User.collection.updateOne({ _id: ids.s1 }, { $set: { university: legacy.ned }, $unset: { universityName: "" } });

  console.log("── admin");
  r = await call("GET", "/api/admin/universities", { tok: tok.s2 });
  check("students can't open the admin list", r.status === 403);
  r = await call("GET", "/api/admin/universities", { tok: tok.admin });
  const statuses = new Set((r.json?.data || []).map((x) => x.status));
  check("the admin list has every university: approved, hidden and unmatched, with student counts", r.status === 200 && statuses.has("approved") && statuses.has("hidden") && statuses.has("unmatched") && (r.json.data.find((x) => x.id === String(legacy.ned))?.students === 2), [...statuses].join(","));
  r = await call("GET", "/api/admin/universities/pending-count", { tok: tok.admin });
  check("no pending-request badge any more", r.status === 404);
  r = await call("POST", `/api/admin/universities/${iobm._id}/approve`, { tok: tok.admin, body: {} });
  const r2 = await call("POST", `/api/admin/universities/${iobm._id}/reject`, { tok: tok.admin, body: { reason: "x" } });
  check("no approve / reject any more", r.status === 404 && r2.status === 404);
  r = await call("GET", "/api/admin/universities?search=iobm&status=approved", { tok: tok.admin });
  check("search + status filter", r.json.data.length === 1 && r.json.data[0].shortName === "IoBM");
  r = await call("GET", "/api/admin/universities?city=Jamshoro", { tok: tok.admin });
  check("city filter", r.json.data.length > 0 && r.json.data.every((x) => x.city === "Jamshoro"));
  r = await call("POST", "/api/admin/universities", { tok: tok.admin, body: { name: "Test Institute of Design", shortName: "TID", city: "Lahore", aliases: "TID Lahore, Design Institute Lahore" } });
  const addedId = r.json?.data?.id;
  check("add: approved, with aliases", r.status === 201 && r.json.data.status === "approved" && r.json.data.aliases.length === 2);
  check("…and in the full list the dropdowns load, right away on this server", names(await call("GET", "/api/universities")).includes("Test Institute of Design"));
  r = await call("PATCH", `/api/admin/universities/${addedId}`, { tok: tok.admin, body: { name: "Test Institute of Design & Media", city: "Lahore" } });
  check("edit: the new name is in the list", r.status === 200 && r.json.data.name === "Test Institute of Design & Media" && names(await call("GET", "/api/universities")).includes("Test Institute of Design & Media"));
  r = await call("POST", `/api/admin/universities/${addedId}/hide`, { tok: tok.admin, body: {} });
  check("hide: not offered any more", r.json?.data?.status === "hidden" && !names(await call("GET", "/api/universities")).includes("Test Institute of Design & Media"));
  r = await call("POST", `/api/admin/universities/${addedId}/show`, { tok: tok.admin, body: {} });
  check("show: back in the list", r.json?.data?.status === "approved" && names(await call("GET", "/api/universities")).includes("Test Institute of Design & Media"));

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
  check("search finds a merged name through its alias", (await call("GET", "/api/universities?search=" + encodeURIComponent("IoBM Karachi Campus Two"))).json.data[0]?.name === "Institute of Business Management");

  console.log("── logged");
  const logs = rows("AdminActionLog", (l) => l.targetType === "University");
  const acts = new Set(logs.map((l) => l.action));
  check("every admin change is in the action log (add, edit, hide, show, match, add as new, merge)", ["university.add", "university.edit", "university.hide", "university.show", "university.match", "university.add_unmatched", "university.merge"].every((a) => acts.has(a)), [...acts].join(","));
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
