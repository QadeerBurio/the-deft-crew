// services/pushBudget.js
// Plan N-2 (owner, Phase N): one daily budget across every sender, per student. Flag pushBudgetV1 (per recipient,
// off by default). Off: allow() says yes without counting and every sender keeps exactly its own rules.
// Classes (owner):
//   personal  no cap, no quiet hours: a reply / mention, your own claim / application / ticket / order / visit,
//             chat, a friend joined with your code, your account (system, security, payment, booking)
//   relevant  a shared cap of PUSH_BUDGET_RELEVANT_MAX a day (default 3): a job that matches, a deal near you, a
//             followed post, your badges and tiers; quiet hours 23:00–09:00 Karachi
//   broadcast a shared cap of PUSH_BUDGET_BROADCAST_MAX a day (1 or 2, default 2): new posts / confessions /
//             listings, new events, campus news, announcements, the daily drop, streak and win-back nudges, offers
//             sent to every student; quiet hours 23:00–09:00 Karachi
//   exempt    admin test pushes (the gateway's skipCaps): never counted, as before
// A type not listed below counts as relevant and is logged once per type ("[push-budget] unclassified …") so it can
// be added here. A sender that knows better passes budgetClass (gateway msg, sendToUser data; never sent to phones).
const flags = require("../config/featureFlags");
const karachi = require("../utils/karachiTime"); // read at call time (tests can set the clock)
const { dayKey } = karachi;

const FLAG = "pushBudgetV1";
// N-5: the student's mode and digest (notifSettingsV2) act at the same point, for every sender
const MODES_FLAG = "notifSettingsV2";
const QUIET = { quietStart: 23, quietEnd: 9 };
const CLASSES = ["personal", "relevant", "broadcast", "exempt"];

const PERSONAL = [
  // chat, replies, mentions
  "message", "Message", "chat", "chat_message", "reply", "mention", "comment",
  // your own claim / ticket / order / visit / application, your account
  "redemption", "event", "ticket", "loyalty", "System",
  // a bell row of type Event is only ever your own ticket (services/events/tickets.js); new events are "new_event"
  "Event", "Security", "Welcome", "Payment", "Booking", "Card",
  "Application Status", "Interview", "Job Application", "Exchange", "transactional",
  // a friend joined with your code; the campus digest you turned on (N-5)
  "referral_joined", "campus_digest",
];
const RELEVANT = [
  "job", "new_job", "Job Posting", "Jobs", "Scholarship", "Course", "Offer", "nearby_deal", "exclusive_offer",
  "new_for_you", "follow", "followed_post", "confession_follow",
  // about you, but not something you're waiting for
  "badge_earned", "tier_unlocked", "card_sorted", "fully_sorted", "streak_milestone", "freeze_used", "freeze_reset",
  "Alert", "Reminder",
];
const BROADCAST = [
  "social_post", "social_confession", "skillshare_listing", "daily_drop", "new_offer", "app_update", "Update",
  "Promotion", "Brand", "new_event", "campus_news", "announcement",
  "streak_warning", "streak_warning_one", "streak_broken", "streak_broken_one", "win_back_soft", "win_back_ghost",
  "welcome_back", "confession_tease", "confession_recap", "try_discounts", "try_scholarship", "try_jobs", "try_resume", "try_events",
  "try_social", "try_skillshare", "try_traveling",
];
const TABLE = new Map([...PERSONAL.map((t) => [t, "personal"]), ...RELEVANT.map((t) => [t, "relevant"]), ...BROADCAST.map((t) => [t, "broadcast"])]);

const unclassified = new Set();
/**
 * The class of a push. type: the push type (data.type / gateway type); notificationType: a bell row's own type, which
 * wins when known (a bell push's type is only its sound family: "new_job" covers both "your application" and "a new
 * job posting", "new_offer" both "payment" and "promotion").
 */
function classify(type, notificationType = null) {
  const t = String(type || "").trim();
  if (notificationType && TABLE.has(String(notificationType))) return TABLE.get(String(notificationType));
  if (t && TABLE.has(t)) return TABLE.get(t);
  const key = t || String(notificationType || "") || "(none)";
  if (!unclassified.has(key)) {
    unclassified.add(key);
    console.warn(`[push-budget] unclassified push type '${key.slice(0, 60)}' → relevant (add it to services/pushBudget.js)`);
  }
  return "relevant";
}

const intEnv = (name, def, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};
const caps = () => ({ relevant: intEnv("PUSH_BUDGET_RELEVANT_MAX", 3, 1, 10), broadcast: intEnv("PUSH_BUDGET_BROADCAST_MAX", 2, 1, 2) });

const who = (user) => ({ id: String(user._id || user.id || user), role: user.role || "student" });
const budgetOn = (user) => !!user && flags.isEnabled(FLAG, who(user));
const modesOn = (user) => !!user && flags.isEnabled(MODES_FLAG, who(user));
const configured = () => flags.pilotConfigured(FLAG) || flags.pilotConfigured(MODES_FLAG);
/** Does anything here apply to this student (the budget or the modes)? */
const onFor = (user) => budgetOn(user) || modesOn(user);

/** The student's mode and digest (N-5): { mode: everything | important | quiet, digest } */
async function prefsOf(userId) {
  const p = await require("../models/EngagementProfile").findOne({ user: userId }).select("notifPrefs.mode notifPrefs.digest").lean();
  const mode = ["important", "quiet"].includes(p?.notifPrefs?.mode) ? p.notifPrefs.mode : "everything";
  return { mode, digest: p?.notifPrefs?.digest === true };
}

/**
 * May this push go to this student now? Counts it when it may (relevant / broadcast).
 *   user: { _id, role } (or an id: role student)  cls: a class from classify() or a sender's budgetClass
 *   campusActivity: a per-item campus push (new post / confession / listing): skipped when the digest is on
 * → { ok: true, cls, counted? } | { ok: false, cls, reason: 'mode_quiet' | 'mode_important' | 'digest' |
 *   'quiet_hours' | 'budget_relevant' | 'budget_broadcast' }
 * Both flags off for the student: { ok: true, off: true }, nothing read or counted.
 */
async function allow(user, cls, { now = new Date(), campusActivity = false } = {}) {
  const u = user && typeof user === "object" ? user : { _id: user, role: "student" };
  const b = budgetOn(u);
  const m = modesOn(u);
  if (!b && !m) return { ok: true, off: true };
  const c = CLASSES.includes(cls) ? cls : "relevant";
  if (m && c !== "exempt") {
    const p = await prefsOf(u._id);
    if (p.mode === "quiet" && c !== "personal") return { ok: false, cls: c, reason: "mode_quiet" };
    if (p.mode === "important" && c === "broadcast") return { ok: false, cls: c, reason: "mode_important" };
    if (campusActivity && p.digest) return { ok: false, cls: c, reason: "digest" };
  }
  if (!b) return { ok: true, cls: c };
  if (c === "personal" || c === "exempt") return { ok: true, cls: c };
  if (karachi.isQuietHour(now, QUIET)) return { ok: false, cls: c, reason: "quiet_hours" };
  const PushBudget = require("../models/PushBudget");
  const day = dayKey(now);
  try {
    await PushBudget.updateOne({ user: u._id, dayKey: day }, { $setOnInsert: { relevant: 0, broadcast: 0 } }, { upsert: true });
  } catch (e) {
    if (e?.code !== 11000) throw e; // two pushes at once: the row exists now
  }
  const r = await PushBudget.updateOne({ user: u._id, dayKey: day, [c]: { $lt: caps()[c] } }, { $inc: { [c]: 1 } });
  if ((r.modifiedCount ?? r.nModified ?? 0) > 0) return { ok: true, cls: c, counted: true };
  return { ok: false, cls: c, reason: `budget_${c}` };
}

/** allow() that never throws (a budget error never blocks a push). */
async function allowSafe(user, cls, opts) {
  try {
    return await allow(user, cls, opts);
  } catch (e) {
    console.warn("[push-budget] check failed, sending:", e.message);
    return { ok: true, error: true };
  }
}

module.exports = { FLAG, MODES_FLAG, CLASSES, classify, allow: allowSafe, configured, onFor, budgetOn, modesOn, prefsOf, caps, _test: { TABLE, unclassified, allowRaw: allow } };
