// config/featureFlags.js
// Feature flags and background-job switches, both read from Railway variables: flipping one needs a
// variable change and a restart, never a code change or an app update. No database.
//
// FEATURE FLAGS (per user, for the app and for server code paths)
//   FLAG_<NAME>   e.g. FLAG_META_EVENTS. Rules separated by ";", the flag is on if any rule matches:
//     on | true                     everyone
//     off | false                   nobody
//     25%                           a stable 25% of signed-in users (same users every time, per flag)
//     roles:admin,brand             these roles
//     users:<id>,<id>               these user ids (ids:<id>,<id> is the same rule)
//   e.g. FLAG_META_EVENTS="roles:admin;10%". A missing or unreadable value uses the flag's default.
//   Forgiving about how the value was typed or pasted: quotes (" or ') around the whole value, a rule or an id are
//   dropped; rules may also be on separate lines; ids / roles may be separated by commas, spaces or line breaks,
//   and a line that doesn't start a rule continues the list above it. So two "Copy ids" outputs pasted one under
//   the other ("ids:a,b" newline "ids:c") work. At startup, describeFlags() logs one line per flag: rule types and
//   counts only, never the ids.
//   GET /api/app/flags/me returns the "client" flags for the signed-in user (routes/appFlags.routes.js).
//
// ADMIN ACCESS AND ROLE DEFAULTS (from the admin portal; models/FeatureAccess.js, models/FeatureDefault.js,
// services/featureAccess.js). Flags with a "grant" entry can be forced on or off for one account by an admin. Every
// feature listed in ROLE_DEFAULTS is ON for every account of that role unless an admin turns the role's default off.
// A flag is decided, in order:
//     1. a Railway value that is only "off" (off / false / 0 / no) is the kill switch: off for everyone
//     2. the account's own row (FeatureAccess): enabled true = forced on, enabled false = forced OFF. An admin "off"
//        beats the student default and the Railway rules
//     3. the default for the account's role: ON for the features ROLE_DEFAULTS lists (student, brand, employee), unless
//        a FeatureDefault row turns it off for that role; admins and travelers have none
//     4. the Railway rules (ids, %, roles)
//     5. otherwise off (the flag's built-in default)
//   The role is checked against the account itself, not just the role a caller passes: every non-student account's
//   role is kept in memory too (a missing role is a student), so a route that asks for "student" never turns a
//   default on for an employer, and one that asks for "employee" never does for an admin.
//   All of it lives in memory here (setAdminAccess, setDefaults, setAccountRoles), loaded and refreshed every 30 s
//   by services/featureAccess.js (at once on the server that made a change), so isEnabled() stays synchronous and
//   never reads the database.
//
// BACKGROUND JOBS (whole server)
//   JOB_<NAME>=on|off decides one job. Without it: off if BACKGROUND_JOBS=off, or in staging
//   (APP_ENV=staging, or Railway's own RAILWAY_ENVIRONMENT_NAME=staging); on otherwise.
//   So a staging copy runs no schedulers and sends no pushes unless a job is switched on by name.

const crypto = require("crypto");

const FLAGS = {
  // Meta App Events in the app (still only after the student allows it). META_EVENTS_ENABLED is the
  // older variable, still honoured when FLAG_META_EVENTS isn't set.
  metaEvents: { default: false, client: true, public: true, legacyEnv: "META_EVENTS_ENABLED" },
  // writing DomainEvent records (services/domainEvents.js); off = recordOnce() writes nothing
  domainEvents: { default: true, client: false },
  // AI Resume Studio (routes/careerResume.routes.js, services/resumeStudio/). Off = the old resume
  // routes behave exactly as before. The employer needs it too to see an attached snapshot, e.g.
  // FLAG_RESUME_STUDIO_V2="ids:<test student id>,<test employer id>". Per user only (/api/app/flags/me).
  resumeStudioV2: { default: false, client: true, grant: { roles: ["student","employee"], label: "AI Resume Studio" }, studentDefault: true },
  // Mutual ratings after a completed interview or a verified hire (routes/careerRatings.routes.js,
  // services/career/ratingService.js). Needs it on for the rater and the person rated, e.g.
  // FLAG_CAREER_RATINGS="ids:<employer id>,<student id>". Per user only (/api/app/flags/me).
  careerRatings: { default: false, client: true, grant: { roles: ["student","employee"], label: "Hiring ratings" }, studentDefault: true },
  // Brand loyalty (routes/loyalty.routes.js, services/loyalty.js). A loyalty credit or discount needs it
  // on for BOTH the brand and the student, e.g. FLAG_LOYALTY_V2="ids:<test brand id>,<test student id>".
  // Per user only: listed by /api/app/flags/me, not by the public /api/app/flags.
  loyaltyV2: { default: false, client: true, grant: { roles: ["brand","student"], label: "Loyalty" }, studentDefault: true },
  // Hiring timeline, interviews, offers, verified hires (routes/career.routes.js, services/career/).
  // Needs it on for BOTH the job's employer and the candidate, e.g.
  // FLAG_CAREER_TIMELINE="ids:<employer id>,<student id>". Per user only (/api/app/flags/me).
  careerTimeline: { default: false, client: true, grant: { roles: ["student","employee"], label: "Hiring timeline" }, studentDefault: true },
  // Employer candidate matching: mandatory criteria and skill evidence per application, decision support only
  // (routes/careerMatching.routes.js, services/career/matchingService.js). On for BOTH the job's employer and the
  // candidate, e.g. FLAG_CAREER_MATCHING="ids:<employer id>,<student id>". Per user only (/api/app/flags/me).
  careerMatching: { default: false, client: true, grant: { roles: ["student","employee"], label: "Candidate matching" }, studentDefault: true },
  // Surprise Box: merchant surplus food, pickup only, pay at pickup (routes/surplus.routes.js,
  // services/surplus/). Needs it on for the brand (its listings show only then) and the student, e.g.
  // FLAG_SURPLUS_BOXES="ids:<brand id>,<student id>". Per user only (/api/app/flags/me).
  surplusBoxes: { default: false, client: true, grant: { roles: ["brand","student"], label: "Surprise Box" }, studentDefault: true },
  // First Hire Free: one fee-waived verified hire per verified company (routes/careerTrial.routes.js,
  // services/career/trialService.js). Per employer, e.g. FLAG_EMPLOYER_FIRST_HIRE_FREE="ids:<employer id>".
  // Off: no trial, no billing ledger rows, the hiring timeline unchanged. Per user only (/api/app/flags/me).
  employerFirstHireFree: { default: false, client: true, grant: { roles: ["employee"], label: "First Hire Free" } },

  // ---- upgrade v2 (tdc-upgrade-v2/TDC_UPGRADE_PLAN.md in the app repo). Every one is OFF for everyone by default
  // and is NOT in ROLE_DEFAULTS (that would turn it on for every student). Turned on per account from the admin
  // portal (features tab) or by a Railway rule, e.g. FLAG_GROWTH_V2="ids:<test student id>". Off = today's behaviour.
  // invite links, referral fixes, leaderboard (plan P1)
  growthV2: { default: false, client: true, grant: { roles: ["student"], label: "Invites v2" } },
  // ambassador invitation, intro, in-app application, hub (plan P2)
  ambassadorV2: { default: false, client: true, grant: { roles: ["student"], label: "Ambassador v2" } },
  // resume builder v2: smart start, fresher track, new sections, coach, templates (plan P3)
  resumeV2: { default: false, client: true, grant: { roles: ["student"], label: "Resume v2" } },
  // confessions v2: handles, tags, moods, polls, sort, follow (plan P4-2 to P4-6)
  confessionsV2: { default: false, client: true, grant: { roles: ["student"], label: "Confessions v2" } },
  // confession safety: pre-post check, report, mute author, strikes (plan P4-1, P4-1b). Separate from
  // confessionsV2 so safety can reach every student while the rest of v2 stays off.
  confessionSafety: { default: false, client: true, grant: { roles: ["student"], label: "Confession safety" } },
  // branded share cards (plan P1-5)
  shareCards: { default: false, client: true, grant: { roles: ["student"], label: "Share cards" } },
  // Server only (plan P0-6): refuse sign-in and requests for accounts whose accountStatus is suspended / banned.
  // Off = accountStatus is ignored, exactly as before. Admins are never locked out by it. Switched on by the owner
  // (FLAG_ACCOUNT_STATUS_ENFORCE=on) only after reviewing scripts/count-account-status.js.
  accountStatusEnforce: { default: false, client: false },
  // Server only (SEC-1 stage 2): every socket.io event needs a verified sign-in token; without one it is refused.
  // Off = older apps without a token keep working (logged). Switched on by the owner (FLAG_SOCKET_TOKEN_REQUIRED=on)
  // once most installs send the token.
  socketTokenRequired: { default: false, client: false },
  // CHAT-1: device pushes for chat messages (services/chatPush.js), per recipient; the app shows the "messages" switch.
  // Off = no chat pushes, as since 5 Oct 2026. Not in ROLE_DEFAULTS.
  chatPushV1: { default: false, client: true, grant: { roles: ["student"], label: "Chat pushes" } },
  // Server only (P1 follow-up, owner): referral rewards (referrer +150, new student +100) are paid when the new
  // student confirms their e-mail code, not at signup. Checked for the referrer's account, so a test can use
  // FLAG_REFERRAL_VERIFY_GATE="ids:<test referrer id>"; FLAG_REFERRAL_VERIFY_GATE=on for everyone. Off = paid at
  // signup, as today. Rewards already paid are never touched (the awards are idempotent).
  referralVerifyGate: { default: false, client: false },
  // N-6: push open tracking (services/pushTracking.js), per recipient: every push to the account gets a PushLog
  // row and carries its id; the app reports the tap. Off = no rows, no extra data: pushes exactly as before.
  pushOpenTracking: { default: false, client: true, grant: { roles: ["student"], label: "Push open tracking" } },
  // N-2: one daily push budget across all senders (services/pushBudget.js), per recipient: personal no cap,
  // relevant 3 a day, broadcast 1–2 a day, quiet hours for relevant and broadcast only. Off = every sender keeps its
  // own rules, exactly as before.
  pushBudgetV1: { default: false, client: true, grant: { roles: ["student"], label: "Push budget" } },
  // N-3 (app only): no notification prompt on login; a small sheet asks after a good moment (first deal claimed,
  // confession posted, job applied); Settings shows "turn on" / "turn on in settings". Off = the prompt on login.
  pushAskV2: { default: false, client: true, grant: { roles: ["student"], label: "Push ask v2" } },
  // N-4: one inbox for the bell and social notifications (GET /api/notification/unified, tabs for you / campus /
  // system, one unread count). Off = the two lists as today (the new route answers 404).
  unifiedInbox: { default: false, client: true, grant: { roles: ["student"], label: "One inbox" } },
  // N-5: simpler notification settings: three modes (everything / only important / quiet), a 6 pm campus digest,
  // the switches under "fine-tune". Modes and the digest act on every sender (services/pushBudget.js). Off = the
  // settings screen and pushes as today.
  notifSettingsV2: { default: false, client: true, grant: { roles: ["student"], label: "Notification modes" } },
  // N-7: push copy that names the specific thing, with real numbers only (services/engagement/copy.js fillV2);
  // nothing specific and real to say → no push. Off = today's copy.
  pushCopyV2: { default: false, client: true, grant: { roles: ["student"], label: "Push copy v2" } },
  // Phase A: admin permissions are enforced (middleware/adminAccess.js). Off = shadow mode: a member admin without a
  // permission is still allowed and the "would deny" is logged for review. Server only, Railway FLAG_ADMIN_RBAC_ENFORCE=on.
  adminRbacEnforce: { default: false, client: false },
  // Phase A (A-8): admin sessions: a code for a new device (and every 30 days), sign-out after 12 hours idle, login
  // history (services/adminSessions.js). Server only, Railway FLAG_ADMIN_SESSIONS_V1=on, after the portal with the
  // code screen is live. Off = admins sign in as today.
  adminSessionsV1: { default: false, client: false },
  // P2-7: "bring your squad": 3 friends who join with your code and verify their e-mail in a Karachi week → a reward
  // (services/crew/squad.js). Off = no mission.
  squadMission: { default: false, client: true, grant: { roles: ["student"], label: "Squad mission" } },
  // P3b (under resumeV2): the resume coach (tap / chat mode, memory joggers, done-for-you writing, live checks,
  // fix everything, ready-to-send check) and speak mode (hold to talk; the audio is transcribed, never stored)
  resumeCoach: { default: false, client: true, grant: { roles: ["student"], label: "Resume coach" } },
  resumeSpeak: { default: false, client: true, grant: { roles: ["student"], label: "Resume speak mode" } },
  // P3c (under resumeV2): the template studio: the library (approved templates only), gallery, customisation,
  // recommended row, ATS-safe badges, embedded fonts. Off: the five templates, as today.
  resumeTemplatesV2: { default: false, client: true, grant: { roles: ["student"], label: "Resume template studio" } },
  // P3d (under resumeV2): recruiter-style feedback (strong / weak / improvements; one AI pass, cached per content)
  resumeFeedback: { default: false, client: true, grant: { roles: ["student"], label: "Resume feedback" } },
  // P3d: the finish moment (celebration, download / share link / matching jobs, the resume-ready card)
  resumeFinish: { default: false, client: true, grant: { roles: ["student"], label: "Resume finish moment" } },
  // P3d: the "verified by tdc" line (verified student, ambassador / founder credentials): off on each resume until added
  resumeVerified: { default: false, client: true, grant: { roles: ["student"], label: "Resume verified-by-tdc line" } },
  // P3d: the public resume page (gettdc.pk/r/<link>): off on each resume until the student turns it on; the page also
  // goes away when this flag is off for its owner
  resumePublicPage: { default: false, client: true, grant: { roles: ["student"], label: "Public resume page" } },
  // P3d: interview rates per template in the gallery (only templates with >= 30 applications and >= 10 interviews)
  resumeOutcomeStats: { default: false, client: true, grant: { roles: ["student"], label: "Resume outcome stats" } },
  // P4b (under confessionsV2): anonymous polls in confessions (2-4 options; who voted for what is never sent)
  confessionPolls: { default: false, client: true, grant: { roles: ["student"], label: "Confession polls" } },
  // P4b: follow a confession (the author follows their own) → a push on new replies, never naming anyone; one-tap mute
  confessionFollow: { default: false, client: true, grant: { roles: ["student"], label: "Confession follow + reply pushes" } },
  // P4c (under confessionsV2): share a public confession as an image card + its gettdc.pk/c/<id> page (text only)
  confessionShare: { default: false, client: true, grant: { roles: ["student"], label: "Confession share card + link" } },
  // P4c: the weekly campus recap push (numbers only; a campus with at least 5 confessions that week)
  confessionRecap: { default: false, client: true, grant: { roles: ["student"], label: "Confession weekly recap" } },
  // Q-3i (app only): smaller, "eco" quality pictures on a slow mobile connection (2G / 3G)
  lowDataImages: { default: false, client: true, grant: { roles: ["student"], label: "Low-data pictures on slow connections" } },
  // Q-3c (app only): Home opens with the last deals / points saved on the phone (read-only data; deleted on sign-out)
  persistCache: { default: false, client: true, grant: { roles: ["student"], label: "Instant reopen (saved Home data)" } },
  // Q-3d (app only): a post's save shows at once and goes back if the server says no
  optimisticActions: { default: false, client: true, grant: { roles: ["student"], label: "Instant save on posts" } },
  // Q-3e (app only): touching an event card starts loading its details
  prefetchDetails: { default: false, client: true, grant: { roles: ["student"], label: "Preload event details on touch" } },
  // P5b (app only): the header's brand search button
  headerSearch: { default: false, client: true, grant: { roles: ["student"], label: "Header search button" } },
  // P5b: "is your city right?" once on Home (POST /api/me/city)
  cityCheck: { default: false, client: true, grant: { roles: ["student"], label: "City check on Home" } },
  // P5b (app only): empty lists show a Dot, one line and one action
  polishEmptyStates: { default: false, client: true, grant: { roles: ["student"], label: "Friendlier empty lists" } },
  // P5b (app only): more celebration moments (first claim, a confession's 10th like, level up)
  celebrationsPlus: { default: false, client: true, grant: { roles: ["student"], label: "More celebrations" } },
  // P5c: "what tdc does for you" + pick 1-2 goals after signing up; Home's missions follow the goals
  onboardingGoals: { default: false, client: true, grant: { roles: ["student"], label: "Goals after signup" } },
  // P5c: one "next best action" card at the top of Home (GET /api/engagement/next-action)
  homeNextAction: { default: false, client: true, grant: { roles: ["student"], label: "Next best action on Home" } },
  // Q-3a (app only): the home stack on the native stack (chosen when the app starts)
  nativeStackDrawer: { default: false, client: true, grant: { roles: ["student"], label: "Native navigation (home stack)" } },
};

const JOBS = {
  eventIngestion: "events/scheduler: hourly Karachi event import, plus one pass 10s after start",
  socialPush: "socialPush: grouped pushes for new posts, confessions, listings, every minute",
  jobCleanup: "startup archive of foreign imported jobs, expired-job clean-up at start and every 6h, job field backfills",
  engagementScheduler: "engagement/schedular: daily drops, streak reminders, rollover, weekly reset (cron)",
  chatSync: "chat-service scheduler: database sync sweeps",
  pushes: "every Expo push (utils/expoProjects.js); off = nothing reaches a phone",
  careerOutbox: "career/careerOutboxJob: hiring-timeline notifications (retries, interview reminders), every 5 minutes",
  surplusSweep: "surplus/sweep: Surprise Box holds expiry, listing close, no-shows, pickup reminders, notifications, every minute",
  careerRetention: "career/careerRetentionJob: daily, anonymises hiring-timeline data 2 years after an application's last event (a dry run unless CAREER_RETENTION_MODE=apply)",
  pushReceipts: "engagement/pushGateway.checkReceipts: every 30 minutes, push receipts for logged pushes (delivered / failed) and dead tokens removed",
};

const envName = (prefix, name) => `${prefix}_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
const ON = new Set(["on", "true", "1", "yes"]);
const OFF = new Set(["off", "false", "0", "no"]);

// 0..99, stable for a user and a flag
const bucket = (flag, userId) => crypto.createHash("sha1").update(`${flag}:${userId}`).digest().readUInt16BE(0) % 100;

// quotes around a value, a rule or an id: "x", 'x', and the typographic ones a phone or a doc may add
// (each end on its own: '"ids:a";"ids:b"' leaves half-quoted rules once the outer pair is gone; ids never hold quotes)
const unquote = (s) => String(s).trim().replace(/^["'\u201c\u201d\u2018\u2019\s]+/, "").replace(/["'\u201c\u201d\u2018\u2019\s]+$/, "");
// ("ids:" inside a list is another pasted "Copy ids" output: its ids join the list)
const listOf = (s) => String(s).split(/[\s,]+/).map(unquote).map((x) => unquote(x.replace(/^(ids|users):/i, ""))).filter(Boolean);

/**
 * A flag's value as rules: [{ type: "on" | "off" | "pct" | "roles" | "ids" | "unreadable", pct?, items? }].
 * Rules split on ";" and line breaks; a line (not a ";" part) that doesn't start a rule continues the ids / roles
 * list on the line above it.
 */
function parseRules(raw) {
  const rules = [];
  const segments = unquote(raw).split(";").flatMap((part) => part.split(/\r?\n|\r/).map((s, i) => ({ s: unquote(s), continues: i > 0 }))).filter((x) => x.s);
  for (const { s: seg, continues } of segments) {
    const lower = seg.toLowerCase();
    const prev = continues ? rules[rules.length - 1] : null;
    if (ON.has(lower)) rules.push({ type: "on" });
    else if (OFF.has(lower)) rules.push({ type: "off" });
    else if (/^\d{1,3}%$/.test(seg)) rules.push({ type: "pct", pct: Number(seg.slice(0, -1)) });
    else if (lower.startsWith("roles:")) rules.push({ type: "roles", items: listOf(seg.slice(6)) });
    else if (lower.startsWith("users:")) rules.push({ type: "ids", items: listOf(seg.slice(6)) });
    else if (lower.startsWith("ids:")) rules.push({ type: "ids", items: listOf(seg.slice(4)) });
    else if (prev && (prev.type === "ids" || prev.type === "roles") && !seg.includes(":")) prev.items.push(...listOf(seg)); // the list goes on
    else rules.push({ type: "unreadable" });
  }
  return rules;
}

function ruleMatches(flag, rule, user) {
  switch (rule.type) {
    case "on": return true;
    case "off": return false;
    case "pct": return !!user?.id && bucket(flag, user.id) < rule.pct;
    case "roles": return !!user?.role && rule.items.includes(user.role);
    case "ids": return !!user?.id && rule.items.includes(String(user.id));
    default: return null; // unreadable
  }
}

const rawValue = (flag) => {
  const def = FLAGS[flag];
  let raw = process.env[envName("FLAG", flag)];
  if (raw == null && def?.legacyEnv) raw = process.env[def.legacyEnv];
  return raw;
};

/** Is a flag on for this user ({ id, role } or nothing)? Unknown flag → false. */
function isEnabled(flag, user = null) {
  return flagState(flag, user).effective;
}

// admin rows, per flag: Map account id → true (forced on) / false (forced off) (replaced as a whole by
// services/featureAccess.js; no row = the default / Railway decide)
let adminAccess = new Map();
/**
 * Replace the admin rows: Map or object of flag → iterable of account ids (each forced on: the older form) or of
 * [id, enabled] pairs / { id, enabled } objects.
 */
function setAdminAccess(byFlag) {
  const next = new Map();
  for (const [flag, list] of byFlag instanceof Map ? byFlag : Object.entries(byFlag || {})) {
    if (!FLAGS[flag]?.grant) continue;
    const m = new Map();
    for (const item of list) {
      if (Array.isArray(item)) m.set(String(item[0]), item[1] !== false);
      else if (item && typeof item === "object") m.set(String(item.id), item.enabled !== false);
      else m.set(String(item), true);
    }
    next.set(flag, m);
  }
  adminAccess = next;
}
/** One account's row in memory (the server that made the change applies it at once): true, false, or null = removed */
function applyAdminAccess(flag, accountId, enabled) {
  if (!FLAGS[flag]?.grant) return;
  if (!adminAccess.has(flag)) adminAccess.set(flag, new Map());
  if (enabled === null || enabled === undefined) adminAccess.get(flag).delete(String(accountId));
  else adminAccess.get(flag).set(String(accountId), !!enabled);
}
/** the account's row: true (forced on), false (forced off) or undefined (none) */
const forcedFor = (flag, id) => (id && FLAGS[flag]?.grant ? adminAccess.get(flag)?.get(String(id)) : undefined);
const hasAdminAccess = (flag, id) => forcedFor(flag, id) === true;
/** Counts only: { flag: accounts forced on } */
const adminAccessCounts = () => Object.fromEntries(Object.keys(FLAGS).filter((k) => FLAGS[k].grant).map((k) => [k, [...(adminAccess.get(k)?.values() || [])].filter((v) => v === true).length]));
/** Counts only: { flag: accounts forced off } */
const forcedOffCounts = () => Object.fromEntries(Object.keys(FLAGS).filter((k) => FLAGS[k].grant).map((k) => [k, [...(adminAccess.get(k)?.values() || [])].filter((v) => v === false).length]));

// role defaults: every listed feature is ON for every account of the role, unless an admin turned that role's
// default off (FeatureDefault row enabled: false). No row = on. Roles not listed (admin, traveler) get none.
const ROLE_DEFAULTS = {
  student: ["resumeStudioV2", "careerRatings", "loyaltyV2", "careerTimeline", "careerMatching", "surplusBoxes"],
  brand: ["loyaltyV2", "surplusBoxes"],
  employee: ["careerTimeline", "careerMatching", "careerRatings", "employerFirstHireFree"],
};
const DEFAULT_ROLES = Object.keys(ROLE_DEFAULTS);
/** may this role have a default for this flag? (listed above, and a role the flag can be granted to) */
const defaultable = (flag, role) => !!(ROLE_DEFAULTS[role] || []).includes(flag) && !!FLAGS[flag]?.grant?.roles.includes(role);
// kept for the student-only callers (models, older code)
const STUDENT_DEFAULTABLE = ROLE_DEFAULTS.student.filter((f) => defaultable(f, "student"));
const DEFAULTABLE_FLAGS = [...new Set(DEFAULT_ROLES.flatMap((r) => ROLE_DEFAULTS[r].filter((f) => defaultable(f, r))))];

// the rows admins set: "role:flag" → true / false
let roleDefaults = new Map();
const rdKey = (role, flag) => `${role}:${flag}`;
/**
 * Replace the defaults: [{ flag, role, enabled }] (rows), or the older student-only Map / object flag → boolean
 */
function setDefaults(input) {
  const next = new Map();
  const rows = Array.isArray(input)
    ? input.filter(Boolean).map((r) => [r.role, r.flag, r.enabled])
    : (input instanceof Map ? [...input] : Object.entries(input || {})).map(([flag, enabled]) => ["student", flag, enabled]);
  for (const [role, flag, enabled] of rows) if (defaultable(flag, role) && typeof enabled === "boolean") next.set(rdKey(role, flag), enabled);
  roleDefaults = next;
}
/** One default in memory (the server that made the change applies it at once); null removes the row (back to on) */
function applyDefault(flag, role, enabled) {
  if (!defaultable(flag, role)) return;
  if (enabled === null || enabled === undefined) roleDefaults.delete(rdKey(role, flag));
  else roleDefaults.set(rdKey(role, flag), !!enabled);
}
// "no row = on". setBuiltInDefaults(false) brings back the old meaning, "no row = not set: the Railway rules decide"
// (pilot-only behaviour: used by the pilot test suites; production never calls it)
let builtInDefaults = true;
function setBuiltInDefaults(on) { builtInDefaults = !!on; }
/** The default for every account of a role: true / false, or null when the role has none for this flag */
function roleDefaultOf(flag, role) {
  if (!defaultable(flag, role)) return null;
  const k = rdKey(role, flag);
  if (roleDefaults.has(k)) return roleDefaults.get(k);
  return builtInDefaults ? true : null; // no row = on
}
/** Was the default set by an admin (a row), or is it the built-in "on"? */
const roleDefaultSet = (flag, role) => roleDefaults.has(rdKey(role, flag));
const studentDefaultOf = (flag) => roleDefaultOf(flag, "student");

// every account with an explicit role other than student: id → role (a missing role is a student). A default
// applies only when the role a caller passes is the account's own, so a route that asks for "employee" for a job's
// poster never gives an admin's job the employer defaults, and "student" never reaches a brand. Replaced as a whole
// on each refresh; a new or changed account is updated at once by markAccountRole.
let accountRoles = new Map();
let accountRolesLoaded = false;
/** [id, role] pairs (or plain ids: an unknown non-student role) */
function setAccountRoles(pairs) {
  const next = new Map();
  for (const p of pairs) {
    if (Array.isArray(p)) { if (p[0] && p[1] && p[1] !== "student") next.set(String(p[0]), String(p[1])); }
    else if (p) next.set(String(p), "other");
  }
  accountRoles = next;
  accountRolesLoaded = true;
}
const setNonStudentIds = (ids) => setAccountRoles([...ids]);
function markAccountRole(id, role) { if (!id) return; if (role && role !== "student") accountRoles.set(String(id), String(role)); else accountRoles.delete(String(id)); }
/** the account's own role as far as the defaults go ("student" when it has none stored) */
const accountRoleOf = (id) => accountRoles.get(String(id)) || "student";
/** the role default that applies to this user (true / false), or undefined */
function defaultFor(flag, user) {
  if (!user?.id || !user.role || !defaultable(flag, user.role)) return undefined;
  // until the account list has loaded, only a student default can apply (as before); after, the role must match
  if (!accountRolesLoaded && user.role !== "student") return undefined;
  if (accountRoleOf(user.id) !== user.role) return undefined;
  const d = roleDefaultOf(flag, user.role);
  return d === null ? undefined : d;
}

/** The Railway value is only "off": the kill switch */
function isKilled(flag) {
  const raw = rawValue(flag);
  if (raw == null || !unquote(raw)) return false;
  const readable = parseRules(raw).filter((r) => r.type !== "unreadable");
  return readable.length > 0 && readable.every((r) => r.type === "off");
}

/** Railway rules alone for this user: true / false, or null when there is no readable value (the default applies) */
function railwayMatch(flag, user) {
  const raw = rawValue(flag);
  if (raw == null || !unquote(raw)) return null;
  const results = parseRules(raw).map((rule) => ruleMatches(flag, rule, user));
  if (!results.length || results.every((x) => x === null)) return null; // nothing readable: keep the default
  return results.some((x) => x === true);
}

/**
 * Why a flag is on or off for one user (the order at the top of this file):
 *   { killed, forced: "on" | "off" | null, studentDefault: true | false | null, fromRailway, granted, source, effective }
 *   source: "kill" | "account" | "default" | "railway" (which step decided)
 */
function flagState(flag, user = null) {
  const def = FLAGS[flag];
  if (!def) return { killed: false, forced: null, studentDefault: null, fromRailway: false, granted: false, source: "railway", effective: false };
  const killed = isKilled(flag);
  const rail = railwayMatch(flag, user);
  const fromRailway = rail === null ? !!def.default : rail;
  const row = forcedFor(flag, user?.id);
  const forced = row === true ? "on" : row === false ? "off" : null;
  const dflt = defaultFor(flag, user);
  const studentDefault = dflt === undefined ? null : dflt;
  let source; let effective;
  if (killed) { source = "kill"; effective = false; }
  else if (forced) { source = "account"; effective = forced === "on"; }
  else if (studentDefault !== null) { source = "default"; effective = studentDefault; }
  else { source = "railway"; effective = fromRailway; }
  return { killed, forced, studentDefault, fromRailway, granted: forced === "on", source, effective };
}

/** Does the Railway value turn the flag on for every account with this role ("on", or a roles rule naming it)? */
function railwayCoversRole(flag, role) {
  const raw = rawValue(flag);
  if (raw == null || !unquote(raw)) return !!FLAGS[flag]?.default;
  return parseRules(raw).some((r) => r.type === "on" || (r.type === "roles" && r.items.includes(role)));
}

/**
 * Is a pilot "set up" (its admin pages and admin routes shown)? The Railway value is set and isn't the kill switch,
 * OR any account has admin access to the flag. Before admin access existed this read the variable alone, so removing
 * FLAG_SURPLUS_BOXES hid the admin pages even with brands and students turned on from the portal. With no admin
 * access, the answer is exactly the old one (any value other than empty / off / false / 0 / no).
 */
function pilotConfigured(flag) {
  if (!FLAGS[flag]) return false;
  if (isKilled(flag)) return false;
  const raw = rawValue(flag);
  if (raw != null && unquote(raw) && !OFF.has(unquote(raw).toLowerCase())) return true;
  if (DEFAULT_ROLES.some((r) => roleDefaultOf(flag, r) === true)) return true; // on by default for a role
  return !!FLAGS[flag].grant && (adminAccessCounts()[flag] || 0) > 0;
}

/** The Railway ids listed for a flag (for counting only; never logged) */
function railwayIds(flag) {
  const raw = rawValue(flag);
  if (raw == null || !unquote(raw)) return [];
  return [...new Set(parseRules(raw).filter((r) => r.type === "ids").flatMap((r) => r.items))];
}

/** Startup lines, one per flag: rule types and counts only (never the ids), e.g. "[flags] FLAG_LOYALTY_V2: 3 ids" */
function describeFlags() {
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return Object.keys(FLAGS).map((flag) => {
    const name = envName("FLAG", flag);
    const def = FLAGS[flag].default ? "on" : "off";
    const raw = rawValue(flag);
    if (raw == null) return `[flags] ${name}: not set, using ${def}`;
    if (!unquote(raw)) return `[flags] ${name}: empty, using ${def}`;
    const rules = parseRules(raw);
    const readable = rules.filter((r) => r.type !== "unreadable");
    if (!readable.length) return `[flags] ${name}: unreadable value, using ${def}`;
    if (FLAGS[flag].grant && isKilled(flag)) return `[flags] ${name}: off (kill switch): admin access ignored`;
    const parts = [];
    if (readable.some((r) => r.type === "on")) parts.push("on for everyone");
    if (readable.some((r) => r.type === "off")) parts.push("off");
    for (const r of readable.filter((x) => x.type === "pct")) parts.push(`${r.pct}% of users`);
    const roles = new Set(readable.filter((r) => r.type === "roles").flatMap((r) => r.items));
    if (roles.size) parts.push(plural(roles.size, "role"));
    const ids = new Set(readable.filter((r) => r.type === "ids").flatMap((r) => r.items));
    if (readable.some((r) => r.type === "ids")) parts.push(plural(ids.size, "id"));
    const bad = rules.length - readable.length;
    return `[flags] ${name}: ${parts.join(", ")}${bad ? `; ${plural(bad, "unreadable rule")} ignored` : ""}`;
  });
}

/** One startup line: how many accounts have admin access per flag (counts only, never the ids) */
function describeAdminAccess() {
  return `[flags] admin access: ${Object.entries(adminAccessCounts()).map(([k, n]) => `${k} ${n}`).join(", ")}`;
}

/** One startup line: accounts forced off per flag (counts only), e.g. "[flags] forced off: loyaltyV2 2" or "none" */
function describeForcedOff() {
  const parts = Object.entries(forcedOffCounts()).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  return `[flags] forced off: ${parts.join(", ") || "none"}`;
}

/**
 * One startup line (no ids), e.g.
 * "[flags] defaults: student {resumeStudioV2 on, careerRatings on, …}, brand {loyaltyV2 on, surplusBoxes off}, employee {…}"
 */
function describeDefaults() {
  const word = (v) => (v === null ? "not set" : v ? "on" : "off");
  const role = (r) => `${r} {${ROLE_DEFAULTS[r].filter((f) => defaultable(f, r)).map((f) => `${f} ${word(roleDefaultOf(f, r))}`).join(", ")}}`;
  return `[flags] defaults: ${DEFAULT_ROLES.map(role).join(", ")}`;
}

/** The client flags for one user, for GET /api/app/flags/me */
function clientFlags(user = null) {
  return Object.fromEntries(Object.keys(FLAGS).filter((k) => FLAGS[k].client).map((k) => [k, isEnabled(k, user)]));
}

/** The public flags (no user), for GET /api/app/flags: only flags marked public */
function publicFlags() {
  return Object.fromEntries(Object.keys(FLAGS).filter((k) => FLAGS[k].client && FLAGS[k].public).map((k) => [k, isEnabled(k, null)]));
}

const isStaging = () => [process.env.APP_ENV, process.env.RAILWAY_ENVIRONMENT_NAME].some((v) => String(v || "").trim().toLowerCase() === "staging");

/** Should this background job run here? (see the top of this file) */
function jobEnabled(job) {
  if (!JOBS[job]) throw new Error(`unknown background job: ${job}`);
  const raw = String(process.env[envName("JOB", job)] || "").trim().toLowerCase();
  if (ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  if (OFF.has(String(process.env.BACKGROUND_JOBS || "").trim().toLowerCase())) return false;
  return !isStaging();
}

/** One startup line: which jobs run here */
function describeJobs() {
  const on = Object.keys(JOBS).filter(jobEnabled);
  const off = Object.keys(JOBS).filter((j) => !on.includes(j));
  return `[jobs] ${isStaging() ? "staging" : "production"}: on ${on.join(", ") || "none"}; off ${off.join(", ") || "none"}`;
}

module.exports = {
  FLAGS, JOBS, isEnabled, clientFlags, publicFlags, jobEnabled, describeJobs, describeFlags, parseRules, isStaging, envName,
  flagState, isKilled, railwayIds, railwayCoversRole, pilotConfigured, setAdminAccess, applyAdminAccess, adminAccessCounts, describeAdminAccess,
  forcedOffCounts, describeForcedOff, STUDENT_DEFAULTABLE, setDefaults, applyDefault, studentDefaultOf, describeDefaults,
  ROLE_DEFAULTS, DEFAULT_ROLES, DEFAULTABLE_FLAGS, defaultable, roleDefaultOf, roleDefaultSet, setBuiltInDefaults,
  setNonStudentIds, setAccountRoles, markAccountRole, accountRoleOf, isNonStudentListLoaded: () => accountRolesLoaded,
};
