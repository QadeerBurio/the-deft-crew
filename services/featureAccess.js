// services/featureAccess.js
// Admin access to feature flags per account (models/FeatureAccess.js), set from the admin portal
// (routes/adminFeatures.routes.js). How a flag is decided is in config/featureFlags.js; this file keeps its
// in-memory access set up to date and makes the changes.
//
//   expectLoad()          called once at startup, before the database connects: requests wait for the first load
//   load()                read every row with enabled: true into the in-memory set (after the database connects)
//   start({ intervalMs }) load, then re-read every 30 s (rows written by another server process show within that)
//   waitReady             middleware: until the first load has finished (or failed, or 5 s after start, whichever
//                         comes first), requests wait,
//                         so a pilot account never sees its features off for the first seconds after a deploy
//   setAccess(...)        one account and flag: the row, the admin log entry (same transaction), the in-memory set
//   bulk(...)             many accounts (max 500): the same per account; wrong role / missing accounts are skipped
//   accountView(id)       per flag: { killed, fromRailway, granted, effective } (+ the pilot's students, for a brand)
//   flagsOverview()       per grantable flag: label, roles, Railway state (counts only), admin access count
//   listFlag(flag)        every account with admin access to a flag, newest first, paged
// Never logs an account id: the startup / refresh lines carry counts only.
const mongoose = require("mongoose");
const FeatureAccess = require("../models/FeatureAccess");
const User = require("../models/User");
const adminLog = require("./adminActionLog");
const { withTransaction } = require("../utils/transaction");
const flags = require("../config/featureFlags");

const { FLAGS } = flags;
const GRANTABLE = FeatureAccess.GRANTABLE;
const MAX_BULK = 500;
const REFRESH_MS = 30 * 1000;
const READY_WAIT_MS = 5 * 1000;

class FeatureAccessError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));

// ---------- the in-memory set ----------
let loaded = false;
let settled = true; // nothing to wait for unless expectLoad() was called
let settle = () => {};
let readyPromise = Promise.resolve();
let timer = null;

function expectLoad() {
  if (loaded || !settled) return;
  settled = false;
  readyPromise = new Promise((resolve) => { settle = () => { settled = true; resolve(); }; });
  // at most 5 s after start: if the database is still connecting by then, requests stop waiting (for good)
  setTimeout(() => settle(), READY_WAIT_MS).unref?.();
}

async function load() {
  try {
    const rows = await FeatureAccess.find({ enabled: true, flag: { $in: GRANTABLE } }).select("account flag").lean();
    const byFlag = new Map(GRANTABLE.map((f) => [f, []]));
    for (const r of rows) byFlag.get(r.flag)?.push(String(r.account));
    flags.setAdminAccess(byFlag);
    const first = !loaded;
    loaded = true;
    return { ok: true, first };
  } catch (err) {
    // the last good set stays; the error's name / code only (never a connection string)
    console.error(`[flags] admin access: could not ${loaded ? "refresh, keeping the last set" : "load, none applied until the next refresh"} (${err.name || "Error"}${err.code ? ` ${err.code}` : ""})`);
    return { ok: false };
  } finally {
    settle();
  }
}

async function start({ intervalMs = REFRESH_MS } = {}) {
  expectLoad();
  const r = await load();
  if (r.ok) console.log(flags.describeAdminAccess());
  if (!timer) {
    timer = setInterval(() => { load(); }, intervalMs);
    timer.unref?.();
  }
  return r;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

function waitReady(req, res, next) {
  if (settled) return next();
  readyPromise.then(() => next());
}
const isLoaded = () => loaded;

// ---------- changes ----------
const flagInfo = (flag) => ({ flag, label: FLAGS[flag].grant.label, roles: [...FLAGS[flag].grant.roles] });

function checkInput({ flag, enabled, reason }) {
  if (!GRANTABLE.includes(flag)) throw new FeatureAccessError(400, "BAD_FLAG", "This feature can't be turned on per account");
  if (typeof enabled !== "boolean") throw new FeatureAccessError(400, "BAD_ENABLED", "enabled must be true or false");
  const why = String(reason ?? "").trim();
  if (why.length < 3 || why.length > 500) throw new FeatureAccessError(400, "REASON", "A reason (3 to 500 characters) is required");
  return why;
}

// one account, already loaded (lean: _id, role); throws FeatureAccessError for a wrong role
async function applyOne({ adminId, user, flag, enabled, reason, requestId }) {
  const roles = FLAGS[flag].grant.roles;
  if (!roles.includes(user.role)) throw new FeatureAccessError(400, "WRONG_ROLE", `${FLAGS[flag].grant.label} is for ${roles.join(" / ")} accounts`);
  const accountId = String(user._id);
  const { result } = await withTransaction(async (session) => {
    const row = await FeatureAccess.findOne({ account: user._id, flag }).session(session).lean();
    const before = row?.enabled === true;
    if (before === enabled) return { changed: false, before, after: before };
    const now = new Date();
    await FeatureAccess.updateOne(
      { account: user._id, flag },
      { $set: { enabled, setBy: adminId, reason, setAt: now } },
      { upsert: true, session, runValidators: true }
    );
    await adminLog.record({
      adminId, action: enabled ? "feature.grant" : "feature.revoke", targetType: "User", targetId: accountId,
      before: { flag, enabled: before }, after: { flag, enabled }, reason, requestId, at: now,
    }, { session });
    return { changed: true, before, after: enabled };
  });
  if (result.changed) flags.applyAdminAccess(flag, accountId, enabled);
  return { accountId, ...result, state: flags.flagState(flag, { id: accountId, role: user.role }) };
}

async function setAccess({ adminId, accountId, flag, enabled, reason, requestId }) {
  const why = checkInput({ flag, enabled, reason });
  if (!isId(accountId)) throw new FeatureAccessError(400, "BAD_ACCOUNT", "Unknown account");
  const user = await User.findById(accountId).select("role").lean();
  if (!user) throw new FeatureAccessError(404, "NOT_FOUND", "Account not found");
  return applyOne({ adminId, user, flag, enabled, reason: why, requestId });
}

async function bulk({ adminId, accountIds, flag, enabled, reason, requestId }) {
  const why = checkInput({ flag, enabled, reason });
  if (!Array.isArray(accountIds) || !accountIds.length) throw new FeatureAccessError(400, "NO_ACCOUNTS", "Select at least one account");
  const unique = [...new Set(accountIds.map(String))];
  if (unique.length > MAX_BULK) throw new FeatureAccessError(400, "TOO_MANY", `At most ${MAX_BULK} accounts per request`);
  const valid = unique.filter(isId);
  const users = valid.length ? await User.find({ _id: { $in: valid } }).select("role").lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const out = { changed: [], unchanged: [], skipped: [] };
  for (const id of unique) {
    const user = byId.get(id);
    if (!user) { out.skipped.push({ id, why: "not found" }); continue; }
    try {
      const r = await applyOne({ adminId, user, flag, enabled, reason: why, requestId });
      (r.changed ? out.changed : out.unchanged).push(id);
    } catch (err) {
      if (!(err instanceof FeatureAccessError)) throw err;
      out.skipped.push({ id, why: err.code === "WRONG_ROLE" ? `wrong role (${user.role})` : err.message });
    }
  }
  return out;
}

// ---------- reads ----------
// for a brand with Loyalty or Surprise Box: how many students have the feature too (counts only)
async function pilotStudents(flag, brandId) {
  const granted = await FeatureAccess.find({ flag, enabled: true }).select("account").lean();
  const railIds = flags.railwayIds(flag).filter(isId);
  const [withAccess, fromRailway] = await Promise.all([
    granted.length ? User.countDocuments({ _id: { $in: granted.map((r) => r.account) }, role: "student" }) : 0,
    railIds.length ? User.countDocuments({ _id: { $in: railIds }, role: "student" }) : 0,
  ]);
  // students who have used this brand (loyalty visits / Surprise Box orders) and how many of them have it
  const Model = flag === "loyaltyV2" ? require("../models/LoyaltyLedger") : require("../models/SurplusOrder");
  const used = [...new Set((await Model.find({ brand: brandId }).select("student").lean()).map((r) => String(r.student)).filter(Boolean))];
  const usedWithIt = used.filter((id) => flags.isEnabled(flag, { id, role: "student" })).length;
  const killed = flags.isKilled(flag);
  return {
    killed,
    // the Railway value turns it on for every student ("on" or "roles:student")
    allStudentsFromRailway: !killed && flags.railwayCoversRole(flag, "student"),
    withAdminAccess: withAccess,
    fromRailwayList: fromRailway,
    usedThisBrand: used.length,
    usedThisBrandWithIt: usedWithIt,
  };
}

async function accountView(accountId) {
  if (!isId(accountId)) throw new FeatureAccessError(400, "BAD_ACCOUNT", "Unknown account");
  const user = await User.findById(accountId).select("role name brandName").lean();
  if (!user) throw new FeatureAccessError(404, "NOT_FOUND", "Account not found");
  const rows = await FeatureAccess.find({ account: user._id }).lean();
  const byFlag = new Map(rows.map((r) => [r.flag, r]));
  const admins = new Map((await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.setBy)))] } }).select("name").lean()).map((u) => [String(u._id), u.name || "admin"]));
  const list = [];
  for (const flag of GRANTABLE) {
    if (!FLAGS[flag].grant.roles.includes(user.role)) continue;
    const row = byFlag.get(flag);
    const item = {
      ...flagInfo(flag),
      ...flags.flagState(flag, { id: String(user._id), role: user.role }),
      // the row as stored (the in-memory set may lag on another server process by up to 30 s)
      lastChange: row ? { enabled: row.enabled, reason: row.reason, setAt: row.setAt, setBy: { id: String(row.setBy), name: admins.get(String(row.setBy)) || "admin" } } : null,
    };
    if (user.role === "brand" && (flag === "loyaltyV2" || flag === "surplusBoxes")) item.students = await pilotStudents(flag, user._id);
    list.push(item);
  }
  return { account: { id: String(user._id), role: user.role, name: user.brandName || user.name || "" }, flags: list };
}

function flagsOverview() {
  const lines = new Map(flags.describeFlags().map((l) => [l.slice("[flags] ".length).split(":")[0], l.slice(l.indexOf(": ") + 2)]));
  const counts = flags.adminAccessCounts();
  return GRANTABLE.map((flag) => ({
    ...flagInfo(flag),
    killed: flags.isKilled(flag),
    railway: lines.get(flags.envName("FLAG", flag)) || "",
    railwayIdCount: flags.railwayIds(flag).length,
    adminAccessCount: counts[flag] || 0,
  }));
}

async function listFlag(flag, { offset = 0, limit = 50 } = {}) {
  if (!GRANTABLE.includes(flag)) throw new FeatureAccessError(400, "BAD_FLAG", "This feature can't be turned on per account");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const filter = { flag, enabled: true };
  const [total, rows] = await Promise.all([
    FeatureAccess.countDocuments(filter),
    FeatureAccess.find(filter).sort({ setAt: -1, _id: -1 }).skip(off).limit(lim).lean(),
  ]);
  const ids = [...new Set(rows.flatMap((r) => [String(r.account), String(r.setBy)]))];
  const users = new Map((await User.find({ _id: { $in: ids } }).select("name brandName role university").lean()).map((u) => [String(u._id), u]));
  const uniIds = [...new Set([...users.values()].map((u) => u.university).filter(Boolean).map(String))];
  const unis = uniIds.length ? new Map((await require("../models/University").find({ _id: { $in: uniIds } }).select("name").lean()).map((u) => [String(u._id), u.name])) : new Map();
  return {
    ...flagInfo(flag),
    killed: flags.isKilled(flag),
    railwayIdCount: flags.railwayIds(flag).length,
    total, offset: off, limit: lim,
    accounts: rows.map((r) => {
      const u = users.get(String(r.account));
      const id = String(r.account);
      return {
        id,
        name: u ? u.brandName || u.name || "" : "(deleted account)",
        role: u?.role || null,
        university: u?.university ? unis.get(String(u.university)) || null : null,
        fromRailway: flags.flagState(flag, { id, role: u?.role }).fromRailway,
        setBy: { id: String(r.setBy), name: users.get(String(r.setBy))?.name || "admin" },
        reason: r.reason, setAt: r.setAt,
      };
    }),
  };
}

module.exports = {
  expectLoad, load, start, stop, waitReady, isLoaded,
  setAccess, bulk, accountView, flagsOverview, listFlag,
  FeatureAccessError, MAX_BULK, REFRESH_MS, GRANTABLE,
};
