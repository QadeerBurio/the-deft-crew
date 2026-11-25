// r11 (owner): the admin features display matches what the app gets (display only: nothing in flagState or the app's
// reply changes). GET /api/admin/features/account/:id: every flag has source ("launch" when on because of launchV2),
// launch { by, on } for launch-covered flags, and app (the value GET /api/app/flags/me gives that account).
// GET /api/admin/features/flags: launch { by, onForStudents } per covered flag.
//   a student with no settings: every launchV2 flag effective, source "launch", and equal to what the app sees
//   (both lists compared flag by flag); one flag forced off → off, source "account", the app off; launchV2 forced off
//   for the account → every launch flag back to "default" (off) and the app off; the students' default off → the same
//   for everyone; launchLinks flags: off, launch.by "launchLinks", launch.on false; confessionsVoting: no launch
//   node tests/r11-admin-launch/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/admin/features", "./routes/adminFeatures.routes"], ["/api/app", "./routes/appFlags.routes"]],
  models: ["FeatureAccess", "FeatureDefault", "AdminActionLog"],
});
const { call, check, oid, user, token, fake, coll, reqS } = h;
const F = reqS("./config/featureFlags");
const S = oid(); const A = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Student"), user(A, "admin", "Ada Admin")]);
const TA = token(A, "admin");

(async () => {
  F.setBuiltInDefaults(true); // production: "no row = on" for role defaults (launchV2 is a student default since r10)
  F.setAccountRoles([[String(A), "admin"]]);
  const server = h.start();
  const view = async () => (await call("GET", `/api/admin/features/account/${S}`, { tok: TA })).json?.data;
  const appFlags = async () => (await call("GET", "/api/app/flags/me", { tok: token(S, "student") })).json || {};
  const byFlag = (v) => Object.fromEntries((v?.flags || []).map((f) => [f.flag, f]));

  console.log("-- a student with no settings");
  let v = await view(); let m = byFlag(v); let app = await appFlags();
  const launchFlags = F.LAUNCH_V2.filter((f) => m[f]);
  check(`the tab lists the launch flags this student can have (${launchFlags.length} of 38)`, launchFlags.length === 38);
  check("every launch flag: effective on, source 'launch', launch { by: launchV2, on: true }", launchFlags.every((f) => m[f].effective === true && m[f].source === "launch" && m[f].launch?.by === "launchV2" && m[f].launch.on === true), launchFlags.filter((f) => m[f].source !== "launch").join(","));
  const mismatch = (v.flags || []).filter((f) => f.app !== null && f.app !== app[f.flag] || f.app !== null && f.app !== f.effective);
  check("the tab's value = 'what the app sees' = GET /api/app/flags/me, for every client flag", mismatch.length === 0 && (v.flags || []).filter((f) => f.app !== null).length >= 45, mismatch.map((f) => `${f.flag}: tab ${f.effective} app ${app[f.flag]}`).join(", "));
  check("…and the tab's own appView agrees", (v.flags || []).every((f) => f.app === null || v.appView.flags[f.flag] === f.app));
  check("launchLinks flags (resumePublicPage, confessionShare): off, launch { by: launchLinks, on: false }", ["resumePublicPage", "confessionShare"].every((f) => m[f].effective === false && m[f].launch?.by === "launchLinks" && m[f].launch.on === false));
  check("confessionsVoting and launchLinks itself: no launch block, off", m.confessionsVoting.launch === null && m.confessionsVoting.effective === false && m.launchLinks.launch === null);
  check("the older student defaults keep their source (loyaltyV2: 'default')", m.loyaltyV2.source === "default");

  console.log("-- one flag forced off");
  let r = await call("PUT", `/api/admin/features/account/${S}/resumeWriter`, { tok: TA, body: { enabled: false, reason: "test: forced off" } });
  m = byFlag(await view()); app = await appFlags();
  check("resumeWriter: off, source 'account', forced off; the app gets off", r.status === 200 && m.resumeWriter.effective === false && m.resumeWriter.source === "account" && m.resumeWriter.forced === "off" && app.resumeWriter === false && m.resumeWriter.app === false);
  check("…its launch block still says launchV2 is on (so the portal shows 'default (on)' as the reset choice)", m.resumeWriter.launch?.on === true);
  await call("PUT", `/api/admin/features/account/${S}/resumeWriter`, { tok: TA, body: { state: "default", reason: "test: back" } });

  console.log("-- launchV2 forced off for the account");
  await call("PUT", `/api/admin/features/account/${S}/launchV2`, { tok: TA, body: { enabled: false, reason: "test: launch off" } });
  m = byFlag(await view()); app = await appFlags();
  check("every launch flag: off, source back to its default, launch.on false; the app off", F.LAUNCH_V2.every((f) => m[f].effective === false && m[f].source !== "launch" && m[f].launch?.on === false && app[f] === false));
  await call("PUT", `/api/admin/features/account/${S}/launchV2`, { tok: TA, body: { state: "default", reason: "test: back" } });
  m = byFlag(await view());
  check("reset: on via launch again", F.LAUNCH_V2.every((f) => m[f].source === "launch"));

  console.log("-- the main features page");
  let ov = (await call("GET", "/api/admin/features/flags", { tok: TA })).json?.data || [];
  const o = Object.fromEntries(ov.map((x) => [x.flag, x]));
  check("each launch flag: launch { by: launchV2, onForStudents: true }", F.LAUNCH_V2.filter((f) => o[f]).every((f) => o[f].launch?.by === "launchV2" && o[f].launch.onForStudents === true));
  check("resumePublicPage / confessionShare: launchLinks, not on for students; confessionsVoting: none", o.resumePublicPage.launch?.by === "launchLinks" && o.resumePublicPage.launch.onForStudents === false && o.confessionsVoting.launch === null);
  r = await call("PUT", "/api/admin/features/defaults/launchV2", { tok: TA, body: { role: "student", enabled: false, reason: "test: students' default off" } });
  ov = (await call("GET", "/api/admin/features/flags", { tok: TA })).json?.data || [];
  m = byFlag(await view());
  check("the students' default off: onForStudents false everywhere; the student's launch flags off (not 'launch')", r.status === 200 && ov.filter((x) => x.launch?.by === "launchV2").every((x) => x.launch.onForStudents === false) && F.LAUNCH_V2.every((f) => m[f].effective === false && m[f].source !== "launch"));
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
