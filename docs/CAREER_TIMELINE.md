# Hiring timeline (Sprint 3)

The career timeline tracks one job application from "applied" to a verified hire. Every step is a
recorded event with who did it, when, and from where. The candidate app and the employer portal read the
same server-side state.

All of it is behind `FLAG_CAREER_TIMELINE`, which is off by default. With the flag off, every route and
screen behaves exactly as before.

- Code: `services/career/`, `routes/career.routes.js` (`/api/career`), and
  `services/career/legacyAdapter.js` (the existing job routes, for pilot applications only).
- Tests: `tests/career/run.js`.

## The flag

`FLAG_CAREER_TIMELINE` must be on for **both** the job's employer and the candidate. For example:

```
FLAG_CAREER_TIMELINE=ids:<employer user id>,<student user id>
```

- **External or imported jobs** have no employer on TDC, so only the candidate's flag counts there.
- **Clients:** the flag appears as `careerTimeline` in `GET /api/app/flags/me`, never in the public
  `GET /api/app/flags`.
- **A candidate outside the pilot** keeps the old screens and the old behaviour, even when the employer
  is in it.

## Records (new collections; no existing schema changed)

| Collection | What it holds |
|---|---|
| `CareerApplicationEvent` | Append-only steps. `seq` is the application's version. A unique `(application, seq)` index is the optimistic version check, and the `idempotencyKey` is unique. |
| `CareerInterview` | The slot, stored in UTC with its time zone (default Asia/Karachi), plus the mode and the meeting link or location. `calendarUid` never changes; `calendarSequence` goes up on every change. One active interview per application. |
| `CareerOffer` | Title, terms and an answer deadline. One open offer per application. No salary or contact details are needed. |
| `CareerOutcome` | "Hired via TDC" or "Interviewed via TDC". Private by default, and it can be revoked. |
| `CareerNotificationOutbox` | One row per event, recipient and channel (unique). Delivery state and retries. |

## Events and who may write them

| Event | Who | Allowed when |
|---|---|---|
| APPLIED | system | When the application is created. Applications from before the pilot get APPLIED plus LEGACY_STATUS (`source: legacy`) on their first write; reading them writes nothing. |
| REVIEWED | employer | The stage is applied. |
| SHORTLISTED | employer | The stage is applied or reviewed. |
| REJECTED | employer | The application is open and there's no accepted offer. |
| WITHDRAWN | candidate | The application is open. It also cancels a pending interview and closes an open offer. |
| INTERVIEW_INVITED | employer | The stage is reviewed, shortlisted or interview, with no active interview and no slot conflict. |
| INTERVIEW_RESCHEDULED, INTERVIEW_CANCELLED | employer | An interview is invited, accepted, or has a reschedule request. |
| INTERVIEW_ACCEPTED | candidate | An interview is invited. |
| INTERVIEW_DECLINED, INTERVIEW_RESCHEDULE_REQUESTED | candidate | An interview is invited or accepted. |
| INTERVIEW_COMPLETED | employer | The interview is accepted **and** its slot has started. Scheduled ≠ completed. |
| CANDIDATE_NO_SHOW_REPORTED | employer | Same as INTERVIEW_COMPLETED. It's a report only and is never penalised automatically. |
| EMPLOYER_NO_SHOW_REPORTED | candidate | Same as INTERVIEW_COMPLETED. |
| INTERVIEW_DISPUTED | candidate | After a completion or no-show was recorded. A reason is required. |
| OFFER_SENT | employer | The stage is shortlisted, interview or offer, with no open offer. The deadline is 1 hour to 90 days away. |
| OFFER_WITHDRAWN | employer | The offer is sent. |
| OFFER_ACCEPTED, OFFER_DECLINED | candidate | The offer is sent and its deadline hasn't passed. |
| HIRE_CONFIRMED | employer (the job's own; never an admin) | The offer is **accepted** and no hire was recorded before. This is the verified hire. |
| HIRE_DISPUTED | candidate | Within 7 days of HIRE_CONFIRMED. A reason is required. The hire is revoked at once and the dispute is open. |
| HIRE_REVOKED | admin | The hire is verified (a correction), or its dispute is open (dispute upheld). A reason is required, and the action is audited. |
| HIRE_RESTORED | admin | The dispute is open: rejected, the hire is verified again and can't be disputed again. A reason is required; audited. It never uses a free hire. |

**Every write is checked for:**
- the role, from the database;
- ownership: an employer can act only on their own jobs, and a candidate only on their own application;
- the version the caller last saw: a stale version gets 409 `VERSION_CONFLICT`;
- the transition rule above: a disallowed step gets 409 `INVALID_TRANSITION`, with the allowed actions.

An `Idempotency-Key` header makes a retry return the event it already wrote. Admin reads and writes are
recorded as `career.admin.access` DomainEvents.

## Compatibility adapter: stage → `JobApplication.status`

The timeline projects onto the existing status field, so old screens stay consistent.

| Timeline stage | `JobApplication.status` | Note |
|---|---|---|
| applied | pending | |
| reviewed | reviewed | |
| shortlisted | shortlisted | |
| interview | interview | The old `interviewDate` / `interviewNotes` fields are kept in step. |
| offer (sent or accepted) | interview | The old enum has no "offer". |
| hired | hired | **Only on a verified hire** (offer accepted + employer confirmed). |
| hire disputed or revoked | interview | The stage returns to offer. |
| rejected | rejected | |
| withdrawn | rejected | The old enum has no "withdrawn"; the timeline keeps WITHDRAWN. |

**The old job routes, for pilot applications only:**
- **Status changes:** `PATCH /api/jobs/application/:id/status` and `/candidates/bulk-status` turn reviewed,
  shortlisted and rejected into timeline events. They refuse `hired`, `pending` and `interview` with 409
  `USE_CAREER_TIMELINE`.
- **The old interview routes:** schedule, reschedule, cancel and complete answer 409 `USE_CAREER_TIMELINE`.
- **Apply** records APPLIED.

## External and deleted jobs

- **External or imported jobs:** the timeline says "External application, outcome unverified". There are
  no interview, offer or hire events; the candidate can only withdraw.
- **A deleted (archived) job keeps its timeline.** Nothing new can start (410 `JOB_ARCHIVED`), but
  open work can be closed: reject, cancel an interview, record an interview, withdraw an offer, or
  confirm an accepted hire.

## Notifications

- **Who gets what:** after each committed event, the people concerned are queued in the outbox and the
  message is delivered.
- **Push:** through the existing `pushGateway`, as transactional messages. They skip the marketing caps
  but keep quiet hours (a later retry) and the student's jobs preference.
- **In-app:** a Notification without its own push.
- **Email:** only when a mail provider is already configured, and only for interviews, offers and hires.
- **The text:** names the job and company, never salary or contact details.
- **Retries:** with backoff, at most 5 attempts. A retry never writes the business event again.
  The background job `careerOutbox` (`JOB_CAREER_OUTBOX`: on in production, off in staging) delivers
  what's due every 5 minutes; `POST /api/career/admin/outbox/drain` does the same on demand.
- **Quiet hours:** a push is held back 30 minutes at a time, without using up an attempt.
- **Interview reminders:** 24 hours and 1 hour before an **accepted** interview, queued by the same job.
  The candidate gets push and in-app; the employer gets in-app. Each reminder is queued once per slot,
  and a moved interview gets fresh ones. A reminder is never delivered after the interview starts, or
  for an interview that was cancelled, declined or moved since it was queued.
- **Calendar file:** interviews have a `.ics` at `GET /api/career/interviews/:id/ics`. The UID is
  stable and `SEQUENCE` goes up on every change, so calendars replace the old slot. A cancelled or
  declined interview gets `METHOD:CANCEL`.

## Analytics: counting rules

`GET /api/career/employers/me/analytics` (own jobs) and `GET /api/career/admin/analytics` (everything,
audited) count distinct applications from events only.

| Metric | Counted when |
|---|---|
| submitted | The timeline started with APPLIED from the app. Pilot applications that started later count as "joined the pilot later". |
| reviewed | Any employer decision: reviewed, shortlisted, rejected, interview invited or offer sent. |
| interviews completed | INTERVIEW_COMPLETED, with no later dispute. Scheduled interviews never count. |
| verified hires | HIRE_CONFIRMED (or a later HIRE_RESTORED), with no HIRE_DISPUTED or HIRE_REVOKED after it. Accepted offers alone never count. |
| disputes | INTERVIEW_DISPUTED + HIRE_DISPUTED + HIRE_REVOKED events. |
| median hours | From APPLIED to the first employer decision, the first interview invite, and the verified hire. |

## Retention policy (no automatic job yet)

- **Kept for 2 years:** timeline events, interviews, offers, outcomes and outbox rows, counted from the
  application's last event.
- **After 2 years, anonymised rather than deleted:**
  - candidate and employer ids are replaced by a one-way hash;
  - notes and terms are cleared, as are meeting links and locations;
  - outbox payloads are emptied;
  - event types, times and counts stay, so funnel analytics remain correct.
- **Public outcomes are excluded from anonymisation** for as long as the student keeps them public. A student can
  make an outcome private, which is the default, at any time.
- **Account deletion:** the existing account-deletion flow is the place to apply this to one person
  early. It isn't wired yet; the deletion job and this policy should be connected before the pilot
  widens.
- **No scheduled job exists for this yet.** Building it is a separate, reviewed change.

## Testing with one employer, one job and one student

1. Set `FLAG_CAREER_TIMELINE=ids:<employer id>,<student id>` in Railway (staging first) and restart.
2. As the employer, post a job (an existing one works too). As the student, apply in the app.
3. Portal → Candidates (Kanban): the student appears under Applied. Review, then shortlist, then
   schedule an interview with a time in Asia/Karachi and a meeting link. Download the `.ics`.
4. App → Jobs → My applications: the invite is there. Accept it, or ask for another time. Add it to your
   calendar from the `.ics`.
5. Once the interview time has passed, record it as completed in the portal, then send an offer with a
   deadline.
6. In the app, accept the offer. The old screens now show "interview", not "hired".
7. In the portal, confirm the hire. The student sees "Hired via TDC" (private) and can dispute it for 7
   days.
8. Admin portal → Hiring funnel: the counts match these steps.
9. Remove the flag: everything is back to the old behaviour.
