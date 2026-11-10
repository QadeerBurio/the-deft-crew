# Rollout plan (pilot flags)

Seven flags, all off today: `FLAG_LOYALTY_V2`, `FLAG_CAREER_TIMELINE`, `FLAG_RESUME_STUDIO_V2`, `FLAG_SURPLUS_BOXES`,
`FLAG_EMPLOYER_FIRST_HIRE_FREE`, `FLAG_CAREER_MATCHING`, `FLAG_CAREER_RATINGS`. Each is a Railway variable on the server service (`config/featureFlags.js`). Changing one
restarts the service (about 1–2 minutes); no code change or app update is needed.

## How to write a flag value (read this first)
- Rules are separated by `;` and the flag is on for a user if **any** rule matches.
- `ids:<id>,<id>` turns it on for exactly those user ids (Mongo `_id`s of the student, brand or employer accounts).
- **Percentages are written `10%`, not `pct:10`.** `pct:10` is not a rule the parser knows. If no rule in the value
  can be read, the flag silently falls back to its default (off).
- A percentage is a stable bucket per flag and per user: the same 10% every time, and 50% includes that 10%.
- Keep the pilot ids in every later stage, e.g. `ids:<pilot ids>;10%`, so pilot users never drop out.
- `on` means everyone. `off` (or deleting the variable) means nobody.
- The app asks `/api/app/flags/me` once per account and keeps the answer for 5 minutes. A change reaches phones within
  about 5 minutes of the restart, or straight away after signing out and in again.

### Two-sided flags: the percentage applies to both sides
Loyalty (brand **and** student), the career timeline (employer **and** candidate) and Surprise Box (brand **and**
student) only work when the flag is on for both sides. A `10%` rule therefore also switches on a random 10% of brands
or employers. At the `%` stages, decide which merchants and employers are ready:
- **Loyalty:** a brand also needs an active loyalty program, so `10%` of brands is harmless. Brands without a program
  see an empty loyalty page.
- **Surprise Box:** a brand only appears to students once it publishes a listing. A brand the `%` rule switches on
  sees the Surprise Box page in its portal. Tell brands before the `%` stages, or keep brands on `ids:` and give the
  `%` only to students. Brand ids and student ids can sit in one value, and roles are not mixed up: a brand id never
  becomes a student.
- **Career timeline:** pilot employers' applications move to the timeline as soon as both sides are on. Employers
  switched on by a `%` rule start using it on their next status change.

## Stages (every flag)
| Stage | Value | Who | Hold at least | Move on when |
|---|---|---|---|---|
| 1. Test ids | `ids:<test student>,<test brand / employer>` | our own test accounts | 1 day | the manual script below passes on Android and iOS |
| 2. Pilot ids | `ids:<test ids>,<pilot ids>` | the people in `docs/PILOT_PLAN.md` | 2 weeks (the pilot) | the pilot success measures are met and no open P1 issue |
| 3. 10% | `ids:<pilot ids>;10%` | + a stable 10% of users | 1 week | watch list clean for 7 days |
| 4. 50% | `ids:<pilot ids>;50%` | + half of users | 1 week | watch list clean; support load OK |
| 5. On | `on` | everyone | — | — |

Before stage 3, decide the open items in `docs/RELEASE_CHECKLIST.md` (the career retention merge, staging). Rate
limits and employer-only hire confirmation are in place.

Rate limits (Railway variables, per user, per server instance): `RATE_LIMIT_RESUME_PDF_MAX` (default 30) /
`RATE_LIMIT_RESUME_PDF_WINDOW_MIN` (10), `RATE_LIMIT_ANALYTICS_MAX` (60) / `RATE_LIMIT_ANALYTICS_WINDOW_MIN` (10).
Raise one if real users report "Too many requests".

## What to watch at every stage
- **Railway logs**, searched for each module's tag. Any repeat of these lines is a stop:
  - `[loyalty] credit for redemption … failed`
  - `[career] listener for … failed`
  - `[trial] reconcile`
  - `[resume-studio] tailor job failed`
  - `[surplus]`
  - `[surplus sweep] … failed`
- 5xx responses on the module's routes: `/api/loyalty`, `/api/career`, `/api/career/resume`, `/api/surplus`.
- **The admin portal**: the Overview page (the analytics cards), plus each module's admin page (listed per flag below).
- Support messages from pilot users.
- The startup line `[jobs] production: on …` must include `careerOutbox` and `surplusSweep`.

## Per flag

### FLAG_LOYALTY_V2 (brand loyalty)
- **Test script:**
  1. The test brand creates a loyalty program in the portal.
  2. The test student redeems at the brand 6 times. Each visit is a confirmed redemption: QR plus "redeem payment",
     or a promo code the brand confirms.
  3. Visits 1–5 get 15%, visit 6 gets 25%.
  4. An admin reverses one visit in Admin → Loyalty exceptions.
- **Watch:**
  - In Admin → Loyalty exceptions, the reversals should have a reason, with no unexplained ones.
  - `[loyalty] credit … failed` lines in the logs.
  - Brands should report the discount as correct at the till.
  - The `ledger rows = verified redemptions` count for each pilot brand. Check it via the loyalty admin page and that
    brand's redemptions.
- **Rollback:**
  - For one brand or student: remove its id from `FLAG_LOYALTY_V2`.
  - For everyone: set `FLAG_LOYALTY_V2=off`.
- **In-flight items when rolled back:**
  - The next redemption uses the offer's own discount again, and no new visits are credited.
  - The ledger and programs are kept, nothing is deleted.
  - The app hides the loyalty card within about 5 minutes.
  - If you switch it back on, visits count from the ledger again, within the program's reset window. Visits made while
    it was off are **not** credited afterwards.
  - A discount already shown on a student's screen but not yet confirmed by the brand gets the offer's discount at
    confirmation, because confirmation recomputes it.

### FLAG_CAREER_TIMELINE (hiring timeline, interviews, offers, verified hires)
- **Test script:**
  1. The test student applies to a job posted by the test employer.
  2. The employer shortlists the student, then schedules an interview.
  3. The student accepts the interview and adds it to their calendar.
  4. The employer records the interview as completed, then sends an offer.
  5. The student accepts the offer.
  6. The employer confirms the hire.
  7. The student sees the timeline, and the hire is private.
- **Watch:**
  - `[career] listener … failed` lines in the logs.
  - Admin → Hiring funnel.
  - Interview reminders arrive once.
  - No application should be stuck. Each one should have moved in the last 7 days, or be in a final state.
- **Rollback:**
  - For one employer or student: remove the id.
  - For everyone: set `FLAG_CAREER_TIMELINE=off`.
- **In-flight items when rolled back:**
  - Pilot applications fall back to the old job routes, using the old status field. The timeline kept that field in
    sync: applied → pending, offer → interview, withdrawn → rejected.
  - Scheduled interviews stay stored but disappear from both sides. Interview reminders stop, because the reminder job
    checks the flag.
  - The employer has to re-send any upcoming interview the old way. **Before switching off, ask each pilot employer to
    note their upcoming interviews from their candidate pipeline. The admin portal shows funnel counts, not a list of
    interviews.**
  - Open offers can no longer be accepted in the app. Verified hires and the timeline history are kept.
  - Notifications already queued are still delivered.
  - If you switch it back on, the stored timeline comes back as it was. Old-route changes made in between are folded in
    as `LEGACY_STATUS`.

### FLAG_RESUME_STUDIO_V2 (AI Resume Studio)
- **Test script:**
  1. The test student opens Resume Studio, pastes a job and tailors their resume.
  2. They accept or reject each change, preview the draft (it is labelled DRAFT) and approve it.
  3. They apply to the test employer's job with the approved version.
  4. The employer opens the sent resume, and it is the same PDF.
- **Watch:**
  - `[resume-studio] tailor job failed` lines in the logs.
  - Tailoring jobs ending `TIMED_OUT` or `FAILED`.
  - Model cost per day.
  - PDF preview and export volume, and 429 `RATE_LIMITED` replies on the PDF routes (limit: 30 per student per 10
    minutes).
- **Rollback:**
  - For one user: remove the id.
  - For everyone: set `FLAG_RESUME_STUDIO_V2=off`.
- **In-flight items when rolled back:**
  - Students lose Resume Studio. Their old resumes, and the old resume routes, are unchanged.
  - Drafts stay stored, and their 30-day expiry keeps running. Approved versions and the snapshots sent to employers
    are kept.
  - **An employer whose id is removed can no longer open a tailored snapshot that was sent with an application
    (404).** Remove employers last, or keep the pilot employers' ids until those applications are decided.
  - A tailoring job that is running finishes or times out. Its result is waiting when the flag comes back on.

### FLAG_SURPLUS_BOXES (Surprise Box)
Needs `SURPLUS_CODE_SECRET` set on Railway (32+ characters). Without it, holds and orders are refused, and the log
says `[surplus] … not configured`.
- **Test script:**
  1. The test brand publishes a box with a pickup window starting in about 1 hour.
  2. The test student holds the box, accepts the terms and confirms the order.
  3. The student receives a pickup reminder 30 minutes before the window.
  4. At pickup, the brand verifies the code with "paid at pickup" ticked.
  5. A second order goes uncollected and becomes NO_SHOW after the window ends.
  6. The student opens a support case on the second order, and an admin decides it.
- **Watch:**
  - In Admin → Surprise boxes, check the cases, orders and no-shows.
  - The no-show rate for each brand.
  - `[surplus sweep] … failed` lines in the logs.
  - Students who report that the brand had no box.
  - Food complaints (case reasons).
- **Rollback (normal), which protects orders already placed:**
  1. In Admin → Surprise boxes → Brands, **block** each pilot brand, with a reason. This stops new listings, holds and
     orders. Verifying pickup still works.
  2. Wait until the last pickup window of the day has ended and those orders are completed or no-show.
  3. Then set `FLAG_SURPLUS_BOXES=off`, or remove the ids.
- **Rollback (emergency, e.g. a food safety issue):**
  1. Block the brands as in the normal rollback.
  2. Set `FLAG_SURPLUS_BOXES=off`.
  3. **Also set `JOB_SURPLUS_SWEEP=off`.**
  4. Contact each student with an order waiting for pickup. The orders are in Admin → Surprise boxes → Orders, and the
     admin pages keep working while the variable is set to anything other than empty or `off`. If you used `off`,
     temporarily set the flag to the test ids to reach the admin pages.
- **In-flight items when rolled back:**
  - With the flag off, students get a 404 for their orders, so they cannot see the pickup code. Brands get a 404 for
    their Surprise Box page, so they cannot verify a pickup.
  - The sweep still runs, so orders waiting for pickup would be marked **NO_SHOW** at the end of their window, and
    students would get a no-show push. That is why the normal rollback waits, and the emergency rollback stops the sweep.
  - Holds expire on their own after 10 minutes once the sweep runs again.
  - No money is involved, because payment happens at pickup.

### FLAG_EMPLOYER_FIRST_HIRE_FREE (First Hire Free)
Needs `FLAG_CAREER_TIMELINE` on for the same employer, because a hire is only verified through the timeline.
- **Test script:**
  1. The test employer submits company details, and an admin approves them with a reason.
  2. The employer activates the free hire.
  3. The employer completes a verified hire, as in the career test script.
  4. In Admin → Billing ledger there is one `free_hire_used` row with fee 0.
  5. A second hire is recorded as `pending pricing`, and nothing is charged.
- **Watch:**
  - Admin → Company verifications: how many are waiting and how long they wait.
  - Admin → Free-hire trials.
  - Admin → Billing ledger: one row per verified hire, never two.
  - `[trial] reconcile` lines in the logs.
- **Rollback:**
  - For one employer: remove the id.
  - For everyone: set `FLAG_EMPLOYER_FIRST_HIRE_FREE=off`.
- **In-flight items when rolled back:**
  - The employer's First Hire Free page returns 404.
  - Company verifications, trials and billing rows are kept.
  - Hires confirmed while the flag is off are **not** recorded in the ledger.
  - **If you switch it back on, the next reconcile goes through hires confirmed since the company was approved. A hire
    made while the flag was off can then use the free hire.** That is usually the intended result. If not, an admin
    can review it in Admin → Free-hire trials.
  - Nothing is ever charged, in either state.

### FLAG_CAREER_MATCHING (candidate matching, decision support)
Needs `FLAG_CAREER_TIMELINE` for the same employer and candidate, because the panel and the sort live on the
candidate pipeline. Value: `ids:<employer id>,<student id>`, with both sides listed.
- **Test script:**
  1. The test student has a resume with a few skills and applies to the test employer's job (one that lists skills).
  2. In the portal's candidate drawer, "match evidence" shows:
     - the mandatory criteria (met / not met / unknown);
     - each listed skill with the resume text that shows it;
     - the estimate and how it's worked out.
  3. Pick the job, then "sort by relevance": the order changes and nobody disappears.
  4. The student adds a skill to their resume: reopen the drawer, and it's now matched.
- **Watch:**
  - employers relying on the number rather than the evidence. Ask in the pilot calls;
  - shortlisting by cohort (fresher / experienced, institution, city), only for groups of 5 or more
    (`docs/MATCHING_FAIRNESS.md`);
  - `[career-matching]` log lines.
- **Rollback:**
  - For one employer or student: remove the id.
  - For everyone: set `FLAG_CAREER_MATCHING=off`.
- **In-flight items when rolled back:**
  - The panel and the sort disappear; the pipeline is back to newest first.
  - Nothing else changes: matching never wrote to an application.
  - Stored match snapshots stay, for reproducibility, and are deleted with the student's account.

### FLAG_CAREER_RATINGS (mutual ratings)
Needs `FLAG_CAREER_TIMELINE`, because ratings follow a completed interview or a verified hire. Value:
`ids:<employer id>,<student id>`.
- **Test script:**
  1. After the career test script's interview is recorded completed, the employer rates the candidate in the portal
     drawer, and the student rates the employer in the app (the application's timeline).
  2. Check that each side sees the other's rating only once both have rated (or after 14 days).
  3. Check that the student's job details show no average until the employer has 5 ratings.
  4. The student reports the employer's rating as unfair. In Admin → Ratings reports, hide it with a reason.
- **Watch:**
  - Admin → Ratings reports: how many, and how fast they're decided;
  - comments refused by the filter (support messages about "offensive words" that weren't);
  - retaliation patterns (low ratings right after a low rating).
- **Rollback:**
  - For one person: remove the id.
  - For everyone: set `FLAG_CAREER_RATINGS=off`.
- **In-flight items when rolled back:**
  - The rating forms, the averages, the received lists and the admin page disappear.
  - Ratings and reports stay stored. When it's switched back on, ratings still inside their 14-day window can be
    given again.
  - Nothing else ever used them.

**Loyalty notifications** (under `FLAG_LOYALTY_V2`):
- **What students get:** a push and an in-app notification for:
  - each counted visit;
  - a tier unlock;
  - an admin reversal.
- **Settings:** students turn pushes off with the new "loyalty" switch (shown to pilot students only).
- **Pushes go out only while the `pushes` background job is on.** Watch the `LoyaltyNotice.push` values: `sent`,
  `quiet_hours`, `pref_off`, `failed: …`.
- **Rollback:** the loyalty rollback above also stops them. Already-sent in-app notifications stay.

## Rollback rehearsal (do once before stage 2, about 30 minutes)
Use test accounts only, in production.
1. Set `FLAG_SURPLUS_BOXES=ids:<test student>,<test brand>`, then wait for the restart.
2. As the test brand, publish a box whose pickup window starts in 40 minutes and lasts 30 minutes.
3. As the test student, order 1 box and note the pickup code.
4. **Normal rollback:**
   1. In Admin → Surprise boxes → Brands, block the test brand.
   2. Check that the student cannot hold a new box: the listing is gone.
   3. Check that the existing order still shows its code.
   4. During the window, check that the brand can still verify the code.
5. Unblock the brand. Publish a new box with a window that starts in 5 minutes and ends 10 minutes later. Order 1 box.
6. **Emergency rollback:**
   1. Set `FLAG_SURPLUS_BOXES=off` and `JOB_SURPLUS_SWEEP=off`, then wait for the restart.
   2. Check that the student's app hides Surprise Box within 5 minutes (or after signing out and in).
   3. Check that the order API answers 404.
   4. Wait until the window has ended, then check that the order is **not** NO_SHOW. Look in Admin → Surprise boxes →
      Orders, after temporarily setting the flag to the test ids.
7. **Restore:**
   1. Set the flag back to `ids:<test student>,<test brand>`, then delete `JOB_SURPLUS_SWEEP`.
   2. Within a minute the sweep marks the order NO_SHOW (expected: its window is over), and the student gets one
      no-show notification.
8. Do the same for one two-sided flag:
   1. Remove the test student from `FLAG_CAREER_TIMELINE` while that student has an interview scheduled.
   2. The application shows its old status on the old screens.
   3. Add the student back: the timeline and the interview return unchanged.
9. Write down the time each restart took and anything unexpected, in the pilot log.
