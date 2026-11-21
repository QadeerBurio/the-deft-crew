// Confession pre-post check (upgrade/p4-1-safety, plan P4-1 / P4-1b), on in-memory data with a fake AI client:
//   flag OFF: posting and commenting work exactly as before (no check, no status, push queued)
//   flag ON (confessionSafety, per author):
//     - ok → live, pushed; phone / e-mail / CNIC / link / profanity / admin banned word / a classmate's full name /
//       religion / politics / sexual / threat → 422 NEEDS_EDIT with reasons and an `error` sentence (older apps)
//     - a check that fails or times out → held (pending), never allowed; no OpenAI key → held
//     - self-harm → held, support with helplines, safety e-mail (no action links), no strike
//     - doxxing / threats stopped at the pre-check → safety e-mail with blacklist / restore links, no strike
//     - held posts: no push, no points; the author sees them, nobody else does
//     - 3 blocked attempts in 24 h → a 24 h ban + 1 strike; while banned: 403 CONFESSION_BANNED for posts and comments
//     - comments: same check; a held comment is shown only to its writer; mentions don't name the commenter
//     - per-user limit (RATE_LIMIT_CONFESSION_POST_MAX) only with the flag on
//   node tests/confession-precheck/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/social.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "SafetyAction"],
});
const { call, check, oid, user, token, fake, coll, reqS, rows } = h;
const flags = reqS("./config/featureFlags");
const CC = reqS("./services/confessionCheck");
const settings = reqS("./services/safetySettings");
const socialPush = reqS("./services/socialPush");
process.env.SAFETY_ALERT_EMAILS = "safety@test.local";

// fake OpenAI: markers in the text decide; "[fail]" throws, "[slow]" never answers
const mod = (text) => {
  const t = String(text || "");
  if (/\[fail\]/.test(t)) throw new Error("boom");
  if (/\[slow\]/.test(t)) return new Promise(() => {});
  return { results: [{ flagged: true, categories: { "self-harm": /\[sh\]/.test(t), sexual: /\[sex\]/.test(t), "harassment/threatening": /\[threat\]/.test(t), hate: false, harassment: false, violence: false } }] };
};
const fakeAi = {
  moderations: { create: async ({ input }) => mod(input.map((x) => x.text || "").join(" ")) },
  chat: { completions: { create: async ({ messages }) => {
    const t = messages[1].content;
    if (/\[fail\]/.test(t)) throw new Error("boom");
    return { choices: [{ message: { content: JSON.stringify({ religion: /\[rel\]/.test(t), politics: /\[pol\]/.test(t), ethnic_or_sectarian: false, sexual_or_vulgar: false, threat: false, quote: "" }) } }] };
  } } },
};
CC._setClientForTests(fakeAi);

const mails = []; reqS("./services/safetyAlerts")._setSendMailForTests(async (m) => { mails.push(m); return { ok: true }; });
const pushes = []; socialPush.enqueue = async (kind, x) => { pushes.push({ kind, ...x }); };

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const ids = { A: oid(), B: oid(), O: oid(), Z: oid(), R: oid() };
fake.seed(coll("User"), [
  user(ids.A, "student", "Ayesha Author", { university: U }),
  user(ids.B, "student", "Bilal Siddiqui", { university: U }),
  user(ids.O, "student", "Omar Oldapp", { university: U }),
  user(ids.Z, "student", "Zara Banned", { university: U }),
  user(ids.R, "student", "Rafay Rate", { university: U }),
]);
const T = Object.fromEntries(Object.keys(ids).map((k) => [k, token(ids[k], "student")]));
for (const k of ["A", "Z", "R"]) flags.applyAdminAccess("confessionSafety", String(ids[k]), true);
const post = (tok, text, extra = {}) => call("POST", "/api/social/confessions/create", { tok, body: { text, visibility: "public", ...extra } });
const conf = (f = () => true) => rows("Confession", f);
const userRow = (id) => fake.STORE.get(coll("User")).find((u) => String(u._id) === String(id));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = h.start();

  console.log("-- flag off");
  let r = await post(T.O, "call me 03001234567");
  check("flag off: a phone number posts as before (201)", r.status === 201, r.text);
  check("…no status stored, no held / status in the reply", conf((c) => String(c.authorId) === String(ids.O))[0]?.status === undefined && !("held" in (r.json || {})));
  await tick(); check("…push queued as before", pushes.some((p) => p.kind === "confession" && String(p.authorId) === String(ids.O)));

  console.log("-- flag on: allowed");
  pushes.length = 0;
  r = await post(T.A, "the canteen chai is elite today");
  check("ok → 201, stored live", r.status === 201 && conf((c) => c.text === "the canteen chai is elite today")[0]?.status === "live", r.text);
  await tick(); check("…pushed", pushes.length === 1);

  console.log("-- flag on: needs an edit");
  const cases = [
    ["phone", "call me on 0300-1234567 tonight", "personal_info"],
    ["e-mail", "mail me at someone@example.com", "personal_info"],
    ["CNIC", "my id is 42101-1234567-1 lol", "personal_info"],
    ["link", "see www.example.com for more", "link"],
    ["classmate's full name", "bilal siddiqui from class is so rude", "identifies_person"],
    ["politics", "who are you voting for [pol]", "politics"],
    ["religion", "a [rel] question", "religion"],
    ["sexual", "something [sex]", "sexual"],
    ["threat", "something [threat]", "threat"],
  ];
  for (const [name, text, code] of cases) {
    // a fresh author for each, so the 3-blocks rule doesn't kick in here
    const id = oid(); fake.STORE.get(coll("User")).push(user(id, "student", `Tmp ${name}`, { university: U }));
    flags.applyAdminAccess("confessionSafety", String(id), true);
    r = await post(token(id, "student"), text);
    check(`${name} → 422 NEEDS_EDIT (${code}) with a sentence in error and message`, r.status === 422 && r.json?.code === "NEEDS_EDIT" && r.json.reasons?.some((x) => x.code === code) && typeof r.json.error === "string" && r.json.error === r.json.message, r.text);
    check(`…${name}: nothing saved`, conf((c) => c.text === text).length === 0);
  }
  await settings.save({ bannedWords: ["chamcha"] }, null);
  { const id = oid(); fake.STORE.get(coll("User")).push(user(id, "student", "Tmp Word", { university: U })); flags.applyAdminAccess("confessionSafety", String(id), true);
    r = await post(token(id, "student"), "he is such a Chamcha");
    check("admin banned word → 422 profanity", r.status === 422 && r.json.reasons.some((x) => x.code === "profanity"), r.text); }

  console.log("-- safety e-mails at the pre-check");
  await tick(50);
  const dox = mails.find((m) => /doxxing/.test(m.subject));
  check("doxxing stopped → safety e-mail with blacklist and restore links", dox && /\/api\/safety\/action\//.test(dox.html) && /blacklist this account/.test(dox.html), JSON.stringify(mails.map((m) => m.subject)));
  check("…the e-mail has an anonymous author reference, never the name or e-mail", dox && /author-[0-9a-f]{10}/.test(dox.html) && !/Tmp phone|Tmp CNIC|@test\.local/.test(dox.html));
  check("…no strike for being stopped once", rows("User", (u) => (u.confessionStrikes || []).length > 0).length === 0);

  console.log("-- held");
  pushes.length = 0; mails.length = 0;
  r = await post(T.A, "check service down [fail]");
  check("a check fails → 201 held (pending), never allowed", r.status === 201 && r.json?.held === true && r.json.status === "pending" && conf((c) => /service down/.test(c.text))[0]?.status === "pending", r.text);
  const t0 = Date.now();
  r = await post(T.A, "slow check [slow]");
  check("a check times out (3 s) → held", r.status === 201 && r.json?.held === true && Date.now() - t0 < 6000, r.text);
  r = await post(T.A, "i don't want to be here anymore [sh]");
  check("self-harm → 201 held with support helplines (1166 among them)", r.status === 201 && r.json?.held === true && r.json.support?.helplines?.some((x) => x.number === "1166"), r.text);
  await tick(50);
  check("…held posts: no push", pushes.length === 0);
  const sh = mails.find((m) => /self harm/.test(m.subject));
  check("…self-harm safety e-mail, without blacklist / restore links", sh && !/\/api\/safety\/action\//.test(sh.html));
  check("…no strike for self-harm", !(userRow(ids.A).confessionStrikes || []).length);
  let feed = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.B });
  check("…others don't see held posts", !(feed.json || []).some((c) => /service down|slow check|anymore/.test(c.text)));
  feed = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.A });
  check("…the author sees them with status pending", (feed.json || []).filter((c) => c.status === "pending").length === 3);
  CC._setClientForTests(null); const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  r = await post(T.A, "no key configured");
  check("no OpenAI key → held", r.status === 201 && r.json?.held === true, r.text);
  if (key) process.env.OPENAI_API_KEY = key; CC._setClientForTests(fakeAi);

  console.log("-- 3 blocked attempts in 24 h");
  for (let i = 0; i < 3; i++) r = await post(T.Z, `call 0300-123456${i}`);
  check("3rd blocked attempt → still 422, with bannedUntil", r.status === 422 && !!r.json?.bannedUntil, r.text);
  const z = userRow(ids.Z);
  check("…1 strike and a ~24 h ban", (z.confessionStrikes || []).length === 1 && z.confessionBanUntil && Math.abs(new Date(z.confessionBanUntil) - Date.now() - 864e5) < 60e3);
  r = await post(T.Z, "a totally fine post");
  check("banned: posting → 403 CONFESSION_BANNED with a sentence", r.status === 403 && r.json?.code === "CONFESSION_BANNED" && /can't post/.test(r.json.error), r.text);
  const live = conf((c) => c.status === "live")[0];
  r = await call("POST", `/api/social/confessions/comment/${live._id}`, { tok: T.Z, body: { text: "fine comment" } });
  check("banned: commenting → 403 CONFESSION_BANNED", r.status === 403 && r.json?.code === "CONFESSION_BANNED", r.text);

  console.log("-- comments");
  r = await call("POST", `/api/social/confessions/comment/${live._id}`, { tok: T.A, body: { text: "dm me 03001112223" } });
  check("comment with a phone → 422 NEEDS_EDIT", r.status === 422 && r.json?.code === "NEEDS_EDIT", r.text);
  r = await call("POST", `/api/social/confessions/comment/${live._id}`, { tok: T.A, body: { text: "this comment check fails [fail]" } });
  check("comment, check fails → 200, held, my comment shows to me with status pending", r.status === 200 && r.json?.held === true && r.json.comments.some((c) => c.isMyComment && c.status === "pending"), r.text);
  feed = await call("GET", "/api/social/confessions/feed?scope=all", { tok: T.B });
  check("…others don't see the held comment", !(feed.json || []).some((c) => (c.comments || []).some((x) => /check fails/.test(x.text))));
  r = await call("POST", `/api/social/confessions/comment/${live._id}`, { tok: T.A, body: { text: "nice one @Bilal", mentions: [String(ids.B)] } });
  check("comment ok → 200, live", r.status === 200 && !r.json?.held, r.text);
  const note = rows("SocialNotification", (n) => String(n.recipient || n.user || n.to) === String(ids.B) || /mentioned you in a confession/.test(n.message || n.text || ""));
  check("…the mention doesn't name the commenter (flag on)", note.length > 0 && note.every((n) => !/Ayesha/.test(JSON.stringify(n))) && note.some((n) => /someone mentioned you/.test(JSON.stringify(n))), JSON.stringify(note));
  check("…and its sender is no real account (not the commenter)", note.every((n) => String(n.sender) === "000000000000000000000a00"), JSON.stringify(note.map((n) => n.sender)));
  const before = rows("SocialNotification").length;
  r = await call("POST", `/api/social/confessions/comment/${live._id}`, { tok: T.O, body: { text: "hey @Bilal", mentions: [String(ids.B)] } });
  const fresh = rows("SocialNotification").slice(before);
  check("flag off too: the mention is anonymous (text and sender), for everyone", r.status === 200 && fresh.length === 1 && /^someone mentioned you in a confession/.test(fresh[0].text || fresh[0].message || "") && String(fresh[0].sender) === "000000000000000000000a00" && !/Omar/.test(JSON.stringify(fresh[0])), JSON.stringify(fresh));

  console.log("-- rate limit (flag on only)");
  process.env.RATE_LIMIT_CONFESSION_POST_MAX = "2";
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(T.R, `fine post number ${i}`)).status);
  check("flag on: 2 posts, then 429", codes[0] === 201 && codes[1] === 201 && codes[2] === 429, codes.join(","));
  const oc = [];
  for (let i = 0; i < 3; i++) oc.push((await post(T.O, `old app post ${i}`)).status);
  check("flag off: never limited (as before)", oc.every((c) => c === 201), oc.join(","));
  delete process.env.RATE_LIMIT_CONFESSION_POST_MAX;

  h.finish(server);
})();
