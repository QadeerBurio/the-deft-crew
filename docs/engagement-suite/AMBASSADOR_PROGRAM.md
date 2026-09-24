# Campus crew: the ambassador program inside the app

Goal: give people who apply as ambassadors one system where **they** see their progress and what they've earned,
**we** see exactly how they use the app, what they bring in and whether it's real, and their social posts
build word of mouth and FOMO.

This upgrades CREW_SYSTEM §4 ("campus crew"). Where they conflict, this file wins. It reuses the crew points
and levels (CREW_SYSTEM), rewards and credentials (REWARDS_AND_CREDENTIALS), and the admin portal crew section (P24).

Mirrored in both repos. Keep them identical.

---

## 1. Who becomes a crew lead

| Path | How | Changes vs CREW_SYSTEM §4 |
|---|---|---|
| **Direct appointment** | Admin enters the person's email or phone in the portal. If they have an account they're appointed now; if not, they get an **invite code** (`CREW-XXXX`) and are appointed at signup. | **new.** This is for people who applied outside the app (a form, Instagram, events). |
| **Apply in app** | "become a campus crew lead." on the crew screen → `crew_lead` agreement → short form | **Open to everyone from day one.** The Main Character gate is removed so new students can apply. |
| GOAT level | automatic | unchanged |

**Seats per campus: 3 leads per university** (config). The app shows **"2 of 3 crew seats taken at IBA."** When a
campus is full, new applicants join a **waitlist** and are told their position. This keeps quality high and adds FOMO.

**Trial month:** a new lead is `lead (trial)` for 30 days. They're confirmed if they meet the trial targets
(section 2.3). Otherwise the admin can extend or end the trial with a note. The student sees their trial checklist.

**First cohort:** everyone appointed before **31 Dec 2026** gets the permanent **"founding crew"** badge.

---

## 2. What the ambassador sees: the "crew hub" in the app

It lives on the crew screen (`components/Points.js`), shown only when `crew.role === 'lead'`, **above** the level
ladder. Nothing is added to Home (rule 2: one ask at a time).

```
crew hub · iba · trial day 12 of 30
────────────────────────────────────────
this month
  47 link opens → 18 joined → 11 sorted a card → 7 still active after a week
  ███████████████░░░░░  11 / 15 target
  rank at iba: #1 of 3 · all campuses: #4 of 21

lead by example                       ✓ 8/8 sorted  ✓ 9 day streak  ○ redeem a deal this week

this week's drop preview (24h early, post it first)
  [ story image ]  [ save ]  [ copy caption ]

your share kit
  [ "i'm tdc's crew lead at iba" ]  [ "11 friends joined with my code" ]  [ "i saved rs 3,420" ]
  your link: go.gettdc.pk/r/X7K2PQ   [ instagram ] [ whatsapp ] [ tiktok ] [ copy ]

posts
  + submit a post (link + screenshot)
  ● reel, 3 oct · approved · +300 pts · 6 signups
  ● story, 8 oct · reviewing

tasks
  ● host a stall at iba fest · 500 pts · due 20 oct   [ submit ]

next reward: experience certificate at 90 days as lead (in 58 days)
```

### 2.1 Funnel numbers (all computed on the server)

| Step | Source |
|---|---|
| link opens | `ReferralClick` (section 4.1) |
| joined | `User.referredBy === lead` |
| sorted a card (verified) | the referred user's `sortedCount >= 1`. This is what earns the 100 points (CREW_SYSTEM §2). |
| still active after a week | the referred user has any `EngagementEvent` 7–14 days after signup |

The **still-active-after-a-week** number is shown to the ambassador on purpose. It teaches them that bringing real
users counts, not just signups.

### 2.2 Share kit (word of mouth)

- **Personal story images** made on the device with `react-native-view-shot` (installed), in brand style:
  black background, the dot in a mood, lowercase line, their code. Templates:
  "i'm tdc's crew lead at {campus}." · "{n} friends joined with my code." · "i've saved rs {saved} on tdc." ·
  "{campus} is {rank} on tdc this month."
  Share through `expo-sharing` to Instagram, WhatsApp or TikTok.
- **Captions** (copy button) in the brand voice, served from the copy bank so the social team can update them.
- **Drop preview:** leads get tomorrow's daily drop **24 hours early** as a story image, so they're the ones "leaking" it.
  This is the main FOMO lever: their followers see it first from a friend, not from tdc.
- Every share button uses a **tracked link per channel** (`?s=ig|wa|tt|copy`), so we know which channel works for each lead.

### 2.3 Targets (config, per month)

| Target | Trial month | After confirmation |
|---|---|---|
| verified friends (sorted a card) | 10 | 15 |
| approved posts | 2 | 4 |
| own app use: active weeks | 3 of 4 | 3 of 4 |
| tasks done | 1 | 1 |

Targets show as progress bars. Hitting all of them in a month earns a **"target hit" bonus of 300 points**. Missing
them isn't punished in the app. The admin sees it (section 3) and decides.

### 2.4 What they get (all non-cash, delivered through REWARDS_AND_CREDENTIALS)

| When | Reward |
|---|---|
| appointed | "crew lead" badge (+ "founding crew" if before 31 Dec 2026), crew lead pip next to their name in the Feed |
| confirmed after trial | **appointment letter signed by Majid** (PDF, verifiable) |
| every month | points for verified friends, approved posts and tasks; target-hit bonus |
| 90 days as lead | **experience certificate** (verifiable, one tap to add to their CV) |
| 6 months as lead | **recommendation letter from Majid** + LinkedIn recommendation |
| top lead of the month (all campuses) | spotlight on @tdc.app + a brand perk |
| path to Founder Circle | leads earn points fastest, so the 10,000-point application is realistic within about 4–6 months |

---

## 3. What we see: admin portal "ambassadors" screens

Add them to the admin portal crew section (P24). Two new screens:

### 3.1 `CrewAmbassadors.js`: a table of every lead

| Column | Meaning |
|---|---|
| name, campus, status | trial / confirmed / paused; days as lead |
| **joined (7d / 30d)** | signups with their code |
| **verified %** | joined who sorted a card. **Below 40% gets a red flag** (possible fake or low-quality signups). |
| **active after a week %** | quality of the people they bring |
| own usage | last active, current streak, sorted x/8, redeemed this month (a lead should be a real user) |
| posts | submitted / approved this month, total approved reach |
| best channel | the channel with the most joins (ig / wa / tt / copy) |
| tasks | done / open |
| points this month | |
| **health** | green (on target), amber (on track for at least 50% of target), red (inactive 7+ days, or verified % < 40) |

Filter by campus and status, sort by any column, and export to xlsx (`xlsx` is already in the portal).

### 3.2 Ambassador detail drawer

- **Timeline:** appointed → trial checklist → posts → tasks → rewards issued.
- **Referral list:** the people who joined with their code: first name + campus + joined date + verified + active.
  Show no contact details. That's enough to spot patterns such as 10 signups in 5 minutes.
- **Posts gallery:** screenshots + links, with approve/reject and a reach tier (section 4.3).
- **Their own usage:** missions, streak, redemptions, last 30 days of activity (a small bar chart; the portal has `recharts`).
- **Actions:** confirm trial / extend / pause / end (with a note, which the student sees), award points, issue a letter, message (sends a push + in-app notification).

### 3.3 Campus view

For each university: leads (x of 3 seats), waitlist, signups this month, verified %, and a **top channel**.
This shows where to recruit next.

---

## 4. Tracking word of mouth

### 4.1 Tracked links (new)

`GET /r/:code` (public, backend, e.g. `go.gettdc.pk/r/X7K2PQ?s=ig`):
1. Logs a `ReferralClick { code, channel, ua, ipHash, at }`.
2. Redirects Android to the Play Store with `referrer=utm_source%3D{channel}%26utm_campaign%3D{code}`
   (same format `Points.js` already builds at L580). iPhone and desktop go to a small landing page that shows
   **"ali invited you. 70+ brands, student prices."** with the code in large text and a copy button, then the App Store.

### 4.2 Crediting the referral without typing (fixes the current leak)

- **Android:** on first launch, read the Play Install Referrer with `expo-application`
  (`Application.getInstallReferrerAsync()`), parse `utm_campaign`, and store it as `pendingReferralCode` in AsyncStorage.
  This needs `expo-application` added, which is a native module, so it goes in the same EAS build as P0/P19.
- **iOS:** there's no install referrer, so the landing page's copy button plus the code field at signup is the fallback.
  If the app is already installed, `tdcapp://signup?ref=CODE` opens signup with the code filled in. This needs a
  `linking` config on `NavigationContainer` (none exists today).
- `SignupScreen.js` already reads `route.params.ref` (L229). Also read `pendingReferralCode` from AsyncStorage,
  prefill the field, and show "invited by ali." above it.
- **Invited-friend perk (two-sided):** a friend who signs up with a code gets a **welcome perk** (a brand-funded first-deal bonus,
  non-cash) and the pop-up "ali invited you. your first deal is on us." They have a reason to use the code, and the
  ambassador has a better pitch.

### 4.3 Social posts

`POST /api/crew/posts { platform: 'instagram'|'tiktok'|'whatsapp'|'linkedin'|'other', kind: 'story'|'reel'|'post'|'status', url?, screenshotUrl, caption? }`

The admin approves and picks a **reach tier**:

| Tier | Rule of thumb | Points |
|---|---|---|
| base | approved, any reach | 50 |
| good | 1k+ views or 50+ story replies/reactions | 150 |
| great | 5k+ views | 300 |
| **drove signups** | at least 5 joins on that channel within 72h of the post (automatic) | +200 bonus |

The "drove signups" bonus is calculated automatically from `ReferralClick` + signups by channel and time window, so
the posts that actually bring people in are rewarded most.

### 4.4 Anti-abuse

- Points only for **verified** friends (they sorted a card), never for raw signups.
- Flag signups from the same device install ID (`expo-application` `getAndroidId` / `getIosIdForVendorAsync`, hashed)
  under one code more than twice, and signups more than 5 within 10 minutes under one code.
  Flagged referrals earn nothing until an admin clears them.
- Posts need admin approval. A screenshot is required.

---

## 5. FOMO mechanics (and the rule they respect)

| Mechanic | Where the FOMO comes from | Plan rule respected |
|---|---|---|
| 3 seats per campus + waitlist | scarcity, visible in the app | no pressure pushes; it's shown on the crew screen only |
| "founding crew" badge (before 31 Dec 2026) | a time-limited status that stays forever | badges stay rare (rule "keep it rare") |
| drop preview 24h early | ambassadors' followers see it first | the drop is real content, not promo |
| personal story cards with real numbers | social proof from a friend, not an ad | copy is lowercase with no emoji, and the dot is the emoji |
| campus rank among leads | competition between campuses | leads only; the public leaderboard stays off until stage 3 |
| invited-friend perk | "use my code, your first deal is on us" | brand-funded perk, no cash |
| monthly spotlight on @tdc.app | public recognition | – |

What **isn't** done: no pushes to ambassadors' friends, no "your friend is waiting" nags, no fake scarcity
(the seats are real and the numbers are real).

---

## 6. Backend additions

```js
// EngagementProfile.crew (CREW_SYSTEM §6) gains:
crew: { ..., role: 'none'|'lead', leadStatus: { enum: ['trial','confirmed','paused','ended'] },
        appointedAt, trialEndsAt, confirmedAt, appointedBy, appointedVia: { enum: ['admin','apply','goat'] },
        foundingCrew: Boolean }

// models/CrewInvite.js      (direct appointment for people without an account yet)
{ code: 'CREW-XXXX' unique, emailOrPhone, university, createdBy, usedBy, usedAt, expiresAt }

// models/ReferralClick.js
{ code, referrer: ObjectId, channel: { enum: ['ig','wa','tt','li','copy','other'] }, uaHash, ipHash, at }   // TTL 400 days

// models/CrewPost.js
{ user, platform, kind, url, screenshotUrl, caption, status: { enum: ['submitted','approved','rejected'] },
  reachTier: { enum: ['base','good','great'] }, signupsAttributed: Number, points: Number, reviewedBy, reviewedAt, note }

// models/CampusSeat.js      (or config + a count query)
{ university: ObjectId unique, seats: Number /* default 3 */, waitlist: [{ user, at }] }

// User: add `signupMeta: { referralChannel, installReferrer, deviceHash }` at signup (auth.routes.js ~L149–196)
```

**Endpoints**

```
Public
GET  /r/:code?s=ig                          → log ReferralClick, then redirect (Android → Play with referrer; else landing)
GET  /invite/:code                          → landing HTML ("ali invited you.")

Student (crew.routes.js)
GET  /api/crew/hub                          → { status, trial: { day, of, checklist }, campus: { name, seatsTaken, seats },
                                              funnel: { opens, joined, verified, activeWeek }, targets: [...], rank: { campus, overall },
                                              leadByExample: [...], dropPreview: { image, caption } | null,
                                              shareKit: { link, channels: [...], cards: [...] }, posts: [...], tasks: [...], nextReward }
POST /api/crew/posts                        → { status: 'submitted' }
POST /api/crew/apply                        → pending, or { waitlisted: true, position } when the campus is full
POST /api/crew/invite/:code/redeem          → appoint (also accepted as `crewInviteCode` at signup)

Admin (adminCrew.routes.js)
GET  /api/admin/crew/ambassadors?campus=&status=   → table rows (section 3.1)
GET  /api/admin/crew/ambassadors/:userId           → detail (section 3.2)
POST /api/admin/crew/ambassadors/appoint { emailOrPhone, university } → { appointed: true } | { inviteCode }
POST /api/admin/crew/ambassadors/:userId/status { status: 'confirmed'|'trial'|'paused'|'ended', note, extendDays? }
POST /api/admin/crew/posts/:id/review { status, reachTier, note }
GET  /api/admin/crew/campuses                      → section 3.3
POST /api/admin/crew/referrals/:userId/clear-flag
```

**Scheduled jobs** (in the engagement scheduler, PKT):
- daily 02:00: recompute each lead's funnel, health and ranks (cached on the profile), apply the "drove signups" post bonus, and flag abuse
- day 1 of each month, 09:00: close last month's targets (award the target-hit bonus) and queue the spotlight candidate for the admin inbox
- when a trial ends: put the lead in the admin inbox with their checklist result

---

## 7. App changes (where)

| Place | Change |
|---|---|
| `components/Points.js` (crew screen) | the crew hub block (section 2) for leads. For everyone else, a "campus crew" card showing seats at their campus and "apply" (or "waitlist #2"). |
| `screens/SignupScreen.js` | prefill the code from `pendingReferralCode`, show "invited by {name}.", and accept a `CREW-XXXX` invite code in the same field (the server tells them apart) |
| `App.js` | first-launch install-referrer read (Android), and a `linking` config for `tdcapp://signup?ref=` |
| `app.json` / `package.json` | add `expo-application` (native, same build as P0/P19) |
| new `engagement/crew/ShareCard.js` | the 4 story-card templates rendered off-screen for `view-shot` |
| new `engagement/crew/SubmitPostSheet.js` | platform, kind, link, screenshot (`expo-image-picker`, installed) |
| `PostCard.js` | crew lead pip (priority: founder > crew lead > top badge), never on confessions |

---

## 8. Packets

| Packet | Repo | Creates | Modifies | Acceptance |
|---|---|---|---|---|
| **P25 Ambassador backend** | backend | the models and endpoints in §6, `routes/referralLink.routes.js` (`/r`, `/invite`), `services/engagement/ambassador.js` (funnel, health, rank, abuse flags), `tests/ambassador.test.js` | `routes/auth.routes.js` (signupMeta, invite code at signup), `crew.routes.js`, `adminCrew.routes.js`, the scheduler | the funnel counts match a seeded test; a flagged referral pays 0 until cleared; the 4th applicant at a campus is waitlisted; an appointment by email works before and after the person signs up |
| **P26 Ambassador app** | app | the crew hub, `ShareCard.js`, `SubmitPostSheet.js` | `Points.js`, `SignupScreen.js`, `App.js` (install referrer + linking), `app.json`, `PostCard.js` | an Android install from a `/r/CODE` link shows "invited by …" with the code prefilled and no typing; share cards export with real numbers; a submitted post shows "reviewing" |
| **P27 Ambassador admin** | `tdc_admin_portal` | `src/screens/crew/CrewAmbassadors.js`, `AmbassadorDrawer.js`, `CrewCampuses.js` | the crew section in `AdminDashboard.js` (P24) | the table sorts and filters, exports xlsx, and flags a lead with verified < 40%; confirming a trial issues the appointment letter task |

**Phase:** this is the part of the crew system to ship **first**, because it works at today's size (10–30
ambassadors doesn't need 100+ weekly users). The suggested order inside phase 3 is P25 → P26 → P27, then the rest of
the crew and credential packets. If you want ambassadors running earlier, P25 + P27 alone (direct appointment,
tracked links, admin table) can go live in **phase 1**, with ambassadors sharing links from day one while the
in-app hub follows. That early start needs the crew fields and the points ledger from P2/P15, and the
portal shell from P24, pulled forward with it.
