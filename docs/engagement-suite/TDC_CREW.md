# tdc crew: the one loyalty system

This is **the only spec** for points, levels, referrals, ambassadors, influencers and Founder Circle.
It replaces `CREW_SYSTEM.md` and `AMBASSADOR_PROGRAM.md` (both deleted) and overrides anything about points,
levels, ambassadors or Founder Circle entry in the other docs.

`REWARDS_AND_CREDENTIALS.md` still covers **how** rewards are delivered (PDFs, verification, Majid's letters).
`LAUNCH_AND_FOUNDER_CIRCLE.md` §B.5 still covers the founder card design.

Mirrored in the backend and app repos. Keep them identical.

---

## 1. The whole system on one page

```
everyone has ONE code  ──►  friend joins with it  ──►  friend sorts their first card
                                                          │
                              ┌───────────────────────────┴───────────────────────────┐
                        code owner: +100 pts                                friend: +100 pts
                                                                           + welcome perk (first deal bonus)

use tdc (missions, streaks) ──► more pts

lifetime pts ──► level (never goes down)          balance ──► spend on brand perks
   rookie 300 · main character 1,000 · pro 3,000 · goat 6,000 · founder circle 10,000 (apply)
```

**Three ideas, and nothing else:**
1. **One code per person** (the existing `User.referralCode`).
2. **One number:** crew points. Lifetime points set the level. The balance is credit to spend.
3. **One ladder for everyone:** students, ambassadors and influencers climb the same levels with the same rules.

**Partners** (ambassadors and influencers) are **not a separate system**. They're users with a `partner` tag
that unlocks two things: a stats view and campaign codes with brands. Same points, same ladder, same Founder Circle rule.

---

## 2. Earning points

| Action | Points | Who |
|---|---|---|
| A friend joins with your code **and sorts their first card** | **100 to you + 100 to them** | everyone |
| That friend's first redemption at a **campaign brand** (§5) | +50 to the code owner | partners |
| Each Get Started mission | 50 (all 8 = 400, +200 bonus) | everyone |
| Streak milestones 7 / 30 / 100 days | 50 / 250 / 1,000 | everyone |
| An approved social post about tdc (§4) | 50 / 150 / 300 by reach | partners |
| Anything special Majid wants to recognise | set by admin, with a reason | anyone |

Only real use counts. There are no points for opens, likes or signups that never use the app.
All values are in `config/crew.config.js`.

## 3. Levels (the same for everyone)

| Level | Lifetime points | You get (no cash) |
|---|---|---|
| member | 0 | your code, missions, savings counter |
| deft rookie | 300 | digital badge with your name |
| deft main character | 1,000 | **free Gold card for a year** + experience certificate |
| deft pro | 3,000 | recommendation letter from Majid + Instagram feature |
| deft goat | 6,000 | internship referral + LinkedIn recommendation from Majid |
| **founder circle** | **10,000 + apply** | founder card (#01–#50), founder letter, quarterly session with Majid, lifetime Gold |

**Founder Circle, one rule for everyone:** 10,000 lifetime points **and** all 8 cards sorted **and** good standing
→ an "apply" button → Majid approves. There are 50 seats, open until 31 Mar 2027.
There's no score, no candidate list and no separate path for ambassadors.

The existing tier screens (`DigitalBadgeScreen`, `MainCharacterScreen`, `DeftProScreen`, `DeftGoatScreen`,
`FounderCircleScreen`) stay as the level detail pages. All cash lines come out, and the rewards are listed above.

---

## 4. Partners: ambassadors and influencers

| | Ambassador | Influencer |
|---|---|---|
| Who | a student who represents tdc on their campus | a creator we send to brands (may not be a student) |
| How they join | applies in the app ("become a campus ambassador.") **or** is added by an admin | added by an admin |
| Tag | `partner.type = 'ambassador'` + university | `partner.type = 'influencer'` + Instagram/TikTok handle |

**What a partner gets on top of a normal user:** that's all, three things.
1. A **"partner" badge** and a pip next to their name in the Feed (never on confessions).
2. A **"your impact" block** on the crew screen: link opens → joined → sorted a card → still active after a week,
   their share link with ready-made story cards, and a **"submit a post"** button (link + screenshot).
3. **Campaign codes** with brands (§5). This is mostly for influencers.

**What they don't get:** trial months, seat limits, monthly targets or a separate ranking. They were cut to keep it simple.
The same points and levels apply, and partners simply climb faster.

**Posts:** the admin approves each submitted post and picks the reach: 50 (posted), 150 (1k+ views), 300 (5k+ views).

---

## 5. Both sides benefit: welcome perks and brand campaigns

### 5.1 Every code (default)

When someone signs up with any code and sorts their first card:
- **the friend** gets **100 points + a welcome perk**: an extra 10% off their first redemption at any partner brand
  (brand-funded, set per brand, opt-in by the brand)
- **the code owner** gets **100 points**

Signup shows "ali invited you. you both get 100 points." and the first deal screen shows
"welcome bonus: +10% on this one."

### 5.2 Brand campaigns (influencer × brand)

When we send an influencer to a brand (e.g. Ali × Kaffeine), the admin creates a **campaign**:

```
Campaign: ali × kaffeine · 1–31 oct · follower perk: +15% on the first visit to kaffeine · cap 200 followers
```

- The influencer shares their **same code** (a campaign doesn't create a new code). While the campaign is live, their link
  and code carry it: `go.gettdc.pk/r/ALI7K2`.
- **Follower:** signs up with the code → 100 points + **the campaign perk** instead of the default one
  ("ali sent you. +15% at kaffeine on your first visit."). The Kaffeine offer shows the bonus at the top of their list.
- **Influencer:** 100 points per follower who sorts a card, and **+50 when that follower redeems at Kaffeine**.
  They see the campaign's numbers in "your impact".
- **Brand:** a new **"campaigns"** section in their portal shows the followers who joined, first visits redeemed,
  bill total and savings given. That's proof the influencer visit worked.
- **When a follower redeems:** the brand's scanner shows "welcome bonus +15% (ali's campaign)".
  `redeem-payment` computes the discount on the server (it's also the B7 security fix) and marks the perk as used.
  One use per follower.

Brands set the bonus percentage and cap, and agree to it before the campaign starts. tdc pays nothing.

---

## 6. What the student sees (one screen)

The **Refer & Earn screen (`components/Points.js`) becomes "the crew."** It's the only place any of this lives.
Profile's "Loyalty Points" row (hardcoded "250" today) opens it.

```
the crew.
[ ring: progress to next level ]   2,450 pts · deft pro · 3,550 to goat

your code  X7K2PQ   [ share ]          "friend joins and sorts a card: you both get 100."

ways to earn   friend +100 · mission +50 · 7 day streak +50

levels         rookie ✓ · main character ✓ · pro ✓ · goat · founder circle     (existing TierCard list)

your impact    ← partners only: funnel, story cards, submit a post, active campaign stats

spend          2-column brand perks → redeem
my rewards     badge ✓ · certificate ✓ · letter (preparing, by 19 oct)
```

The app has one screen and one number. The only extra block is "your impact", and only partners see it.

## 7. What the admin sees (admin portal)

Add **one** sidebar section, "crew", to `AdminDashboard.js`, with four screens:

| Screen | Purpose |
|---|---|
| **Inbox** | everything waiting on a person: partner applications, posts to review, letters to issue, links to post. Overdue first. |
| **Partners** | a table of ambassadors and influencers: joined, % who sorted a card (**red below 40%**), % active after a week, their own app use, posts, points, best channel. Click for details. Add a partner here. |
| **Campaigns** | create/end an influencer × brand campaign (brand, influencer, follower perk, dates, cap), with live results |
| **Credentials** | issue Majid's letters (draft → edit → preview → issue), award points or badges, revoke, and settings (signature, templates, agreements) |

Brand portal (`src/screens/Home.js`, brand role): add a **"campaigns"** menu item next to "Redemption",
showing that brand's campaign results (read-only).

## 8. What was removed (so nothing conflicts)

| Removed | Why |
|---|---|
| Founder score, contribution log, candidate list | points already measure everything; one rule for everyone |
| Ambassador trial month, 3 seats per campus, waitlist, monthly targets, target bonus, campus rank | too many rules for a small program; can come back later as config |
| Separate Rewards screen and crew hub | everything lives on the one crew screen |
| Drop preview for ambassadors | kept only as an idea for later |
| Referral credited at signup | now only when the friend sorts a card (stops fake signups) |
| Cash rewards on every tier | replaced by the non-cash rewards in §3 |

---

## 9. Backend (only what's new beyond BLUEPRINT)

```js
// EngagementProfile additions
points: { balance, lifetime },
level: { id, reachedAt },
partner: { type: 'none'|'ambassador'|'influencer', since, university, handle, addedBy } ,
welcomePerk: { campaign: ObjectId|null, brand: ObjectId|null, percent: Number, usedAt: Date|null }

// models/Campaign.js
{ brand: ObjectId(User brand), partner: ObjectId(User), followerPercent: Number, startsAt, endsAt,
  cap: Number, status: 'draft'|'live'|'ended', createdBy }

// models/ReferralClick.js  { code, referrer, channel, at }      (tracked links)
// models/PartnerPost.js    { user, platform, url, screenshotUrl, status, reach: 'posted'|'1k'|'5k', points, reviewedBy }
// models/PartnerApplication.js { user, university, why, handle, status, reviewedBy }
// Reward, RewardRedemption, Credential, AgreementVersion/Acceptance: as in BLUEPRINT §3.4 and REWARDS_AND_CREDENTIALS §6
```

**Referral rule** (in `engine.js`, when a user's `sortedCount` goes 0→1): if `user.referredBy` is set,
award 100 to both (`ref:{referrer}:{user}` and `welcome:{user}`), and set `welcomePerk` from the referrer's live campaign,
or the default.

**Redemption** (`offer.routes.js` `/redeem-payment` and the promo verify routes): if the student's `welcomePerk` is unused and
applies to this brand (or any brand for the default), add `percent` to the server-computed discount, set `usedAt`, and
if it came from a campaign, award the partner +50.

**Endpoints** (`routes/crew.routes.js`, `routes/adminCrew.routes.js`)

```
GET  /api/crew/me                  → points, level, levels[], code, share link, waysToEarn, spend catalog, myRewards,
                                     founder { canApply, seatsLeft, closesAt, checklist }, impact (partners only)
POST /api/crew/partner/apply       { university, why, handle }        (after accepting the partner agreement)
POST /api/crew/posts               { platform, url, screenshotUrl }
POST /api/crew/founder/apply       { answer }
POST /api/crew/rewards/:id/redeem
GET  /r/:code?s=ig|wa|tt|copy       public tracked link → store / landing page
GET  /verify/:code                  public credential check (REWARDS_AND_CREDENTIALS §3.3)

Admin: /api/admin/crew/inbox · partners (list, detail, add, remove) · posts/:id/review · campaigns (CRUD + results)
       · credentials (draft, preview, issue, revoke) · points/award · settings
Brand: GET /api/brand/campaigns     → that brand's campaign results
```

**Agreements:** only **two**. `crew_terms` (points have no cash value, can't be transferred, fraud is removed, rewards
can change with notice) and `partner` (what a partner does, no pay, how their name is used, it can end anytime).
Founder Circle applicants tick a short founder section inside the apply sheet.

**Referral attribution** (so word of mouth is counted): on Android, read the Play install referrer with
`expo-application` on first launch; on iOS, the landing page shows the code with a copy button. Signup prefills the code
and shows "ali invited you." This needs `expo-application` in the same native build as P0/P19.

---

## 10. Packets (replace P15, P15b, P20a/b entry rules, P21, P25–P27)

| Packet | Repo | What | Done when |
|---|---|---|---|
| **C1 Crew backend** | backend | config, models above, points/levels in `points.js`, the referral rule, the welcome perk in redemption, crew + admin routes, founder apply (FounderSeat from LAUNCH §B.7), migration script | both sides get 100 only after the friend's first sort; the campaign perk applies once at the right brand; the partner gets +50; the level never drops after spending; nobody loses their card or tier in migration |
| **C2 Crew screen** | app | `Points.js` → "the crew." (§6), 5 tier screens (no cash, rewards from the server), Profile row, signup prefill + "invited by", install referrer | one screen shows everything; partners see "your impact"; an Android install from a link needs no typing |
| **C3 Admin crew section** | tdc_admin_portal | Inbox, Partners, Campaigns, Credentials (§7) | Majid can add a partner, start a campaign and issue a letter from the portal |
| **C4 Brand campaigns view** | tdc_admin_portal | "campaigns" in the brand `Home.js` menu | a brand sees its campaign's joins and redemptions |

Credential delivery stays as **P22/P23** (REWARDS_AND_CREDENTIALS). The founder card design stays as **P20b** (LAUNCH §B.5).

**Order:** C1 → C2 → C3 → C4, all in phase 3. The one exception: campaigns (C1 campaign part + C3 Campaigns + C4) can be
pulled into **phase 1** if you're sending influencers to brands now. It only needs the code, the welcome perk and the
redemption change.

## 11. Migration

- Past referrals: 100 points each for referred users who have sorted a card (after the engagement backfill).
- Anyone with the Gold card today (`isVip`) or 10+ referrals keeps it and starts at a minimum of 1,000 points (main character).
  Anyone who reached the old Rookie (50 referrals) starts at a minimum of 300.
- Existing ambassadors: the admin adds them as partners in the portal (there's no automatic import, because there's no ambassador data in the app today).
