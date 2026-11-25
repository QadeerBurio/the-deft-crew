// services/engagement/goals.js — P5c.
//   goals (flag onboardingGoals): the student picks 1-2 goals after signing up; Home's missions then show the cards
//   for those goals first, and "next" comes from them (the response keeps its shape: only the order changes).
//   next action (flag homeNextAction): one card at a time at the top of Home, the first that applies, in the plan's
//   order: finish your resume (under 80) · claim a deal (never claimed) · today's drop (not answered yet) · invite a
//   friend (none yet). The ambassador invite keeps its own moment (crew/AmbassadorInviteHost), so it isn't repeated.
const missions = require("./missions");

const GOALS = {
  save_money: ["discounts", "traveling"],
  internship: ["jobs", "resume", "scholarship"],
  meet_people: ["social", "events", "skillshare"],
  resume: ["resume", "jobs"],
};
const GOAL_IDS = Object.keys(GOALS);

/** 1-2 known goals, no repeats; anything else (an unknown goal, a repeat, 0 or 3+) → null */
function cleanGoals(list) {
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.map((g) => String(g || "")))].filter((g) => GOAL_IDS.includes(g));
  return out.length >= 1 && out.length <= 2 && out.length === list.length ? out : null;
}

/** the features that match the goals, in the goals' order */
const featuresFor = (goals) => [...new Set((goals || []).flatMap((g) => GOALS[g] || []))];

/** mission cards with the goals' features first (otherwise the same order) */
function orderCards(cards, goals) {
  const first = featuresFor(goals);
  if (!first.length) return cards;
  const rank = (c) => { const i = first.indexOf(c.feature); return i < 0 ? first.length + missions.FEATURES.indexOf(c.feature) : i; };
  return [...cards].sort((a, b) => rank(a) - rank(b));
}

/** the next card: the first unsorted, not snoozed goal feature; otherwise the usual rule */
function nextCardFor(profile, goals) {
  const usual = missions.nextCard(profile);
  const first = featuresFor(goals);
  if (!first.length || !profile) return usual;
  const now = Date.now();
  const snoozed = new Set((profile.snoozes || []).filter((s) => s.until && new Date(s.until).getTime() > now).map((s) => s.feature));
  return first.find((f) => !profile.sorted?.[f] && !snoozed.has(f)) || usual;
}

/**
 * The next best action, from facts the server already has (nothing invented):
 *   { resumePercent: number|null, claimedEver: boolean, dropOpenNotAnswered: boolean, referralCount: number }
 */
function nextAction(facts) {
  const f = facts || {};
  if (typeof f.resumePercent === "number" && f.resumePercent < 80) {
    return { kind: "finish_resume", mood: "sorted", line: `your resume is ${Math.max(0, Math.round(f.resumePercent))}% done. finish it.`, cta: { label: "finish it", route: "Resume", params: {} } };
  }
  if (!f.claimedEver) return { kind: "claim_deal", mood: "broke", line: "claim your first student deal.", cta: { label: "see deals", route: "Brands", params: {} } };
  // the drop's card is on Home itself: the action points there
  if (f.dropOpenNotAnswered) return { kind: "daily_drop", mood: "excited", line: "today's drop is waiting below.", cta: { label: "ok", route: "Home", params: {} } };
  if ((f.referralCount || 0) === 0) return { kind: "invite_friend", mood: "cheeky", line: "bring a friend to tdc.", cta: { label: "invite", route: "Points", params: {} } };
  return null;
}

module.exports = { GOALS, GOAL_IDS, cleanGoals, featuresFor, orderCards, nextCardFor, nextAction };
