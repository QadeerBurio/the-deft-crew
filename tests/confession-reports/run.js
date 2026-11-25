// Confession reports, mute, rules, strikes and the safety e-mail links (upgrade/p4-1-safety, plan P4-1 / P4-1b), on
// in-memory data with a fake AI client:
//   - flag off: every new route answers 404 (as if it didn't exist)
//   - report: a reason from the list; one per student per item; can't report your own; evidence must be words in the
//     post; the author's id never in a reply
//   - with evidence: hidden at once, re-checked: confirmed → removed + a strike ("action taken"); not confirmed →
//     back to live, the report rejected, a false-report mark ("no rule broken"); re-check unavailable → stays hidden
//   - without evidence: hidden at the threshold (3 unique students, admin setting)
//   - strike ladder: 1 → 24 h ban, 2 → 7 days, 3 → account suspended + safety e-mail with blacklist / restore links
//   - 3 false reports in 30 days → reporting paused (403 REPORTING_PAUSED)
//   - self-harm risk report: item stays, safety e-mail (no action links)
//   - comments: the same report flow on a confession comment
//   - mute / unmute an author; rules accepted once; safety/me
//   - e-mail links: GET shows a page and changes nothing; POST blacklists (banned + e-mail / phone blocked from signup)
//     or restores; each works once; expired / unknown links refused; every use in AdminActionLog
//   node tests/confession-reports/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionSafety.routes"], ["/api/social", "./routes/social.routes"], ["/api/safety", "./routes/safetyActions.routes"], ["/api/auth", "./routes/auth.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "SafetyAction", "Blocklist", "AdminActionLog", "OtpCode"],
});
const { call, check, oid, user, token, fake, coll, reqS, rows } = h;
const flags = reqS("./config/featureFlags");
const CC = reqS("./services/confessionCheck");
const alerts = reqS("./services/safetyAlerts");
process.env.SAFETY_ALERT_EMAILS = "safety@test.local";
const mails = []; alerts._setSendMailForTests(async (m) => { mails.push(m); return { ok: true }; });
let aiDown = false;
CC._setClientForTests({
  moderations: { create: async ({ input }) => { if (aiDown) throw new Error("down"); const t = input.map((x) => x.text || "").join(" "); return { results: [{ categories: { "harassment/threatening": /kill/.test(t), sexual: false } }] }; } },
  chat: { completions: { create: async ({ messages }) => { if (aiDown) throw new Error("down"); const t = messages[1].content; return { choices: [{ message: { content: JSON.stringify({ religion: false, politics: /election/.test(t), ethnic_or_sectarian: false, sexual_or_vulgar: false, threat: /kill/.test(t), quote: "" }) } }] }; } } },
});

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const S = {}; const T = {};
const mk = (k, name, extra = {}) => { S[k] = oid(); T[k] = token(S[k], "student"); return user(S[k], "student", name, { university: U, ...extra }); };
fake.seed(coll("User"), [mk("author", "Anam Author", { phone: "03007654321" }), mk("r1", "Rimsha One"), mk("r2", "Raza Two"), mk("r3", "Rida Three"), mk("off", "Fahad Flagoff"), mk("liar", "Laiba Liar"), mk("threatener", "Tariq Threat")]);
for (const k of ["author", "r1", "r2", "r3", "liar"]) flags.applyAdminAccess("confessionSafety", String(S[k]), true);
const at = (m) => new Date(Date.now() - m * 60000);
const C = {};
const conf = (k, text, extra = {}) => { C[k] = oid(); return { _id: C[k], authorId: S.author, text, university: U, visibility: "public", likes: 0, likedBy: [], comments: [], createdAt: at(30), ...extra }; };
const cmt = oid();
fake.seed(coll("Confession"), [
  conf("threat", "i will kill the next person who parks there", { authorId: S.threatener }),
  conf("s1", "election season is here"),
  conf("ok", "the library smells like old dreams"),
  conf("threshold", "the 8am class should be illegal"),
  conf("s2", "election talk again lol"), conf("s3", "another election post"),
  conf("sh", "i feel like giving up"),
  conf("down", "the bus is late, kill me"),
  conf("withComment", "post with a comment", { comments: [{ _id: cmt, user: S.r3, text: "i will kill you lol", createdAt: at(5) }] }),
  conf("f1", "fine post one"), conf("f2", "fine post two"), conf("f3", "fine post three"), conf("f4", "fine post four"),
  conf("mute", "mute me maybe"),
]);
const Crow = (k) => fake.STORE.get(coll("Confession")).find((c) => String(c._id) === String(C[k]));
const urow = (k) => fake.STORE.get(coll("User")).find((u) => String(u._id) === String(S[k]));
const rep = (who, k, body) => call("POST", `/api/social/confessions/${C[k]}/report`, { tok: T[who], body });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = h.start();
  // owner (r9 launch): the built-in default is now observe; this suite tests enforce, so it sets it, as an admin would
  await reqS("./services/safetySettings").save({ mode: "enforce" });

  console.log("-- flag off");
  for (const [m, p] of [["POST", `/api/social/confessions/${C.ok}/report`], ["POST", `/api/social/confessions/${C.ok}/mute-author`], ["POST", "/api/social/confessions/rules/accept"], ["GET", "/api/social/confessions/safety/me"]]) {
    const r = await call(m, p, { tok: T.off, body: { reason: "Spam" } });
    check(`flag off: ${m} ${p.replace(/[0-9a-f]{24}/, ":id")} → 404`, r.status === 404, `${r.status}`);
  }
  let r = await call("POST", `/api/social/confessions/${C.ok}/report`, { body: { reason: "Spam" } });
  check("guest → 404", r.status === 404);

  console.log("-- validation");
  r = await rep("r1", "ok", { reason: "Because" });
  check("unknown reason → 400 BAD_REASON", r.status === 400 && r.json?.code === "BAD_REASON");
  r = await rep("author", "ok", { reason: "Spam" });
  check("reporting your own post → 400 OWN_POST", r.status === 400 && r.json?.code === "OWN_POST");
  r = await rep("r1", "ok", { reason: "Harassment", evidence: "words not in it" });
  check("evidence not in the post → 400 EVIDENCE_NOT_FOUND", r.status === 400 && r.json?.code === "EVIDENCE_NOT_FOUND");

  console.log("-- a confirmed threat → removed, account suspended at once (severe)");
  mails.length = 0;
  r = await rep("r1", "threat", { reason: "Violence", evidence: "i will kill the next person" });
  check("report with evidence of a threat → 201 action_taken", r.status === 201 && r.json?.outcome === "action_taken", r.text);
  check("…the confession is removed", Crow("threat").status === "removed");
  check("…the reply never carries the author's id", !r.text.includes(String(S.threatener)));
  const rp = rows("Report", (x) => String(x.contentId) === String(C.threat))[0];
  check("…Report stored: Confession, evidence, reportedUserId = author, resolved (user_suspended), recheck confirmed", rp && rp.contentType === "Confession" && rp.evidenceQuote === "i will kill the next person" && String(rp.reportedUserId) === String(S.threatener) && rp.status === "resolved" && rp.actionTaken === "user_suspended" && rp.recheck?.confirmed === true);
  check("…severe: the author is suspended at once (1 strike)", urow("threatener").accountStatus === "suspended" && (urow("threatener").confessionStrikes || []).length === 1);
  await tick(50);
  check("…safety e-mail (severe) with action links", mails.some((m) => /severe/.test(m.subject) && /\/api\/safety\/action\//.test(m.html)));

  console.log("-- the ladder: strike 1, 2, 3");
  r = await rep("r1", "s1", { reason: "Other", evidence: "election season" });
  check("1st confirmed (not severe) → action_taken, removed", r.json?.outcome === "action_taken" && Crow("s1").status === "removed", r.text);
  const a = urow("author");
  check("…author: 1 strike, a ~24 h confession ban", (a.confessionStrikes || []).length === 1 && Math.abs(new Date(a.confessionBanUntil) - Date.now() - 864e5) < 60e3);
  r = await rep("r1", "threat", { reason: "Violence" });
  check("the removed post can't be reported again (404)", r.status === 404);
  r = await rep("r2", "ok", { reason: "Spam" });
  r = await rep("r2", "ok", { reason: "Spam" });
  check("one report per student per item → 409 ALREADY_REPORTED", r.status === 409 && r.json?.code === "ALREADY_REPORTED");

  console.log("-- strikes 2 and 3");
  r = await rep("r1", "s2", { reason: "Other", evidence: "election talk" });
  check("2nd confirmed report → action_taken", r.json?.outcome === "action_taken", r.text);
  check("…2 strikes, a ~7-day ban", (urow("author").confessionStrikes || []).length === 2 && Math.abs(new Date(urow("author").confessionBanUntil) - Date.now() - 7 * 864e5) < 60e3);
  mails.length = 0;
  r = await rep("r1", "s3", { reason: "Other", evidence: "election post" });
  check("3rd confirmed report → action_taken", r.json?.outcome === "action_taken", r.text);
  check("…account suspended, long confession ban", urow("author").accountStatus === "suspended" && new Date(urow("author").confessionBanUntil) > new Date(Date.now() + 300 * 864e5));
  await tick(50);
  const susp = mails.find((m) => /suspension/.test(m.subject));
  check("…safety e-mail with blacklist and restore links, an anonymous author reference", susp && /\/api\/safety\/action\//.test(susp.html) && /author-[0-9a-f]{10}/.test(susp.html) && !/Anam/.test(susp.html), JSON.stringify(mails.map((m) => m.subject)));

  console.log("-- the e-mail links");
  const links = [...susp.html.matchAll(/href="([^"]+\/api\/safety\/action\/([^"]+))"/g)].map((m) => m[2]);
  const [blk, rst] = links;
  r = await call("GET", `/api/safety/action/${rst}`);
  check("GET a link: a page with a button, nothing changed", r.status === 200 && /<form method="post">/.test(r.text) && urow("author").accountStatus === "suspended");
  r = await call("POST", `/api/safety/action/${rst}`);
  check("POST restore → active, strikes and bans cleared", r.status === 200 && urow("author").accountStatus === "active" && !(urow("author").confessionStrikes || []).length && !urow("author").confessionBanUntil);
  r = await call("POST", `/api/safety/action/${rst}`);
  check("…the same link again → 410 already used", r.status === 410 && /already used/.test(r.text));
  r = await call("POST", `/api/safety/action/${blk}`);
  check("POST blacklist → banned", r.status === 200 && urow("author").accountStatus === "banned");
  const bl = rows("Blocklist");
  check("…e-mail and phone blocked as hashes only (no plain e-mail / phone stored)", bl.length === 2 && !JSON.stringify(bl).includes("@") && !JSON.stringify(bl).includes("7654321"));
  r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "AnamAuthor@test.local", password: "pass-1234", fullName: "New Anam", phone: "0300-1111111" } });
  check("signup with the blocked e-mail → 403 SIGNUP_BLOCKED", r.status === 403 && r.json?.code === "SIGNUP_BLOCKED", r.text);
  r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "fresh@test.local", password: "pass-1234", fullName: "Fresh Person", phone: "+92 300 7654321" } });
  check("signup with the blocked phone (other format) → 403", r.status === 403 && r.json?.code === "SIGNUP_BLOCKED", r.text);
  const logs = rows("AdminActionLog", (l) => /^safety\.(restore|blacklist)$/.test(l.action));
  check("…both clicks in AdminActionLog (the e-mail-link admin id, a reason)", logs.length === 2 && logs.every((l) => String(l.admin) === "000000000000000000000e11" && /safety e-mail link/.test(l.reason)));
  r = await call("GET", "/api/safety/action/not-a-real-token-at-all-xyz");
  check("unknown link → 410", r.status === 410);
  const SA = reqS("./models/SafetyAction"); const tok2 = "expiredtokenexpiredtoken123";
  await SA.create({ tokenHash: alerts.hashToken(tok2), action: "restore", user: S.author, expiresAt: new Date(Date.now() - 1000) });
  r = await call("POST", `/api/safety/action/${tok2}`);
  check("expired link → 410, nothing changed", r.status === 410 && urow("author").accountStatus === "banned");
  urow("author").accountStatus = "active"; // for the rest

  console.log("-- not confirmed, threshold, re-check down");
  r = await rep("liar", "f1", { reason: "Harassment", evidence: "fine post" });
  check("evidence not confirmed → no_rule_broken, back to live, report rejected + falseReport", r.json?.outcome === "no_rule_broken" && Crow("f1").status === "live" && rows("Report", (x) => String(x.contentId) === String(C.f1))[0]?.falseReport === true, r.text);
  await rep("liar", "f2", { reason: "Harassment", evidence: "fine post" });
  await rep("liar", "f3", { reason: "Harassment", evidence: "fine post" });
  r = await rep("liar", "f4", { reason: "Harassment" });
  check("3 false reports in 30 days → 403 REPORTING_PAUSED", r.status === 403 && r.json?.code === "REPORTING_PAUSED", r.text);
  for (const k of ["r1", "r2"]) { r = await rep(k, "threshold", { reason: "Spam" }); check(`no evidence, ${k}: received, still live`, r.json?.outcome === "received" && !Crow("threshold").status); }
  r = await rep("r3", "threshold", { reason: "Spam" });
  check("3rd unique report (threshold 3) → hidden", r.json?.outcome === "under_review" && Crow("threshold").status === "hidden" && Crow("threshold").reportCount === 3, r.text);
  aiDown = true;
  r = await rep("r1", "down", { reason: "Violence", evidence: "kill me" });
  check("re-check can't run → stays hidden, report under_review", r.json?.outcome === "under_review" && Crow("down").status === "hidden" && rows("Report", (x) => String(x.contentId) === String(C.down))[0]?.status === "under_review", r.text);
  aiDown = false;

  console.log("-- self-harm, comments, mute, rules");
  mails.length = 0;
  r = await rep("r2", "sh", { reason: "Self Harm Risk" });
  await tick(50);
  check("self-harm risk report → under_review, the post stays, safety e-mail without action links", r.json?.outcome === "under_review" && !Crow("sh").status && mails.some((m) => /self harm/.test(m.subject) && !/\/api\/safety\/action\//.test(m.html)));
  r = await call("POST", `/api/social/confessions/comment/${C.withComment}/${cmt}/report`, { tok: T.r1, body: { reason: "Violence", evidence: "i will kill you" } });
  check("comment report with evidence → action_taken, the comment removed", r.json?.outcome === "action_taken" && Crow("withComment").comments[0].status === "removed", r.text);
  check("…the commenter gets the strike", (urow("r3").confessionStrikes || []).length === 1);
  r = await call("POST", `/api/social/confessions/${C.mute}/mute-author`, { tok: T.r1 });
  check("mute → 200, stored, the reply doesn't say who", r.status === 200 && r.json?.muted === true && (urow("r1").mutedConfessionAuthors || []).map(String).includes(String(S.author)) && !r.text.includes(String(S.author)));
  let feed = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.r1 });
  check("…that author's posts are gone from my feed", !(feed.json || []).some((c) => c.text === "mute me maybe"));
  r = await call("DELETE", `/api/social/confessions/${C.mute}/mute-author`, { tok: T.r1 });
  feed = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.r1 });
  check("unmute → back", r.status === 200 && (feed.json || []).some((c) => c.text === "mute me maybe"));
  r = await call("POST", `/api/social/confessions/${C.mute}/mute-author`, { tok: T.author });
  check("muting yourself → 400", r.status === 400);
  r = await call("GET", "/api/social/confessions/safety/me", { tok: T.r2 });
  check("safety/me: rules not accepted yet, helplines, reasons incl. Identifies A Person", r.status === 200 && r.json.rulesAcceptedAt === null && r.json.helplines.length > 0 && r.json.reasons.includes("Identifies A Person"), r.text);
  r = await call("POST", "/api/social/confessions/rules/accept", { tok: T.r2 });
  const first = r.json?.acceptedAt;
  r = await call("POST", "/api/social/confessions/rules/accept", { tok: T.r2 });
  check("rules accepted once (a second accept keeps the first date)", !!first && String(r.json?.acceptedAt) === String(first));

  h.finish(server);
})();
