# tdc Sorted System: developer implementation blueprint

Source of truth for building the engagement and retention suite described in
*tdc Sorted System: build plan* (24 Sep 2026). This file is mirrored in both
repos at `docs/engagement-suite/BLUEPRINT.md`. Keep the two copies identical.

- Backend: `the-deft-crew` (Express 5, Mongoose 9, CommonJS, `expo-server-sdk`, `node-cron`, deployed on Railway)
- Mobile: `The-Deft-Crew-App` (Expo SDK 54, RN 0.81, React Navigation 7, React Query 5, plain JS)

Screen-by-screen UI placement (what goes where in the existing interface) is in
`UI_PLACEMENT.md` next to this file. It overrides section 7 wherever they differ.
The launch screen and the Founder Circle card are specified in `LAUNCH_AND_FOUNDER_CIRCLE.md`
(packets P19 and P20).
**Loyalty points, levels, the campus crew and Founder Circle entry are specified in `CREW_SYSTEM.md`,
which overrides §3.4, §4.6, the rewards endpoints in §5, and packets P15/P20 here.**

Each section says **what exists today**, **what to build**, and **exactly which
files change**. Section 11 splits the work into self-contained task packets for
code generation.

---

## 0. The plan assumes Firebase; the code doesn't use it

The build plan's dev spec is written for Firestore and Cloud Functions. Neither
repo uses them. The app has `google-services.json` but no Firebase SDK. The real stack
maps like this:

| Plan says | We build it as |
|---|---|
| Firestore `users/{uid}/sorted`, `/streak`, `/stats`, `/notifPrefs` | One Mongo doc per user in a new `EngagementProfile` collection (keeps `User` and `/auth/profile/me` light) |
| `users/{uid}/badges/{badgeId}` | `UserBadge` collection, unique `(user, badgeId)` |
| `duoStreaks/{pairId}` | `DuoStreak` collection (phase 4) |
| `dailyDrops/{date}` | `DailyDrop` collection keyed by Karachi `dayKey` |
| Cloud Functions (event triggers) | `services/engagement/engine.js`, called in-process from the existing route handlers |
| Cloud Functions (scheduled) | `node-cron` 4.6 jobs with `{ timezone: 'Asia/Karachi' }`, guarded by a Mongo lock |
| FCM + image field | Expo Push Service via `expo-server-sdk` 6.1, `richContent.image` (Android now, iOS needs an NSE later) |
| Firebase Analytics + DebugView | Server-side `EngagementEvent` collection is the source of truth. Firebase Analytics is optional and can come later. |

**Why:** the server has to own the logic anyway (a client can't award its own points or
streaks), and adding `@react-native-firebase/*` means new native builds for no functional gain.

---

## 1. Fix before building (phase 0, blocking)

These are existing bugs that the suite depends on. All were confirmed by reading the code.

| # | Problem | Where | Fix |
|---|---|---|---|
| B1 | **Push tokens are never saved.** `save-token` writes `expoPushToken`, but `User` has no such field and Mongoose strict mode drops it without an error. | `routes/notification.routes.js:10`, `models/User.js` | Add `pushTokens: [{ token, platform, updatedAt }]` to `User` (multi-device). Upsert with `$pull` then `$push`. Remove tokens that Expo reports as `DeviceNotRegistered`. |
| B2 | `POST /notification/send` calls `sendPushNotification` without importing it. It hasn't crashed yet only because of B1. | `routes/notification.routes.js:41` | `require('../utils/pushNotification')`. Better: route all sends through the new `pushGateway`. |
| B3 | The push permission prompt fires right after login, which breaks rule 8 ("ask after their first sorted moment"). | `App.js` `NotificationHandler` | Split it into `ensureChannel()` (always) and `requestPermissionAndRegister()` (only when `PermissionGate` fires after the first card flips). If permission is already granted, register silently on login. |
| B4 | Tapping a notification only logs it. There's no deep link. | `App.js` `responseListener` | Add `navigationRef` and `engagement/deepLinks.js` (section 7.6). |
| B5 | `NotificationSettings` is navigated to but not registered as a screen. There are two settings screens: `screens/SettingScreen.js` (used by `ProfileStack`) and `screens/Social/SettingItem.js` (registered as `SettingsScreen` in the drawer). | `screens/SettingScreen.js:149,372` | Build `NotificationSettingsScreen` (section 7.5), register it in `DrawerNavigator` **and** `ProfileStack`, and link to it from both settings screens. |
| B6 | Home queries `GET /home-endpoint`, which doesn't exist (404 on every Home mount). | `screens/Home.js:392` | Replace it with `GET /engagement/home` (section 5). |
| B7 | `POST /offers/redeem-payment` trusts `userId` and `savedAmount` from the body and doesn't check the caller's role. Once this action awards points and badges, anyone logged in could farm them. | `routes/offer.routes.js:242` | Require `req.userRole` to be `brand`, `employee` or `admin` (the scanner side). Compute `savedAmount` from `offer.discountPercentage * billAmount` on the server. |
| B8 | Android push on EAS builds needs FCM v1 credentials. `app.json` has no `android.googleServicesFile`, and the `expo-notifications` plugin isn't listed. | `app.json` | Add `"googleServicesFile": "./google-services.json"` and the `expo-notifications` plugin (`icon: ./assets/notification-icon.png`, `color: #f9c349`). Check the FCM v1 key is uploaded in EAS credentials. **Needs a new native build.** |
| B9 | Day boundaries use the server's local time (`setHours(0,0,0,0)`), and Railway runs in UTC. | e.g. `offer.routes.js:254` | All engagement code uses `utils/karachiTime.js` (section 4.1). Don't change the existing redemption limit in this project. |
| B10 | No "last active" signal exists, so the D1/D7/D30 baseline the plan asks for can't be computed exactly. | n/a | Ship `app_open` tracking first. For the baseline, use a proxy: the union of activity timestamps across Offer.redemptions, Post, Confession, JobApplication, Registration and Resume.updatedAt (section 9). |

---

## 2. Feature flags and stages

The plan rolls out in stages (under 100, 100 to 500, and 500+ weekly users). Build
everything behind server flags so a stage change doesn't need an app release.

`config/engagement.config.js` (backend):

```js
module.exports = {
  TZ: 'Asia/Karachi',
  STAGE: Number(process.env.ENGAGEMENT_STAGE || 1),
  flags: (stage) => ({
    tour: true,
    missions: true,
    dailyDrop: true,
    popups: true,
    soloStreak: stage >= 2 || process.env.FORCE_STREAKS === '1',
    badges: stage >= 2 || process.env.FORCE_BADGES === '1',
    savingsCounter: true,
    duoStreak: stage >= 3,
    leaderboard: stage >= 3,
    winBack: stage >= 3,
  }),
  push: {
    weeklyCap: (stage) => (stage >= 3 ? 4 : 2),
    dailyCap: 1,
    quietStartHour: 23, // 23:00 PKT
    quietEndHour: 9,    // 09:00 PKT
  },
  og: { cutoff: '2026-12-31T23:59:59+05:00' }, // Majid to confirm
};
```

`GET /engagement/me` returns `flags`, and the client hides anything that's off.

> The plan's phases (streaks in phase 2, 19 to 31 Oct) are ahead of its stages
> (streaks off under 100 weekly users). Build them on the phase schedule and switch them
> on with `FORCE_STREAKS=1` only once Majid decides to. **Decision D3.**

---

## 3. Backend data model (new Mongoose models)

All files go in `models/`. Use `timestamps: true` everywhere.

### 3.1 `EngagementProfile.js` (one per student)

```js
{
  user: { type: ObjectId, ref: 'User', unique: true, index: true },

  // Get Started missions (8 "sorted cards")
  sorted: {                      // Date the card flipped, or null
    discounts: Date, resume: Date, jobs: Date, social: Date,
    events: Date, scholarship: Date, skillshare: Date, traveling: Date,
  },
  sortedCount: { type: Number, default: 0 },
  fullySortedAt: Date,
  snoozes: [{ feature: String, until: Date, count: Number }], // swipe away, 7 days, max 2
  lastSortedFeature: String,     // drives the next-card rule

  // Tour
  tourCompletedAt: Date,
  tooltipsSeen: [String],        // 'points', 'membershipCard'

  // Solo streak
  streak: {
    count: { type: Number, default: 0 },
    best: { type: Number, default: 0 },
    lastActionDay: String,       // 'YYYY-MM-DD' in Karachi time
    freezesLeft: { type: Number, default: 1 },
    freezeWeekKey: String,       // ISO week 'YYYY-Www'; reset to 1 when it changes
    examModeUntil: String,       // dayKey, inclusive
    examModeUses: [{ semesterKey: String, startedDay: String }], // max 2 per semester
    brokenAt: Date,
    restorableUntil: Date,       // phase 4 restore-by-invite
    milestonesHit: [Number],     // 3,7,14,30,50,100
  },

  // Stats (savings counter, win-back)
  stats: {
    totalSaved: { type: Number, default: 0 },   // Rs
    lastActiveAt: Date,
    lastActiveDay: String,
    lastFeatureUsed: String,
  },

  // Loyalty points (cached; the ledger is the source of truth)
  points: {
    balance: { type: Number, default: 0 },
    lifetime: { type: Number, default: 0 },
  },

  // Notifications
  notifPrefs: {
    streaks: { type: Boolean, default: true },
    dailyDrop: { type: Boolean, default: true },
    deals: { type: Boolean, default: true },
    jobsScholarships: { type: Boolean, default: true },
    social: { type: Boolean, default: true },
  },
  osPushPermission: { type: String, enum: ['granted','denied','undetermined'], default: 'undetermined' },
  pushPermissionAskedAt: Date,
  push: {
    weekKey: String, sentThisWeek: { type: Number, default: 0 },
    lastPushDay: String, lastPushAt: Date,
  },

  // In-app pop-up queue (server-owned so brand-side actions still celebrate on the student's phone)
  pendingPopups: [{
    _id: ObjectId, kind: String,  // 'card_sorted'|'fully_sorted'|'badge'|'streak_milestone'|'freeze_used'|'points'
    mood: String, line: String, cta: { label: String, route: String, params: Mixed },
    payload: Mixed, priority: Number, createdAt: Date,
  }],
}
```

Indexes: `{ 'streak.lastActionDay': 1, 'streak.count': 1 }`, `{ 'stats.lastActiveAt': 1 }`.

### 3.2 `EngagementEvent.js` (append-only tracking and audit)

```js
{ user: ObjectId, name: String, feature: String|null, dayKey: String,
  meta: Mixed, source: { type: String, enum: ['server','client'] },
  dedupeKey: { type: String, unique: true, sparse: true } }
```

Indexes: `{ user:1, createdAt:-1 }`, `{ name:1, dayKey:1 }`. TTL index on `createdAt`,
set to 400 days.

### 3.3 `PointsLedger.js`

```js
{ user: ObjectId, delta: Number, reason: String, // 'mission_sorted','fully_sorted','streak_milestone','badge','reward_redeemed','admin_adjust','referral'
  refType: String, refId: String, balanceAfter: Number,
  dedupeKey: { type: String, unique: true } }
```

Always write it with `services/engagement/points.js#award()`. That function inserts the
ledger row first, relying on the `dedupeKey` unique index for idempotency, then
`$inc`s `EngagementProfile.points`.

### 3.4 `Reward.js` and `RewardRedemption.js` (spending points)

```js
Reward: { title, description, brand: ObjectId(User), image, costPoints: Number,
          stock: Number|null, perUserLimit: Number, active: Boolean,
          kind: { enum: ['promo_code','brand_perk','tdc_card_discount'] }, validDays: Number }
RewardRedemption: { user, reward, costPoints, code: String, status: { enum:['issued','used','expired','refunded'] },
                    expiresAt, usedAt }
```

Generate the code with the existing `services/codeGenerator.js`. Redeem inside a
Mongo transaction: decrement stock, write a ledger row with `-costPoints`, then create
the redemption. If there's no replica set, use a conditional `findOneAndUpdate` on
`points.balance >= cost`.

### 3.5 `UserBadge.js`

```js
{ user, badgeId: String, earnedAt: Date, shownAt: Date|null, meta: Mixed }  // unique (user, badgeId)
```

Badge definitions live in code, in `config/badges.config.js` (section 4.5).

### 3.6 `DailyDrop.js` and `DropReaction.js`

```js
DailyDrop: { dayKey: { type:String, unique:true }, type: { enum:['internship','brand','confession','event','scholarship','poll','best_confession'] },
             title, body, image, mood,
             contentRef: { kind: String, id: ObjectId },          // Job, User(brand), Confession, Event, Scholarships
             action: { kind: { enum:['react','vote','save','rsvp','interest','match'] }, options: [String] },
             publishAt: Date /* 19:00 PKT */, status: { enum:['draft','scheduled','live','archived'] },
             pushedAt: Date, createdBy: ObjectId }
DropReaction: { drop: ObjectId, user: ObjectId, choice: String }  // unique (drop, user)
```

### 3.7 `PushLog.js`

```js
{ user, type: String /* 'daily_drop','streak_warning','new_for_you','win_back','transactional' */,
  priority: Number, title, body, mood, dayKey, weekKey, ticketId, status, openedAt }
```

Used for caps, open rate and the Monday metrics.

### 3.8 `SavedItem.js` (new; needed for `scholarship_saved` and `trip_saved`)

```js
{ user, kind: { enum:['scholarship','trip'] }, refId: ObjectId, deadline: Date }  // unique (user, kind, refId)
```

There's no save endpoint for scholarships or trips today (only `/auth/exchange/apply`).

### 3.9 `JobLock.js`

```js
{ _id: String /* job name + dayKey */, lockedAt: Date, owner: String }
```

Take the lock with `insertOne`. A duplicate-key error means another instance already
ran that job, so the cron runs exactly once per slot even if Railway scales to more
than one replica.

### 3.10 Phase 4: `DuoStreak.js`

```js
{ members: [ObjectId, ObjectId] /* sorted */, pairKey: { type:String, unique:true },
  count, best, actedDay: { type: Map, of: String }, lastBothDay: String,
  status: { enum:['invited','active','broken'] }, inviteCode: String, startedAt }
```

### 3.11 Change to `User.js`

Add only `pushTokens` (B1). Everything else goes on `EngagementProfile`.

---

## 4. Backend services (`services/engagement/`)

```
services/engagement/
  index.js            // exports { track, getProfile, ensureProfile }
  engine.js           // processes a qualifying event: missions → streak → stats → points → badges → popups
  missions.js         // feature map, next-card rule, snooze
  streak.js           // pure functions + DB update; nightly rollover
  points.js           // award(), spend()
  badges.js           // evaluate(profile, ctx) → newly earned badge ids
  popups.js           // enqueue(), one-per-session is enforced on the client
  pushGateway.js      // the only way to send an engagement push (caps, quiet hours, prefs, priority)
  copy.js             // copy bank + template fill; lowercase, full stop, no emoji
  drops.js            // publish and react
  scheduler.js        // all cron jobs + JobLock
utils/karachiTime.js  // dayKey(), weekKey(), semesterKey(), isQuietHour(), karachiNow()
```

### 4.1 `utils/karachiTime.js` (pure; write it first and unit test it)

```js
dayKey(date = new Date())      // 'YYYY-MM-DD' via Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' })
addDays(dayKey, n)             // arithmetic on dayKeys
weekKey(date)                  // ISO week in PKT, e.g. '2026-W39' (Mon start)
semesterKey(date)              // 'YYYY-S1' (Jan–Jun) / 'YYYY-S2' (Jul–Dec)  (decision D6)
karachiHour(date)              // 0–23
isQuietHour(date, cfg)         // hour >= 23 || hour < 9
```

PKT has no daylight saving time, so a fixed +05:00 offset is safe. Still, use `Intl`.

### 4.2 `track()` contract (the single entry point)

```js
/**
 * @param {ObjectId|string} userId
 * @param {string} name           event name from the table below
 * @param {object} [opts]
 * @param {object} [opts.meta]    e.g. { offerId, savedAmount }
 * @param {string} [opts.dedupeKey] defaults to `${name}:${userId}:${meta.refId||dayKey}`
 * @returns {Promise<EngagementResult|null>}  never throws; logs and returns null on failure
 */
async function track(userId, name, opts = {})

// EngagementResult (returned to the calling route, attached to its JSON as `engagement`)
{
  cardSorted: 'resume' | null,
  sortedCount: 3,
  streak: { count: 5, extendedToday: true, milestone: 7 | null } | null,
  pointsAwarded: 50,
  badgesEarned: ['feature_resume'],
  popups: [{ id, kind, mood, line, cta }],   // already persisted in pendingPopups
}
```

**Rules:**
- Skip guests (`req.isGuest` / `userId === 'guest-user'`) and non-students.
- Call `track()` **after** the route's own write succeeds, and `await` it. It must never
  change the route's status code, so wrap it in try/catch. Add the result to the route's
  JSON response as `engagement` (an additive field that existing clients ignore).
- For routes where the actor isn't the student (the brand scanner redeems for a student),
  call `track(studentId, ...)` and don't attach the result. The student's app picks the
  popup up from `pendingPopups`.

### 4.3 Event catalog and the exact hook points

| Event | Streak | Sorts card | Hook (file:line today) | Notes |
|---|---|---|---|---|
| `deal_redeemed` | yes | discounts | `routes/offer.routes.js:242` (`/redeem-payment`), `routes/promoCode.routes.js` `/verify` (~L391), `/brand-verify` (~L864), `/confirm-redemption` (~L1038), `routes/webhook.routes.js` (~L152, ~L324) | actor is the brand, so use `track(studentId)`; `meta.savedAmount` feeds `stats.totalSaved` (`$inc`) |
| `cv_completed` | yes | resume | `routes/resume.routes.js` `PUT /:id` (L604) and `POST /` (L65), `/upload` (L304) | fire when `resume.isComplete` goes false→true. `isComplete` means `completionPercentage >= 85` (`models/Resume.js:322`), not the plan's 100%. **Decision D5.** |
| `job_applied` | yes | jobs | `routes/jobs.routes.js:448` `/apply/:jobId` | |
| `job_saved` | yes | – | `routes/jobs.routes.js:1461` `/bookmarks/:jobId` | counts toward the streak only |
| `social_posted` | yes | social | `routes/social.routes.js:921` `/create-post`, `:1752` `/confessions/create` | |
| `social_commented` | yes | social | `routes/social.routes.js:1078` `/posts/comment/:id`, `:1534` `/confessions/comment/:id` | |
| `event_rsvp` | yes | events | `routes/event.routes.js:297` `/register` | |
| `scholarship_saved` | yes | scholarship | **new** `POST /engagement/saved/scholarship/:id` | |
| `scholarship_applied` | yes | scholarship | `routes/auth.routes.js:601` `/exchange/apply` | |
| `skill_posted` | yes | skillshare | `routes/listing.routes.js:40` `POST /` | |
| `skill_swapped` | yes | skillshare | `routes/skillOffer.routes.js:188` when `status === 'accepted'` (L232) | track both parties |
| `trip_saved` | yes | traveling | **new** `POST /engagement/saved/trip/:id` | |
| `trip_booked` | yes | traveling | `routes/booking.routes.js:8` (the app's `BookingScreen.js` calls `/api/bookings`) | `traveler.routes.js` is the traveler-role side; don't hook it |
| `drop_reacted` | yes | – | **new** `POST /engagement/drops/:dayKey/react` | |
| `app_open` | **no** | – | **new** `POST /engagement/events` (client) | only updates `stats.lastActiveAt`; for retention metrics |
| `tour_completed`, `card_snoozed`, `popup_seen`, `push_opened` | no | – | client endpoints below | analytics only |

**Anti-cheat:** only `app_open`, `tour_*`, `popup_seen` and `push_opened` can come from the
client. Every qualifying event is emitted on the server, inside the route that did the real write.

### 4.4 `engine.process()` order (inside `track`)

1. Insert the `EngagementEvent` (a duplicate `dedupeKey` returns `null` and nothing else happens).
2. `ensureProfile(user)` (upsert).
3. Update `stats.lastActiveAt`, `lastActiveDay` and `lastFeatureUsed`. If `savedAmount`, `$inc stats.totalSaved`.
4. **Mission:** if the event sorts a card and `sorted[feature]` is null, set it with a conditional update
   (`{ ['sorted.'+f]: null }` in the filter so it happens once), `$inc sortedCount`, award
   `POINTS.missionSorted`, and queue a `card_sorted` popup. If `sortedCount` reaches 8, set `fullySortedAt`,
   award `POINTS.fullySorted` and queue a `fully_sorted` popup (the client shows it full-screen).
5. **Streak** (only if `flags.soloStreak` and the event counts toward the streak): `streak.applyAction(profile, today)`:
   - `lastActionDay === today` → no-op.
   - `lastActionDay === yesterday` → `count + 1`.
   - otherwise → `count = 1` (the nightly job already applied a freeze or exam mode if either was available).
   - Update with the filter `{ 'streak.lastActionDay': { $ne: today } }` so it's once per day even under concurrency.
   - `best = max(best, count)`. If `count` is in `[3,7,14,30,50,100]` and isn't in `milestonesHit` yet, award points and queue a `streak_milestone` popup.
6. **Badges** (only if `flags.badges`): `badges.evaluate()` → insert `UserBadge` rows (duplicates ignored),
   award any points attached to the badge, and queue a `badge` popup.
7. Return an `EngagementResult`.

### 4.5 Badges (`config/badges.config.js`)

17 badges at launch, as in the plan:

| id | group | rule (evaluated on the profile) | reward |
|---|---|---|---|
| `feature_discounts` … `feature_traveling` (8) | features | `sorted[f] != null` | badge only |
| `fully_sorted` | features | `sortedCount === 8` | brand perk (`Reward` issued free) + full-screen |
| `saved_1k`, `saved_5k`, `saved_10k` | savings | `stats.totalSaved >= n` | badge / perk / perk + shoutout |
| `streak_7`, `streak_30`, `streak_100` | streaks | `streak.best >= n` | badge / perk / rare badge |
| `og` | status | `user.createdAt <= og.cutoff` (backfill + at signup) | kept forever |
| `confession_of_the_day` | status | granted when an admin picks a confession for a drop | badge + feature |

Each definition: `{ id, group, mood, title, line, points, perkRewardId? }`.

### 4.6 Loyalty points

> **Superseded by `CREW_SYSTEM.md` §1–3** (points, levels, referral verification, values).
> The table below is kept for history only.

**What exists today:** the "Points" screen (`components/Points.js`) is actually a referral
tracker. It reads `referralCount` from `/auth/profile/me` and unlocks the VIP/TDC card at 10
referrals (`/auth/activate-vip/:userId`). There's no points balance or ledger anywhere.

**What we add:** a ledger-backed balance that sits next to referrals and doesn't touch them.

| Reason | Points (proposal; **decision D1**) | Dedupe key |
|---|---|---|
| Mission sorted | 50 each (400 total) | `mission:{user}:{feature}` |
| Fully sorted bonus | 200 | `fully:{user}` |
| Streak milestone 3/7/14/30/50/100 | 20/50/100/250/400/1000 | `streak:{user}:{n}:{streakStartDay}` |
| Badge with points | per badge def | `badge:{user}:{id}` |
| Verified referral (optional) | 100 | `ref:{referrer}:{newUser}` |
| Reward redeemed | −cost | `redeem:{redemptionId}` |

No points for app opens, likes or story views (rule 1). Points never expire in v1.

### 4.7 `pushGateway.send()`: every engagement push goes through here

```js
/**
 * @param {ObjectId} userId
 * @param {{ type: 'streak_warning'|'new_for_you'|'daily_drop'|'win_back'|'transactional',
 *           pref: 'streaks'|'dailyDrop'|'deals'|'jobsScholarships'|'social'|null,
 *           title?: string, body: string, mood: Mood, data: PushData }} msg
 * @returns {Promise<{ sent: boolean, reason?: 'pref_off'|'quiet_hours'|'daily_cap'|'weekly_cap'|'no_token' }>}
 */
```

Checks, in order: token exists → `notifPrefs[pref]` is on → not quiet hours → `push.lastPushDay !== today`
→ `sentThisWeek < weeklyCap(stage)` (reset when `weekKey` changes) → send → write `PushLog` and bump
counters atomically. `transactional` (chat, redemption receipt, application status) **skips the caps** but
still respects prefs and quiet hours (**decision D4**).

**Priority when two pushes want the same day** (streak warning > something new for them > daily drop > win-back),
handled by time slot:
- 19:00 drop push **skips** users with `streak.count >= 2` who haven't acted today. They get the 20:00
  warning instead, and its copy points to the drop ("one vote saves it").
- "New for you" pushes (a new brand near them, a saved deadline, a confession reply) go out at 13:00 and use up that day's slot.
- Win-back only runs for users with no push in the last 7 days.

**Expo message built by the gateway:**

```js
{ to, title, body, sound: null, channelId: 'engagement', priority: 'high',
  richContent: { image: `${CDN}/dots/${mood}-1024x512.png` },   // Android big picture; iOS needs NSE (phase 3)
  data: { v: 1, type, route, params, pushLogId } }
```

Handle Expo tickets and receipts: remove `DeviceNotRegistered` tokens (B1).

### 4.8 Scheduler (`services/engagement/scheduler.js`)

Started from `server.js` inside `connectDB().then(...)`, next to `eventScheduler.initialize()`.
Every job does `if (!await lock(name, dayKey())) return;`.

| Cron (PKT) | Job | Phase |
|---|---|---|
| `0 19 * * *` | publish today's `DailyDrop` (`status: live`) and push it to users with `notifPrefs.dailyDrop` (with the skip rule above) | 2 |
| `0 20 * * *` | streak warning: `streak.count >= 2 && lastActionDay !== today` → push `panic` copy | 2 |
| `5 0 * * *` | streak rollover for everyone with `count > 0 && lastActionDay < yesterday`: in exam mode set `lastActionDay = yesterday`; else if `freezesLeft > 0`, decrement it, set `lastActionDay = yesterday`, queue `freeze_used`; else break the streak (keep `best`, set `restorableUntil = now+24h`) | 2 |
| `0 0 * * 1` | weekly freeze reset (`freezesLeft = 1`, new `freezeWeekKey`) | 2 |
| `0 13 * * *` | "new for you" (saved scholarship deadline in 3 days, new brand in their city) | 2 |
| `0 10 * * *` | win-back at 3/7/14/30 days since `lastActiveAt`, copy based on `lastFeatureUsed` | 4 |
| `0 9 * * 1` | weekly metrics snapshot + leaderboard refresh | 3/4 |

Use `cron.schedule(expr, fn, { timezone: 'Asia/Karachi' })`. This is supported by the installed `node-cron@4.6.0`.

**Rollover edge case:** a user who misses two or more days with one freeze left uses the
freeze for the first missed day, and the streak breaks on the next nightly run. That's the
intended behaviour ("1 free freeze a week").

### 4.9 Copy bank (`services/engagement/copy.js`)

Every line from the plan's copy bank as `{ key, mood, type, template }`, with templates like
`'your {count} day streak ends at midnight. one vote saves it.'`. `fill(key, vars)` returns
`{ title, body, mood }`. Add a unit test that fails if any template has uppercase letters
(outside `{vars}`), emoji, or doesn't end with `.`. The 8 mission lines (before and after)
also live here and are served to the client, so the social team can change copy without
an app release.

---

## 5. API contracts (new routes)

Mount in `server.js`:
`app.use('/api/engagement', require('./routes/engagement.routes'));`
`app.use('/api/admin/engagement', require('./routes/adminEngagement.routes'));`

Auth comes from the existing `middleware/auth.middleware.js`. Guests get `{ guest: true, flags }`
with a 200 on GETs and a 401 on writes. Errors use `{ message }` (the existing convention).

### Student endpoints

```
GET  /api/engagement/me
200 {
  flags: { tour, missions, dailyDrop, popups, soloStreak, badges, savingsCounter, duoStreak, leaderboard, winBack },
  tour: { completed: bool },
  missions: {
    sortedCount: 3, total: 8,
    cards: [{ feature: 'discounts', mood: 'broke', sorted: false, sortedAt: null,
              lineBefore: 'paying full price? never again.', lineAfter: 'rs 360 saved. sorted.',
              route: 'Brands', params: {} , snoozedUntil: null }],   // ordered by the plan's order
    next: 'resume'               // server-computed via the next-card rule + snoozes
  },
  streak: { count, best, health: 'safe'|'at_risk'|'broken'|'none', freezesLeft, examModeUntil, hoursLeftToday } | null,
  points: { balance, lifetime },
  stats: { totalSaved },
  badges: { earned: 5, total: 17 },
  popups: [{ id, kind, mood, line, cta: { label, route, params } }],   // pendingPopups, oldest first
  notifPrefs: { streaks, dailyDrop, deals, jobsScholarships, social },
  askPushPermission: bool        // true once sortedCount >= 1 and never asked
}

GET  /api/engagement/home        → { drop: DailyDropDTO|null, missions: {...same as above}, streak }   // replaces /home-endpoint (B6)

POST /api/engagement/events      { name: 'app_open'|'tour_completed'|'card_snoozed'|'popup_seen'|'push_opened', meta? } → 204
POST /api/engagement/tour/complete                                   → { ok: true }
POST /api/engagement/tooltips/:id/seen                               → { ok: true }
POST /api/engagement/missions/:feature/snooze                         → { ok: true, until, remainingSnoozes }   // 409 after 2
POST /api/engagement/popups/:id/ack                                   → { ok: true }   // removes from pendingPopups

GET  /api/engagement/badges      → [{ id, group, title, line, mood, earnedAt|null }]
GET  /api/engagement/points/ledger?cursor=<id>&limit=20 → { items: [{ delta, reason, createdAt }], nextCursor }
GET  /api/engagement/rewards     → [{ _id, title, brand: { name, logo }, costPoints, affordable: bool, stockLeft }]
POST /api/engagement/rewards/:id/redeem → 201 { redemption: { code, expiresAt, reward } } | 409 { message: 'not enough points' }

GET  /api/engagement/notification-prefs → { streaks, dailyDrop, deals, jobsScholarships, social, osPermission }
PUT  /api/engagement/notification-prefs   { streaks?: bool, ... }       → same shape
POST /api/engagement/push-permission      { status: 'granted'|'denied'|'undetermined' } → 204   // turn-off metric

POST /api/engagement/streak/exam-mode     { days: 1..14 } → { examModeUntil } | 409 { message: 'used twice this semester.' }
DELETE /api/engagement/streak/exam-mode   → { examModeUntil: null }

GET  /api/engagement/drops/today → DailyDropDTO | null
     DailyDropDTO = { dayKey, type, title, body, image, mood, action: { kind, options }, myChoice: string|null,
                      counts?: { [option]: n }, target: { route, params } }
POST /api/engagement/drops/:dayKey/react  { choice } → { myChoice, counts, engagement: EngagementResult }

POST /api/engagement/saved/:kind/:id      (kind = scholarship|trip) → { saved: true, engagement }
DELETE /api/engagement/saved/:kind/:id    → { saved: false }
```

### Admin endpoints (admin portal; `req.userRole === 'admin'`)

```
GET    /api/admin/engagement/drops?from=YYYY-MM-DD&to=YYYY-MM-DD
POST   /api/admin/engagement/drops            DailyDrop body (dayKey unique)
PUT    /api/admin/engagement/drops/:dayKey
DELETE /api/admin/engagement/drops/:dayKey
POST   /api/admin/engagement/drops/:dayKey/publish-now     // testing
POST   /api/admin/engagement/confession-of-the-day { confessionId }  // grants badge + creates drop
CRUD   /api/admin/engagement/rewards
POST   /api/admin/engagement/points/adjust { userId, delta, note }
GET    /api/admin/engagement/metrics?weeks=8   // section 9
POST   /api/admin/engagement/test-push { userId, copyKey, vars }
```

The admin portal UI isn't in either repo attached here. These endpoints are what it
should call. The social lead's "schedule a week ahead" workflow is a list of 7 `dayKey`
rows on the drops endpoints.

### Additive fields on existing responses

Every hooked route in section 4.3 adds `engagement: EngagementResult | undefined` to its JSON.
Don't change any existing field.

---

## 6. Moods and the dot (visual status system)

`mood` is a closed set shared by the backend and the app:

```
excited · broke · panic · sus · shook · sleepy · cheeky · sorted
```

| Where the dot shows | Mood logic | Size |
|---|---|---|
| Mission card | the card's mood before, `sorted` after | 72 |
| x/8 row | 8 small dots, filled ones are `sorted` | 14 |
| Streak chip (Home header + Profile) | `safe`→`sorted`, `at_risk` (< 4h left, i.e. after 20:00 PKT and not acted)→`panic`, `broken`→`sleepy` | 20 + count |
| Pop-ups | from `popup.mood` | 120 (lottie) |
| Push image | `richContent.image` → `/dots/{mood}-1024x512.png` | n/a |
| Notification settings rows | one mood per type | 20 |
| Feed author row (**never on confessions**: they're anonymous, UI_PLACEMENT §6) | one badge dot next to the name (phase 3) | 12 |
| Friends list (phase 4) | duo streak health | 12 |

**Designer delivers:** 8 × Lottie JSON (`assets/dots/lottie/{mood}.json`), 8 × PNG
@1x/@2x/@3x (`assets/dots/{mood}.png`) for static use, and 8 × 1024×512 push images
(hosted on Cloudinary, not bundled). Until they arrive, `Dot` renders a coloured circle
fallback so development isn't blocked.

---

## 7. Mobile app architecture

### 7.1 New folder

```
app/src/engagement/
  api/engagementApi.js           // thin wrappers on the shared `api` axios instance
  EngagementProvider.js          // context: me, flags, refresh(), celebration queue, session popup guard
  hooks/
    useEngagement.js             // useQuery(['engagement','me']) + helpers
    useMissions.js
    useStreak.js
    useDailyDrop.js              // useQuery(['engagement','home'])
    useCelebrationQueue.js       // FIFO, dedupe by popup id, 1 per session, defers while keyboard open
  components/
    Dot.js                       // <Dot mood size animated />  (lottie-react-native, static fallback)
    MissionCard.js               // big card: dot + line + CTA; flip animation (Reanimated 4) + haptic
    MissionProgressRow.js        // "3/8 sorted" + 8 mini dots
    MissionStack.js              // Home section: one card + row; swipe-away = snooze
    StreakChip.js                // dot + count, health colour; tap → StreakSheet
    StreakSheet.js               // bottom sheet: best, freezes, exam mode toggle
    DailyDropCard.js             // 7pm card with one action
    CelebrationPopup.js          // modal: big dot, one line, one button, "not now"
    FullySortedCelebration.js    // full-screen once
    BadgeShelf.js                // profile + membership card
    BadgePip.js                  // tiny badge dot next to names in Feed/Confession (phase 3)
    SavingsCounter.js            // "you've saved rs X on tdc" + share-to-story (react-native-view-shot + expo-sharing)
    Tooltip.js                   // one-time tooltips for Points and the Membership Card
  tour/
    TourProvider.js              // registerTarget(id, ref); start(); step state; persisted
    TourOverlay.js               // dim + spotlight via measureInWindow; tap anywhere to continue; "skip"
    tourSteps.js
  screens/
    NotificationSettingsScreen.js   // fixes B5
    BadgesScreen.js
    RewardsScreen.js                // points balance + catalog + ledger
  utils/
    moods.js                     // mood → { color, lottie, png }
    haptics.js                   // pop(): Haptics.impactAsync(Light); success(): notificationAsync(Success)
    deepLinks.js                 // route key → navigationRef.navigate(...) (fixes B4)
    pushPermission.js            // ask-after-first-sorted-moment logic (fixes B3)
  copy.js                        // client fallback copy only; the server copy wins
```

Use the `api` instance from `app/src/api/api.js`, not raw `axios` + `BASE_URL`. That keeps
guest-mode handling and the session-expiry interceptor working.

### 7.2 Provider placement (`App.js`)

```jsx
<QueryClientProvider>
  <KeyboardProvider><SafeAreaProvider>
    <AuthProvider>
      <EngagementProvider>            {/* NEW: needs AuthContext + queryClient */}
        <TourProvider>                {/* NEW */}
          <AppContent />              {/* NavigationContainer gets ref={navigationRef} */}
        </TourProvider>
      </EngagementProvider>
    </AuthProvider>
  ...
```

Inside `AppContent`, next to `<GlobalNotificationLayer />`, add `<CelebrationHost />` and
`<TourOverlay />` so both render above the navigator.

### 7.3 How a celebration reaches the screen

1. **Fast path:** add a response interceptor to `api.js`. If `response.data?.engagement?.popups?.length`,
   call `engagementBus.emit('popups', popups)` (a tiny event emitter so `api.js` doesn't import React).
   Also invalidate `['engagement']` queries. **Most action screens use raw `axios`/`fetch`, not `api`,
   so each call site also calls `celebrate(res.data?.engagement)`. The full list is in UI_PLACEMENT §11.**
2. **Slow path:** `EngagementProvider` refetches `/engagement/me` on `AppState` → `active`, on Home focus,
   and every 60s while the app is in the foreground. Anything in `me.popups` gets queued. This path
   covers brand-side redemptions.
3. `useCelebrationQueue` shows **one** popup per session. A session starts when `AppState` becomes
   `active` after more than 30 min in the background. It never shows while `Keyboard.isVisible()`,
   never within 1.5s of a screen mount (so "never on app open" holds), and defers the rest to the
   next session. `fully_sorted` always wins.
4. On show: `haptics.pop()`, play the Lottie, `POST /popups/:id/ack`. On "not now", ack as well.
5. After the first `card_sorted` popup closes, if `me.askPushPermission`, show the pre-permission
   sheet ("want a heads up when a deal drops near you?") → OS prompt → `registerForPushNotificationsAsync`
   → `PUT /notification/save-token` → `POST /engagement/push-permission`.

Keep the existing `NotificationBanner` path (polling `Notification` docs) as it is. It handles
inbox-style notifications. Celebrations are a separate layer.

### 7.4 Home screen (`app/src/screens/Home.js`)

Home already has an 8-item `FEATURES` array (line 34) that matches the 8 missions one to one.
Reuse its `screen` values as mission `route`s.

- Replace the `/home-endpoint` query (L389–397) with `useDailyDrop()`.
- Insert, above the existing feature grid inside the `ScrollView`:
  1. `StreakChip` in the header row (if `flags.soloStreak`)
  2. `MissionStack` (if `flags.missions && sortedCount < 8`). Once fully sorted, collapse it to a one-line "fully sorted." chip.
  3. `DailyDropCard` (if `flags.dailyDrop && drop` and after 19:00 PKT, which the server enforces)
- Rule 2 (one ask at a time): if both a mission card and a drop are visible, the drop sits below the fold.
  Don't show a tooltip or popup while the tour is running.

**Mission card routes** (open the action, not the tab):

| feature | route (from existing navigators) |
|---|---|
| discounts | `Brands` (HomeStack) |
| resume | `Resume` → `ResumeBuilder` (ResumeNavigator) |
| jobs | `Career` (drawer) |
| social | `Social` (it has no tab param today; P10 adds `route.params?.initialTab` support to `screens/Social/Social.js` to open Confessions) |
| events | `Events` |
| scholarship | `Exchange` |
| skillshare | `Dashboard` (drawer) → `SkillShareGate` → `SelectListingTypeScreen` → `CreateListing` |
| traveling | `Travelling` (drawer) / `TravellingScreen` (HomeStack) |

Next-card rule (on the server, in `missions.js`): after jobs → resume, scholarship → resume,
discounts → events, events → social; otherwise the first unsorted card in plan order. Skip
cards that are snoozed. A card can be snoozed at most twice, for 7 days each time.

### 7.5 Profile, Points, Membership Card and Settings

- `screens/ProfileScreen.js`: it already fetches `/offers/my-total-savings` (L215). Replace that with
  `me.stats.totalSaved` and render `SavingsCounter` with share. Add `MissionProgressRow` ("3/8 sorted"),
  `StreakChip`, and `BadgeShelf` (the first 6, "see all" → `BadgesScreen`).
- `components/Points.js`: keep the referral and VIP logic. Add a points balance header plus a "rewards"
  entry to `RewardsScreen`. Show the one-time `Tooltip` (`tooltipsSeen: 'points'`).
- `components/Card.js` (Membership Card): add `BadgeShelf` compact and the one-time tooltip.
- `screens/SettingScreen.js` and `screens/Social/SettingItem.js`: the `NotificationSettings` target is now real, so link to it from both. Add a "replay the tour" row
  that calls `TourProvider.start()`, and an "exam mode" row (if `flags.soloStreak`).
- **`NotificationSettingsScreen`**: 5 switches (streaks, daily drop, deals, jobs & scholarships, social),
  each with a mood dot. Save optimistically with `PUT`. If the OS permission is denied, show an "open settings" row.
  Register it as `NotificationSettings` in `navigation/DrawerNavigator.js` and `navigation/ProfileStack.js`.

### 7.6 Deep links from push (`utils/deepLinks.js`)

Create `export const navigationRef = createNavigationContainerRef()` and pass it to
`<NavigationContainer ref={navigationRef}>` in `App.js`. Replace the logging-only
`responseListener` with:

```js
const data = response.notification.request.content.data;
api.post('/engagement/events', { name: 'push_opened', meta: { pushLogId: data.pushLogId, type: data.type } });
openRoute(data.route, data.params);    // waits for navigationRef.isReady()
```

Also handle the cold-start case with `Notifications.getLastNotificationResponseAsync()`.
`openRoute` maps route keys to nested navigation (`Home > HomeStackMain`, `Career`, `Events`, and so on).
Unknown keys go to Home.

### 7.7 The app tour (4 steps, shown once)

The targets are measured with `measureInWindow`:

| Step | Target (all in `CustomTabBar`, `navigation/TabNavigator.js`) | ref id | Mood / line |
|---|---|---|---|
| 1 | Home tab icon | `tab_home` | excited · "this is tdc. 70+ brands, student prices." |
| 2 | Explore tab (= Student Hub, `Explore.js`) | `tab_explore` | broke · "deals, events, scholarships. all here." |
| 3 | Campus tab (= Career Dashboard, `StudentDashboard.js`) | `tab_campus` | panic · "build your cv, see your job match %." |
| 4 | Centre Social button | `tab_social` | sus · "say it anonymously. we won't tell." |

- The tour starts on the first Home focus after sign-up **or** for a guest, once
  (`AsyncStorage 'tdc.tourDone'` + server `tourCompletedAt` for signed-in users).
- `TourOverlay`: full-screen `Pressable`, dim `rgba(0,0,0,0.7)`, spotlight made with 4 dim rects around
  the target (no masked-view dependency), `Dot` + line, and "skip" in the top-right.
- On finish or skip: `POST /engagement/tour/complete`, then scroll Home to `MissionStack`.

### 7.8 Style constraints (from the brand guide and the existing code)

- Gold `#f9c349`, dark `#1a1a1a`, white Home background (the constants in `Home.js` L26–31).
- User-facing engagement copy is lowercase, ends with a full stop, and has no emoji. Existing
  notifications like `"Payment Successful! 🎉"` break this. Update the `offer.routes.js` / `promoCode.routes.js`
  notification titles when those files are touched for hooks.
- Haptics: `expo-haptics` (already used in `SettingScreen.js`). Light impact on the pop, no sound.
- Animations: `react-native-reanimated` 4 for the card flip. `lottie-react-native` 7 (installed, unused so far) for dots.

---

## 8. Backfill and migration (`scripts/backfillEngagement.js`)

Run once before the phase 1 release, and make it safe to re-run (every write is idempotent via `dedupeKey`).

For every `User` with `role: 'student'`:
- discounts: any `Offer.redemptions.student` or used `PromoCode` for the user
- resume: any `Resume` with `isComplete: true`
- jobs: any `JobApplication`
- social: any `Post`, `Confession`, or embedded comment by the user
- events: any `Registration` with `userId`
- scholarship: any `Application` (exchange)
- skillshare: any `Listing` owned, or `SkillOffer` accepted
- traveling: any traveler `Booking`
- `stats.totalSaved`: reuse the aggregation in `offer.routes.js` `/my-total-savings` (L422) plus PromoCode savings
- `og` badge for everyone created before the cutoff

Backfilled cards are marked sorted **with points** but **no popups** (`silent: true`).
Mission points for backfilled cards are **decision D2**.

Also run `db.users.updateMany({ expoPushToken: { $exists: true } }, ...)`. It's a no-op because
B1 means no tokens were ever stored. Users re-register on the next app open with the fixed build.

---

## 9. Metrics (`GET /api/admin/engagement/metrics`)

All computed from `EngagementEvent`, `EngagementProfile`, `PushLog` and `User.createdAt`:

| Metric | Query |
|---|---|
| Weekly users | distinct `user` with any event in the ISO week |
| D1/D7/D30 retention | cohort by `User.createdAt` day; returned if any event on day +1 / +7 / +30 |
| New users with 2+ cards sorted in week 1 | `sorted.*` within 7 days of `createdAt` |
| Avg cards sorted per active user | mean `sortedCount` over weekly-active |
| Weekly users with an active streak | `streak.count > 0 && lastActionDay >= today-1` |
| Push open rate by type/mood | `PushLog.openedAt != null / sent` |
| Push turn-offs per week | prefs flipped off + `osPushPermission` → denied, over weekly users (**stage gate: < 2%**) |

**Baseline (phase 0, B10):** until `app_open` data exists, compute retention from the union of
activity timestamps in existing collections. Label it a proxy in the dashboard.

---

## 10. Decisions needed from Majid (block the listed packets)

| # | Decision | Default if nobody answers | Blocks |
|---|---|---|---|
| D1 | Points values per reason (section 4.6) | the proposal table | P6 |
| D2 | Do backfilled cards give points? | yes, silently | P7 |
| D3 | Turn streaks on in phase 2 despite stage 1 (under 100 WAU)? | build it, keep the flag off | P12 |
| D4 | Do transactional pushes (chat, receipts) count toward the weekly cap? | no, but they respect quiet hours | P9 |
| D5 | "CV complete" = `isComplete` (≥ 85%) or 100%? | `isComplete` | P5 |
| D6 | Semester boundaries for exam mode | Jan–Jun / Jul–Dec | P12 |
| D7 | ~~Tour steps 2 and 3 targets~~ **Resolved:** Explore tab = Student Hub, Campus tab = Career Dashboard (UI_PLACEMENT §0) | – | – |
| D8 | `og` cutoff date | 31 Dec 2026 | P7 |
| D9 | What can points buy at launch? (needs 5 brand perks from partnerships) | promo codes only | P15 |
| D10–D13 | Founder Circle: card edition, not a rename; 50 seats until 31 Mar 2027; invite only; no cash | **Decided**, see LAUNCH_AND_FOUNDER_CIRCLE.md §B.2 | – |

---

## 11. Task packets for code generation

Each packet can be handed over on its own. Give the code generator this preamble **plus**
the packet **plus** the sections it references.

**Preamble (paste every time):**

> Backend: Node/Express 5, CommonJS (`require`), Mongoose 9, routes are `express.Router()` files
> mounted in `server.js`. Auth middleware sets `req.userId` (string), `req.user`, `req.userRole`
> and `req.isGuest` (`userId === 'guest-user'` for guests). Errors are `res.status(n).json({ message })`.
> No test framework: write tests with `node:test` + `node:assert` under `tests/`.
> Mobile: Expo SDK 54, React Native 0.81, plain JavaScript (no TS), React Navigation 7,
> `@tanstack/react-query` v5, the shared axios instance `import api from '../api/api'`,
> `StyleSheet.create`, gold `#f9c349`, dark `#1a1a1a`. Copy is lowercase, ends with a full stop, no emoji.
> Don't change existing response fields. Engagement hooks must never break the host route (try/catch).
> All engagement dates use `utils/karachiTime.js`.

| Packet | Repo | Creates | Modifies | Acceptance |
|---|---|---|---|---|
| **P0 Fixes** | both | – | `models/User.js` (pushTokens), `routes/notification.routes.js` (import + multi-token), `routes/offer.routes.js` (B7 role check), `app.json` (B8), `Home.js` (remove `/home-endpoint`) | token persists after login (check in Mongo); `/send` delivers; non-brand gets 403 on redeem-payment |
| **P1 Time utils** | backend | `utils/karachiTime.js`, `tests/karachiTime.test.js` | – | tests cover 23:59/00:01 PKT, ISO week on Mon, and the year boundary |
| **P2 Models** | backend | all of section 3 | – | `node -e "require('./models/EngagementProfile')"` works for each; indexes declared |
| **P3 Config + copy** | backend | `config/engagement.config.js`, `config/badges.config.js`, `services/engagement/copy.js`, `tests/copy.test.js` | – | copy lint test passes for every line |
| **P4 Engine core** | backend | `services/engagement/{index,engine,missions,streak,points,badges,popups}.js`, `tests/streak.test.js`, `tests/missions.test.js` | – | pure-function tests: streak extend/same-day/reset, next-card rule, snooze limit, dedupe |
| **P5 Hooks** | backend | – | every file:line in section 4.3 | each route still returns its old fields + `engagement`; a double request doesn't double-award |
| **P6 Engagement routes** | backend | `routes/engagement.routes.js` | `server.js` (mount) | every contract in section 5 returns the documented shape; guest → 401 on writes |
| **P7 Backfill** | backend | `scripts/backfillEngagement.js` | – | a dry-run flag prints per-feature counts; re-running changes nothing |
| **P8 Mobile foundation** | app | `engagement/api`, `EngagementProvider`, `hooks/*`, `utils/{moods,haptics,deepLinks}.js`, `components/Dot.js` | `App.js` (providers, navigationRef, response listener), `api/api.js` (interceptor + bus) | tapping a push with `route: 'Events'` opens Events from a cold start |
| **P9 Push gateway** | backend | `services/engagement/pushGateway.js`, `tests/pushGateway.test.js` | `utils/pushNotification.js` (multi-token, receipts) | tests: quiet hours, daily cap, weekly cap by stage, pref off |
| **P10 Missions UI** | app | `MissionCard`, `MissionProgressRow`, `MissionStack`, `CelebrationPopup`, `FullySortedCelebration`, `useCelebrationQueue`, `utils/pushPermission.js` | `Home.js`, `App.js` (`CelebrationHost`), `ProfileScreen.js` (x/8 row) | redeeming a deal flips the card with pop + haptic; only 1 popup per session; permission asked after the first flip, never on install |
| **P11 Tour** | app | `tour/*` | `TabNavigator.js` (4 target refs), `Home.js` (MissionStack scroll ref), `Social/SettingItem.js` (replay row) | 4 steps, skip works, shown once, replay works |
| **P12 Daily drop + solo streak** | both | `services/engagement/{drops,scheduler}.js`, `models/JobLock.js`, `routes/adminEngagement.routes.js` (drops); app: `DailyDropCard`, `StreakChip`, `StreakSheet` | `server.js` (start scheduler) | drop goes live at 19:00 PKT; warning at 20:00 only for at-risk users; rollover applies freeze/exam/break correctly; two server instances → one push |
| **P13 Notification settings** | app | `screens/NotificationSettingsScreen.js` | `DrawerNavigator.js`, `ProfileStack.js` (register), `screens/Social/SettingItem.js` (link) | toggling off `dailyDrop` stops the 19:00 push for that user |
| **P14 Badges + savings** | both | app: `BadgeShelf`, `BadgePip`, `BadgesScreen`, `SavingsCounter` | `ProfileScreen.js`, `components/Card.js`, `screens/Social/PostCard.js` (badge pip), `routes/social.routes.js` (include top badge in author projection) | one badge popup per session; share card exports an image |
| ~~P15 Rewards / points spend~~ → see CREW_SYSTEM §10 (P15, P15b, P21) | both | `routes` rewards endpoints, app `RewardsScreen` | `components/Points.js` (balance + entry) | concurrent redeems can't overdraw; ledger sums to balance |
| **P16 Metrics** | backend | admin metrics endpoint | – | returns section 9 for the last 8 weeks |
| **P17 iOS rich push** | app | NSE config plugin (`plugins/withNotificationServiceExtension.js`) | `app.json` | dot image shows on iOS (needs a native build; do it last) |
| **P19 Launch screen** | app | see LAUNCH_AND_FOUNDER_CIRCLE.md §A.5 | `App.js`, `AuthNavigator.js`, `Splash.js`, `app.json` | matches the reference animation; no yellow/Splash flash |
| **P20a/b Founder Circle** (entry rules per CREW_SYSTEM §5) | both | see LAUNCH_AND_FOUNDER_CIRCLE.md §B.8 | `Card.js`, `Points.js`, `FounderCircleScreen.js`, `ProfileScreen.js` | ≤ 50 seats; three card editions |
| **P18 Duo streaks, leaderboard, win-back** | both | `models/DuoStreak.js`, invite-by-referral flow, leaderboard, win-back cron | `Points.js` (share link carries referral) | stage 3 flags only |

**Build order, mapped to the plan's phases:**

- **Phase 0 (by 3 Oct):** P0, P1, P2, P3, plus `app_open` tracking from P6/P8.
- **Phase 1 (5–17 Oct):** P4, P5, P6, P7, P8, P9, P10, P11, P19.
- **Phase 2 (19–31 Oct):** P12, P13.
- **Phase 3 (2–14 Nov):** P14, P15, P16, P17, P20a, P20b (first founder invites 1 Dec).
- **Phase 4 (after 100+ WAU):** P18.

P0, P8 and P19 each need a **new native build** (B8, `expo-notifications` plugin). Batch them into
one EAS build early in phase 1 so later packets can ship as JS-only updates.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Hooks spread across ~15 routes, and one slips | `track()` never throws; add a `tests/hooks.smoke.js` that calls each hooked route against a test DB and asserts `engagement` is present |
| Points farming via repeatable actions | points only for once-per-life events (missions, milestones, badges); the streak counts once per day; B7 closes the redemption hole |
| Cron running twice on scaled Railway | `JobLock` per job per day |
| Popup spam across the celebration layer and the existing `NotificationBanner` | the celebration queue checks `bannerVisible` from `useNotificationPopup` and waits until it clears |
| Copy drifting away from the brand rules | server-side copy bank + lint test; the app only has fallbacks |
| 10s notification polling (`useNotifications.js`) adds load | out of scope, but the 60s `/engagement/me` refetch must not add to it. Only refetch on focus/active, and the interval only while Home is focused |
