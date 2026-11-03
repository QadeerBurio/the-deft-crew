# Staging environment

A second copy of the server on Railway, with **its own database**, where changes are tried before
production. In staging, every background job is **off by default**: no schedulers, no imports and no
pushes. You switch on only the job you want to test.

Production is not affected by anything here. Nothing in this guide changes a production variable.

---

## 1. Database: a separate MongoDB Atlas cluster

Use a **separate cluster**. A new database name inside the production cluster is not enough. Two reasons:

- The chat service always uses the database name `The_deft_crew_Ai_assistant`, hard-coded in
  `chat-service/src/config/db.ts`. On the production cluster, staging would read and write the
  production AI database.
- With its own cluster and database user, staging *cannot* reach production data, even by a typo.

Steps (Atlas):

1. Atlas → **New Project** → name it `tdc-staging`. A separate project keeps users and network rules
   apart.
2. **Create cluster.** The free M0 tier is enough. Pick the same region as production.
3. **Database Access → Add database user.** Username `tdc-staging-app`, generated password, role
   *Read and write to any database*. The role covers only this project's cluster.
4. **Network Access.** Allow `0.0.0.0/0`, because Railway has no fixed outgoing IP on most plans. The
   cluster is protected by the user and password.
5. **Connect → Drivers** → copy the connection string. Add the main database name to the path, e.g.
   `mongodb+srv://tdc-staging-app:<password>@<staging-cluster>/tdc_staging?retryWrites=true&w=majority`.
   It goes into Railway as `MONGO_URI` and `BACKEND_MONGO_URI` (step 2).

**Test data.** Start empty and create test accounts through the app and portal. **Never restore a
production dump into staging**: it would copy students' personal data, and their push tokens, into an
environment more people can reach. If realistic data is ever needed, export only what you need with
the e-mails, phones, names, `pushTokens` and ID-card fields removed.

---

## 2. Railway: a `staging` environment

1. Railway → the project → **Settings → Environments → New Environment** → name it **`staging`**.
   Choose **an empty environment**, not "Duplicate production". A duplicate copies every production
   secret, and each one would then have to be found and replaced.
2. In `staging`, add the server service from the same GitHub repository. Under **Settings → Source**,
   pick the branch to deploy: a `staging` branch, or the PR branch you are testing.
3. **Settings → Networking → Generate Domain.** This gives the staging URL, e.g.
   `https://tdc-server-staging.up.railway.app`. It is called `<staging-url>` below.
4. Add the variables in the next section, then deploy.

Railway sets `RAILWAY_ENVIRONMENT_NAME=staging` in this environment by itself, and the server treats
that as staging even if `APP_ENV` is missing. Set `APP_ENV=staging` anyway, so the intent is visible.

### Variables

**Set in staging, each with a staging-only value.** Never copy the production value.

| Variable | Staging value | Why |
|---|---|---|
| `APP_ENV` | `staging` | All background jobs are off (section 3). |
| `NODE_ENV` | `production` | The same code paths as production. It also keeps `LOG_DEV_CODES` from printing one-time codes. |
| `MONGO_URI` | staging cluster string (step 1) | Main database, and the chat service's AI database (same cluster). |
| `BACKEND_MONGO_URI` | the same string | The chat service reads the main data from here. |
| `JWT_SECRET` | a new random value (`openssl rand -hex 32`) | Production sign-ins must not work on staging, and staging sign-ins must not work on production. |
| `PUBLIC_BASE_URL` | `<staging-url>` | **Required.** Without it, the server falls back to the production URL. WooCommerce webhooks registered from staging would then call production, and push icons and ticket links would point there. |
| `BRAND_PORTAL_URL` | the staging portal URL (section 4) | Links in brand e-mails. |
| `STORE_CREDENTIALS_KEY` | a new random value (`openssl rand -hex 32`) | Encrypts connected stores' keys. Staging encrypts its own; production's key never leaves production. |
| `CRON_SECRET` | a new random value | Protects the cron endpoints. |
| `CORS_ORIGIN` | the staging portal URL | Chat service. |

**Third-party services.** Use test or sandbox keys, or leave them unset.

| Variable | In staging |
|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | A separate Resend API key with a sending limit, or the same domain with test inboxes only. If no mail provider is set, sign-up codes can't be sent and testers can't verify accounts. |
| `CLOUDINARY_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | **A separate Cloudinary account, or at least a separate API key.** Staging uploads and deletes must not touch production images and resumes. |
| `EXPO_ACCESS_TOKEN`, `EXPO_ACCESS_TOKEN_112506B0`, `EXPO_ACCESS_TOKEN_D14CDF3A` | Unset, unless you switch pushes on (section 3). Even then, pushes go only to devices signed in to staging. |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | A separate key with a low monthly limit, or unset (AI features then fail on staging). |
| `REDIS_URL` | A Railway Redis added inside `staging`, or unset. |
| `SHOPIFY_*` | Unset, unless a separate Shopify development app is used. Never the production app's secrets. |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JSEARCH_API_KEY`, `RAPIDAPI_KEY` | Unset. Job imports only run from the admin "ingest" button; set them only to test that. |
| `GEOCODER`, `GEOCODER_API_KEY` | Unset, or a separate key. |

**Leave unset in staging:**
- `LOG_DEV_CODES`: local machines only.
- `BACKGROUND_JOBS`: staging is already off.
- `DISABLE_NOTIFICATION_PUSH`: tests only.

**Feature flags** work the same as in production: `FLAG_<NAME>` (see `config/featureFlags.js`).
Staging is the place to try a rule first, e.g. `FLAG_META_EVENTS=roles:admin`.
Brand loyalty is `FLAG_LOYALTY_V2` (off by default). It must cover both the brand and the student,
e.g. `FLAG_LOYALTY_V2=ids:<test brand id>,<test student id>`.

---

## 3. Background jobs: all off in staging

Each job starts only if `jobEnabled()` in `config/featureFlags.js` allows it. The rules:

1. `JOB_<NAME>=on` or `off` decides that one job, in any environment.
2. Otherwise, `BACKGROUND_JOBS=off` turns every job off.
3. Otherwise, every job is **off in staging** (`APP_ENV=staging` or `RAILWAY_ENVIRONMENT_NAME=staging`)
   and **on everywhere else**.

| Job | Variable to switch it on in staging | What it does |
|---|---|---|
| `eventIngestion` | `JOB_EVENT_INGESTION=on` | Imports Karachi events every hour, plus one pass 10 s after start. |
| `socialPush` | `JOB_SOCIAL_PUSH=on` | Every minute, sends the grouped pushes for new posts, confessions and listings. |
| `jobCleanup` | `JOB_JOB_CLEANUP=on` | At startup, archives imported jobs outside Pakistan (the old purge). Also: the expired-job clean-up at start and every 6 h, and the job field backfills. |
| `engagementScheduler` | `JOB_ENGAGEMENT_SCHEDULER=on` | Daily drop, streak reminders, rollover and weekly reset (cron). |
| `chatSync` | `JOB_CHAT_SYNC=on` | The chat service's database sync sweeps. |
| `pushes` | `JOB_PUSHES=on` | **Every** Expo push. While off, nothing reaches a phone: push tickets say `PUSHES_OFF` and tokens are kept. |
| `careerOutbox` | `JOB_CAREER_OUTBOX=on` | Every 5 minutes: hiring-timeline notification retries and 24 h / 1 h interview reminders (only does anything for `FLAG_CAREER_TIMELINE` applications). |

**What is not a job.** Job ingestion from the Adzuna, JSearch and Greenhouse feeds has no schedule; it runs only when an admin presses
"ingest" in the portal. E-mail is sent as part of requests (sign-up codes, tickets), so it follows the
mail settings above, not a switch.

**Checking it.** The first log line after the database connects lists what runs:

```
[jobs] staging: on none; off eventIngestion, socialPush, jobCleanup, engagementScheduler, chatSync, pushes, careerOutbox
```

To test one job, set its variable to `on` and redeploy. The line then lists it under `on`. Remove the
variable when done.

**Production.** Nothing needs setting there: all jobs stay on. To stop one job in an emergency, set
`JOB_<NAME>=off` and restart. For example, `JOB_PUSHES=off` stops every push at once.

---

## 4. Pointing the brand portal at staging

The portal reads the server address from `REACT_APP_API_URL`: the origin only, without `/api`. Create
React App bakes it in at **build** time.

- **Local:**
  ```
  REACT_APP_API_URL=<staging-url> npm start
  ```
  For a staging build: `REACT_APP_API_URL=<staging-url> npm run build`.
- **Hosted:** create a second site or deployment (e.g. a "staging" or preview environment on the
  host). Set `REACT_APP_API_URL=<staging-url>` there, and leave production's value as it is.
  Put that site's URL into the server's `BRAND_PORTAL_URL` and `CORS_ORIGIN` (section 2).

Until the change that makes every portal screen use `REACT_APP_API_URL` is merged, many screens still
call the production URL directly. Don't use a staging portal build before then.

---

## 5. Pointing the app at staging

The app reads the server address from `EXPO_PUBLIC_API_URL`: the origin only, without `/api`. Expo
inlines `EXPO_PUBLIC_*` variables at build time. When the variable is missing, the app uses production.

- **Expo Go or a dev build on your machine:**
  ```
  EXPO_PUBLIC_API_URL=<staging-url> npx expo start --clear
  ```
- **An installable staging build (EAS).** Store the value in an EAS environment, not in a file:
  ```
  eas env:create --environment preview --name EXPO_PUBLIC_API_URL --value <staging-url> --visibility plaintext
  ```
  Build with a profile that uses the `preview` environment. Which profile uses which environment is
  set in `eas.json`, so the app owner makes that change. Production builds keep using the
  `production` environment, where the variable is unset or set to the production URL.

Install staging builds only on testers' phones. Pushes from staging are off anyway (section 3).

Until the change that makes every app screen use `EXPO_PUBLIC_API_URL` is merged, some screens call the
production URL directly. Don't hand out a staging build before then.

---

## 6. First deploy checklist

1. The logs show `[jobs] staging: on none; off …`, and no `🧹 [Startup]` or `[EventScheduler]` lines.
2. `GET <staging-url>/api/app/flags` returns `{"metaEvents":false}`, and the response has an
   `X-Request-Id` header.
3. Sign up a test student from a staging app build. The code e-mail arrives (if mail is configured),
   and the user appears in the **staging** cluster, not in production.
4. No `mongodb+srv://`, e-mail address or phone number appears in the Railway logs. They are printed
   as `mongodb://[redacted]`, `***@domain` and `[phone]`.
5. In the production logs, nothing changed.

## 7. Backlog (known, not changed)

- **Leftover `job_applied` block in `POST /api/jobs/:jobId/interactions`** (`routes/jobs.routes.js`,
  around line 1573). After saving the interaction, the handler runs a copy of the apply route's
  engagement hook: `track(req.userId, 'job_applied', …)`. That copy refers to `application`, which
  doesn't exist in this route.
  - **What happens now:** a `ReferenceError`, caught by the block's own `try/catch`. Each call logs
    `[engagement] job_applied hook failed: application is not defined`, and the request still
    returns 200. No `job_applied` points are awarded from here, which is correct.
  - **Why it matters soon:** nothing calls this route yet. Once the app calls it (the app's
    `fix/two-404-calls` branch corrects the path), every job view will log that line.
  - **The fix:** delete the block (lines `try { await track(… 'job_applied' …) } catch …`) from this
    handler only, and leave the one in the apply route.

## 8. Removing staging

Railway → **Settings → Environments** → delete `staging`. This removes its services and variables.
Atlas → the `tdc-staging` project → terminate the cluster. Revoke any staging-only keys you created
(Resend, Cloudinary, OpenAI).
