// r9 launch (owner): the master switches launchV2 and launchLinks (config/featureFlags.js)
//   off (default) = today's app exactly: every listed flag off, the flags endpoint as before (plus the two switches, off)
//   launchV2 on for an account = every LAUNCH_V2 flag on for it (source "launchV2"); LAUNCH_LINKS and the never-included
//   flags untouched; other accounts unaffected
//   launchLinks on = resumePublicPage + confessionShare on (gettdc.pk links, after DNS)
//   force-disable wins: an admin's "off" for the account, or the Railway kill switch
//   "for every student" (admin role default): opt-in, so no row = off; an admin row "on" → all students (not employers)
//   confession safety: the built-in mode is now observe
//   node tests/r9-launch/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/app", "./routes/appFlags.routes"]], models: ["SafetySettings"] });
const { call, check, oid, user, token, fake, coll, reqS } = h;
const F = reqS("./config/featureFlags");
const S = oid(); const O = oid(); const E = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student"), user(E, "employee", "Emma Employer")]);
const st = (id) => ({ id: String(id), role: "student" });
const flagsOf = async (id, role = "student") => (await call("GET", "/api/app/flags/me", { tok: token(id, role) })).json || {};
const env = (name) => `FLAG_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

(async () => {
  F.setBuiltInDefaults(true); // production meaning: role defaults with no row are on (opt-in switches excepted)
  const server = h.start();
  check("38 flags in launchV2, 2 in launchLinks, 6 never included; every name is a real flag", F.LAUNCH_V2.length === 38 && F.LAUNCH_LINKS.length === 2 && F.LAUNCH_NEVER.length === 6 && [...F.LAUNCH_V2, ...F.LAUNCH_LINKS, ...F.LAUNCH_NEVER].every((f) => F.FLAGS[f]));
  check("…and none overlap (voting, enforcement switches, the gettdc.pk links are not in launchV2)", !F.LAUNCH_V2.some((f) => F.LAUNCH_LINKS.includes(f) || F.LAUNCH_NEVER.includes(f)) && !F.LAUNCH_V2.includes("confessionsVoting"));

  console.log("-- off (default): today's app");
  let fl = await flagsOf(S);
  const onNow = Object.entries(fl).filter(([, v]) => v === true).map(([k]) => k);
  check("launchV2 / launchLinks off by default; every listed flag off", fl.launchV2 === false && fl.launchLinks === false && [...F.LAUNCH_V2, ...F.LAUNCH_LINKS].every((f) => fl[f] === false), onNow.join(","));
  check("…the student role default for launchV2 is not set (opt-in: no row ≠ on)", F.roleDefaultOf("launchV2", "student") === null && F.roleDefaultOf("loyaltyV2", "student") === true);

  console.log("-- launchV2 on for one account");
  F.applyAdminAccess("launchV2", String(S), true);
  fl = await flagsOf(S);
  const notOn = F.LAUNCH_V2.filter((f) => fl[f] !== true);
  check("every launchV2 flag is on for that student", notOn.length === 0, notOn.join(","));
  check("…source 'launchV2'", F.LAUNCH_V2.every((f) => F.flagState(f, st(S)).source === "launchV2"));
  check("…the gettdc.pk link flags stay off (resumePublicPage, confessionShare)", F.LAUNCH_LINKS.every((f) => fl[f] === false));
  check("…the never-included stay off (confessionsVoting and the enforcement switches)", F.LAUNCH_NEVER.every((f) => !F.isEnabled(f, st(S))) && fl.confessionsVoting === false);
  const other = await flagsOf(O);
  check("…another student: nothing changes", [...F.LAUNCH_V2].every((f) => other[f] === false));

  console.log("-- force-disable wins");
  F.applyAdminAccess("resumeWriter", String(S), false);
  check("an admin's 'off' for the account beats the switch", F.isEnabled("resumeWriter", st(S)) === false && F.isEnabled("resumeV2", st(S)) === true);
  F.applyAdminAccess("resumeWriter", String(S), null);
  process.env[env("confessionPolls")] = "off";
  check("the Railway kill switch beats the switch", F.isEnabled("confessionPolls", st(S)) === false && F.flagState("confessionPolls", st(S)).source === "kill");
  delete process.env[env("confessionPolls")];
  check("…removed: on again through the switch", F.isEnabled("confessionPolls", st(S)) === true);

  console.log("-- launchLinks");
  F.applyAdminAccess("launchLinks", String(S), true);
  check("launchLinks on: resumePublicPage and confessionShare on", F.isEnabled("resumePublicPage", st(S)) && F.isEnabled("confessionShare", st(S)));
  F.applyAdminAccess("launchLinks", String(S), null);
  F.applyAdminAccess("launchV2", String(S), null);
  check("both removed: back to today's app", [...F.LAUNCH_V2, ...F.LAUNCH_LINKS].every((f) => !F.isEnabled(f, st(S))));

  console.log("-- for every student (admin role default, opt-in)");
  F.setAccountRoles([[String(E), "employee"]]);
  F.applyDefault("launchV2", "student", true);
  check("an admin turns it on for all students: both students get every launchV2 flag", [S, O].every((id) => F.LAUNCH_V2.every((f) => F.isEnabled(f, st(id)))));
  check("…not an employer", !F.isEnabled("launchV2", { id: String(E), role: "employee" }) && !F.isEnabled("resumeV2", { id: String(E), role: "employee" }));
  F.applyAdminAccess("growthV2", String(O), false);
  check("…a student forced off one flag keeps it off", !F.isEnabled("growthV2", st(O)) && F.isEnabled("growthV2", st(S)));
  F.applyAdminAccess("growthV2", String(O), null);
  F.applyDefault("launchV2", "student", null);
  check("…the row removed: off again (no row = off for the switch)", !F.isEnabled("launchV2", st(S)) && !F.isEnabled("resumeV2", st(S)));
  process.env.FLAG_LAUNCH_V2 = "on";
  check("Railway FLAG_LAUNCH_V2=on also works (everyone)", F.isEnabled("resumeV2", st(S)) && F.isEnabled("resumeV2", st(O)));
  delete process.env.FLAG_LAUNCH_V2;

  console.log("-- confession safety default");
  reqS("./services/safetySettings")._reset();
  check("the built-in mode is observe (an admin switches to enforce after 3 days of review)", (await reqS("./services/safetySettings").get()).mode === "observe");
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
