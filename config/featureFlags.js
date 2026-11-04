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
//   GET /api/app/flags/me returns the "client" flags for the signed-in user (routes/appFlags.routes.js).
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
  resumeStudioV2: { default: false, client: true },
  // Brand loyalty (routes/loyalty.routes.js, services/loyalty.js). A loyalty credit or discount needs it
  // on for BOTH the brand and the student, e.g. FLAG_LOYALTY_V2="ids:<test brand id>,<test student id>".
  // Per user only: listed by /api/app/flags/me, not by the public /api/app/flags.
  loyaltyV2: { default: false, client: true },
  // Hiring timeline, interviews, offers, verified hires (routes/career.routes.js, services/career/).
  // Needs it on for BOTH the job's employer and the candidate, e.g.
  // FLAG_CAREER_TIMELINE="ids:<employer id>,<student id>". Per user only (/api/app/flags/me).
  careerTimeline: { default: false, client: true },
  // Surprise Box: merchant surplus food, pickup only, pay at pickup (routes/surplus.routes.js,
  // services/surplus/). Needs it on for the brand (its listings show only then) and the student, e.g.
  // FLAG_SURPLUS_BOXES="ids:<brand id>,<student id>". Per user only (/api/app/flags/me).
  surplusBoxes: { default: false, client: true },
  // First Hire Free: one fee-waived verified hire per verified company (routes/careerTrial.routes.js,
  // services/career/trialService.js). Per employer, e.g. FLAG_EMPLOYER_FIRST_HIRE_FREE="ids:<employer id>".
  // Off: no trial, no billing ledger rows, the hiring timeline unchanged. Per user only (/api/app/flags/me).
  employerFirstHireFree: { default: false, client: true },
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
};

const envName = (prefix, name) => `${prefix}_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
const ON = new Set(["on", "true", "1", "yes"]);
const OFF = new Set(["off", "false", "0", "no"]);

// 0..99, stable for a user and a flag
const bucket = (flag, userId) => crypto.createHash("sha1").update(`${flag}:${userId}`).digest().readUInt16BE(0) % 100;

function ruleMatches(flag, rule, user) {
  const r = rule.trim();
  const lower = r.toLowerCase();
  if (ON.has(lower)) return true;
  if (OFF.has(lower) || !r) return false;
  const pct = /^(\d{1,3})%$/.exec(r);
  if (pct) return !!user?.id && bucket(flag, user.id) < Number(pct[1]);
  if (lower.startsWith("roles:")) return !!user?.role && r.slice(6).split(",").map((x) => x.trim()).includes(user.role);
  if (lower.startsWith("users:")) return !!user?.id && r.slice(6).split(",").map((x) => x.trim()).includes(String(user.id));
  if (lower.startsWith("ids:")) return !!user?.id && r.slice(4).split(",").map((x) => x.trim()).includes(String(user.id));
  return null; // unreadable
}

/** Is a flag on for this user ({ id, role } or nothing)? Unknown flag → false. */
function isEnabled(flag, user = null) {
  const def = FLAGS[flag];
  if (!def) return false;
  let raw = process.env[envName("FLAG", flag)];
  if (raw == null && def.legacyEnv) raw = process.env[def.legacyEnv];
  if (raw == null || !String(raw).trim()) return def.default;
  const results = String(raw).split(";").map((rule) => ruleMatches(flag, rule, user));
  if (results.every((x) => x === null)) return def.default; // nothing readable: keep the default
  return results.some((x) => x === true);
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

module.exports = { FLAGS, JOBS, isEnabled, clientFlags, publicFlags, jobEnabled, describeJobs, isStaging, envName };
