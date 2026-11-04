# Security review: Sprints 1-6 (Sprint 7)

Scope: everything added in Sprints 1-6 on the server (loyalty, career timeline, Resume Studio, Surprise Box, First
Hire Free, analytics, and the Sprint 1 hotfixes), and the portal/app screens that call it. Method: the permission
matrix (`tests/permissions/run.js`, 680 checks), an injection / input fuzz (`tests/security/run.js`), the leak
scanners in every suite, and a read of the routes and services.

## Findings

| # | Area | Finding | Status |
|---|---|---|---|
| 1 | Injection | `POST /api/surplus/merchant/orders/:id/transition` with an object or array as `version` reached the query as `NaN`: **500**. Nothing was changed or leaked (the update matched nothing), but it's a crash on bad input. | **Fixed** (`fix/security-review`): `400 INVALID_VERSION`. |
| 2 | Auth (policy) | Admins may act for an employer on the hiring timeline (shortlist, interviews, offers, **confirm a hire**). Sprint 3 design: support actions, each in the admin audit. An admin-confirmed hire counts as a verified hire and uses the company's First Hire Free entitlement. | **Decision needed** (see below). Not changed. |
| 3 | Rate limits | No global rate limit. Per-feature limits exist: Resume Studio tailoring (10 an hour, 2 at once per student), Surprise Box pickup codes (10 wrong codes / 10 min per brand), holds and orders bounded by business rules, the Woo webhook limiter. **Not limited**: Resume Studio PDF preview / export (CPU), analytics admin overview (reads every redemption in the range), loyalty quotes, First Hire Free verification resubmits. All need a signed-in account of the right role (pilot accounts only while flags are scoped). | **Recommendation**: per-user limiter on the PDF and analytics routes before `pct:` stages. Not added (it changes behaviour). |
| 4 | Rate limits | The wrong-pickup-code limiter is in memory, per server instance. With one Railway instance that's the real limit; with several, it's per instance. | Note for scaling. |
| 5 | Ownership | Every route x 8 roles behaves as designed (680/680). "Not yours" answers 404 (ids can't be probed). Employers see only their own jobs' candidates, attachments and figures; brands only their listings, orders and figures. | OK |
| 6 | Injection | 462 operator / array / oversized probes on 39 write routes, malformed ids on every `:id` route, query-string operators (`?a[$ne]=`): no 500 (after #1), no operator accepted as an id or code. Express 5's simple query parser never makes objects. Body ids are checked with `isId` before any query; codes and strings are coerced with `String()`. A global `mongoose.set("sanitizeFilter")` is **not** used: it would also neutralise operators the code builds itself. | OK |
| 7 | Input limits | JSON bodies over 100 KB are refused (413) before routes run. Free text is trimmed and truncated (job descriptions 12,000 chars, notes 300-1,000, titles 80-200). | OK |
| 8 | PII in responses | Leak scanners in every suite: no password hashes, push tokens, ID-card images, contact details in career / surplus / analytics replies. Employers see a candidate's first name only (surplus) or the career timeline's fields; NTN / SECP numbers only in the employer's own and admin replies; analytics never contain student names and hide groups under 5 students. | OK |
| 9 | PII in logs | New modules log ids, codes of errors and counts, never request bodies, e-mails, phones, tokens, pickup codes or registration numbers. Sprint 1 `logSafety` redacts URLs and tokens. | OK |
| 10 | Secrets | None in the repository (the only connection string is a fake test fixture for the redaction test). New code reads `OPENAI_API_KEY`, `OPENAI_MODEL`, `SURPLUS_CODE_SECRET` (dedicated, ≥32 chars, no fallback) and flags. | OK |
| 11 | Audit | Admin writes recorded: career timeline (admin audit), loyalty reversals (ledger actor + reason), Surprise Box cases and brand blocks (history), First Hire Free (`CareerAdminAudit`, reason required). | OK |

## Decisions for the owner
1. **Admin acting as employer (#2).** Options: keep (support can fix a stuck hire; audited), or restrict admins to
   corrections only (`HIRE_REVOKED`) so a verified hire always needs the employer. Recommendation: restrict
   `HIRE_CONFIRMED` to the employer before First Hire Free goes beyond test ids.
2. **Rate limits (#3).** Recommendation: a per-user limiter (e.g. 30 / 10 min) on Resume Studio PDF preview/export and
   the analytics overview, before the `pct:10` stage.
