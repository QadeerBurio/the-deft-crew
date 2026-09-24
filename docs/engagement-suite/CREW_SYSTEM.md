# The crew: one loyalty system (points, levels, campus crew, Founder Circle)

This replaces three separate ideas with one: the referral ladder in `Points.js`, the planned points
balance, and the separate Founder Circle scoring. Everyone who uses tdc is in the crew. They earn
**crew points** for real use, their **level** comes from lifetime points, and they spend points as
**credit** on brand perks. There's no cash anywhere.

Where this conflicts with `BLUEPRINT.md` §3.4, §4.6 and §5 (rewards), `UI_PLACEMENT.md` §7 and §9,
or `LAUNCH_AND_FOUNDER_CIRCLE.md` Part B, **this file wins**. The Founder Circle *card design*
(Part B §B.5) is unchanged and still applies.

How rewards are delivered (badges, certificates, Majid's letters, verification), what students agree to,
and the admin portal screens are in `REWARDS_AND_CREDENTIALS.md` (packets P22–P24).

Mirrored in both repos. Keep them identical.

---

## 1. Rules

1. **One number.** Crew points come from the `PointsLedger` (BLUEPRINT §3.3), and every award goes through `points.award()`.
2. **Two views of that number:**
   - **Lifetime points** = the sum of every positive award. This sets the **level** and never goes down.
   - **Balance** = lifetime minus what they've spent. This is the **credit** for rewards. Spending never lowers the level.
3. **Only real use earns** (plan rule 1): no points for app opens, likes or story views.
4. **No cash.** Rewards are credit, perks, documents, roles and the Founder Circle card.
5. All numbers live in `config/crew.config.js`, so they can be tuned without an app release.

## 2. Ways to earn

| Action | Points | Dedupe key | Notes |
|---|---|---|---|
| **Verified referral:** a friend signs up with their code **and** sorts 1 card | 100 | `ref:{referrer}:{friend}` | awarded when the friend's first card flips, not at signup, so fake signups earn nothing |
| Each Get Started mission sorted | 50 | `mission:{user}:{feature}` | 400 for all 8 |
| Fully sorted bonus | 200 | `fully:{user}` | |
| Streak milestone 7 / 30 / 100 | 50 / 250 / 1,000 | `streak:{user}:{n}:{startDay}` | 3/14/50 are pop-ups only |
| Badge | per badge | `badge:{user}:{id}` | savings badges 100 / 250 / 500 |
| **Crew work** (logged by an admin) | 100–500 | `crew:{taskId}` | section 4 |
| Spend on a reward | −cost | `redeem:{redemptionId}` | lowers the balance only |

**Referral change (backend):** `routes/auth.routes.js` signup (~L149–196) keeps incrementing
`referralCount` (existing screens read it), and also stores `referredBy`, which is already there.
The 100 points are awarded in `engine.js` step 4 the first time the *referred* user's
`sortedCount` goes 0→1: `if (user.referredBy) award(user.referredBy, 100, 'referral', ...)`.

## 3. Levels

| Level (existing name kept) | Lifetime points | What that looks like | Rewards (no cash) |
|---|---|---|---|
| **Crew member** | 0 | installed | savings counter, missions |
| **Deft Rookie** | 300 | missions + 1 friend, first week | digital badge (existing `DigitalBadgeScreen`) |
| **Deft Main Character** | 1,000 | e.g. 10 friends, *or* missions + streak + 4 friends | **TDC Privilege Card (Gold), free for a year** + experience certificate |
| **Deft Pro** | 3,000 | about 2 months for an active referrer | recommendation letter + Instagram feature on @tdc.app + internship consideration |
| **Deft GOAT** | 6,000 | a real campus ambassador | **campus crew lead role** (section 4) + leadership access + internship referral |
| **Founder Circle** | 10,000 → **apply** | about 4–6 months as a crew lead | the founder edition card (Part B §B.5), founder letter + LinkedIn recommendation, quarterly 1:1 founder session, roadmap vote, lifetime Gold |

- **The Privilege Card moves.** Today it unlocks at 10 referrals (`/auth/activate-vip`). Now it unlocks at
  Main Character. 10 verified friends = 1,000 points = Main Character, so the referral path works the same
  as before. Anyone who already has `referralCount >= 10` or `isVip` keeps their card (see the migration).
- **Removed:** every cash reward (Main Character PKR 2,000, Pro 5,000, GOAT 10,000, Founder 15,000) and
  "guaranteed paid internship" (it becomes "internship referral"). These promises are in
  `Points.js` TIERS and the four tier screens.
- **Level-up moment:** a `level_up` pop-up (mood `excited`, "deft pro. you earned it.") with one button,
  "see your rewards", plus a transactional push. Rewards that need a person (letter, Instagram feature,
  role) create an **admin task** (section 6) so nothing gets forgotten.

## 4. Campus crew (ambassadors, inside the app)

> **Superseded by `AMBASSADOR_PROGRAM.md`.** It adds direct appointment, applying open to everyone (no Main Character gate),
> 3 seats per campus, the in-app crew hub, tracked links, social post review and the admin ambassador table.

- **Apply from Main Character.** The crew screen shows "become a campus crew lead." with a short form
  (university, why, Instagram). This is `POST /api/crew/apply` → `CrewApplication` (pending), and an admin approves it.
- **Approved crew leads** get `crew.role = 'lead'` and their university. The crew screen then shows a
  **"crew tasks"** list (below). A crew lead badge appears on their profile and next to their name in the Feed
  (never on confessions).
- **Crew tasks** are posted by an admin and earn points when an admin marks them done:

  | Example task | Points |
  |---|---|
  | host a campus drop / stall | 500 |
  | bring your society onto tdc (10+ verified signups) | 300 (plus the 100 per friend) |
  | film a "how to" story for @tdc.app that gets used | 200 |
  | run a user interview / beta test session | 200 |
  | feedback or bug that gets shipped | 100–300 |

  An admin can also award a one-off crew task to any user (not only leads) for "built it with us" work.
- **Stage 3** (500+ weekly users): a campus leaderboard (lifetime points by university, refreshed weekly) on the
  same screen. It stays off before that (plan stage rules).
- GOAT automatically gets the lead role if they don't already have it.

## 5. Founder Circle, simplified

- **Entry:** 10,000 lifetime points **and** all 8 cards sorted **and** an active account with no upheld
  reports in 90 days. When all three are met, the "apply" button unlocks. There's no separate score:
  points already include usage, streaks, referrals and crew work.
- **Apply:** `POST /api/crew/founder/apply` (one short question: "what did you build with us?").
  Majid reviews in admin, and approving creates the seat. The rest follows Part B:
  **50 numbered seats**, open until **31 Mar 2027**, then closed, with the founder edition card, lifetime Gold and
  the founder mark in the Feed.
- **Removed from Part B:** the founder score (§B.3), the `Contribution` model (crew tasks replace it),
  and the monthly candidates list (applications replace it). §B.4 rewards, §B.5 card design and §B.6 placement
  (invite moment, profile pill, card) stay, but "invite" becomes "approved".

## 6. Data model (on top of BLUEPRINT §3)

```js
// EngagementProfile additions
points: { balance: Number, lifetime: Number },            // already in BLUEPRINT §3.1
crew: {
  level: { type: String, enum: ['member','rookie','main_character','pro','goat','founder'], default: 'member' },
  levelReachedAt: Date,
  role: { type: String, enum: ['none','lead'], default: 'none' },
  university: ObjectId,
}

// models/CrewApplication.js
{ user, kind: { enum: ['lead','founder'] }, answers: Mixed,
  status: { enum: ['pending','approved','rejected'] }, reviewedBy, reviewedAt, note }

// models/CrewTask.js
{ title, description, points: Number, audience: { enum: ['leads','everyone','user'] },
  targetUser: ObjectId|null, university: ObjectId|null, active: Boolean, deadline: Date }

// models/CrewTaskCompletion.js   (unique: task + user)
{ task, user, status: { enum: ['submitted','approved','rejected'] }, proof: String, reviewedBy, pointsAwarded }

// models/AdminTask.js   (level rewards that need a person)
{ kind: { enum: ['letter','instagram_feature','internship_referral','founder_session','certificate'] },
  user, level, status: { enum: ['open','done'] }, doneBy, doneAt }

// FounderSeat: unchanged from Part B §B.7.   Contribution: dropped.
```

`Reward` / `RewardRedemption` (BLUEPRINT §3.4) are unchanged. They're the spend side.

**The level is computed on every award:** `levelFor(lifetime)` from config. When it goes up, set
`crew.level`, queue the `level_up` pop-up and create the `AdminTask`s for that level. Main Character also
calls the existing VIP activation logic on the server (`isVip = true`, `vipExpiry = +1 year`), moved out of
the client-triggered `/auth/activate-vip` path.

## 7. API

Mount `app.use('/api/crew', require('./routes/crew.routes'))`.

```
GET  /api/crew/me
200 {
  points: { balance: 2450, lifetime: 3100 },
  level: { id: 'pro', name: 'deft pro', min: 3000, next: { id: 'goat', name: 'deft goat', min: 6000 }, progress: 0.03 },
  levels: [{ id, name, min, rewards: [String], unlocked: bool, reachedAt|null }],
  waysToEarn: [{ key: 'referral', label: 'friend joins and sorts 1 card.', points: 100 }, ...],
  referral: { code: 'X7K2PQ', link, verified: 12, pending: 3 },
  crew: { role: 'none'|'lead', canApplyLead: bool, leadApplication: 'none'|'pending'|'rejected' },
  founder: { open: true, seatsLeft: 38, closesAt, canApply: bool, application: 'none'|'pending'|'approved'|'rejected', seat: null,
             checklist: [{ key: 'points', label: '10,000 points.', done: false }, { key: 'sorted_all', label: '8/8 sorted.', done: true }, { key: 'good_standing', label: 'good standing.', done: true }] },
  tasks: [{ _id, title, points, status: 'open'|'submitted'|'approved' }]      // leads, or tasks targeted at this user
}
GET  /api/crew/ledger?cursor=&limit=20       → { items: [{ delta, reason, label, createdAt }], nextCursor }
GET  /api/crew/rewards                        → the spend catalog (was /engagement/rewards)
POST /api/crew/rewards/:id/redeem             → 201 { redemption } | 409
POST /api/crew/apply        { university, why, instagram }      → { status: 'pending' }   403 below Main Character
POST /api/crew/founder/apply { answer }                         → { status: 'pending' }   403 if checklist incomplete, 409 if closed or full
POST /api/crew/tasks/:id/submit { proof }                       → { status: 'submitted' }

Admin (/api/admin/crew):
GET  applications?kind=lead|founder&status=pending
POST applications/:id/approve | reject { note }
CRUD tasks
POST tasks/:id/completions/:userId/approve | reject
POST award { userId, points, reason }        // one-off "built it with us"
GET  admin-tasks?status=open ; POST admin-tasks/:id/done
```

The BLUEPRINT §5 endpoints `/engagement/points/ledger`, `/engagement/rewards` and `/engagement/rewards/:id/redeem`
**move here**. `/engagement/me` keeps `points` and adds `level: { id, name }` for the header and profile.

## 8. App UI (inside the existing screens)

**One place:** the **Refer & Earn screen (`components/Points.js`) becomes the crew screen.** Keep the file,
the route name `Points` and the layout. Change the drawer label from "Refer & Earn" to **"the crew"**
(`DrawerNavigator.js` ~L152). The Profile "Loyalty Points" row (`ProfileScreen.js:503`, currently hardcoded
"250" + "Coming Soon") → `navigation.navigate('Points')`, with `rightText` = `` `${balance} pts` `` and the
subtitle = level name.

What changes in `Points.js`, top to bottom:

| Today | After |
|---|---|
| header "Refer & Earn" (L972) | "the crew." |
| `HeroProgressCard` (L193): ring = referrals out of 10 for the Privilege Card | ring = **progress to next level**. The centre shows the **balance** ("2,450 pts"), with the subtitle "deft pro · 2,900 to goat". Keep the ring component; change the `progress` input (L232) to `level.progress`. |
| – | **NEW "ways to earn"** row: a horizontal list of chips from `waysToEarn` ("friend joins +100", "sort a card +50", "7 day streak +50", "crew task +100–500") |
| "Achievement Tiers" list (`TierCard`, L355) based on `minDownloads` | the same `TierCard`, but driven by `levels[]`. `tier.minDownloads` → `tier.min`, and `currentDownloads` → `points.lifetime`. The label at L510 changes from "x/y downloads" to "x/y pts". The locked alert (L422) says "earn 900 more points to unlock deft goat." Remove the separate "TDC PRIVILEGE CARD" tier entry, since it's now listed as a Main Character reward. |
| Founder tier as the last ladder item | **Founder Circle card below the ladder** (black card from Part B §B.6): "founder circle. 10,000 pts + apply. 38 seats left. closes 31 mar." The checklist comes from `founder.checklist`, and the button is "apply" when `canApply`, else disabled. |
| – | **NEW "campus crew"** block: at Main Character or above, "become a campus crew lead." → apply form (bottom sheet). For leads, a "crew tasks" list with submit. |
| – | **NEW "spend your points"** block: 2-column reward tiles (`ModernOfferCard` style from Home) → redeem, then a code sheet. Then "history" (the ledger, 10 items + "see all"). |
| Download link, referral link, share button | **keep as is**, and move them into a "bring friends · +100 each" block under the hero. The share text says the friend needs to sort 1 card for it to count. |
| `checkAndActivateVIP` (the client calls `/auth/activate-vip` at 10 referrals) | **remove**. The server grants the card on reaching Main Character (section 6). |

**Tier screens** (`DigitalBadgeScreen`, `MainCharacterScreen`, `DeftProScreen`, `DeftGoatScreen`,
`FounderCircleScreen`): keep them as the "rewards for this level" detail pages. Remove every PKR cash line
and "guaranteed paid internship". Change the copy to lowercase with no emoji (e.g. "🐐 DEFT GOAT" → "deft goat.").
Show "unlocked" or "x pts to go" at the top.

**Elsewhere:**
- **Profile header:** a small pill next to the name with the level ("deft pro"), or "founder #07" for founders (Part B §B.6).
- **Home:** nothing new (one ask at a time). Points appear inside celebration pop-ups ("+50 pts") only.
- **Feed author row:** one pip, with priority founder > crew lead > top badge. Never on confessions.

This replaces the separate `RewardsScreen` from BLUEPRINT §7.1 and UI_PLACEMENT §9. Don't build that screen.

## 9. Migration (`scripts/migrateCrew.js`, run once with the engagement backfill)

1. For each student with `referralCount > 0`: award `100 × (number of referred users who have sortedCount ≥ 1 after the engagement backfill)`.
   Referrals that were never verified earn 0, **but** nobody's level drops. See step 3.
2. Award the mission, streak and badge points from the engagement backfill (BLUEPRINT §8), silently.
3. **Keep what people have:** anyone with `isVip` or `referralCount >= 10` keeps the Privilege Card as it is, and
   gets a floor of `max(computed lifetime, 1000)` lifetime points so they show as Main Character.
   The same floor rule applies to anyone who ever reached Rookie (50 referrals) → at least 300.
4. Set `crew.level` from lifetime points. There are no level-up pop-ups for migrated levels.

## 10. Packets (replace P15 and P20a/b)

| Packet | Repo | Creates | Modifies | Acceptance |
|---|---|---|---|---|
| **P15 Crew backend** | backend | `config/crew.config.js`, `models/{CrewApplication,CrewTask,CrewTaskCompletion,AdminTask}.js`, `routes/crew.routes.js`, `routes/adminCrew.routes.js`, `services/engagement/crew.js` (`levelFor`, `onAward`), `tests/crew.test.js` | `services/engagement/points.js` (call `onAward`), `engine.js` (verified referral award), `routes/auth.routes.js` (VIP granted by level; keep `/activate-vip` for admin only) | the ledger sums to the balance; the level never drops after spending; a referral pays out only after the friend's first sort; concurrent redeems can't overdraw |
| **P15b Crew screen** | app | apply sheets, reward tiles, ledger list | `components/Points.js` (section 8), the 5 tier screens (copy, no cash), `ProfileScreen.js` (row + level pill), `DrawerNavigator.js` (label) | every level renders; the locked alert shows points to go; there's no cash text anywhere (`grep -ri "PKR" app/src/components/*Screen.js` finds nothing tier-related) |
| **P20a Founder backend** | backend | `models/FounderSeat.js`, founder apply/approve in the crew routes | `/auth/profile/me` (founder field), feed author projection | at most 50 seats under concurrent approvals; apply is closed after 31 Mar 2027 |
| **P20b Founder app** | app | the `FounderInvite` full-screen (now "you're in.") | `Card.js` (edition), `FounderCircleScreen.js`, `PostCard.js` (pip) | as in Part B §B.8 |
| **P21 Migration** | backend | `scripts/migrateCrew.js` | – | a dry run prints per-level counts; nobody who had the card or Rookie loses it |

**Phase:** P15, P15b and P21 go in **phase 3** with badges (2–14 Nov). P20a/b follow once the first user can
realistically reach 10,000. Build them in phase 3 anyway so the ladder shows the goal from day one.
Start `crew.config.js` with these numbers and review them on the first Monday metrics after launch.
If nobody reaches Rookie in the first 2 weeks, lower the thresholds, not the rewards.
