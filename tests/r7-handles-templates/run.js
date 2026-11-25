// Owner (25 Nov 2026), on in-memory data with the real routes:
//   confessionHandles (its own flag, separate from confessionsV2): off → everyone "anon." (config disabled, no handle
//     made); on → handles. Admin blocks a single word later (Safety settings → blockedHandleWords, no app update): new
//     handles never use it; a student whose handle has it gets a new one on their next post; their earlier posts show
//     "anon." in the feed; other handles unaffected; only plain words are kept
//   resume templates: GET /api/resume/templates/hidden (resumeV2 + resumeTemplatesV2; else 404) → the hidden ids;
//     admin GET / PUT /api/admin/resume-settings (features.manage) hides single templates (known ids only, logged)
//   node tests/r7-handles-templates/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/confessionsV2.routes"], ["/api/social", "./routes/social.routes"], ["/api/admin/safety", "./routes/adminSafety.routes"], ["/api/resume", "./routes/resumeFinish.routes"], ["/api/admin/resume-settings", "./routes/adminResumeSettings.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "AdminActionLog", "ResumeSettings", "Resume"],
});
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;
const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const ids = { A: oid(), B: oid(), ADM: oid() };
fake.seed(coll("User"), [user(ids.A, "student", "Ayesha Author", { university: U }), user(ids.B, "student", "Bilal Reader", { university: U }), user(ids.ADM, "admin", "Ada Admin")]);
const T = { A: token(ids.A, "student"), B: token(ids.B, "student"), ADM: token(ids.ADM, "admin") };
const create = (tok, body) => call("POST", "/api/social/confessions/create", { tok, body });
const handleOf = (id) => rows("User", (u) => same(u._id, id))[0]?.confessionHandle;
const feed = async (tok) => { const r = await call("GET", "/api/social/confessions/feed?scope=all&sort=new", { tok }); return Array.isArray(r.json) ? r.json : []; };
const settle = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  const server = h.start();
  process.env.FLAG_CONFESSIONS_V2 = `ids:${ids.A},${ids.B}`;
  delete process.env.FLAG_CONFESSION_HANDLES;

  // ── handles ──
  let r = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
  check("confessionsV2 on, confessionHandles off: handles disabled", r.json?.handle?.enabled === false && r.json.handle.handle === null);
  r = await create(T.A, { text: "as my handle please", postAs: "handle" });
  check("…'as @handle' still posts anon., no handle made", r.status === 201 && !r.json.confession.handle && !handleOf(ids.A));

  process.env.FLAG_CONFESSION_HANDLES = `ids:${ids.A},${ids.B}`;
  r = await create(T.A, { text: "first as handle", postAs: "handle" });
  const first = handleOf(ids.A);
  check("confessionHandles on: the post carries the student's handle", /^[a-z]+-[a-z]+-\d{3}$/.test(first || "") && r.json.confession.handle === first, JSON.stringify(r.json?.confession));
  await create(T.B, { text: "bilal as handle", postAs: "handle" });
  const bHandle = handleOf(ids.B);
  const [adj, noun] = first.split("-");

  r = await call("PUT", "/api/admin/safety/settings", { tok: T.ADM, body: { blockedHandleWords: [adj.toUpperCase(), "  ", "two words", "x", "ok1"] } });
  check("admin blocks a word: saved lowercase; spaces, 1-letter, digits dropped", r.status === 200 && JSON.stringify(r.json?.data?.blockedHandleWords) === JSON.stringify([adj]), JSON.stringify(r.json?.data?.blockedHandleWords));
  reqS("./services/safetySettings")._reset?.();
  await settle();
  let list = await feed(T.B);
  const old = list.find((c) => c.text === "first as handle");
  check("A's earlier post with the blocked word now shows anon. (no handle, no tick)", old && old.handle === undefined && old.handleVerified === undefined, JSON.stringify(old && { handle: old.handle }));
  const bPost = list.find((c) => c.text === "bilal as handle");
  check("…other handles unaffected" + (bHandle.split("-").includes(adj) ? " (B's shares the word: anon. too)" : ""), bPost && (bHandle.split("-").includes(adj) ? bPost.handle === undefined : bPost.handle === bHandle));
  r = await create(T.A, { text: "second as handle", postAs: "handle" });
  const second = handleOf(ids.A);
  check("A's next post: a new handle without the blocked word", second && second !== first && !second.split("-").includes(adj) && r.json.confession.handle === second, `${first} → ${second}`);
  const svc = reqS("./services/confessionHandles");
  let ok200 = true; for (let i = 0; i < 300; i++) { const c = svc.candidate(); if (svc.clean(c, [adj]) && c.split("-").includes(adj)) { ok200 = false; break; } }
  check("a handle with the blocked word never passes the filter", ok200 && svc.hasBlockedWord(`${adj}-${noun}-123`, [adj]) && !svc.hasBlockedWord(`${adj}-${noun}-123`, []));
  delete process.env.FLAG_CONFESSION_HANDLES;
  list = await feed(T.B);
  r = await call("GET", "/api/social/confessions/v2/config", { tok: T.A });
  check("flag off again: handles disabled in the config", r.json?.handle?.enabled === false);
  check("…and every earlier post shows anon. again (owner: off = everyone anon.)", list.length > 0 && list.every((c) => c.handle === undefined && c.handleVerified === undefined), JSON.stringify(list.map((c) => c.handle)));
  check("no feed row ever carries the author", list.every((c) => !("authorId" in c)));

  // ── templates ──
  r = await call("GET", "/api/resume/templates/hidden", { tok: T.A });
  check("hidden templates, flags off: 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${ids.A}`; process.env.FLAG_RESUME_TEMPLATES_V2 = `ids:${ids.A}`;
  r = await call("GET", "/api/resume/templates/hidden", { tok: T.A });
  check("flags on, nothing hidden: []", r.status === 200 && JSON.stringify(r.json?.data?.hidden) === "[]");
  r = await call("GET", "/api/admin/resume-settings", { tok: T.ADM });
  check("admin: the 15 offered templates (the five + the 10 new), none hidden", r.status === 200 && r.json.data.templates.length === 15 && r.json.data.templates.includes("two_tone") && JSON.stringify(r.json.data.hiddenTemplates) === "[]");
  r = await call("PUT", "/api/admin/resume-settings", { tok: T.ADM, body: { hiddenTemplates: ["two_tone", "made_up"] } });
  check("an unknown template id: 400, nothing saved", r.status === 400 && r.json?.error?.code === "BAD_SETTINGS");
  r = await call("PUT", "/api/admin/resume-settings", { tok: T.ADM, body: { hiddenTemplates: ["two_tone", "two_tone", "scholar"], reason: "spacing" } });
  check("hide two_tone and scholar: saved once each", r.status === 200 && JSON.stringify(r.json.data.hiddenTemplates) === '["two_tone","scholar"]');
  check("…logged in the admin actions log", rows("AdminActionLog").some((x) => x.action === "resume.settings.update"));
  reqS("./services/resumeSettings")._reset();
  r = await call("GET", "/api/resume/templates/hidden", { tok: T.A });
  check("the app gets them at once (no app update)", JSON.stringify(r.json?.data?.hidden) === '["two_tone","scholar"]');
  r = await call("PUT", "/api/admin/resume-settings", { tok: T.A, body: { hiddenTemplates: [] } });
  check("a student can't change them", r.status === 401 || r.status === 403);
  delete process.env.FLAG_CONFESSIONS_V2; delete process.env.FLAG_RESUME_V2; delete process.env.FLAG_RESUME_TEMPLATES_V2;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
