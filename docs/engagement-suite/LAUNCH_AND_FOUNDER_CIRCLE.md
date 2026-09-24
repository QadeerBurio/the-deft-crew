# Launch screen and Founder Circle card

Two additions to the engagement suite. They extend `BLUEPRINT.md` (packets P19 and P20)
and `UI_PLACEMENT.md`. Mirrored in both repos. Keep them identical.

---

# Part A: launch screen (P19)

## A.1 Reference

The reference animation is `assets/launch_reference.mp4`
(1080×1920, 30fps, **1.6s**, one pop sound). The keyframes, one every 0.1s, are in
`assets/launch_keyframes.png`.

Measured from the frames (sizes as a % of screen width, everything centred on screen):

| Time | What happens | Size | Easing |
|---|---|---|---|
| 0.00–0.10s | pure black | – | – |
| 0.10–0.35s | **panic** dot (worried face, sweat drop) pops in, overshoots and jitters | 0 → 50% → 44% | spring, overshoot about 1.1 |
| **0.40s** | face flips **panic → sorted** (content smile). **Pop sound peak** here. | 44% | cross-fade of the face layers, 80ms |
| 0.45–0.70s | squash and settle (about scaleX 1.08 / scaleY 0.92 at 0.5s) | 44% | spring |
| 0.75–0.85s | dot shrinks | 44% → 31% | ease-in |
| 0.85–1.00s | "tdc" fades in from grey to white. The dot shrinks to full-stop size, loses its face, and slides into the full-stop position. | dot 31% → about 5.5%; wordmark about 39% | ease-in-out |
| 1.00–1.60s | final "**tdc.**": white wordmark with a gold full stop, held | – | – |

The story is the app's whole loop in 1.6 seconds: **panic → sorted → tdc.**

## A.2 What happens today (problems)

- The native splash is **yellow** (`app.json` `splash.backgroundColor #f9c349`) with `tdc.png` set to `cover`.
- `App.js` `prepare()` holds it with a hardcoded **2s** `setTimeout`, even though nothing is loading.
- Logged out: `screens/Splash.js` adds its own black logo intro with a hardcoded **2.8s** timeout, then
  shows the Terms screen on **every** launch.
- Logged in: `AuthNavigator` doesn't wait for `AuthContext.loading`, so the logged-out Splash
  can flash for a moment before Home.
- `screens/SplashScren.js` (`TDCFlow`) is imported but never shown.

## A.3 Target flow

```
native splash: pure black, nothing on it
   └─► LaunchScreen overlay (JS): plays the 1.6s animation
         ├─ runs in parallel: AuthContext loads the stored token; if logged in, prefetch /engagement/me
         └─ at 1.6s: if ready → 250ms fade → the real first screen (Home, onboarding, or Login)
                     if not ready → the gold full stop breathes (scale 1 ↔ 1.25, 700ms loop)
                                    until ready, 4s max, then continue anyway
```

Every user sees the full 1.6s once per cold start. There's no launch screen when the app
resumes from the background.

## A.4 Build decisions

1. **Asset: Lottie first.** Ask the designer to export the same After Effects comp to a
   **Lottie JSON** with Bodymovin (`assets/launch/launch.json`), including the "tdc." text as
   shapes, not a font. Play it with `lottie-react-native` (installed, v7). That's pixel-identical
   to the video and needs no animation code. **Fallback** if the export isn't possible: build it
   with `react-native-reanimated` 4 + `react-native-svg` (both installed), with the timings from A.1
   and the two faces and the wordmark as SVG paths from the designer.
2. **Native splash: pure black, no logo.** The video starts on an empty black frame, which also
   avoids Android 12+ cropping the splash icon into a circle. In `app.json`:
   - Remove the top-level `splash` block and add the `expo-splash-screen` plugin:
     `["expo-splash-screen", { "backgroundColor": "#000000", "image": "./assets/launch/blank.png", "imageWidth": 1, "dark": { "backgroundColor": "#000000" } }]`
     (`blank.png` is a 1×1 transparent PNG).
   - `android.adaptiveIcon.backgroundColor` stays as it is (that's the app icon, not the splash).
   - Set top-level `backgroundColor` to `#000000` so the root view doesn't show yellow between frames.
   - **Needs a native build.** Ship it in the same EAS build as P0 (push fixes).
   - Check on a real Android 12+ device that nothing is drawn on the black before the JS takes over.
3. **Sound: haptic every time, sound once.** A sound on every app open gets annoying and plays in
   public. The pop at 0.40s fires `Haptics.impactAsync(Light)` on every launch. The pop **sound** plays
   only on the first launch after install, through `expo-audio` (installed), and never in silent mode
   (`playsInSilentMode: false`). Store the flag in AsyncStorage `tdc.launchSoundPlayed`.
   Export the sound from the video as `assets/launch/pop.m4a` (about 0.4s, starting 0.35s into the clip).
4. **Reduce motion.** If `AccessibilityInfo.isReduceMotionEnabled()`, skip straight to the final
   "tdc." frame for 400ms, then continue.
5. **Status bar:** `light-content` on black during launch. Screens set their own after that.

## A.5 File changes

| File | Change |
|---|---|
| `app/src/launch/LaunchScreen.js` (new) | the overlay: black `View` with `StyleSheet.absoluteFill`, `LottieView` 100% width centred, `onAnimationFinish` → `markAnimationDone()`. Haptic at 0.40s via a `setTimeout(400)` started with the animation. |
| `app/src/launch/useAppReady.js` (new) | resolves when `AuthContext.loading === false` and (if logged in) `/engagement/me` has settled or 1.5s has passed. It uses `SplashScreen.hideAsync()` **once**, when LaunchScreen first renders (so native black → JS black with no seam). |
| `App.js` | Delete the `setTimeout(2000)` in `prepare()`. Render `<AppContent />` immediately, with `<LaunchScreen />` above it (after `<TourOverlay />`), and unmount it after the fade-out. `SplashScreen.preventAutoHideAsync()` stays at the top. |
| `app/src/navigation/AuthNavigator.js` | Return `null` while `AuthContext.loading` (the overlay covers it), so the Splash-to-Drawer flash goes away. |
| `app/src/screens/Splash.js` | Remove the logo intro block and the 2.8s timer. It becomes onboarding only: first launch → slides, otherwise → `navigation.replace(termsAccepted ? 'Login' : 'Privacy')`. |
| `app/src/screens/PrivacyScreen.js` | On accept, set `AsyncStorage 'tdc.termsAccepted' = 'true'` (a returning, logged-out user then goes to Login, not Terms). |
| `app/src/screens/SplashScren.js` | Delete it, and delete its import in `AuthNavigator.js` (dead code). |
| `app.json` | per A.4.2 |
| `assets/launch/` (new) | `launch.json`, `pop.m4a`, `blank.png` |

**Acceptance:** cold start on a mid-range Android shows no yellow frame, no logo flash, and no Splash
flash for a logged-in user. The animation matches the reference frames at 0.1s steps. The app is usable
within 1.85s when data is warm. The pop sound plays on first install only and is silent in silent mode.

---

# Part B: Founder Circle card (P20)

The decisions below are my recommendations, which you've accepted. They replace
**D9** and add D10–D13 to the blueprint's decision table.

## B.1 What exists today

- **Membership Card** (`components/Card.js`): one design with a `vip` boolean.
  `BASIC MEMBER` vs `PREMIER CARD` (Gold), paid Rs 750/year or unlocked by 10 referrals.
- **Founder Circle** (`components/FounderCircleScreen.js`): the **top rung of the referral ladder**
  in `components/Points.js` (Rookie → Main Character 100 → Deft Pro 500 → GOAT 2,000 →
  **Founder 5,000 downloads**). It promises **PKR 15,000 cash**, a founder job recommendation letter,
  a LinkedIn recommendation and lifetime mentorship. At current install numbers nobody can reach it.

## B.2 Decisions

| # | Decision |
|---|---|
| D10 | **The Membership Card keeps its name.** Founder Circle is a third **edition** of the same card, so there's still one card, one screen and one scanner flow. |
| D11 | **50 numbered seats** (#01–#50), open until **31 Mar 2027**, then **closed forever**. It isn't a percentage, because "top 1%" of 15 weekly users is nobody. A later elite tier can have a different name. |
| D12 | **Invite only.** The system shortlists by a minimum bar and a score (B.3). Majid approves every seat. You can't pay for it, and 5,000 referrals automatically puts someone on the shortlist but doesn't grant the seat. |
| D13 | **No cash reward.** At PKR 15,000 × 50 seats = PKR 750,000, it's an open-ended liability. Rewards are listed in B.4. The same risk exists for GOAT/Pro/Main Character (PKR 10k/5k/2k). Leave those as they are in this project, but decide on them separately. |

## B.3 Who gets a seat

**Minimum bar (all required):**
- all 8 missions sorted (`EngagementProfile.sortedCount === 8`)
- account at least 30 days old, and active in at least 3 of the last 4 ISO weeks (`EngagementEvent`)
- `accountStatus === 'active'`, and no report against them upheld in the last 90 days (`Report`)

**Founder score (0–100), shown to admins only:**

| Part | Max | Formula |
|---|---|---|
| **Built it with us** | 35 | sum of logged `Contribution.points` (feedback shipped 5, confirmed bug 3, beta test session 5, Crew lead month 10, content picked 3), capped at 35 |
| Uses everything | 25 | `sortedCount/8 × 15` + `min(streak.best, 30)/30 × 10` |
| Grows tdc | 20 | 2 per verified referral install (the referred user signed up and sorted at least 1 card), capped at 20 |
| Saves | 10 | `min(totalSaved / 5000, 1) × 10` |
| Community | 10 | 5 per confession of the day or feature in a drop, capped at 10 |

"Built it with us" weighs the most because that's the point of the circle. It only exists
if someone logs it, so the admin contribution log (B.6) is part of this packet, not an extra.

**Monthly review:** on the 1st of each month, `GET /admin/founder/candidates` lists everyone who meets
the bar, sorted by score. Majid invites people from that list. The invitee has 14 days to accept.

## B.4 What founders get

1. **Founder edition card** (B.5), which stays theirs even after the circle closes.
2. **Lifetime Gold.** `isVip` stays on with no `vipExpiry` for as long as they have a seat.
3. **Founder recommendation letter + LinkedIn recommendation** (kept from the current screen).
4. **1:1 founder session every quarter** (replaces "lifetime mentorship", which was open-ended).
5. **Priority beta access + a roadmap vote.** They test new features first, which feeds "built it with us".
6. **One brand perk per semester**, from partnerships.
7. **Founder mark** next to their name in the Feed (never on confessions, which are anonymous).

## B.5 Card design (inside the existing `Card.js`)

Replace the `vip` boolean with `edition: 'basic' | 'premier' | 'founder'`. Derive it from
`/auth/profile/me` → new field `founder: { seat: 7, since: '2026-10' } | null`.
Founder takes priority over premier.

```
FRONT (founder)                               BACK (founder)
┌─────────────────────────────────────┐       ┌─────────────────────────────────────┐
│ tdc.                          [chip]│       │ ALI RAZA                            │
│                                     │       │ +92 3xx xxxxxxx                     │
│        CARD NUMBER                  │       │ BADGES  ● ● ● ● ●                   │
│        4821 0930 1173 5520          │       │                                     │
│                                     │       │ FOUNDER CIRCLE              tdc.    │
│ FOUNDER            SINCE            │       └─────────────────────────────────────┘
│ #07 of 50          OCT 2026         │
└─────────────────────────────────────┘
```

| Element | basic | premier (today's Gold) | **founder** |
|---|---|---|---|
| Background | `BACKGROUND_IMAGE` + dark gradient | same, lighter gradient | **solid `#000`, no image**, faint gold `GoldPattern` at 0.18 opacity |
| Border | none | `goldBorder` | `goldBorder` at 2px, full-strength gold `#f9c349` |
| Wordmark | white "tdc" + gold "." | same | **gold "tdc" + white "."** (inverted, so it's recognisable at a glance) |
| Bottom-left label / value | MEMBER / user id | MEMBER / user id | **FOUNDER / `#07 of 50`** |
| Bottom-right | – | VALID THRU / date | **SINCE / `OCT 2026`** (no expiry) |
| Back footer tag | BASIC MEMBER | PREMIER CARD | **FOUNDER CIRCLE** |
| Status line under the card | – | PREMIUM ACCESS ACTIVE | **founder circle #07. forever.** |

The download and share buttons work as they do today. The share image uses the founder front.
The card number and QR stay unchanged, so brand scanning is unaffected.

## B.6 Where it shows in the app

| Place | Change |
|---|---|
| **Invite moment** | Full-screen, black, and using the **launch animation's language**: the panic dot flips to sorted, then shrinks into the gold full stop after **"founder circle #07."** One button, "i'm in." → `POST /engagement/founder/accept`, then a light haptic, then the Card screen showing the new edition. It's triggered by a `founder_invite` popup (priority over everything, including `fully_sorted`) plus a transactional push: "you're in. founder circle #07." |
| **Profile** (`ProfileScreen.js`) | A small gold pill "founder #07" next to `userName` (L609). The "Membership Card" row subtitle becomes "founder circle #07" with a gold icon. |
| **Membership Card** (`Card.js`) | the founder edition (B.5) |
| **Refer & Earn** (`Points.js`) | Remove the `founder` tier from the ladder (it ends at GOAT). Below the ladder, add one black card: **"founder circle. invite only. 50 seats, 38 left. closes 31 mar."** For non-founders, it shows their minimum-bar checklist (✓ 8/8 sorted, ✓ 30 days, ○ active 3 of 4 weeks), never their score or rank. Tapping it opens the reworked `FounderCircleScreen`. |
| **`FounderCircleScreen.js`** | Keep the layout. Change the copy to lowercase with no emoji ("👑 FOUNDER CIRCLE" → "founder circle."), replace the rewards list with B.4, and remove "PKR 15,000 Cash". For founders it shows their seat and "share founder circle". For everyone else it shows the checklist and "how seats are picked". |
| **Feed** (`PostCard.js`) | Founders get `BadgePip` in gold with a thin ring, taking the top-badge slot. The backend adds `author.founderSeat` to the feed author projection. **Never on confessions.** |
| **Drawer** | no new item (reached from Profile and Refer & Earn) |

## B.7 Backend

**Models**

```js
// models/FounderSeat.js
{ seatNumber: { type: Number, min: 1, max: 50, unique: true },
  user: { type: ObjectId, ref: 'User', unique: true, sparse: true },
  status: { enum: ['invited','accepted','declined','expired','revoked'] },
  invitedAt, inviteExpiresAt, acceptedAt, invitedBy: ObjectId, note: String }

// models/Contribution.js  ("built it with us" log)
{ user: ObjectId, kind: { enum: ['feedback_shipped','bug_confirmed','beta_session','crew_lead_month','content_picked'] },
  points: Number, note: String, ref: String, loggedBy: ObjectId }
```

The seat number is assigned on **accept**: the lowest free number, taken with a conditional insert.
A declined or expired invite frees nothing, because seats are only created on accept.
The count of 50 includes open invites, so never more than `50 − accepted` invites are open at once.

**Service:** `services/engagement/founder.js`, with `meetsBar(userId)`, `score(userId)`,
`candidates()`, `invite()`, `accept()` (sets `isVip = true`, clears `vipExpiry`, sets
`cardStatus = 'Active'`), and `revoke()` (bans only).

**Endpoints**

```
GET  /api/engagement/founder
     → { open: true, closesAt, seatsLeft: 38,
         me: { status: 'none'|'invited'|'accepted', seat: 7|null, inviteExpiresAt|null },
         checklist: [{ key: 'sorted_all', label: '8/8 sorted.', done: true }, ...] }
POST /api/engagement/founder/accept        → { seat: 7 }        409 if expired / full / closed
POST /api/engagement/founder/decline       → { ok: true }

GET  /api/admin/founder/candidates         → [{ user: {_id,name,university}, score, breakdown, meetsBar: true }]
POST /api/admin/founder/invite  { userId } → { inviteExpiresAt }   409 if seats full or closed
POST /api/admin/founder/revoke  { userId, reason }
CRUD /api/admin/contributions
```

`GET /auth/profile/me` adds `founder: { seat, since } | null`. `GET /engagement/me` adds the same,
plus a `founder_invite` entry in `popups` when one is pending.

## B.8 Packets

| Packet | Repo | Creates | Modifies | Acceptance |
|---|---|---|---|---|
| **P19 Launch screen** | app | `launch/LaunchScreen.js`, `launch/useAppReady.js`, `assets/launch/*` | `App.js`, `AuthNavigator.js`, `Splash.js`, `PrivacyScreen.js`, `app.json`; delete `SplashScren.js` | Part A acceptance |
| **P20a Founder backend** | backend | `models/FounderSeat.js`, `models/Contribution.js`, `services/engagement/founder.js`, routes above | `routes/auth.routes.js` (`/profile/me` founder field), `engagement.routes.js`, feed author projection in `social.routes.js` | seats can't exceed 50 under concurrent accepts; invites closed after 31 Mar 2027; the score breakdown sums correctly |
| **P20b Founder app** | app | `FounderInvite` full-screen | `Card.js` (edition), `ProfileScreen.js`, `Points.js` (ladder + founder card), `FounderCircleScreen.js` (copy, rewards, states), `PostCard.js` (founder pip) | all three editions render. The founder share image shows the seat. The Feed shows the pip and confessions never do. |

**Phase placement:** P19 goes in phase 1, in the same native build as P0. P20a/b go in **phase 3**
(badges and savings), because the minimum bar needs missions to be live and the score needs a
month of activity. The first invites go out on **1 Dec 2026**.
