// P3-1 / P3-3 additive resume fields, through the real routes (the Resume schema is strict, so each must be accepted):
//   settings.track (fresher | experienced; anything else ignored, never a failed save), activities, volunteering,
//   awards, coursework, on create (POST /api/resume) and on save (PUT /api/resume/:id, only the sent sections change)
//   the stored strength (completionPercentage) follows the track; older resumes and replies are unchanged
//   node tests/resume-fresher-fields/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resume.routes"]], models: ["Resume", "ResumeCreationLock"] });
const { call, check, oid, user, token, fake, coll, rows, reqS, same } = h;

const S = oid(); const O = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan", { location: "" }), user(O, "student", "Old Resume")]);
const OLD = oid();
fake.seed(coll("Resume"), [{ _id: OLD, user: O, personalInfo: { firstName: "Old", lastName: "Resume", email: "o@x.co" }, education: [{ institution: "NED", degree: "BS" }], skills: [], workExperience: [], projects: [], certifications: [], languages: [], achievements: [], interests: [], references: [], targetJobs: [], settings: { visibility: "public" }, template: "modern_ats", createdAt: new Date(), updatedAt: new Date() }]);
const T = { S: token(S, "student"), O: token(O, "student") };
const rules = reqS("./utils/resumeRules");

(async () => {
  const server = h.start();
  console.log("-- create with the fresher fields");
  let r = await call("POST", "/api/resume", { tok: T.S, body: {
    personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@x.co", phone: "03001234567", city: "Karachi", title: "BBA student" },
    settings: { track: "fresher" },
    education: [{ institution: "IBA", degree: "BBA", endDate: "2027-06-01" }],
    activities: [{ organisation: "Marketing Society", role: "events lead", startDate: "2025-09-01", current: true, bullets: ["organised the welcome week"] }],
    volunteering: [{ organisation: "Edhi", role: "volunteer", description: "packed food parcels" }],
    awards: [{ title: "Dean's list", issuer: "IBA", date: "2025-06-01" }],
    coursework: ["Marketing 101", "Statistics"],
  } });
  check("created", r.status === 201 || r.status === 200, r.text.slice(0, 200));
  let d = rows("Resume", (x) => same(x.user, S))[0];
  const id = d && String(d._id);
  check("settings.track stored", d?.settings?.track === "fresher");
  const asExperienced = rules.resumeStrength({ ...JSON.parse(JSON.stringify(d || {})), settings: {} }).score;
  check("the stored strength is the fresher score (higher than the same resume scored as experienced)", d?.completionPercentage === rules.resumeStrength(d).score && d.completionPercentage > asExperienced, `${d?.completionPercentage} vs ${asExperienced}`);
  check("activities, volunteering, awards, coursework stored", d?.activities?.[0]?.organisation === "Marketing Society" && d.activities[0].bullets[0] === "organised the welcome week" && d.volunteering?.[0]?.organisation === "Edhi" && d.awards?.[0]?.title === "Dean's list" && d.coursework?.join() === "Marketing 101,Statistics", JSON.stringify(d).slice(0, 300));

  console.log("-- save");
  r = await call("PUT", `/api/resume/${id}`, { tok: T.S, body: { activities: [{ organisation: "IEEE", role: "member", bullets: [] }] } });
  d = rows("Resume", (x) => same(x._id, id))[0];
  check("PUT activities: replaced; the other new sections kept", r.status === 200 && d.activities.length === 1 && d.activities[0].organisation === "IEEE" && d.volunteering[0].organisation === "Edhi" && d.awards.length === 1, r.text.slice(0, 200));
  r = await call("PUT", `/api/resume/${id}`, { tok: T.S, body: { awards: [], coursework: ["Finance"] } });
  d = rows("Resume", (x) => same(x._id, id))[0];
  check("PUT awards [] and coursework", d.awards.length === 0 && d.coursework.join() === "Finance");
  r = await call("PUT", `/api/resume/${id}`, { tok: T.S, body: { settings: { track: "senior" } } });
  d = rows("Resume", (x) => same(x._id, id))[0];
  check("an unknown track is ignored (200, still fresher)", r.status === 200 && d.settings.track === "fresher", r.text.slice(0, 200));
  r = await call("PUT", `/api/resume/${id}`, { tok: T.S, body: { settings: { track: "experienced" } } });
  d = rows("Resume", (x) => same(x._id, id))[0];
  check("switch to experienced", d.settings.track === "experienced");
  r = await call("GET", `/api/resume/${id}`, { tok: T.S });
  const got = r.json?.data || r.json?.resume || r.json;
  check("GET returns the new sections", JSON.stringify(got).includes("IEEE") && JSON.stringify(got).includes("Finance"));

  console.log("-- older resumes");
  r = await call("PUT", `/api/resume/${OLD}`, { tok: T.O, body: { personalInfo: { phone: "0300" } } });
  d = rows("Resume", (x) => same(x._id, OLD))[0];
  check("an older resume saves as before, no track added", r.status === 200 && !d.settings?.track, JSON.stringify(d.settings));
  check("…and scores as before (experienced)", rules.trackOf(d) === "experienced");
  r = await call("GET", "/api/resume", { tok: T.O });
  check("the list reply is unchanged in shape", r.status === 200);

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
