// config/funnelEvents.js
// The funnel events the app may send to POST /api/engagement/events for the upgrade v2 plan
// (tdc-upgrade-v2/TDC_UPGRADE_PLAN.md §11.2 and P3-6 analytics). They are stored as EngagementEvent rows like the
// older client events; they never go to Meta. Names are exact, or one of the families below whose suffix is a short
// lowercase id (a step number, a variant, a template id). Anything else is refused as before.
//
// Dedupe: track() keeps one row per user + name + day unless meta.refId is given (then one per refId), so the app
// passes refId where every occurrence should count (e.g. one per resume).

const EXACT = new Set([
  // growth (P1)
  "invite_link_opened", "invite_code_prefilled", "signup_with_ref",
  // ambassador (P2)
  "amb_invite_shown", "amb_invite_accepted", "amb_invite_not_now", "amb_invite_never", "amb_apply_submitted", "amb_approved",
  // resume (P3)
  "resume_start_upload", "resume_start_profile", "resume_start_fresh",
  "resume_track_fresher", "resume_track_experienced",
  "resume_ai_bullets_used", "resume_finished", "resume_minutes_to_finish",
  "template_previewed", "template_selected", "resume_ats_badge_safe", "resume_ats_badge_design",
  // resume coach (P3b): which mode, fix everything, the ready-to-send check, one page reached (meta: seconds, typed, taps)
  "resume_coach_tap", "resume_coach_chat", "resume_coach_speak", "resume_fix_everything", "resume_ready_check", "resume_one_page_ready",
  // resume finish (P3d): feedback, the finish moment, the verified line, the public page, applying with a tdc resume
  "resume_feedback_opened", "resume_finish_shown", "resume_finish_download", "resume_finish_share_link", "resume_finish_jobs",
  "resume_ready_card", "resume_verified_added", "resume_verified_removed", "resume_public_on", "resume_public_off",
  "resume_public_new_link", "resume_public_copied", "job_apply_tdc_resume",
  // confessions (P4)
  "confession_precheck_ok", "confession_precheck_edit", "confession_precheck_hold",
  "confession_reported", "confession_shared_card", "confession_followed",
  // P4b: polls, follow / mute, save
  "confession_poll_created", "confession_poll_voted", "confession_unfollowed", "confession_saved", "confession_unsaved",
  // P4c: the share link made / refused, a confession opened from a link, the weekly recap opened
  "confession_share_link", "confession_share_refused", "confession_link_opened", "confession_recap_opened",
  // r7: a student banned from confessions opened the appeal email (P4-1 appeals)
  "confession_appeal_opened",
  // r7 (P3-9, resumeWriter): a letter / linkedin text written, copied, saved as a pdf
  "resume_writer_letter", "resume_writer_linkedin", "resume_writer_copied", "resume_writer_pdf",
]);

const SUFFIX = "[a-z0-9][a-z0-9_-]{0,39}";
const FAMILIES = [
  new RegExp("^amb_intro_card_[1-4]$"),
  new RegExp("^resume_step_done_\\d{1,2}$"),
  new RegExp(`^share_card_${SUFFIX}$`),
  new RegExp(`^template_customised_${SUFFIX}$`),
  new RegExp(`^resume_downloaded_${SUFFIX}$`),
  new RegExp(`^resume_feedback_fix_${SUFFIX}$`),
];

/** Is this a funnel event the app may send? */
function isFunnelEvent(name) {
  if (typeof name !== "string" || name.length > 64) return false;
  return EXACT.has(name) || FAMILIES.some((re) => re.test(name));
}

// meta from the phone is stored as given for the older events; for funnel events only small plain values are kept:
// at most 10 keys (letters, digits, _), strings up to 100 characters, finite numbers, booleans. Nothing nested.
const MAX_KEYS = 10;
function cleanMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return out;
  for (const [k, v] of Object.entries(meta)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 100);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

module.exports = { isFunnelEvent, cleanMeta, FUNNEL_EXACT: EXACT, FUNNEL_FAMILIES: FAMILIES };
