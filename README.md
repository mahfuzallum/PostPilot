# PostPilot — Social Media Scheduler (posts to Threads, X and Reddit)

> No coding needed.

---

## What it does

| Platform | What the app does | What it does **not** do |
|---|---|---|
| **Threads (Meta)** | Publishes text, image, carousel and short video posts at the exact time you pick, or in auto slots (every 3–4 h, weighted to New York prime time). Fetches views/likes/replies/reposts 6–7 h after posting. Optional link as first reply. | Never deletes anything automatically. |
| **X (Twitter)** | Publishes the posts you write and schedule via the official `POST /2/tweets` (max 280 characters, up to 4 images via v2 media upload; video is not sent to X). Optional link as first reply. Recent search (last 24 h) for analysis. | No auto-likes, auto-replies, follows or reposts. Never deletes. |
| **Reddit** | Submits your scheduled post via the official `/api/submit` to the subreddit you type per post: first line = title (max 300), text post or link post. Subreddit top/rising for analysis. | Never comments, votes or follows. Follow each subreddit's rules. |

**Choosing platforms per post:** in Compose → *Post to*, tick Threads, X, Reddit (pill toggles, or **All**) and the accounts under each. One scheduled post with N ticked accounts becomes N queue rows, one per platform/account, so retries, analytics, deleted-post emails and owner stats work per platform. Over-limit text (Threads 500, X 280, Reddit title 300) is blocked with a clear message.

**Accounts connected before posting existed** were approved read-only. They show **Reconnect to enable posting**; click it once and approve the new permissions.

Other features: email/password accounts, AI writing (OpenAI), image library (choose a folder on your computer → images are scored for sharpness/contrast/resolution → upload best ones; each image is used only once), Cloudinary or Google Drive, dashboard (Published / Reached / Deleted), queue with edit/cancel, calendar, Free vs Premium plans, light/dark mode, a hidden owner admin page. English interface. When a post has a link, "#ad / affiliate" is added (you can switch it off per post).

**Pricing built in:** Free (10 scheduled posts / month) · Premium $7 / month · $16 / 3 months.

> **Payment integration is handled by the owner.** `src/payments.js` is a clearly commented placeholder: the pricing page shows both plans with **Coming soon** buttons until a provider is plugged in. Meanwhile the owner can give any user Premium from the owner admin page (plan override).

---

## Part A — Put it on Railway (about 10 minutes)

1. Go to **https://railway.com** → **Login** → sign in with GitHub (create a free GitHub account first if you don't have one).
2. Upload the code to GitHub:
   1. On **https://github.com** click **+** (top right) → **New repository** → name it `social-scheduler` → **Private** → **Create repository**.
   2. On the new page click **"uploading an existing file"**. Unzip `social-scheduler.zip` on your computer, then drag **all the files and folders inside it** (not the zip itself) into the browser → **Commit changes**.
3. In Railway: **New Project** → **Deploy from GitHub repo** → pick `social-scheduler` → **Deploy Now**.
4. **Add storage (very important, otherwise data is lost on every restart):** right-click the service (or **+ Create**) → **Volume** → attach to `social-scheduler` → **Mount path:** `/data` → **Create**.
5. **Public address:** service → **Settings** → **Networking** → **Generate Domain**. You get something like `https://social-scheduler-production.up.railway.app`.
6. **Variables (Part B)** → the app redeploys by itself.
7. Open your domain → **Start free** → create an account. Every signup is a normal user account.

Health check: `https://YOUR-DOMAIN/healthz` should show `{"ok":true}`.

---

## Part B — Railway Variables (set once by the owner)

**The website has no setup screens and no key boxes.** All API credentials are Railway **Variables**, set once by you (or your bot). End users never see them; they only click **Connect**, approve on the platform's own login page, and are done. Logins are stored encrypted (AES-256-GCM) and renewed automatically.

How: Railway → your service → **Variables** → **Raw Editor** → paste the contents of `railway-variables.example` → fill in the values you have → **Update Variables**. Anything left blank simply shows a greyed-out **Coming soon** button.

| Variable | Needed for |
|---|---|
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Connect Threads (posting) |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Connect Reddit. Scopes requested: `identity read submit`, duration=permanent (submit = posting). |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | Connect X. Scopes requested: `tweet.read tweet.write users.read media.write offline.access`. In the X developer portal the app's **User authentication settings** must be set to **Read and write**, and the project needs an API access tier that allows posting. |
| `OPENAI_API_KEY` | AI writer (optional) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Media hosting (optional, recommended) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Drive import (optional) |
| `THREADS_KEYWORD_SEARCH` | `yes` if Meta approved keyword search (optional) |
| `APP_URL` | Optional; auto-detected from Railway's domain |
| `ADMIN_PATH` | Optional; secret path of the owner page (see Part C) |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Optional; generated once and saved in `/data` if blank. Never change `ENCRYPTION_KEY` after users have connected. |

### OAuth callback URLs (paste these into each developer portal)
Replace `YOUR-DOMAIN` with your Railway domain (or `APP_URL`). https is required.

| Platform | Callback / redirect URL |
|---|---|
| Threads | `https://YOUR-DOMAIN/oauth/threads/callback` |
| Threads uninstall callback | `https://YOUR-DOMAIN/oauth/threads/uninstall` |
| Threads delete callback | `https://YOUR-DOMAIN/oauth/threads/delete` |
| Reddit | `https://YOUR-DOMAIN/oauth/reddit/callback` |
| X | `https://YOUR-DOMAIN/oauth/x/callback` |
| Google Drive | `https://YOUR-DOMAIN/oauth/google/callback` |

- **Threads** (https://developers.facebook.com/apps): create an app with the Threads use case; put the three Threads URLs above into Redirect / Uninstall / Delete callback; copy the Threads App ID + App Secret into Variables. Add yourself as a Threads Tester and accept the invite in Threads (Settings → Account → Website permissions → Invites). Optional permissions: `threads_keyword_search`, `threads_delete`. Before Meta **App Review**, only you and invited testers can connect.
- **Reddit** (https://www.reddit.com/prefs/apps): "create another app…" → **web app** → redirect uri above → the ID under the app name is `REDDIT_CLIENT_ID`, the secret is `REDDIT_CLIENT_SECRET`.
- **X** (https://developer.x.com/en/portal/dashboard): User authentication settings → **Read**, **Web App** → callback above → copy the **OAuth 2.0** Client ID / Client Secret (not the API Key). The Free tier has very small read limits.

---

## Part C — Hidden owner admin page

- Address: `https://YOUR-DOMAIN` + `ADMIN_PATH`. If `ADMIN_PATH` is blank, a random path like `/owner-3f9a…` (24 hex characters) is created on first start, saved in `/data/.admin_path`, and printed in Railway **Deploy Logs** (`Owner admin path: …`). Keep it private.
- It is not linked anywhere (no menu, footer, robots.txt or sitemap). Any page under it returns the normal "Page not found" unless you are logged in as owner.
- First visit: a one-time form to create the owner username + password (stored bcrypt-hashed). After that only a login form is shown. 5 wrong logins per 15 minutes per IP are blocked. It uses its own login cookie, with a **Log out** button.
- Inside (sidebar layout, works on phones):
  - **Overview**: KPI cards (users, active 24h/7d, Premium, expiring, banned, MRR) and per-platform analytics (published, views, deleted by users, queued, failed). Shows an "Email is not configured" hint until SMTP is set.
  - **Users**: search/filter; masked password ("stored hashed"); plan with a live expiry countdown; country, IP, registered and last active; Push on/off per user (the worker skips users with push off); ban/unban with a reason, with history; grant or revoke Premium (logged).
  - **Revenue**: payments ledger, MRR, per-user totals and a 12-month SVG chart. You can record manual payments too.
  - **Activity**: logins and actions with IP/country (kept for 90 days). **Audit log**: every action, filterable, paginated, CSV export.
  - **Accounts, Schedules** (edit, reschedule, remove; the user gets an email), **Competitors**, **Settings** (app name, default timezone, caption, free limit, registration open/closed).
  - **Email setup**: step-by-step Gmail App Password guide, copy chips for the Railway variables, set/missing status (values never shown) and a **Send test email** button.
- No API keys here; those stay in Railway Variables.

---

## Daily use
- **Settings** → Profile, Appearance (theme changes instantly), Posting defaults, timezone (auto-detected; presets or any IANA zone), Notifications, and optionally *your own* OpenAI key (stored encrypted, masked, with a Test button).
- **Compose** has a calendar picker, a typed/scroll-wheel/clock-face time picker, account checkboxes (several Threads accounts) and a live Threads/X/Reddit preview with character counters.
- **Compose** → write yourself or switch to **AI** → choose type (text/image/carousel/video) → pick media → optional link (+ “post link as first reply”) → **Exact time** (shows Dhaka and New York time) or **Auto slot** → Single or Batch (2 posts) → **Schedule**.
- **Queue** → edit / cancel / retry. **Calendar** → month view.
- **Dashboard** → Published / Reached / Deleted, per platform, recent posts, “low reach” flag (info only, default under 15 views — change it on the dashboard). **Delete** button = your manual choice.
- **Competitors** (Premium) → X search, subreddits, Threads keyword → pattern summary → “Draft inspired by pattern” writes *new original* text.
- Link in your Threads **bio** is something you add yourself in the Threads app.

## How reliability works
Worker runs every 30 s. Each post moves `scheduled → posting → published` with an atomic lock (never posted twice). Before posting: token valid, API reachable, `threads_publishing_limit` quota not full. Temporary errors retry after 2, 5, 15 and 60 minutes (max 4 tries; the queue shows "Retry n/4 · next …"). Permanent errors (bad media, policy) are not retried, and auth errors mark the account "Needs reconnect". Users with Push turned off by the owner are skipped. If the server was offline and a post is more than 15 min late it is marked **missed** (you can press Retry); less than 15 min late it is posted. Logins renew themselves: every 5 minutes the worker refreshes Threads tokens (60-day, `th_refresh_token`) within 7 days of expiry and Reddit/X tokens (refresh tokens via `duration=permanent` / `offline.access`; X uses PKCE) 10 minutes before expiry. If a platform still answers 401, the token is refreshed and the call retried once. If a user revokes access, their card shows 'Needs reconnect'.

## Run locally (optional, for developers)
```
npm install
npm start      # http://localhost:3000  (data in ./data)
npm test       # smoke test (mocked Threads, env-driven Connect, owner page)
```

## Known limitations
- Database is SQLite on the Railway volume (`/data`). `DATABASE_URL`/Postgres is **not** used; keep the volume attached and back it up (Railway volume backups).
- Threads: other users can connect only after Meta App Review; Threads API limit is 250 posts / 24 h per account; video must be a public MP4/MOV (Cloudinary recommended). Keyword search & delete need extra Meta permissions.
- X: read quota depends on your paid X API plan; no posting by design.
- No payment processor is included (owner-handled placeholder); Premium is granted from the owner page until one is plugged in.
- Emails (post deleted, Premium ends in 3 days / expired, payment failed) are sent only when `SMTP_*` variables are set; otherwise they are skipped and logged. Users can opt out per type in Settings → Notifications. Gmail allows about 500 emails per day.
- Payment provider webhooks are not wired: `payments.recordPayment()` is idempotent and ready, see the `/hooks/payment` comment in `src/payments.js`.
