// P5c, on in-memory data with the real engagement routes:
//   onboardingGoals: POST /api/engagement/goals (1-2 known goals, else 400; off → 404); GET /home then puts the goals'
//     mission cards first and picks "next" from them (same shape; off or no goals → exactly the old order)
//   homeNextAction: GET /api/engagement/next-action → one action from real facts, in the plan's order: finish resume
//     (< 80) · claim a deal (never) · today's drop (not answered) · invite a friend (none); nothing left → null; off → 404
//   node tests/engagement-goals/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/engagement", "./routes/engagement.routes"]],
  models: ["EngagementProfile", "Resume", "DailyDrop", "DropReaction"],
});
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;
const { dayKey } = reqS("./utils/karachiTime");
const G = reqS("./services/engagement/goals");

const S = oid(); const D = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Student", { referralCount: 0 }), user(D, "student", "Dua Done", { referralCount: 3 })]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: S, sorted: {}, sortedCount: 0 }, { _id: oid(), user: D, sorted: { discounts: new Date() }, sortedCount: 1 }]);
const T = { S: token(S, "student"), D: token(D, "student") };
const prof = (id) => rows("EngagementProfile", (p) => same(p.user, id))[0];

(async () => {
  const server = h.start();
  delete process.env.FLAG_ONBOARDING_GOALS; delete process.env.FLAG_HOME_NEXT_ACTION;

  // ── goals ──
  let r = await call("POST", "/api/engagement/goals", { tok: T.S, body: { goals: ["internship"] } });
  check("goals, flag off: 404", r.status === 404);
  r = await call("GET", "/api/engagement/home", { tok: T.S });
  const oldOrder = (r.json?.missions?.cards || []).map((c) => c.feature).join();
  check("home, flag off: the old order and no goals field", r.status === 200 && oldOrder === "discounts,resume,jobs,social,events,scholarship,skillshare,traveling" && !("goals" in r.json) && r.json.missions.next === "discounts", oldOrder);

  process.env.FLAG_ONBOARDING_GOALS = `ids:${S},${D}`;
  for (const bad of [[], ["internship", "resume", "save_money"], ["flying"], ["internship", "internship"], "internship", null]) {
    r = await call("POST", "/api/engagement/goals", { tok: T.S, body: { goals: bad } });
    check(`goals ${JSON.stringify(bad)}: 400`, r.status === 400, r.status);
  }
  r = await call("GET", "/api/engagement/home", { tok: T.S });
  check("flag on, no goals yet: the old order, goals []", r.json.missions.cards.map((c) => c.feature).join() === oldOrder && JSON.stringify(r.json.goals) === "[]");
  r = await call("POST", "/api/engagement/goals", { tok: T.S, body: { goals: ["meet_people", "internship"] } });
  check("two goals saved", r.status === 200 && JSON.stringify(prof(S).goals) === '["meet_people","internship"]');
  r = await call("GET", "/api/engagement/home", { tok: T.S });
  const order = r.json.missions.cards.map((c) => c.feature).join();
  check("home: the goals' cards first (social, events, skillshare, jobs, resume, scholarship), then the rest", order === "social,events,skillshare,jobs,resume,scholarship,discounts,traveling", order);
  check("…'next' is the first goal card not done yet; same card shape", r.json.missions.next === "social" && Object.keys(r.json.missions.cards[0]).sort().join() === "feature,lineAfter,lineBefore,mood,params,route,sorted,sortedAt");
  prof(S).sorted = { social: new Date() };
  r = await call("GET", "/api/engagement/home", { tok: T.S });
  check("…social done → next is events", r.json.missions.next === "events");

  // owner (25 Nov 2026): shown once only — { asked: true } when shown; goalsAsked then stays true
  const N2 = oid();
  fake.seed(coll("User"), [user(N2, "student", "Noor New")]);
  fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: N2, sorted: {}, sortedCount: 0 }]);
  process.env.FLAG_ONBOARDING_GOALS = `ids:${S},${D},${N2}`;
  r = await call("GET", "/api/engagement/home", { tok: token(N2, "student") });
  check("never shown: goalsAsked false (the sheet may show)", r.json.goalsAsked === false && JSON.stringify(r.json.goals) === "[]");
  r = await call("POST", "/api/engagement/goals", { tok: token(N2, "student"), body: { asked: true } });
  const askedAt = prof(N2).goalsAskedAt;
  check("shown → { asked: true } records it", r.status === 200 && r.json.asked === true && !!askedAt);
  await call("POST", "/api/engagement/goals", { tok: token(N2, "student"), body: { asked: true } });
  check("…a second time keeps the first time", String(prof(N2).goalsAskedAt) === String(askedAt));
  r = await call("GET", "/api/engagement/home", { tok: token(N2, "student") });
  check("after it was shown (skipped): goalsAsked true, goals still []", r.json.goalsAsked === true && JSON.stringify(r.json.goals) === "[]");
  r = await call("GET", "/api/engagement/home", { tok: T.S });
  check("goals picked: goalsAsked true", r.json.goalsAsked === true);
  const N3 = oid();
  fake.seed(coll("User"), [user(N3, "student", "No Profile Yet")]);
  process.env.FLAG_ONBOARDING_GOALS = `ids:${S},${D},${N2},${N3}`;
  r = await call("POST", "/api/engagement/goals", { tok: token(N3, "student"), body: { asked: true } });
  check("a student without an engagement profile yet: recorded too", r.status === 200 && !!prof(N3)?.goalsAskedAt);

  // ── next action ──
  r = await call("GET", "/api/engagement/next-action", { tok: T.S });
  check("next action, flag off: 404", r.status === 404);
  process.env.FLAG_HOME_NEXT_ACTION = `ids:${S},${D}`;
  fake.seed(coll("Resume"), [{ _id: oid(), user: S, completionPercentage: 55, updatedAt: new Date() }]);
  r = await call("GET", "/api/engagement/next-action", { tok: T.S });
  check("resume 55%: 'your resume is 55% done. finish it.' → Resume", r.json.action?.kind === "finish_resume" && r.json.action.line === "your resume is 55% done. finish it." && r.json.action.cta.route === "Resume", JSON.stringify(r.json));
  rows("Resume", (x) => same(x.user, S))[0].completionPercentage = 90;
  r = await call("GET", "/api/engagement/next-action", { tok: T.S });
  check("resume 90%, never claimed: 'claim your first student deal.' → Brands", r.json.action?.kind === "claim_deal" && r.json.action.cta.route === "Brands");
  prof(S).sorted = { social: new Date(), discounts: new Date() };
  fake.seed(coll("DailyDrop"), [{ _id: oid(), dayKey: dayKey(), status: "live", kind: "brand", title: "today", options: ["a", "b"] }]);
  r = await call("GET", "/api/engagement/next-action", { tok: T.S });
  check("claimed, a live drop not answered: 'today's drop is waiting below.'", r.json.action?.kind === "daily_drop", JSON.stringify(r.json));
  r = await call("GET", "/api/engagement/next-action", { tok: T.D });
  check("D: claimed, the drop not answered either → the drop first", r.json.action?.kind === "daily_drop");
  rows("DailyDrop").forEach((d) => { d.status = "ended"; });
  r = await call("GET", "/api/engagement/next-action", { tok: T.S });
  check("no drop, 0 referrals: 'bring a friend to tdc.' → Points", r.json.action?.kind === "invite_friend" && r.json.action.cta.route === "Points");
  r = await call("GET", "/api/engagement/next-action", { tok: T.D });
  check("D (claimed, 3 referrals, no resume, no drop): nothing to suggest → null (no made-up card)", r.status === 200 && r.json.action === null, JSON.stringify(r.json));

  check("unit: cleanGoals / orderCards / nextAction", JSON.stringify(G.cleanGoals(["resume", "save_money"])) === '["resume","save_money"]' && G.cleanGoals(["resume", "x"]) === null && G.nextAction({ resumePercent: null, claimedEver: true, dropOpenNotAnswered: false, referralCount: 1 }) === null);
  delete process.env.FLAG_ONBOARDING_GOALS; delete process.env.FLAG_HOME_NEXT_ACTION;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
