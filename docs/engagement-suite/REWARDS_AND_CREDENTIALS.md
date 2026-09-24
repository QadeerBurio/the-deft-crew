# Rewards, credentials and agreements

How students see **what they're signing up for and what they'll get**, how rewards like badges,
certificates and recommendation letters are **issued inside tdc**, and how anyone can
**verify** them. It extends `CREW_SYSTEM.md` (levels, crew lead, Founder Circle).

**Signer on every document: Majid, Founder, tdc.**

Three codebases are involved:
- backend `the-deft-crew`
- app `The-Deft-Crew-App`
- admin portal `tdc_admin_portal` (React 19 CRA, lucide-react, framer-motion, axios to the Railway API; sidebar in `src/screens/AdminDashboard.js`)

This file is mirrored in the backend and app repos. The admin portal packet (P24) is written here
because this session can only read that repo, not push to it.

---

## 1. What exists today

| Need | Today |
|---|---|
| Badge a student can show | `components/DigitalBadgeScreen.js` is static: the same "DEFT ROOKIE" icon for everyone, with no name, no date and nothing to verify |
| Certificate / recommendation letter | promised on the tier screens; nothing creates or delivers them |
| What a student agrees to | nothing: no terms, no record of agreeing |
| When or how a reward arrives | not stated anywhere |
| Admin issuing rewards | no screen; the portal has card, offer, job, exchange and brand screens only |
| Reusable pieces | `pdfkit` + `services/pdfService.js` (resume PDFs), `qrcode`, Cloudinary (`config/cloudinary.js`), `react-native-pdf` + `expo-sharing` in the app, and `Resume.certifications[]` with `credentialId`/`credentialUrl` fields |

---

## 2. What the student sees before earning or applying

### 2.1 Level detail pages (the 5 existing tier screens)

Keep `DigitalBadgeScreen`, `MainCharacterScreen`, `DeftProScreen`, `DeftGoatScreen` and `FounderCircleScreen`.
Give all five the same structure, filled from `GET /api/crew/levels/:id` so the wording lives on the server:

```
deft pro.                                   ← level name, lowercase, full stop
2,450 / 3,000 pts  ████████████░░░          ← progress (or "unlocked 12 oct.")

what you get
  ● recommendation letter      pdf · signed by majid · within 7 days
  ● instagram feature          post on @tdc.app · within 14 days
  ● internship consideration   we share your profile with partner companies

how to get there
  friends who join +100 · missions +50 · streaks · crew tasks

what we ask                                  ← only for crew lead and founder circle
  (short summary of the agreement, link "read the full agreement")

[ share ]  or  [ apply ]                     ← apply only for crew lead / founder circle
```

- **Delivery chip** on every reward: `format · who · when`. Formats are `badge` (instant), `pdf` (issued by Majid),
  `card` (instant), `link` (Instagram / LinkedIn) and `perk` (brand perk code). The "when" is a promise we track (§4.4).
- There's no cash text anywhere (per CREW_SYSTEM §3).

### 2.2 Agreements ("i agree")

There are three agreements. Each is versioned, with the text served from the server and edited in the admin portal (§5).

| Agreement | Shown when | Key points it must cover |
|---|---|---|
| `crew_terms` | the first time the crew screen opens | points have **no cash value**, can't be transferred or sold, tdc can remove points gained by fraud, levels and rewards can change with 14 days' notice, rewards already earned are kept |
| `crew_lead` | before applying to be a campus crew lead | what a lead does, about 3 hrs/week, code of conduct, **no pay** (points, perks and credentials only), tdc can end the role, they can step down anytime, how their name/photo may be used on @tdc.app |
| `founder_circle` | before applying to Founder Circle | seat rules (50, closes 31 Mar 2027), what founders get (CREW_SYSTEM §3), what's expected (feedback sessions, beta testing), removal only for misconduct, the seat and card are personal |

**The agreement sheet in the app** is a bottom sheet in the same modal style as the sign-out modal. It has the
title, a scrollable body (rendered from markdown), and a checkbox "i've read this." that only becomes enabled
after scrolling to the end, then a gold button "i agree." It saves with `POST /api/crew/agreements/:kind/accept { version }`.

**When the agreement changes:** publishing a new version with `requiresReaccept: true` shows the sheet again on the
next visit. The apply endpoints return `428` with `{ agreement: kind, version }` if the current version hasn't been
accepted.

**App copy is lowercase** (brand rule). **Agreement text and documents use normal sentence case.** They're
formal and get read by employers.

---

## 3. What the student gets: "my rewards"

### 3.1 On the crew screen (`components/Points.js`)

Add a **"my rewards"** block under the level ladder, with one row per earned reward:

```
my rewards
  ● deft rookie badge          delivered   ›
  ● experience certificate     delivered   ›
  ● recommendation letter      preparing · by 19 oct   ›
  ● instagram feature          preparing · by 26 oct   ›
```

Status chips: `delivered` (gold), `preparing · by <date>` (grey), `late` (panic dot. It shows if the promised date
has passed, and it also puts the item at the top of the admin inbox, so the promise is visible to both sides).

### 3.2 Reward detail screen (new `RewardDetailScreen`, registered in the drawer stack)

| Kind | What it shows | Actions |
|---|---|---|
| badge | the **live badge** (from the redone `DigitalBadgeScreen`): level art, **their name**, earned date, credential code | share image (`react-native-view-shot` + `expo-sharing`), copy verify link |
| certificate / letter | a PDF preview with `react-native-pdf` (installed) | **download / share PDF**, copy verify link, **"add to my cv"** |
| founder card / Gold card | opens `Card` | – |
| link (Instagram, LinkedIn) | the link, and the date it was posted | open link |
| perk | the code sheet (same as the reward redemption) | copy |

**"Add to my CV"** calls `PUT /resume/:id` (through `api/resumeApi.js:132`) and appends to `certifications[]`:
`{ name: credential.title, organization: 'tdc (The Deft Crew)', issueDate, credentialId: code, credentialUrl: verifyUrl }`.
If they have more than one resume, a picker lists them. If they have none, it goes to `ResumeBuilder`.

### 3.3 Verification (public, no login)

- Every credential has a **code** like `TDC-7K2P-9QX4` and a **verify URL**:
  `https://the-deft-crew-production.up.railway.app/verify/TDC-7K2P-9QX4`.
  Point a `verify.gettdc.pk`-style domain at it later.
- The page (server-rendered HTML, black header with the "tdc." wordmark) shows: **Valid** / **Revoked**, the student's
  name, the credential title, level, issue date, "Signed by Majid, Founder, tdc", and for letters a short excerpt.
  **No email, phone or university ID.**
- The PDF has a QR code in the footer (backend `qrcode` package) that links to this page.

---

## 4. How rewards are issued

### 4.1 What happens automatically vs by hand

| Reward | Issued | How |
|---|---|---|
| Level badge (every level) | **automatically** on level-up | a `Credential { kind: 'badge' }` with a code, delivered instantly |
| Gold card (Main Character) / founder card | automatically | existing card logic (CREW_SYSTEM §6) plus a wallet row |
| Experience certificate (Main Character) | **automatically**, with a template and Majid's stored signature | PDF generated on level-up. No admin step, since the template content is factual (level, dates, points). |
| Recommendation letter (Pro), crew lead appointment letter, founder letter | **by Majid** | an `AdminTask` → drafted from a template in the admin portal → Majid edits → issue |
| Instagram feature, LinkedIn recommendation | by hand, outside the app | `AdminTask` → admin pastes the link → marked delivered |
| Internship consideration / referral | by hand | `AdminTask` → admin notes the company → delivered |
| Brand perk | automatically (reward catalog) | as in CREW_SYSTEM §7 |
| Manual badge (e.g. "confession of the day", special recognition) | by an admin, anytime | admin portal "award badge" |

### 4.2 Letter templates (drafts Majid edits)

Templates are stored server-side (`CredentialTemplate`) with placeholders filled from real data:

```
{{name}} has been part of tdc (The Deft Crew) since {{joinedMonth}} and reached {{levelName}}
on {{levelDate}}. During this time {{firstName}} {{contributionSummary}}.
...
Majid
Founder, tdc
```

`contributionSummary` is built from the ledger: verified referrals, crew tasks done (with titles),
streak best, and months active. Majid rewrites anything before issuing. The **issued text is frozen** on the
credential, so later template edits never change it.

### 4.3 The PDF (`services/credentialPdf.js`, reusing pdfkit patterns from `services/pdfService.js`)

- A4 portrait. Black header band with the white "tdc" + gold "." wordmark on the left, and the document type on the right.
- Title (e.g. "Letter of Recommendation"), date, recipient line ("To whom it may concern"), then the body.
- **Signature image** (uploaded once in admin settings), then "Majid", then "Founder, tdc".
- Footer: credential code, the verify URL, and a QR code (60px).
- Uploaded to Cloudinary under `credentials/` as a raw file. Only the URL is stored.
- Generation happens on issue (a synchronous request is fine at this volume; about 1s).

### 4.4 Delivery promises

Each reward kind has a `slaDays` in `config/crew.config.js`: letter 7, Instagram 14, LinkedIn 14,
internship referral 30. An `AdminTask.dueAt` is set on creation. The nightly engagement cron flags overdue tasks
(the admin inbox shows them in red, and the student's row shows `late`). At the moment of delivery the student gets
a pop-up plus a transactional push: "your recommendation letter is ready. signed by majid."

---

## 5. Admin portal: new "crew" section (`tdc_admin_portal`)

Add a sidebar section `crew` in `src/screens/AdminDashboard.js` `menuItems` (same shape: `{ id, label, icon, section: 'crew' }`,
lucide icons), rendered with the existing `switch` (next to `case "card_manager"`). New screen files go in `src/screens/crew/`.
Follow the `CardManager.js` look: lucide icons, framer-motion `AnimatePresence` drawers, axios with the Bearer token from `AuthContext`.

| Sidebar item | Screen | What it does |
|---|---|---|
| **Crew inbox** (badge count) | `CrewInbox.js` | One queue of everything waiting on a person, **overdue first**: letters to write, Instagram/LinkedIn to post, lead and founder applications, crew task submissions. Each row opens the matching drawer. |
| Applications | `CrewApplications.js` | Tabs for lead / founder. The drawer shows the applicant's profile, level, points breakdown, missions, streak, verified referrals, agreement version accepted, and their answers. **Approve / Reject** with a note. |
| Crew tasks | `CrewTasks.js` | Create a task (title, description, points, audience: leads / everyone / one user, university, deadline). A submissions tab with proof → approve (awards points) / reject. |
| **Issue credential** | `IssueCredential.js` | Opened from an inbox letter task, or "new" for a one-off. A left pane has the template-drafted text in an editable textarea. A right pane has a **live PDF preview** (`POST /admin/crew/credentials/preview` returns a PDF blob). **Issue** → confirm dialog ("this will be signed by Majid and sent to Ali Raza.") → done. |
| Credentials | `CrewCredentials.js` | Every issued credential: search by name or code, open the PDF, copy the verify link, **revoke** with a reason (the verify page then shows Revoked). |
| Points & badges | `CrewPoints.js` | Look up a student, see the ledger, **award or deduct points** with a reason, **award a badge** (pick from the badge list + a note). |
| Agreements | `CrewAgreements.js` | Edit the three agreements (markdown editor + preview), **publish a new version**, toggle "requires re-accept", and see acceptance counts per version. |
| Settings | `CrewSettings.js` | Upload the **signature image** (PNG, transparent), signer name ("Majid") and title ("Founder, tdc"), and edit the letter templates. Only role `admin` can see this. |

The portal's API base is hardcoded in each screen today (`https://the-deft-crew-production.up.railway.app/api`).
For the new screens, add one `src/api/crewApi.js` with that base, and don't copy the URL into each file.

---

## 6. Backend additions

**Models**

```js
// models/Credential.js
{ code: { type: String, unique: true },            // 'TDC-XXXX-XXXX', Crockford base32, no ambiguous chars
  user: ObjectId, kind: { enum: ['badge','certificate','recommendation_letter','appointment_letter','founder_letter'] },
  title: String, level: String, badgeId: String|null,
  body: String,                                     // frozen issued text (letters)
  pdfUrl: String|null,
  signer: { name: 'Majid', title: 'Founder, tdc', signatureUrl },
  issuedAt: Date, issuedBy: ObjectId|null,          // null = automatic
  status: { enum: ['issued','revoked'] }, revokedAt, revokedReason,
  adminTask: ObjectId|null }

// models/CredentialTemplate.js
{ kind, title, body /* with {{placeholders}} */, updatedBy, updatedAt }

// models/AgreementVersion.js
{ kind: { enum: ['crew_terms','crew_lead','founder_circle'] }, version: Number, title, body /* markdown */,
  requiresReaccept: Boolean, publishedAt, publishedBy }            // unique (kind, version)

// models/AgreementAcceptance.js
{ user, kind, version, acceptedAt, platform, appVersion }        // unique (user, kind, version)

// models/CrewSettings.js  (a single document)
{ signer: { name, title, signatureUrl }, slaDays: { recommendation_letter: 7, ... } }

// AdminTask (CREW_SYSTEM §6) gains: dueAt: Date, credential: ObjectId|null, deliveredLink: String|null
```

**Student endpoints** (add to `routes/crew.routes.js`)

```
GET  /api/crew/levels/:id                 → { id, name, min, progress, unlockedAt,
                                              rewards: [{ kind, title, description, format, by, whenText }],
                                              expectations: string|null, cta: 'share'|'apply'|null, agreement: kind|null }
GET  /api/crew/agreements/:kind           → { kind, version, title, body, accepted: bool }
POST /api/crew/agreements/:kind/accept    { version } → { ok: true }        409 if the version isn't current
GET  /api/crew/rewards/mine               → [{ id, kind, title, status: 'delivered'|'preparing'|'late', dueAt,
                                              credential: { code, pdfUrl, verifyUrl } | null, link: string|null }]
POST /api/crew/credentials/:code/add-to-resume { resumeId } → { ok: true }
```

The apply endpoints (CREW_SYSTEM §7) return `428 { agreement, version }` until the current version is accepted.

**Public**

```
GET /verify/:code          → HTML page (mounted in server.js before the /api routes, with rate limiting via express-rate-limit, already installed)
GET /api/verify/:code      → { valid, name, title, level, issuedAt, signer: 'Majid, Founder, tdc', status }
```

**Admin** (add to `routes/adminCrew.routes.js`, `isAdmin`)

```
GET  /api/admin/crew/inbox                              → { overdue: [...], letters: [...], links: [...], applications: [...], submissions: [...] }
POST /api/admin/crew/credentials/draft { adminTaskId }  → { title, body }       (template filled)
POST /api/admin/crew/credentials/preview { title, body, userId } → application/pdf (not stored)
POST /api/admin/crew/credentials/issue { adminTaskId?, userId, kind, title, body } → { credential }
POST /api/admin/crew/credentials/:code/revoke { reason }
GET  /api/admin/crew/credentials?query=
POST /api/admin/crew/admin-tasks/:id/deliver-link { link }
POST /api/admin/crew/badges/award { userId, badgeId, note }
GET/POST /api/admin/crew/agreements/:kind  (list versions / publish new)
GET/PUT  /api/admin/crew/settings  (+ POST settings/signature, multipart → Cloudinary)
GET/PUT  /api/admin/crew/templates/:kind
```

**Automatic issuing hooks** (`services/engagement/crew.js` `onLevelUp`): create the badge credential. For Main
Character, also create the certificate credential with its PDF. Create `AdminTask`s (with `dueAt`) for the manual
rewards, and add wallet rows for everything.

**Guard:** automatic PDFs need `CrewSettings.signer.signatureUrl`. If it's missing, the certificate becomes an
`AdminTask` instead of failing.

---

## 7. Packets

| Packet | Repo | Creates | Modifies | Acceptance |
|---|---|---|---|---|
| **P22 Credentials backend** | backend | the models in §6, `services/credentialPdf.js`, `services/credentialCode.js`, `routes/verify.routes.js`, the §6 endpoints, `tests/credentialCode.test.js` | `server.js` (mount `/verify`), `services/engagement/crew.js` (onLevelUp), `routes/crew.routes.js` (428 agreement gate) | a Main Character level-up creates badge + certificate PDF with a working QR; verify shows Valid, then Revoked after revoke; no email/phone on the verify page; the issued text doesn't change when the template is edited |
| **P23 Rewards UI (app)** | app | `engagement/screens/RewardDetailScreen.js`, `engagement/components/AgreementSheet.js`, `MyRewardsList.js` | the 5 tier screens (shared layout from `/crew/levels/:id`), `DigitalBadgeScreen.js` (live name/date/code), `components/Points.js` (my rewards block, agreement gate before apply), `DrawerNavigator.js` (register) | apply is impossible without agreeing; a PDF opens, shares and is added to the CV with `credentialId`/`credentialUrl`; the late chip shows after `dueAt` |
| **P24 Crew section (admin portal)** | `tdc_admin_portal` | `src/api/crewApi.js`, `src/screens/crew/*` (8 screens in §5) | `src/screens/AdminDashboard.js` (menuItems + switch cases) | Majid can go from inbox to draft, edit, preview and issue a letter in under 2 minutes; the signature upload shows on the preview; the student sees "delivered" within a minute |

**Phase:** P22–P24 ship with the crew system in **phase 3** (2–14 Nov). Main Character is the first level where
someone gets a certificate, so the automatic certificate path has to work first. Letters (Pro) can follow a week later.

**P24 needs push access to `tdc_admin_portal`.** This session only has read access, so either attach it with push
access or give the packet to whoever works on that repo.
