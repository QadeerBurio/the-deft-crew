// services/safetyAlerts.js
// The safety e-mail to admins (plan P4-1b): sent for every suspension, threat, self-harm signal or doxxing attempt.
// Recipients: SAFETY_ALERT_EMAILS (comma-separated Railway variable). Unset = nothing is sent (a warning is logged).
// The e-mail carries the content, the reason, the evidence and an anonymous author reference (never the real name or
// e-mail), and, when an account is involved, two one-time links (models/SafetyAction.js): blacklist and restore.
// Never throws.
const crypto = require("crypto");
const SafetyAction = require("../models/SafetyAction");

const LINK_DAYS = 7;
// the mail sender (utils/mailer.js); tests swap it with _setSendMailForTests
let sendMailFn = null;
const sendMail = (m) => (sendMailFn || require("../utils/mailer").sendMail)(m);
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "https://the-deft-crew-production.up.railway.app").replace(/\/+$/, "");
const recipients = () => String(process.env.SAFETY_ALERT_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
/** An anonymous reference for an account (the same account always gets the same one; not reversible). */
const authorRef = (userId) => `author-${crypto.createHash("sha256").update(`tdc-safety:${userId}`).digest("hex").slice(0, 10)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Make one link (the secret goes only into the e-mail). */
async function makeLink(action, userId, reason) {
  const token = crypto.randomBytes(24).toString("base64url");
  await SafetyAction.create({ tokenHash: hashToken(token), action, user: userId, reason: String(reason || "").slice(0, 200), expiresAt: new Date(Date.now() + LINK_DAYS * 864e5) });
  return `${baseUrl()}/api/safety/action/${token}`;
}

/**
 * kind: "suspension" | "threat" | "self_harm" | "doxxing" | "severe"
 * { userId, reason, content, evidence, contentType, contentId, withActions }
 * Returns { sent, to, links } (for tests and logs; never the secrets in logs).
 */
async function send(kind, { userId, reason = "", content = "", evidence = "", contentType = "Confession", contentId = "", withActions = true } = {}) {
  try {
    const to = recipients();
    if (!to.length) { console.warn(`[safety] alert not e-mailed (${kind}): SAFETY_ALERT_EMAILS is not set`); return { sent: false, to: [], links: null }; }
    const links = withActions && userId ? { blacklist: await makeLink("blacklist", userId, reason), restore: await makeLink("restore", userId, reason) } : null;
    const ref = userId ? authorRef(userId) : "(none)";
    const subject = `[tdc safety] ${kind.replace(/_/g, " ")}: ${String(reason).slice(0, 80)}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p><b>${esc(kind.replace(/_/g, " "))}</b> · ${esc(contentType)} ${esc(String(contentId))}</p>
<p><b>reason:</b> ${esc(reason)}</p>
<p><b>author:</b> ${esc(ref)} (anonymous reference; the real account is on the admin Safety page)</p>
<p><b>content:</b></p><blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 10px">${esc(String(content).slice(0, 2000))}</blockquote>
${evidence ? `<p><b>evidence (reported words):</b> “${esc(String(evidence).slice(0, 500))}”</p>` : ""}
${links ? `<p>The automatic action stays as it is unless you choose:</p>
<p><a href="${esc(links.blacklist)}">blacklist this account</a> (ban it and block its e-mail and phone from signing up again)<br>
<a href="${esc(links.restore)}">restore this account</a> (undo the suspension and the strike)</p>
<p style="color:#666">Each link works once and expires in ${LINK_DAYS} days. Every click is logged.</p>` : ""}
</div>`;
    await sendMail({ to: to.join(","), subject, html });
    return { sent: true, to, links };
  } catch (e) {
    console.error(`[safety] alert e-mail failed (${kind}): ${e.name}`);
    return { sent: false, to: [], links: null };
  }
}

module.exports = { send, authorRef, hashToken, makeLink, LINK_DAYS, _setSendMailForTests: (fn) => { sendMailFn = fn; } };
