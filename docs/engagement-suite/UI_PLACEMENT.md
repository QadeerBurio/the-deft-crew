# tdc Sorted System: where everything goes in the existing UI

Companion to `BLUEPRINT.md`. This file is screen by screen: what the screen looks like
today (from reading the code), where each new element goes, and which existing component
or style to reuse so it looks native to the app. Line numbers are from the
`claude/tdc-engagement-suite-arch-8ma4xf` branch on 24 Sep 2026.

Mirrored in both repos. Keep them identical.

---

## 0. The app shell, as it is today

```
Drawer (DrawerNavigator.js)
└─ HomeTabsScreen
   ├─ CustomHeader (DrawerNavigator.js:526)   [☰]   tdc.   [🔔 unread]
   │   (hidden when the Social tab is active)
   └─ TabNavigator (CustomTabBar, TabNavigator.js)
        Home   Explore   (Social●)   Campus   Profile
        │      │          │           │        └─ ProfileScreen.js
        │      │          │           └─ StudentDashboard.js  "Career DASHBOARD"
        │      │          └─ Social.js (own tab bar: Feed · Search · + · Messages · Profile)
        │      │              └─ FeedScreen.js  [Feed | Confession] toggle
        │      └─ Explore.js  "STUDENT HUB"
        └─ HomeStack → Home.js
```

**How the plan's names map to the app:**

| Plan says | In the app |
|---|---|
| Home | Home tab (`Home.js`) |
| Student Hub | **Explore tab** (`Explore.js`, subtitle "STUDENT HUB" at L611) |
| Career Dashboard | **Campus tab** (`StudentDashboard.js`, subtitle "Career DASHBOARD" at L527) |
| Feed + Confession | centre gold button → `Social.js` → `FeedScreen.js` Feed/Confession toggle (L576–588) |
| Loyalty Points | Profile menu row "Loyalty Points" (`ProfileScreen.js:503`). Today it shows a **hardcoded "250"** and opens a "Coming Soon" alert. |
| Membership Card | `components/Card.js` (screen `Card`); the Profile row opens a promo modal first |

This settles **decision D7**: tour step 2 is the Explore tab and step 3 is the Campus tab.

**Visual language to match** (from `Home.js` L26–31 and the existing cards):
white background, `LIGHT #fafafa` cards with a 1px `BORDER #f0f0f0`, radius 14–16, gold
`#f9c349` accents, dark `#1a1a1a` text, section titles 18/800. Headers use the
`tdc` + gold `.` wordmark. Motion comes from `FadeInView` (Home.js:101) and spring press-scale.
`expo-haptics` is already used on every tap in the header and profile.

---

## 1. Global layers (render above every screen)

Mount in `App.js` inside `AppContent`, next to `<GlobalNotificationLayer />`:

```jsx
<NavigationContainer ref={navigationRef} theme={MyTheme}>
  <AppNavigator />
</NavigationContainer>
<GlobalNotificationLayer />   // existing top banner (inbox notifications)
<CelebrationHost />           // NEW: sorted / badge / streak pop-ups
<TourOverlay />               // NEW: 4-step coach marks
```

`CelebrationHost` waits while `NotificationBanner` is visible, the keyboard is open,
the tour is running, or the AI chat modal on Home is open.

**Pop-up look** (`CelebrationPopup`): centred white card, radius 24, like the sign-out modal
in `ProfileScreen.js` (the `modalOverlay` / `modalContent` styles). Inside: a 120px dot
Lottie, one line of copy (16/700, dark), one gold button (full width, radius 14, text dark 15/800),
and a small grey "not now" link underneath. There's no title, no icon row and no emoji.

---

## 2. Top header (`navigation/DrawerNavigator.js`, `CustomHeader`, L526)

Today: `[☰ menu]   tdc.   [🔔]`. It shows on Home, Explore, Campus and Profile.

**Add a streak chip to the left of the bell** in `headerRight` (L716), only when
`flags.soloStreak && streak.count > 0`:

```
[☰]          tdc.          (● 12) [🔔]
```

- `StreakChip` is 32px tall with radius 16, `LIGHT` background and a 1px `BORDER`, the same
  height as `headerCircleBtn`. It holds a 14px dot in the health mood (sorted, panic, or sleepy)
  and the count (13/800).
- Tapping it opens `StreakSheet` (a bottom sheet in the same Modal style as the sign-out modal),
  with the copy "12 days. best 21. 1 freeze left." and an exam mode toggle.
- Hide it while the search field is open, the same way the bell is hidden (`!searchVisible`).

This is the only header change. Don't add a points counter here, because that breaks
rule 2 (one ask at a time).

---

## 3. Home tab (`screens/Home.js`)

**Today** (inside the `ScrollView`, L458):

```
Slider (L475, fed by /home-endpoint, which 404s)
"Explore Features" / "All you need in one place"   (SectionHeader L482)
┌────┐┌────┐┌────┐
│Disc││Trav││Skil│   FEATURES grid, 3 columns, 8 FeatureCards (L485)
└────┘└────┘└────┘
┌────┐┌────┐┌────┐
│Evnt││Resm││Jobs│
└────┘└────┘└────┘
┌────┐┌────┐
│Schl││Socl│
└────┘└────┘
bottomSpacer                                      (AI FAB floats bottom-right, L502)
```

**After:**

```
Slider                                   (keep; source from /engagement/home or keep static)
── MissionStack ─────────────────────────  (NEW, only while sortedCount < 8)
┌──────────────────────────────────────┐
│ (● big dot, mood)                    │   MissionCard: width 100% of content (16px gutters),
│ cv from matric?                      │   radius 16, LIGHT bg, BORDER, padding 18,
│ [ build my cv  → ]                   │   gold CTA pill. Swipe left = snooze 7 days.
└──────────────────────────────────────┘
 ● ● ● ○ ○ ○ ○ ○   3/8 sorted            MissionProgressRow: 8 × 10px dots + 12/700 label
── DailyDropCard ──────────────────────── (NEW, after 19:00 PKT when a drop is live)
┌──────────────────────────────────────┐
│ today's drop. (dot)                  │
│ biryani or karahi at 2am?            │
│ [ biryani ]  [ karahi ]              │
└──────────────────────────────────────┘
"Explore Features"                        (existing section, unchanged)
8 FeatureCards  ← each gets a tiny sorted state (below)
```

Implementation notes:
- Insert both blocks between the Slider (`Animated.View`, L471–476) and
  `<View style={styles.content}>` (L479). Put them *inside* the content view, using
  `FadeInView delay={100}` and `delay={150}`, so the entrance matches the rest of Home.
- **Existing FeatureCard gets a sorted indicator.** `FeatureCard` already has a small
  `featureIconDot` (8px, top-right of the icon, Home.js:141/`styles.featureIconDot`). Swap its
  colour for the mission state: the feature's gradient colour while unsorted (today's look), and a
  **gold dot with a white check** once sorted. Pass `sorted` in via `missions.cards`. The Home grid
  becomes the passive "8 cards" view the plan describes, with no new layout.
- The `FEATURES` ids (`discount`, `traveling`, `dashboard`, `events`, `resume`, `jobs`, `scholar`,
  `social`) map to mission keys (`discounts`, `traveling`, `skillshare`, `events`, `resume`, `jobs`,
  `scholarship`, `social`). Put that map in `engagement/utils/moods.js`, not in Home.
- When `sortedCount === 8`, replace `MissionStack` with one line: `(● sorted) fully sorted.` (13/700, MUTED).
- Guests see `MissionStack` with a single card, "sign up to get sorted.", which goes to
  `Login` (the same pattern `CustomHeader` uses for guests at L664).
- The `DailyDropCard` action buttons use the same chip style as `offerTag` (Home.js styles).
  After voting, show the percentage bars with the `offerProgressBar` style that's already there.
- Tour step 1 targets the **Home tab icon**, but the post-tour "first mission" scroll target is
  `MissionStack`. Give it a `ref` and call `scrollTo` from `TourProvider`.
- Remove the `/home-endpoint` `useQuery` (L389–397) → `useDailyDrop()`.

---

## 4. Explore tab = Student Hub (`screens/Explore.js`)

Today: the "tdc. STUDENT HUB" header, "EXPLORE FEATURES" module list (L632), and hardcoded stats (100+ / 25+ / 500+).

- **Tour step 2** target: the Explore tab icon in `CustomTabBar`.
- Add no new cards (one ask at a time: missions live on Home only).
- Optional (phase 3): once a feature is sorted, its module row can show the same gold check dot as the Home grid. Same `sorted` map, same dot component.

## 5. Campus tab = Career Dashboard (`screens/StudentDashboard.js`)

Today: the "Explore / Career DASHBOARD" header and an "EXPLORE MODULES" list (L542)
with Resume (`ResumeDashboard`), SkillShare (`Dashboard`), Jobs (`Career`) and Exchange.

- **Tour step 3** target: the Campus tab icon.
- On the module rows for Resume, Jobs and Exchange, add the sorted check dot (same as Home).
- When the "jobs, no cv" push lands here (`route: 'Campus'`), nothing extra is shown. The
  push copy explains it.

---

## 6. Social (`screens/Social/Social.js` → `FeedScreen.js`, `ConfessionScreen.js`)

- **Tour step 4** target: the centre gold `centerButton` in `CustomTabBar` (TabNavigator.js).
- **Deep link to confessions:** `FeedScreen` keeps the Feed/Confession toggle in local state
  (`useState("Feed")`, L57). Add `route.params?.initialTab === 'Confession'` →
  `handleTabSwitch('Confession')` on focus. The mission card and the "confession picked" push
  both use it.
- **Badge next to names, Feed only.** In `PostCard.js`, render `BadgePip` (12px dot, the
  author's top badge mood) right after the author name. The backend adds `author.topBadge`
  to the author projection in `social.routes.js` feed queries.
- **Never on confessions.** `ConfessionScreen.js` shows every author as "Anonymous"
  (L705, L764, L810). A badge next to an anonymous author would narrow down who wrote it
  and break the "we won't tell." promise. The plan asks for badges on confessions. **Don't
  build that.** The only confession-side badge is the author's own "confession of the day"
  badge, which shows on their profile.
- Stories don't count for streaks or missions, so there are no UI changes there.

---

## 7. Profile tab (`screens/ProfileScreen.js`)

**Today:**

```
[avatar]  Name / email                        profileHeader
┌ Used  3  │  Discounts  5 ┐                 statsRow (L639)
Menu card (L670):
  Profile Details
  Membership Card     → promo modal ("GET MEMBERSHIP")
  Loyalty Points  250 → Alert "Coming Soon!"      ← placeholder (L503–508)
  My Discounts     5
  Settings            → drawer SettingsScreen (Social/SettingItem.js)
  Sign Out
Version 2.0.1
```

**After:**

```
[avatar] Name / email
         (● 12)  ● badge ● badge ● badge  +3      NEW row under the email: StreakChip + BadgeShelf (compact)
┌───────────────────────────────────────────┐
│ you've saved rs 3,420 on tdc.   [share]   │   NEW SavingsCounter (above statsRow)
└───────────────────────────────────────────┘
┌ Used 3 │ Discounts 5 │ Sorted 3/8 ┐              statsRow gets a 3rd statItem
Menu:
  Profile Details
  Membership Card
  Loyalty Points   1,250 pts  → RewardsScreen     (real balance, real screen)
  Badges           5/17        → BadgesScreen     NEW row (phase 3)
  My Discounts
  Settings
  Sign Out
```

Implementation notes:
- `totalSaved` is **already fetched** (`/offers/my-total-savings`, L215) and stored in state,
  but it's only passed on to `MyDiscountScreen` and never shown. Switch it to `me.stats.totalSaved`
  and render `SavingsCounter`. It's a gold-bordered card, radius 16, same width as `statsRow`.
  "share" makes an image with `react-native-view-shot` and opens `expo-sharing`
  (both installed; `Card.js` already does this for the card).
- **Loyalty Points row** (L503–508): replace `rightText: "250"` with
  `` `${me.points.balance.toLocaleString()} pts` `` and set `onPress` to
  `navigation.navigate('Points')` (the crew screen, CREW_SYSTEM §8). The first time it's tapped, show the one-time `Tooltip`
  ("points come from getting sorted. spend them on brand perks.").
- `statsRow` has 2 `statItem`s with a `statDivider`. Add a third ("Sorted" / `3/8`) with
  the same markup and the gold icon box.
- The StreakChip + BadgeShelf row goes inside `userInfo` under `emailRow` (L609 area). Hide it
  entirely at stage 1 (`flags.soloStreak` and `flags.badges` both false). The profile then
  looks like today, plus the savings counter and the real points row.

---

## 8. Membership Card (`components/Card.js`)

Today: a flippable card (`FrontContent`/`BackContent`), a status line ("PREMIUM ACCESS ACTIVE" at L497
or "WAITING FOR VERIFICATION"), the activate button, and download/share.

- The plan says badges show on the Membership Card. Add a **badge strip on `BackContent`**
  (not the front, which holds the card number and has to stay clean for the scanner):
  up to 5 × 18px dots in a row labelled `BADGES` in the same small-caps style as `memberLabel`.
- Under the status line, add `SavingsCounter` compact (one line, no share button).
- One-time tooltip on first open: "your badges live on the back. tap to flip."

---

## 9. Points screen = "Refer & Earn" (`components/Points.js`)

> **Superseded by `CREW_SYSTEM.md` §8.** This screen becomes "the crew." and holds points, levels,
> referrals, campus crew, Founder Circle and spending. There's no separate `RewardsScreen`.

This is the drawer's `Points` route. It's a **referral** screen ("Refer & Earn" header L972, hero
progress card L992, Achievement Tiers L1003, referral link, share).

- Keep it as the referral screen. Don't add the points balance here, or two "points" concepts will
  sit on the same screen.
- The drawer already labels it "Refer & Earn" (DrawerNavigator.js:152). No rename needed. Add a
  separate drawer item "Rewards" → `Rewards`.
- Phase 4: the duo streak invite reuses this screen's share link, which already carries
  the referral code (`getDownloadLink`, Points.js:575).

**New `RewardsScreen`** (registered in the drawer as `Rewards`): a header like Card.js's
(`headerTitle` / `headerSubtitle`), a balance hero card (gold gradient, the same look as the
Card front), a reward list in `ModernOfferCard`-style tiles (2 columns), and a "history" section
(ledger list).

---

## 10. Settings

There are **two** settings screens:
- `screens/Social/SettingItem.js`, registered as drawer `SettingsScreen`. **This is the one the
  Profile tab opens.** It has a `ToggleItem` component and a commented-out "Push Notifications"
  toggle (L388–395).
- `screens/SettingScreen.js`, used by `ProfileStack` (not reachable from the current tab bar).
  It links to `NotificationSettings`, which doesn't exist.

**Changes, in `SettingItem.js`:**
- Add a row "notifications" → `NotificationSettings` (use its existing `SettingItem` row component).
- Add "replay the tour" → `TourProvider.start()` then `navigate('Home')`.
- Add "exam mode" → opens `StreakSheet` (only if `flags.soloStreak`).
- Delete the commented-out Push Notifications toggle. It's replaced by the new screen.

**New `NotificationSettingsScreen`:** reuse `ToggleItem` from `SettingItem.js` (same
icon-bubble + label + switch look). There are 5 rows: streaks (sleepy dot), daily drop (excited),
deals (broke), jobs & scholarships (shook), social (sus). If the OS permission is denied, show a top row
"notifications are off for tdc. [open settings]" → `Linking.openSettings()`.

---

## 11. Where the "sorted" moment actually happens

The celebration pop-up is global, but the action has to reach it. Most of these screens call the
API with **raw `axios`/`fetch`, not the shared `api` instance**, so an interceptor on `api.js`
would miss them. Each call site needs one line after success: `celebrate(res.data?.engagement)`
(exported from `engagement/EngagementProvider`), which queues the pop-ups and refreshes `['engagement']`.

| Action | Call site today | What the user sees today | Change |
|---|---|---|---|
| Redeem a deal (QR) | Student: `screens/MyDiscountScreen.js:1009` (`/offers/scan-verify`). The brand then completes `/offers/redeem-payment` on their device. | the existing scan flow | Nothing inline. The pop-up arrives via `pendingPopups` on the next `/engagement/me` refetch (app foreground / Home focus). Also refetch when the student returns to MyDiscountScreen. |
| Redeem a deal (promo code) | backend webhooks / brand verify | "CODE USED" state in MyDiscountScreen (L348) | same as above |
| Finish CV | `api/resumeApi.js:132` (`api.put('/resume/:id')`, called from `ResumeContext.js`) | the builder | `celebrate()` in the save handler. Pop-up CTA "see your job match %." → `Career` |
| Apply to a job | `components/Career.js:1391`, `components/TDCCareers.js:538`, `api/resumeApi.js:317` | `ToastAndroid "Submitted!"` / iOS `Alert "Success!"` (Career.js:1396) | `celebrate()` after success. Keep the Android toast, and drop the iOS Alert when a celebration is queued. |
| Post | `screens/Social/CreatePostScreen.js:183` (fetch) | goes back to the feed | `celebrate()` before `goBack()`. The pop-up shows on the feed. |
| Confession | `screens/Social/ConfessionScreen.js:630` (fetch) | the list refreshes | `celebrate()`. Defer while the compose sheet is open (the keyboard rule handles this). |
| Comment | `PostCard.js:616`, `PostDetailScreen.js:460`, `UserProfile.js:894`, `ConfessionScreen.js:546`, `Social/ProfileScreen.js:325` | – | `celebrate()` in each |
| RSVP | `screens/Events/Events.js:689` | `Alert.alert("Success", "Registration successful.")` | replace the Alert with `celebrate()`. If nothing is returned to celebrate, keep a small toast, not an Alert. |
| Scholarship apply | `components/ApplicationForm.js:103` | its own success UI | `celebrate()` |
| Skill listing | `api/api.js:505` `createListing` (uses `api`) | ProfileSuccess-style screens | `celebrate()` in `CreateListingScreen` after success |
| Skill swap accepted | `api/api.js:636` `updateOfferStatus` | – | `celebrate()` |
| Trip booked | `components/BookingScreen.js:27` → `/api/bookings` (**this is `booking.routes.js`**, which settles the open question in BLUEPRINT §4.3) | – | `celebrate()` |
| Job bookmark (streak only) | `api/api.js:347` | – | `celebrate()` (streak popups only) |

Existing success UIs that should step aside when a celebration is queued: `Alert.alert`
success dialogs (Events, Career apply). The "🎉 Offer Claimed!" overlay in `OfferScreen.js:307`
is for *claiming*, not redeeming, so it stays, but its copy should follow the brand rules
("offer claimed. show it at the counter.").

---

## 12. Tour targets (register refs)

| Step | File | Element | ref id |
|---|---|---|---|
| 1 | `navigation/TabNavigator.js` `CustomTabBar` | Home `TouchableOpacity` | `tab_home` |
| 2 | same | Explore `TouchableOpacity` | `tab_explore` |
| 3 | same | Campus `TouchableOpacity` | `tab_campus` |
| 4 | same | `centerButtonContainer` | `tab_social` |

All four are in one component, which keeps `TourOverlay` measurement simple. The tab bar
is `position: 'absolute'` at the bottom (`tabBarWrapper`), so show the tooltip bubble
**above** the target, and add `insets.bottom`.

The tour runs on the first Home focus after sign-up. Keep it behind the AI FAB's
z-index conflict: `TourOverlay` renders in `App.js` above the navigator, so it already
covers the FAB.

---

## 13. What stays untouched

- The inbox notification bell and `NotificationModal`. They show `Notification` documents as today.
- The `NotificationBanner` top toast. It still shows new inbox items.
- Explore and Campus layouts (only the sorted check dots in phase 3).
- Referral / VIP logic in `Points.js` and `Card.js`.
- The Social tab bar (Feed · Search · + · Messages · Profile).
