# First Hire Free

Behind `FLAG_EMPLOYER_FIRST_HIRE_FREE` (off by default), per employer: `FLAG_EMPLOYER_FIRST_HIRE_FREE=ids:<employer id>`.
Hires come from the hiring timeline, so the employer (and the student) also need `FLAG_CAREER_TIMELINE`.
Admin pages work once the flag is set for anyone. Flag off: the routes answer 404, no trial or ledger rows are
written and the hiring timeline behaves exactly as before.

## Rules
- One fee-waived verified hire per **verified company group**. A company is verified by an admin from: company
  name, NTN or SECP registration number, business e-mail domain (free-mail domains refused) and website.
- Same registration number, e-mail domain or website as another account = the same company group →
  `duplicate_review`. An admin approves (joins the group: no second trial), approves as a separate group
  (only with a different registration number), rejects, or marks it a duplicate. Every decision needs a reason
  and is written to `CareerAdminAudit`.
- The trial (`EmployerHiringTrial`, one per group) is activated by an approved employer; activation is idempotent.
- It is consumed only when a hire becomes verified on the timeline (`HIRE_CONFIRMED`: the candidate accepted the
  offer and the employer confirmed), exactly once per hire, and only by a hire confirmed after activation. Never
  by a job post, application, shortlist, interview or offer. Hires before the company's approval are ignored.
- Every other verified hire of a pilot employer is recorded as `hire_billable_pending_pricing` (amount null).
- A verified hire revoked within 7 days (candidate dispute, or admin) restores the free hire
  (`free_hire_restored`); revoked later, the trial goes to `under_review` and an admin restores, keeps or revokes.
- An admin who rejects the dispute restores the hire (`HIRE_RESTORED`, with a reason). It counts again, exactly once:
  - if the company's trial is still active and unused, it uses the free hire again (`free_hire_consumed`, fee 0);
  - if another hire used the free hire meanwhile, it is recorded as `hire_billable_pending_pricing`;
  - if the hire still holds its free hire or a pending row (the dispute came after the 7 days, or it was never
    free), nothing new is recorded.

  Each of these is audited on the trial (`trial.restored_hire_used_free_hire` / `trial.restored_hire_pending_pricing`)
  with the admin's reason. Free hires consumed minus restored always equals the trial's `consumedCount`.
- **No charging**: `EmployerHiringBillingEvent` is a ledger only (no payment provider, no invoices). Employers
  see "pricing for further hires is coming soon"; no prices.
- Not changed: employer sign-up, the admin approve-user toggle, and unverified employers posting jobs.

## Pieces
- Collections (new): `EmployerCompanyVerification`, `EmployerHiringTrial`, `EmployerHiringBillingEvent`,
  `CareerAdminAudit`.
- `services/career/trialService.js` (hooks on the timeline's after-commit events; `reconcile()` catches up hires a
  hook missed, with the same idempotency keys).
- `routes/careerTrial.routes.js` under `/api/career` (see its header).
- Tests: `tests/first-hire-free/run.js`.
