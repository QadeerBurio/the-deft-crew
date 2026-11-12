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
// ADMIN ACCESS AND STUDENT DEFAULTS (from the admin portal; models/FeatureAccess.js, models/FeatureDefault.js,
// services/featureAccess.js). Flags with a "grant" entry can be forced on or off for one account by an admin; flags
// with studentDefault: true can also be set on or off for every student at once. A flag is decided, in order:
//     1. a Railway value that is only "off" (off / false / 0 / no) is the kill switch: off for everyone
//     2. the account's own row (FeatureAccess): enabled true = forced on, enabled false = forced OFF. An admin "off"
//        beats the student default and the Railway rules
//     3. the default for the account's role (FeatureDefault; students only: employers, brands and admins have none)
//     4. the Railway rules (ids, %, roles)
//     5. otherwise off (the flag's built-in default)
//   "Students only" is checked against the account itself, not just the role a caller passes: the ids of every
//   non-student account are kept in memory too, so a route that asks for role "student" never turns a default on
//   for an employer, a brand or an admin.
//   All of it lives in memory here (setAdminAccess, setDefaults, setNonStudentIds), loaded and refreshed every 30 s
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

// student defaults: flag → true / false (no entry = not set: the Railway rules decide)
const STUDENT_DEFAULTABLE = Object.keys(FLAGS).filter((k) => FLAGS[k].grant && FLAGS[k].studentDefault && FLAGS[k].grant.roles.includes("student"));
let studentDefaults = new Map();
/** Replace the defaults: Map / object flag → boolean, or [{ flag, role: "student", enabled }] */
function setDefaults(input) {
  const next = new Map();
  const entries = Array.isArray(input) ? input.filter((r) => r && r.role === "student").map((r) => [r.flag, r.enabled]) : input instanceof Map ? [...input] : Object.entries(input || {});
  for (const [flag, enabled] of entries) if (STUDENT_DEFAULTABLE.includes(flag) && typeof enabled === "boolean") next.set(flag, enabled);
  studentDefaults = next;
}
/** One default in memory (the server that made the change applies it at once); null removes it */
function applyDefault(flag, role, enabled) {
  if (role !== "student" || !STUDENT_DEFAULTABLE.includes(flag)) return;
  if (enabled === null || enabled === undefined) studentDefaults.delete(flag);
  else studentDefaults.set(flag, !!enabled);
}
const studentDefaultOf = (flag) => (studentDefaults.has(flag) ? studentDefaults.get(flag) : null);

// accounts that are NOT students (employers, brands, admins): a default never applies to them, whatever role a
// caller passes. Replaced as a whole on each refresh; a new non-student account is added at once by markAccountRole.
let nonStudents = new Set();
let nonStudentsLoaded = false;
function setNonStudentIds(ids) { nonStudents = new Set([...ids].map(String)); nonStudentsLoaded = true; }
function markAccountRole(id, role) { if (!id) return; if (role && role !== "student") nonStudents.add(String(id)); else nonStudents.delete(String(id)); }
/** the student default that applies to this user (true / false), or undefined */
function defaultFor(flag, user) {
  if (!user?.id || user.role !== "student" || !studentDefaults.has(flag)) return undefined;
  if (nonStudents.has(String(user.id))) return undefined; // the caller said "student", the account isn't one
  return studentDefaults.get(flag);
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
  if (studentDefaults.get(flag) === true) return true; // on for every student
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

/** One startup line, e.g. "[flags] student defaults: loyaltyV2 on, careerMatching off, surplusBoxes not set" (no ids) */
function describeDefaults() {
  return `[flags] student defaults: ${STUDENT_DEFAULTABLE.map((k) => `${k} ${studentDefaults.has(k) ? (studentDefaults.get(k) ? "on" : "off") : "not set"}`).join(", ")}`;
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
  setNonStudentIds, markAccountRole, isNonStudentListLoaded: () => nonStudentsLoaded,
};
