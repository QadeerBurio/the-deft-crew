// Confession safety modes, precheck and image clean-up (upgrade/p4-1-followups), in-memory data, fake AI client:
//   mode "observe": every new post / comment from every student (flag or not) is checked after it's saved and logged;
//     nothing is blocked, held, hidden, struck or banned; reports are stored and re-checked, logged, nothing hidden;
//     self-harm still e-mails admins; the admin "observed" list shows what would have acted, with counts, no author id
//   mode "off": no checks, nothing logged; reports stored only
//   mode "enforce" (default): as signed off (other suites); precheck says edit / ok for the text
//   precheck: flag-gated, never stores or counts a block; ok in observe / off
//   images: a blocked post's image, a confirmed report's removal and an admin removal delete the Cloudinary image (our
//     cloud only, the right public id); another cloud's image is never touched
//   settings: mode saved and logged; a bad mode → 400
//   node tests/confession-observe/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionSafety.routes"], ["/api/social", "./routes/social.routes"], ["/api/admin/safety", "./routes/adminSafety.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "SafetyAction", "SafetyObservation", "AdminActionLog"],
});
const { call, check, oid, user, token, fake, coll, reqS, rows } = h;
const flags = reqS("./config/featureFlags");
const CC = reqS("./services/confessionCheck");
const settings = reqS("./services/safetySettings");
const images = reqS("./services/confessionImages");
const alerts = reqS("./services/safetyAlerts");
const socialPush = reqS("./services/socialPush");
process.env.SAFETY_ALERT_EMAILS = "safety@test.local";
const mails = []; alerts._setSendMailForTests(async (m) => { mails.push(m); return { ok: true }; });
socialPush.enqueue = async () => {};
const destroyed = []; images._setDestroyForTests(async (id) => { destroyed.push(id); return { result: "ok" }; }, "decaxpera");
CC._setClientForTests({
  moderations: { create: async ({ input }) => { const t = input.map((x) => x.text || x.image_url?.url || "").join(" "); return { results: [{ categories: { "self-harm": /\[sh\]/.test(t), sexual: /nsfw/.test(t), "harassment/threatening": /kill/.test(t) } }] }; } },
  chat: { completions: { create: async ({ messages }) => ({ choices: [{ message: { content: JSON.stringify({ religion: false, politics: /election/.test(messages[1].content), ethnic_or_sectarian: false, sexual_or_vulgar: false, threat: /kill/.test(messages[1].content), quote: "" }) } }] }) } },
});

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const S = {}; const T = {};
const mk = (k, name, flag) => { S[k] = oid(); T[k] = token(S[k], "student"); if (flag) flags.applyAdminAccess("confessionSafety", String(S[k]), true); return user(S[k], "student", name, { university: U }); };
fake.seed(coll("User"), [mk("flag", "Fiza Flagged", true), mk("plain", "Pervez Plain", false), mk("rep1", "Rep One", true), mk("rep2", "Rep Two", true), mk("rep3", "Rep Three", true)]);
const adminId = oid(); fake.STORE.get(coll("User")).push(user(adminId, "admin", "Admin One")); const TA = token(adminId, "admin");
const post = (who, text, extra = {}) => call("POST", "/api/social/confessions/create", { tok: T[who], body: { text, visibility: "public", ...extra } });
const conf = (f) => rows("Confession", f);
const obs = (f = () => true) => rows("SafetyObservation", f);
const urow = (k) => fake.STORE.get(coll("User")).find((u) => String(u._id) === String(S[k]));
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const IMG = (name, cloud = "decaxpera") => `https://res.cloudinary.com/${cloud}/image/upload/v1712345678/${name}.jpg`;

(async () => {
  const server = h.start();

  console.log("-- images: the public id");
  check("parse: version and extension dropped", JSON.stringify(images.parse(IMG("abc123"))) === JSON.stringify({ cloud: "decaxpera", publicId: "abc123" }));
  check("parse: transformations dropped, a folder kept (tdc_uploads)", images.parse("https://res.cloudinary.com/decaxpera/image/upload/w_400,c_fill/v12/tdc_uploads/pic.png").publicId === "tdc_uploads/pic");
  check("parse: not Cloudinary → null", images.parse("https://example.com/x.jpg") === null);

  console.log("-- enforce (default)");
  check("default mode is enforce", (await settings.get()).mode === "enforce");
  let r = await call("POST", "/api/social/confessions/precheck", { tok: T.flag, body: { text: "call me 0300-1234567" } });
  check("precheck, enforce: phone → edit with the reason", r.status === 200 && r.json?.verdict === "edit" && r.json.reasons.some((x) => x.code === "personal_info"), r.text);
  r = await call("POST", "/api/social/confessions/precheck", { tok: T.flag, body: { text: "the canteen is fine" } });
  check("precheck: fine text → ok", r.json?.verdict === "ok");
  check("precheck stores nothing and counts no block", !(urow("flag").confessionBlocks || []).length && obs().length === 0);
  r = await call("POST", "/api/social/confessions/precheck", { tok: T.plain, body: { text: "x" } });
  check("precheck without the flag → 404", r.status === 404);
  r = await post("flag", "nsfw stuff here", { image: IMG("blocked1") });
  await tick();
  check("enforce: a post blocked with an image → 422 and the image deleted (public id blocked1)", r.status === 422 && destroyed.includes("blocked1"), JSON.stringify(destroyed));
  r = await post("flag", "kill everyone lol", { image: IMG("other1", "someoneelse") });
  await tick();
  // P4a (owner): an image from another Cloudinary account is refused before anything else (400 BAD_IMAGE)
  check("…an image in another Cloudinary account is refused and never touched", r.status === 400 && r.json?.code === "BAD_IMAGE" && !destroyed.includes("other1"), `${r.status} ${JSON.stringify(destroyed)}`);

  console.log("-- observe");
  await settings.save({ mode: "observe" }, null);
  mails.length = 0;
  const blocksBefore = (urow("flag").confessionBlocks || []).length; const strikesBefore = (urow("flag").confessionStrikes || []).length; const banBefore = urow("flag").confessionBanUntil || null;
  r = await post("flag", "call me 0300-1234567 please");
  check("observe, flagged student: a phone number posts (201, live)", r.status === 201 && !r.json?.held, r.text);
  r = await post("plain", "who will win the election");
  check("observe, a student without the flag: posts as always (201)", r.status === 201);
  r = await post("plain", "a fine post about chai");
  r = await post("plain", "i want to give up [sh]");
  check("observe: self-harm → still posts (201, not held)", r.status === 201 && !r.json?.held);
  await tick(150);
  const byText = (t) => obs((o) => (o.text || "").includes(t))[0];
  check("…logged: phone → would have blocked (personal_info)", byText("0300-1234567")?.wouldHave === "block" && byText("0300-1234567").reasons.some((x) => x.code === "personal_info"));
  check("…logged: politics from a student without the flag → would have blocked", byText("election")?.wouldHave === "block");
  check("…logged: a fine post → none", byText("chai")?.wouldHave === "none");
  check("…logged: self-harm → support, and the safety e-mail went (welfare)", byText("give up")?.wouldHave === "support" && mails.some((m) => /self harm/.test(m.subject)));
  check("…every observed post stayed live", conf((c) => /0300-1234567|election|give up/.test(c.text)).every((c) => !c.status || c.status === "live"));
  check("…no new strike, ban or block counted in observe", (urow("flag").confessionStrikes || []).length === strikesBefore && (urow("flag").confessionBanUntil || null) === banBefore && (urow("flag").confessionBlocks || []).length === blocksBefore);
  const target = conf((c) => /election/.test(c.text))[0];
  r = await call("POST", `/api/social/confessions/comment/${target._id}`, { tok: T.rep1, body: { text: "i will kill you" } });
  await tick(150);
  check("observe: a threatening comment posts (200) and is logged (would have blocked)", r.status === 200 && !r.json?.held && obs((o) => o.kind === "comment" && o.wouldHave === "block").length === 1);
  r = await call("POST", "/api/social/confessions/precheck", { tok: T.flag, body: { text: "call me 0300-1234567" } });
  check("observe: precheck says ok (nothing blocks)", r.json?.verdict === "ok" && r.json.mode === "observe");
  r = await call("POST", `/api/social/confessions/${target._id}/report`, { tok: T.rep1, body: { reason: "Hate Speech", evidence: "who will win the election" } });
  await tick(150);
  check("observe: a report with confirmed evidence → received, the post stays live", r.status === 201 && r.json?.outcome === "received" && (!conf((c) => String(c._id) === String(target._id))[0].status || conf((c) => String(c._id) === String(target._id))[0].status === "live"), r.text);
  check("…logged: would have removed", obs((o) => o.kind === "report" && o.wouldHave === "remove").length === 1);
  check("…no strike for the author", !(urow("plain").confessionStrikes || []).length);
  const chai = conf((c) => /chai/.test(c.text))[0];
  for (const k of ["rep1", "rep2", "rep3"]) await call("POST", `/api/social/confessions/${chai._id}/report`, { tok: T[k], body: { reason: "Spam" } });
  await tick(150);
  check("observe: 3 reports → still live, logged 'would have hidden'", (!conf((c) => String(c._id) === String(chai._id))[0].status) && obs((o) => o.kind === "report" && o.wouldHave === "hide").length >= 1);

  r = await call("GET", "/api/admin/safety/observed?days=7", { tok: TA });
  const d = r.json?.data || {};
  check("admin observed: counts (checked, would have acted, by outcome, by reason)", r.status === 200 && d.checked >= 6 && d.wouldHaveActed >= 4 && d.byOutcome.block >= 2 && d.byReason.personal_info >= 1 && d.byReason.politics >= 1, JSON.stringify({ ...d, items: undefined }));
  check("…items only where it would have acted, with anonymous authors, no account ids", d.items.every((i) => i.wouldHave !== "none" && /^author-[0-9a-f]{10}$/.test(i.author || "author-0000000000")) && !Object.values(S).some((id) => r.text.includes(String(id))), r.text.slice(0, 300));

  console.log("-- off");
  await settings.save({ mode: "off" }, null);
  const before = obs().length;
  r = await post("flag", "call me 0300-7654321");
  await tick(100);
  check("off: a flagged student's phone post goes through, nothing logged", r.status === 201 && obs().length === before);
  r = await call("POST", "/api/social/confessions/precheck", { tok: T.flag, body: { text: "call 0300-1111111" } });
  check("off: precheck ok", r.json?.verdict === "ok" && r.json.mode === "off");

  console.log("-- settings and removals (enforce)");
  r = await call("PUT", "/api/admin/safety/settings", { tok: TA, body: { mode: "nonsense" } });
  check("bad mode → 400 BAD_MODE", r.status === 400 && r.json?.error?.code === "BAD_MODE");
  r = await call("PUT", "/api/admin/safety/settings", { tok: TA, body: { mode: "enforce", reason: "tuned" } });
  check("mode saved", r.status === 200 && r.json.data.mode === "enforce");
  check("…logged with before / after mode", rows("AdminActionLog", (l) => l.action === "safety.settings.update").some((l) => l.before?.mode === "off" && l.after?.mode === "enforce"));
  const withImg = oid();
  fake.STORE.get(coll("Confession")).push({ _id: withImg, authorId: S.plain, text: "i will kill the guy who took my seat", image: IMG("reported1"), university: U, visibility: "public", comments: [], likedBy: [], createdAt: new Date() });
  r = await call("POST", `/api/social/confessions/${withImg}/report`, { tok: T.rep2, body: { reason: "Violence", evidence: "i will kill the guy" } });
  await tick();
  check("enforce: a confirmed report removes it and deletes its image", r.json?.outcome === "action_taken" && destroyed.includes("reported1"), r.text);
  const held = oid();
  fake.STORE.get(coll("Confession")).push({ _id: held, authorId: S.plain, text: "held", image: IMG("held1"), status: "pending", university: U, visibility: "public", comments: [], likedBy: [], createdAt: new Date() });
  r = await call("POST", `/api/admin/safety/confession/${held}/resolve`, { tok: TA, body: { action: "remove", note: "no" } });
  await tick();
  check("admin removes a held confession → its image deleted", r.status === 200 && destroyed.includes("held1"));

  h.finish(server);
})();
