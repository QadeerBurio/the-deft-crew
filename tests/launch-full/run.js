// 1.3.0 launch (owner, 29 Nov): nothing hidden for students.
//   a student with no settings (GET /api/app/flags/me): launchV2 and all 38 launch flags ON, the resume full fix
//   included (resumeV2, coach, speak, templates, feedback, finish, verified, outcome stats, writer), and every other
//   student default ON (resume studio, careers, loyalty, surplus)
//   OFF only (owner): launchLinks + its two (until DNS), confessionsVoting, accountStatusEnforce, socketTokenRequired,
//   adminRbacEnforce, adminSessionsV1, referralVerifyGate
//   no resume template hidden by default: GET /api/resume/templates/hidden is empty, all 50 offered
//   node tests/launch-full/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/app", "./routes/appFlags.routes"], ["/api/resume", "./routes/resumeFinish.routes"]], models: ["SafetySettings", "ResumeSettings"] });
const { call, check, oid, user, token, fake, coll, reqS } = h;
const F = reqS("./config/featureFlags");
const REG = reqS("./utils/resumeRender");
const S = oid();
fake.seed(coll("User"), [user(S, "student", "Sara Example")]);

const RESUME_FIX = ["resumeV2", "resumeCoach", "resumeSpeak", "resumeTemplatesV2", "resumeFeedback", "resumeFinish", "resumeVerified", "resumeOutcomeStats", "resumeWriter"];
const KEEP_OFF = ["launchLinks", "resumePublicPage", "confessionShare", "confessionsVoting", "accountStatusEnforce", "socketTokenRequired", "adminRbacEnforce", "adminSessionsV1", "referralVerifyGate"];

(async () => {
  F.setBuiltInDefaults(true); // production: role defaults with no row are on (opt-in switches excepted)
  const server = h.start();
  for (const k of Object.keys(process.env)) if (/^FLAG_/.test(k)) delete process.env[k]; // production has no FLAG_* (checked on Railway)
  const fl = (await call("GET", "/api/app/flags/me", { tok: token(S, "student") })).json || {};
  const launchOff = F.LAUNCH_V2.filter((f) => fl[f] !== true);
  check(`a student with no settings: launchV2 and all ${F.LAUNCH_V2.length} launch flags ON`, fl.launchV2 === true && F.LAUNCH_V2.length === 38 && launchOff.length === 0, launchOff.join(","));
  check("…the resume full fix is part of it (all 9 resume flags ON)", RESUME_FIX.every((f) => F.LAUNCH_V2.includes(f) && fl[f] === true), RESUME_FIX.filter((f) => fl[f] !== true).join(","));
  const studentDefaults = F.ROLE_DEFAULTS.student.filter((f) => !["launchLinks"].includes(f) && F.FLAGS[f]?.client);
  const sdOff = studentDefaults.filter((f) => fl[f] !== true);
  check(`…every other student default ON too (${studentDefaults.filter((f) => f !== "launchV2").join(", ")})`, sdOff.length === 0, sdOff.join(","));
  const clientFlags = Object.keys(F.FLAGS).filter((f) => F.FLAGS[f].client && F.FLAGS[f].grant?.roles?.includes("student"));
  const offForStudent = clientFlags.filter((f) => fl[f] !== true).sort();
  check("OFF for a student: exactly the owner's list (links until DNS, voting, the enforcement switches)", offForStudent.every((f) => KEEP_OFF.includes(f)), offForStudent.filter((f) => !KEEP_OFF.includes(f)).join(","));
  console.log(`   off for students: ${offForStudent.join(", ")}`);
  check("…launchLinks, resumePublicPage, confessionShare and confessionsVoting are off", ["launchLinks", "resumePublicPage", "confessionShare", "confessionsVoting"].every((f) => fl[f] === false));
  const hid = await call("GET", "/api/resume/templates/hidden", { tok: token(S, "student") });
  check("no resume template hidden by default (the admin list is empty); all 50 offered", hid.status === 200 && Array.isArray(hid.json?.data?.hidden) && hid.json.data.hidden.length === 0 && REG.OFFERED_IDS.length === 50, JSON.stringify(hid.json).slice(0, 200));
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
