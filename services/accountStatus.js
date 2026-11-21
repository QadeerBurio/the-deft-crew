// services/accountStatus.js
// Plan P0-6: is this account locked out? Used by middleware/auth.middleware.js (every signed-in request) and by
// routes/auth.routes.js (/login, /signup/verify-otp). Only while the server-only flag accountStatusEnforce is on
// (FLAG_ACCOUNT_STATUS_ENFORCE); off = accountStatus is ignored, exactly as before.
//   - "banned": locked out
//   - "suspended": locked out until suspensionExpiry; with no expiry, until an admin restores the account
//   - "active", "deactivated", missing: not locked out ("deactivated" is not acted on here)
//   - admins are never locked out (until team roles exist, every admin counts as a super admin)
const flags = require("../config/featureFlags");

/** { locked: false } or { locked: true, code, status, message, until } for a user ({ _id, role, accountStatus, … }) */
function lockOf(user, now = new Date()) {
  if (!user) return { locked: false };
  if (!flags.isEnabled("accountStatusEnforce", { id: String(user._id || user.id || ""), role: user.role })) return { locked: false };
  if (user.role === "admin") return { locked: false };
  if (user.accountStatus === "banned") {
    const message = "This account has been closed for breaking tdc's community rules.";
    return { locked: true, code: "ACCOUNT_BANNED", status: "banned", message, until: null };
  }
  if (user.accountStatus === "suspended") {
    const until = user.suspensionExpiry ? new Date(user.suspensionExpiry) : null;
    if (until && !Number.isNaN(until.getTime()) && until <= now) return { locked: false }; // the suspension has ended
    const when = until ? ` until ${until.toISOString().slice(0, 10)}` : "";
    const message = `Your account is paused${when}${user.suspensionReason ? ` because: ${String(user.suspensionReason).slice(0, 200)}` : ""}.`;
    return { locked: true, code: "ACCOUNT_SUSPENDED", status: "suspended", message, until };
  }
  return { locked: false };
}

/** Where a student appeals (Railway SAFETY_APPEAL_EMAIL, e.g. safety@gettdc.pk), or null when unset. */
const appealEmail = () => {
  const v = String(process.env.SAFETY_APPEAL_EMAIL || "").trim();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? v : null;
};

/** The JSON body for a locked account. `message` and `error` both carry the sentence (older apps read either). */
function lockBody(lock) {
  const appeal = appealEmail();
  return { code: lock.code, accountStatus: lock.status, until: lock.until, message: lock.message, error: lock.message, ...(appeal ? { appealEmail: appeal } : {}) };
}

module.exports = { lockOf, lockBody, appealEmail };
