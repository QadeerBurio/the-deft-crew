# Pilot plan (2 weeks)

Who takes part, what they agree to, the day-by-day schedule, and how we decide whether each module moves to `10%`
(`docs/ROLLOUT.md`, stage 3). Every measure below is a number the admin Overview page, brand Insights or employer
Hiring results already shows (`services/analytics/businessAnalytics.js`, `services/career/careerAnalyticsService.js`).
They are counted only from authoritative records: brand-confirmed bills, verified pickup codes, timeline events. They
are never counted from claims, holds, views or scheduled interviews.

**The targets are proposals: confirm or change them before day 1.**
Per-brand and per-employer figures built from fewer than 5 students are hidden by design, so pilot cohorts need at
least 5 students per brand and per employer, or the numbers have to be read from the admin pages.

## Who to recruit

| Module | Flag | Recruit | Students |
|---|---|---|---|
| Brand loyalty | `FLAG_LOYALTY_V2` | **1 brand** with steady student footfall that already confirms redemptions in tdc (QR "redeem payment" or promo confirm), ideally with 2+ visits a month per regular | 30–50 students who have redeemed at that brand before |
| Surprise Box | `FLAG_SURPLUS_BOXES` | **2–5 food merchants** with predictable end-of-day surplus (bakeries, cafés), each able to list at least 3 days a week, staff at the counter who can verify a code in the portal | 50–100 students in the merchants' cities, near the branches |
| Hiring timeline + First Hire Free | `FLAG_CAREER_TIMELINE`, `FLAG_EMPLOYER_FIRST_HIRE_FREE` | **1–2 employers** with a real opening to fill within 2 weeks, a registered company (NTN or SECP number) and a company e-mail domain | 20–40 students who fit the openings and apply through tdc |
| Resume Studio | `FLAG_RESUME_STUDIO_V2` | the same 1–2 employers (they must see the snapshots sent with applications) | the hiring students, plus 20–30 others who are actively applying |

Put all of them in the flag values as `ids:` (`docs/ROLLOUT.md`). Keep a pilot sheet with, for every participant:
account id, module, contact, the date they agreed, and the date they left if they left.

## What participants agree to (in writing, a short message or form is enough)

**Everyone**
- It's a pilot. Features may change or be switched off at short notice, and we will tell them when that happens.
- We may contact them for feedback, and they report problems through in-app support or the pilot contact.
- Data is handled as in the privacy policy. Analytics are counted without student names, and per-brand or per-employer
  figures are hidden below 5 students.

**Loyalty brand**
- Honour the tier discount the portal shows at the till: 15% for visits 1–5, 25% from visit 6. It replaces the
  offer's own discount for pilot students.
- Only confirm real bills. Report refunds or voids so an admin can reverse the visit (reversals are logged with a
  reason).
- Keep the loyalty program active for the 2 weeks.

**Surprise Box merchants**
- tdc takes no money and has no role in payment: the student pays at pickup.
- Every listing states its contents (or "contents may vary"), allergens, best-before and the pickup window. The
  merchant is responsible for food safety and the accuracy of those disclosures.
- Hold every confirmed order until the end of its pickup window, and verify the code in the portal at handover.
- Cancel through the portal only (the student is notified). Repeated merchant cancellations are reviewed.
- Answer support cases within 24 hours. An admin decides disputes.
- tdc can pause the merchant's listings (block) at any time.

**Students (Surprise Box)**
- Pay at pickup and collect within the window.
- Cancel up to 30 minutes before pickup starts. A missed pickup is recorded as a no-show (not a ban during the pilot).
- Read the allergen information. tdc doesn't prepare the food.

**Employers**
- Submit real company details for verification.
- Use the timeline for the pilot openings: move candidates through it, record interviews only once they have
  happened, and confirm a hire only after the candidate has accepted and actually starts.
- The first verified hire is free, and **nothing is charged for any hire during the pilot**. Further hires are
  recorded as "pending pricing", and any future pricing will be agreed separately before anything is charged.
- Treat sent resumes as confidential and use them only for this opening.

**Students (hiring / Resume Studio)**
- Resume Studio only rewrites what is already in their resume. They check every suggested change and approve the final
  version themselves, and they are responsible for what they send.
- A "hired" outcome is private unless they make it public, and they can dispute it within 7 days.

## Schedule

**Before day 1:**
- the rollout stage 1 (test ids) has passed on Android and iOS;
- `SURPLUS_CODE_SECRET` is set;
- the rollback rehearsal is done;
- the decisions in `docs/RELEASE_CHECKLIST.md` are signed off;
- participants are recruited and have agreed.

| Day | What happens |
|---|---|
| 1 (Mon) | Add pilot ids to all five flags, then a short onboarding call with each brand, merchant and employer: portal walk-through, who to call. Loyalty program goes live. Employers submit company details; admin decides within 1 working day. |
| 2 | Students get a message (in-app or WhatsApp) about the features they can use. First Surprise Box listings (each merchant lists at least once by day 3). Employers post or attach the pilot openings. |
| 3 | First check-in: look at every watch item in `docs/ROLLOUT.md`, and fix or answer anything raised. Employers activate First Hire Free after approval. |
| 4–5 | Normal use. Daily 10-minute log and support review (every day of the pilot). |
| 6–7 | Weekend: Surprise Box only if merchants list. No hiring actions expected. |
| 8 (Mon) | **Mid-pilot review:** read the measures below for days 1–7, call each brand, merchant and employer (10 minutes each), fix issues. Decide whether any participant should be replaced. |
| 9–12 | Normal use. Employers should be at the interviews or offers stage by now. Push any stuck applications by contacting the employer. |
| 13 | Last day for new Surprise Box orders in the pilot window (listings may continue). Short feedback survey to students. |
| 14 (Sun) | Pilot ends at 23:59 (Karachi time). Keep the flags as they are, and don't remove anyone. |
| 15–16 | **Go / no-go per module:** read the measures with the range set to days 1–14, collect feedback, write the decision in the pilot log. Go = stage 3 (`ids:<pilot ids>;10%`). No-go = stay on pilot ids, fix, or roll back as in `docs/ROLLOUT.md`. |

## Success measures (days 1–14)

All figures come from the admin **Overview** page with the range set to the pilot dates, unless another page is named.

**Brand loyalty** (Overview → Discounts and Loyalty, brand Insights):

| Measure | Definition (as the page counts it) | Proposed target |
|---|---|---|
| Counted visits | loyalty credits that counted as a visit, each tied to a brand-confirmed redemption | ≥ 60 |
| Repeat rate | student-brand pairs with 2+ redemptions / all student-brand pairs | higher than the same brand's previous 2 weeks |
| Members reaching tier 2 | members by tier: "Regular" (6+ visits) | reported (not a target in 2 weeks) |
| Reversals | credits reversed by an admin (refund, void, fraud) | ≤ 5% of counted visits, each with a reason |
| Credit failures | `[loyalty] credit … failed` log lines | 0 unexplained |

**Surprise Box** (Overview → Surprise Box, Admin → Surprise boxes):

| Measure | Definition | Proposed target |
|---|---|---|
| Orders placed | confirmed orders (holds and views are not orders) | ≥ 40 across merchants |
| Pickup rate | orders whose pickup code the brand verified / orders not cancelled | ≥ 80% |
| No-shows | orders not collected by the end of the window | ≤ 15% of orders placed |
| Cancelled by brand | merchant cancellations | ≤ 5% of orders placed |
| Disputes | orders in DISPUTED | ≤ 5%, every one decided within 48 hours |
| Food-safety complaints | support cases with a food reason | 0 serious; any serious one = stop (`docs/ROLLOUT.md` emergency rollback) |
| Collected at pickup | money the brand marked paid at pickup (merchant revenue, not tdc's) | reported |

**Hiring timeline and First Hire Free** (Overview → Hiring funnel and Employers, employer Hiring results):

| Measure | Definition | Proposed target |
|---|---|---|
| Applications | applications whose timeline started in the range | ≥ 20 |
| Submitted → reviewed | applications with an employer decision / applications | ≥ 80% |
| Median first employer response | hours from apply to the first employer decision (submitted through the timeline) | ≤ 72 h |
| Interviews completed | interviews recorded completed (not disputed afterwards); scheduled ones don't count | ≥ 5 |
| Verified hires | hire confirmed and not disputed or revoked afterwards | ≥ 1 |
| Companies verified / time to decide | approved company verifications; pending ones waiting | all decided within 1 working day |
| Free hires consumed | `free_hire_consumed` billing rows minus restored | equals verified hires of pilot companies (max 1 each); never 2 for one company |
| Disputes | interview and hire disputes or revocations | each one resolved, reason recorded |

**Resume Studio** (Overview → Resume Studio card; tailoring requests are kept 30 days, so read it within the pilot):

| Measure | Definition | Proposed target |
|---|---|---|
| Approved versions | tailored versions the student approved | ≥ 30 |
| Applications sent with an approved version | snapshots attached to applications | ≥ 10 |
| Failed or timed-out tailoring jobs | jobs ending `FAILED` or `TIMED_OUT` / all jobs | ≤ 5% |
| Fabrication reports | students or employers reporting a fact that wasn't in the source resume | 0 (any confirmed one = stop and fix before 10%) |
| Employer snapshot mismatch | an employer can't open, or sees a different PDF from, what the student approved | 0 |

**Across all modules**
- No P1 incident: wrong money shown, data visible to the wrong account, lost order or application.
- 5xx responses on the pilot routes below 0.5%.
- Feedback: most participants would keep using the feature, from the day 13 survey and the day 15 calls.

## Roles
- **Pilot owner:** recruits, signs off agreements, runs the day 8 and day 15 calls, makes the go / no-go call.
- **On-call engineer:** daily log and watch review, rollbacks (`docs/ROLLOUT.md`), fixes.
- **Admin (support):** company verifications, Surprise Box cases, loyalty reversals, within the response times above.
