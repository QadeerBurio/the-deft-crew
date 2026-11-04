# Release checklist (Sprint 7)

Every acceptance criterion from the master plan (section 9 "Acceptance criteria (release blockers)") and the Career
Engine handoff (section 8 "must pass before launch", the Resume Tailoring QA matrix in section 11, and the "Final
release gate"), each mapped to the automated check that proves it, or marked **manual** with exact steps.

How to run: server suites are folders under `tests/`, each run as `node tests/<suite>/run.js <serverDir>` from a
folder with no `.env` (they use an in-memory fake database and never connect to MongoDB). App suites are
`tests/app/*.test.js` in the app repo (`node tests/app/<name>.test.js`). Portal checks are headless-Chrome scripts that
ran from a scratch folder each sprint (not in a repo: see "Gaps"). Quoted text below is the exact check label printed
by the suite.

Status: **auto** = an automated check proves it · **manual** = a person checks it (steps given) · **partial** = automated
for the server, manual for the device / real service · **N/A** = not in this pilot (reason given) · **gap** = no proof yet.

## Brand loyalty (plan 9)
| Criterion | Proof | Status |
|---|---|---|
| A claim doesn't count as a visit; only a qualifying verified redemption counts | `loyalty`: "claim + promo code + QR scan → 0 ledger rows"; "redeem-payment: … visit 1 credited" | auto |
| Duplicate / retried verification doesn't double-credit | `loyalty`: "the hook run 5 more times at once for the same redemption → still 1 row"; "promo confirm ×2 at once → one 200, one 409"; `load`: "50 students at once: 50 redemptions, one loyalty credit each" | auto |
| 1–5 visits = 15%, 6+ = 25%; boundaries | `loyalty`: "after 4 visits: visit 5 gets 15%"; "after 5 visits: visit 6 gets 25%"; "reverse visit 5 → 4 visits; the next visit gets 15%" | auto |
| Refund / void reverses the right credit without deleting audit history | `loyalty`: "admin reverses visit 6 → 201, a REVERSAL row (-1) with the admin and reason"; "ledger only grew (+2 rows), no row deleted or edited"; "reversing the same credit twice → 409" | auto |
| Existing brand offers aren't destroyed when creating another offer | `live-security`: "POST /offers → 200/201, new offer active"; "old offer kept, archived, with all its redemptions"; "nothing deleted" | auto |

## Surprise Box (plan 9)
| Criterion | Proof | Status |
|---|---|---|
| No overselling under concurrent requests | `surplus`: "the last box, 5 students at once: exactly one hold"; "3 boxes, 5 students asking for 2,2,1,1,1 at once: never more than 3 held"; `load`: "the last box, 50 at once"; "10 boxes, 50 at once: exactly 10 held" | auto |
| Pickup code can't be reused; only the authorized merchant branch can verify | `surplus`: "the code can't be used again: 409 CODE_USED"; "another brand can't verify the code"; "the brand's other branch: 403 WRONG_BRANCH"; "after the window ends the code has expired"; `permissions`: verify-pickup rows | auto |
| Failed payments don't create paid orders; duplicate webhook safe | Pilot is **pay at pickup only**: no payment provider, no webhook, tdc takes no money. "Paid" only when the brand marks it at handover (`surplus`: "completing needs 'paid at pickup'"). | **N/A** (must be re-proven before any online payment) |
| Expired holds release stock; cancellation / refund states consistent | `surplus`: "the expired hold gave its box back"; "the sweep releases expired holds: the last box is back on sale"; "cancelling 3 hours before pickup: CUSTOMER_CANCELLED, both boxes back on sale"; "cancelling 20 minutes before pickup: 409"; no refunds exist (no money) | auto |
| Food disclosure and pickup terms visible before order confirmation | `surplus`: "detail: every disclosure before confirming …"; "confirming without accepting the food and pickup terms: 400"; `app/surprise-box`: "contents may vary, allergens, best-before, pickup window, cancellation rule, pay at pickup"; "confirm stays off until the terms are accepted" | auto |

## Career / hiring (plan 9 + handoff 8)
| Criterion | Proof | Status |
|---|---|---|
| One application per student/job, idempotent retries | `career`: "3 simultaneous applies → one application"; "applying again later → refused as before, still one event" | auto |
| Student / employer see the same stage and timeline | `career`: "…the employer sees it"; timeline reads for both sides; `permissions`: timeline row | auto |
| Every state change has actor, timestamp, source | `career`: "…the timeline's REJECTED event records the employer and source" | auto |
| Scheduled interview ≠ completed | `career`: "recording 'completed' before the interview starts → 409 (scheduled ≠ completed)"; `analytics`: "a completed interview counts only when recorded completed" | auto |
| Candidate can accept, decline, request reschedule | `career`: interview respond checks; `app/career`: "accept, ask for another time, decline, add to calendar, withdraw" | auto |
| Updated .ics supersedes the old slot | `career`: "…the new .ics: same UID, SEQUENCE:1 (replaces the old slot)"; "the candidate withdraws → … its .ics becomes CANCEL" | auto (+ manual: import on a phone, see below) |
| Accepted offer ≠ verified hire until the employer confirms | `career`: "the candidate accepts → offer accepted, NOT hired"; `analytics`: "an accepted offer and a scheduled interview aren't hires" | auto |
| Hired badge revocable on dispute, private by default | `career`: "verified hire: … outcome verified, private"; "the student disputes within 7 days → revoked, private again"; "a revoked outcome can't be made public (409)" | auto |
| First verified hire free consumed exactly once per verified company | `first-hire-free`: "the first verified hire: fee 0 …"; "5 duplicate callbacks + a reconcile: still one billing row"; "two verified hires at the same moment: exactly one free"; "the company's second verified hire … isn't free"; `load`: "50 confirm-hires at once: … the free hire used once" | auto |
| Employer can't access another employer's applicants | `career`: "employer B → 404 for employer A's applicant"; `permissions`: every career row (other employer denied) | auto |
| Historical hiring evidence survives job archival | `career`: "employer deletes a job (archived)"; "its application's timeline is still there" | auto |
| Notification retries can't duplicate state transitions | `career`: "the retry delivers it (attempt 2); no timeline event written again"; "… stops after 5 attempts" | auto |
| No regressions to existing jobs, resumes, portals | All server suites (19) + app suites + portal headless checks green on every merge | auto (+ manual smoke below) |

## Resume Studio (plan 9 + handoff 8 + handoff 11)
| Criterion | Proof | Status |
|---|---|---|
| No unsupported facts / metrics / skills generated | `resume-studio/benchmark`: 130/130 fabrications caught, 0 unsupported additions; `resume-studio/core`: "TypeScript (not in the resume) is never ok"; "an invented 40% is flagged"; "a new date is blocked" | auto |
| Job says TypeScript, resume lacks it → never inserted automatically | `resume-studio/run`: "TypeScript is not inserted: needs confirmation, content unchanged" | auto |
| No metrics in source → can't add "40% improvement" | `resume-studio/run`: "invented 40%: not ok" | auto |
| Dates can't be altered | `resume-studio/core`: "a changed date fails at approval"; `run`: "invented date: blocked" | auto |
| Only academic projects → no invented employment | `resume-studio/core`: "fresher: an invented job fails at approval"; "fresher: no work-experience field is offered" | auto |
| Malicious job text ignored | `resume-studio/core`: "injection lines are removed from the job text"; `run`: "malicious job text: warning shown, Kubernetes not treated as a requirement" | auto |
| Ambiguous parsed PDF → confirmation, not silent trust | `resume-studio/run`: "unconfirmed parsed upload: 409 SOURCE_UNVERIFIED"; "confirming a stale revision: 409"; `app/resume-studio`: "an unconfirmed upload: the details read from it are shown first" | auto |
| Malformed model JSON → safe retry / fallback | `resume-studio/core`: "malformed JSON twice: one retry, then no suggestions (resume untouched)"; "model error: falls back, no crash" | auto |
| Preview and explicit approval before save / apply | `resume-studio/run`: "preview PDF carries the DRAFT label"; "approve needs both confirmations: 422"; "approve with undecided changes: 422 UNRESOLVED" | auto |
| Every substantive edit visible and individually resolvable | `app/resume-studio`: review section (statuses, plain-word risks, accept / reject / edit per change) | auto |
| Drafts don't consume the published resume quota | `resume-studio/run`: "approval creates no Resume and doesn't touch the resume count" | auto |
| Published resume limit consistent across routes | `resume-basics`: "5 simultaneous creates → exactly 1 more, the rest refused (403)" (the shared race-safe limit) | auto |
| PDF text extractable, readable by ATS parsers | `resume-studio/renderer`: "pdftotext: reading order …"; "links are clickable"; "long resume breaks onto more pages"; `resume-basics`: pdftotext checks | auto (+ manual: open in a real ATS, below) |
| Draft vs approved labelling | `resume-studio/renderer`: "approved version has no DRAFT label"; "every page of a preview has the DRAFT label" | auto |
| Candidate recovers from AI timeout without losing edits | `resume-studio/run`: "after 3 attempts: failed TIMED_OUT" (resume untouched); `app/resume-studio`: decisions saved offline and sent later; draft reopens | partial (+ manual: kill the app mid-review, below) |
| Stale revision → conflict, newer edits kept | `resume-studio/run`: "a decision with a stale revision: 409 STALE_REVISION"; "two devices at once: one 200, one 409" | auto |
| Approved version immutable; changes create another | `resume-studio/run`: "an approved draft can't be changed: 409"; "3 simultaneous approves: one version" | auto |
| Employer receives the immutable approved snapshot only | `resume-studio/run`: "employer downloads exactly the approved snapshot"; "a version whose hash no longer matches what was sent is not served"; "another employer: 404" | auto |
| User A can't access user B's drafts / exports / versions | `resume-studio/run` ownership checks; `permissions`: every Resume Studio row | auto |
| Duplicate generation / approval / apply → no duplicates | `resume-studio/run`: "5 simultaneous taps with one key: one job"; `load`: "50 approvals at once: one version" | auto |
| Fresher resume works without work experience | `resume-studio/renderer`: "pdftotext: fresher gets projects and education before skills" | auto |
| Match score doesn't imply a hiring guarantee | `resume-studio/run`: leak scan "no hiring verdicts / percentiles / probabilities"; `app/resume-studio`: "no scores, percentages or hiring verdicts anywhere" | auto |
| Delete drafts; revoke public career badges | `resume-studio/run`: "deleting an approved draft keeps its version"; `career`: outcome visibility switch | auto |
| Retention policies; no accidental public URLs | Draft TTL 30 days, used versions 2 years (TTL indexes): `resume-studio/run`: "approved draft: no expiry; open draft: expires in ~30 days"; PDFs are served only through authorised routes (no public storage URLs) | partial (TTL deletion itself happens in MongoDB: check in staging, below) |

## Platform (plan 9)
| Criterion | Proof | Status |
|---|---|---|
| No regression to discounts, QR verification, jobs, scholarships, events, confessions, networking, portals | 19 server suites incl. `live-security`, `brand-online-store`, `social-push`, `streak-reminders`, `perf-server`; app suites incl. events, tickets, social push; portal headless checks | auto (+ manual smoke) |
| Admin actions audited | `loyalty` (reversal with admin + reason), `career` (admin writes audited), `surplus` (case decisions, brand blocks), `first-hire-free`: "every admin decision is in the audit with its reason" | auto |
| Analytics reconcile to authoritative events | `analytics`: 39 checks reconciling each card with seeded records | auto |
| Permissions | `permissions`: 85 routes × 8 roles (680) | auto |
| Concurrency | `load`: 7 scenarios, 0 duplicates | auto |
| Security | `security` (fuzz) + `docs/SECURITY_REVIEW.md` | auto + review |
| Accessibility | portal: axe WCAG 2 A/AA, 0 violations on the new pages; app: `app/a11y-pilot` | auto (+ manual screen reader pass, below) |
| Staging QA, backup / rollback, product sign-off | — | **manual** (below) |

## Manual checks (exact steps)
1. **Device pass (Android + iOS)** with one test student per flag: run each module's test script in `docs/ROLLOUT.md`
   ("test ids" stage), on a real Android phone and an iPhone, on Wi-Fi and on mobile data.
2. **Calendar**: accept an interview, tap "add to calendar", open the .ics in Google Calendar and Apple Calendar;
   reschedule from the portal, re-import: one event, new time.
3. **ATS read**: export an approved ATS Classic PDF and upload it to two public ATS parsers / job sites; check name,
   contact, experience dates and skills land in the right fields.
4. **Crash recovery**: in Resume Studio, decide 2 changes in airplane mode, force-quit the app, reopen online: the draft
   reopens and the 2 decisions are applied.
5. **Notifications**: for each module, trigger one notification to a real device (order ready, interview invite, offer):
   it arrives once and the tap opens the right screen.
6. **Screen reader**: TalkBack and VoiceOver through Surprise Box order and Resume Studio approval: every control is read
   with its name and state.
7. **Retention**: in staging, set a draft's `expiresAt` to the past and wait for MongoDB's TTL monitor (≤ 60 s): it's gone.
8. **Backup / rollback**: Atlas snapshot exists from today; do the rollback rehearsal in `docs/ROLLOUT.md`.
9. **Smoke (existing features)**: claim + QR redeem, promo code, job apply, resume create + PDF, event ticket, post +
   comment, scholarship page, brand / employer / admin portal sign-in.
10. **Product sign-off**: the owner signs the decisions listed below.

## Gaps (no proof yet)
- **Staging environment**: all automated proof runs on an in-memory database. `docs/STAGING.md` describes a staging
  Railway environment with its own Atlas cluster; whether it has been set up is not confirmed. Manual steps 1-9 run
  there, or in production with test ids only (flags scoped to test accounts).
- **Career data retention**: the 2-year anonymisation job and the account-deletion wiring for hiring timeline data
  are not built (`docs/CAREER_TIMELINE.md`, "Retention"). Needed before the career pilot widens past pilot ids.
- **Portal headless checks are not in the portal repo** (they ran from a scratch folder each sprint). They should be
  committed as a portal test suite.
- **Online payments for Surprise Box**: not built (N/A by decision); acceptance must be re-proven before any payment.
- **Resume Studio pilot measures**: no analytics card or admin page counts Resume Studio usage
  (`docs/PILOT_PLAN.md`).
- **Real-device push and calendar behaviour**: manual only (steps 2, 5).

## Decisions needing sign-off
1. Admins can act for an employer on the hiring timeline, including **confirming a hire**, which then uses the
   company's free hire (see `docs/SECURITY_REVIEW.md` #2). Keep, or restrict hire confirmation to the employer?
2. Per-user rate limits on Resume Studio PDF preview/export and the analytics overview before `pct:` stages.
3. Staging: set up the staging environment in `docs/STAGING.md`, or accept "production with test ids" for the pilot.
6. Build the career retention job and account-deletion wiring before `FLAG_CAREER_TIMELINE` goes past pilot ids.
4. Pricing for hires after the free one (today recorded as "pending pricing", nothing charged).
5. Surprise Box pickup-only, pay-at-pickup for the pilot (no refunds through tdc).
