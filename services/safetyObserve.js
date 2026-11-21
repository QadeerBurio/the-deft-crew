// services/safetyObserve.js
// Observe mode (confession safety, admin setting mode = "observe"): every check runs on real posts, comments and reports,
// and the decision is logged (models/SafetyObservation.js). Nothing is blocked, held, hidden, struck or banned. One
// exception, on purpose: a self-harm signal still e-mails the admins (it neither blocks nor hides; someone may need help).
// Runs after the post is saved, in the background; never throws.
const SafetyObservation = require("../models/SafetyObservation");
const check = require("./confessionCheck");
const alerts = require("./safetyAlerts");

const WOULD = { ok: "none", edit: "block", hold: "hold", selfharm: "support" };

async function observePost({ kind = "confession", text = "", image = "", universityId = null, userId = null, confessionId = null, commentId = null } = {}) {
  try {
    const r = await check.check({ text, image, universityId });
    await SafetyObservation.create({
      kind, confessionId, commentId, author: userId, verdict: r.verdict, wouldHave: WOULD[r.verdict] || "none",
      reasons: r.reasons, severe: !!r.severe, aiOk: !!r.aiOk, text: String(text || "").slice(0, 600), image: String(image || "").slice(0, 500),
    });
    if (r.verdict === "selfharm" && userId) {
      await alerts.send("self_harm", { userId, reason: `self-harm signal in a ${kind} (observe mode: nothing was held)`, content: text, contentId: String(confessionId || ""), withActions: false });
    }
    return r;
  } catch (e) {
    console.warn(`[safety] observe failed (${e.name})`);
    return null;
  }
}

/** A report in observe mode: what the re-check found and what would have happened. */
async function observeReport({ reportId, confessionId, commentId = null, userId = null, text = "", evidence = "", universityId = null, uniqueReporters = 1, threshold = 3 } = {}) {
  try {
    let verdict = "not_checked";
    let reasons = [];
    let wouldHave = uniqueReporters >= threshold ? "hide" : "none";
    let aiOk = true;
    let severe = false;
    if (evidence) {
      const r = await check.recheck({ text: evidence, universityId });
      aiOk = !!r.aiOk; severe = !!r.severe;
      verdict = r.confirmed ? "confirmed" : r.aiOk ? "not_confirmed" : "unavailable";
      reasons = r.reasons.map((code) => ({ code, message: check.MESSAGES[code] || code }));
      wouldHave = r.confirmed ? "remove" : r.aiOk ? wouldHave : "hide";
    }
    await SafetyObservation.create({ kind: "report", reportId, confessionId, commentId, author: userId, verdict, wouldHave, reasons, severe, aiOk, text: String(text || "").slice(0, 600) });
  } catch (e) {
    console.warn(`[safety] observe report failed (${e.name})`);
  }
}

module.exports = { observePost, observeReport };
