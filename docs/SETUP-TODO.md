# Setup checklist — things only you can do

Ordered by what they unblock. Items in **§1 are blocking right now**; everything else
lines up with a specific phase, so you can do it just before that phase lands.

Nothing here is code — it's credentials, cloud config, physical hardware, and the handful
of decisions that are yours rather than mine.

---

## 1. Blocking now — PR #1 deploys but the app can't store anything

Right now `/api/health` reports `storage: "unconfigured"`. The app builds and deploys; it
just has nowhere to put data.

- [ ] **Create a storage account** (~$0.05/month at family scale).

  ```bash
  az group create --name family-dashboard --location eastus

  az storage account create \
    --name fdstorage$RANDOM \
    --resource-group family-dashboard \
    --sku Standard_LRS \
    --kind StorageV2

  # Grab the connection string — you'll paste it in the next step.
  az storage account show-connection-string \
    --name <the-name-you-just-used> \
    --resource-group family-dashboard \
    --query connectionString -o tsv
  ```

- [ ] **Set it on the Static Web App**, along with the household settings.

  ```bash
  az staticwebapp appsettings set \
    --name <your-swa-name> \
    --setting-names \
      TABLES_CONNECTION_STRING="<connection string from above>" \
      HOUSEHOLD_ID="home" \
      HOUSEHOLD_TZ="America/New_York"
  ```

  Or in the Portal: **Static Web App → Settings → Environment variables**.

- [ ] ⚠️ **Set `HOUSEHOLD_ID=preview` on the PR environment, before the next preview deploy.**

  This is the one with a real consequence if skipped. SWA staging environments **share
  production app settings and therefore production storage**. Every partition key in the
  schema is household-prefixed, so this single setting gives complete isolation — but only
  if it's set *before* a preview deploy writes anything.

  ```bash
  az staticwebapp appsettings set \
    --name <your-swa-name> \
    --environment-name 1 \
    --setting-names HOUSEHOLD_ID="preview"
  ```

  (`--environment-name` is the PR number.)

- [ ] **Confirm your timezone.** I've assumed `America/New_York`. This is load-bearing:
      every partition key uses *local* dates, so the wrong zone puts chores on the wrong day.

---

## 2. Decisions I need from you

- [ ] **Merge PR #1 now, or keep stacking?** It currently holds Phases 0–2 (scaffold, PIN
      identity, chores + approvals). It's green and self-consistent. My default is to keep
      stacking all 9 phases onto it unless you'd rather review in smaller pieces — say the
      word and I'll open a fresh PR per phase from here.

- [ ] **Which tablet?** This changes nothing in the code but it does change the setup
      instructions I write, and it's worth deciding early:
      - **Android + [Fully Kiosk Browser](https://www.fully-kiosk.com/)** — meaningfully
        better for this. Real kiosk mode, screen-on control, auto-restart, remote admin.
      - **iPad + Guided Access + Safari** — workable, clumsier. No proper kiosk mode.

      (We deliberately skipped a PWA, so kiosk behaviour comes from device configuration
      rather than code.)

- [ ] **Node 20 vs 22.** Some `@azure/core-*` packages now declare `node >=22` while the SWA
      runtime is pinned to `node:20`. It works today — they're transitive deps of
      `@azure/data-tables`, which itself declares `node >=20`. If you can check whether your
      SWA supports `apiRuntime: "node:22"`, I'd rather move deliberately than inherit a
      silent mismatch. Not urgent.

---

## 3. Before Phase 5 — Claude integration

- [ ] **Create an Anthropic API key** at [console.anthropic.com](https://console.anthropic.com)
      → API Keys.

- [ ] **Set a monthly spend limit on it.** Realistic usage is under $1/month, but a runaway
      loop is exactly the failure a cap is for. The code has its own daily budget caps
      (40 Haiku / 10 Sonnet / 3 Opus calls) that silently fall back to hand-written copy when
      exhausted — this is the belt to that's braces.

- [ ] **Add it to the SWA:**

  ```bash
  az staticwebapp appsettings set \
    --name <your-swa-name> \
    --setting-names ANTHROPIC_API_KEY="sk-ant-..."
  ```

- [ ] **Use a separate, lower-limit key for the preview environment** so a broken loop in a
      PR can't drain production quota.

- [ ] **Read the PG-13 rubric and tell me if it's wrong for your family.** I'll put the exact
      banned/allowed lists in front of you when Phase 5 lands. The realistic failure mode of
      this whole project isn't technical — it's a generated quip that lands as mocking one
      kid, displayed permanently on a kitchen wall. Your calibration beats mine.

---

## 4. Before Phase 6 — Google Calendar

- [ ] **Decide which Google account owns the household calendar.** One account connects, once.
      This is *not* per-person login — PINs handle identity; this is a single stored refresh
      token, server-side and encrypted.

- [ ] **Create a Google Cloud project** → APIs & Services → **enable the Google Calendar API**.

- [ ] 🚨 **Publish the OAuth consent screen ("In production").**

      This is the single most common way projects like this break. Left in **Testing**
      status, Google expires refresh tokens after **7 days** — your calendar silently stops
      syncing every week and nothing tells you why. Publishing shows an "unverified app"
      interstitial once and caps at 100 users; both are irrelevant for a family.

- [ ] **Create an OAuth 2.0 Client ID** (type: *Web application*) with these redirect URIs:
      - `https://<your-swa>.azurestaticapps.net/api/google/oauth/callback`
      - `http://localhost:4280/api/google/oauth/callback` (Google exempts localhost from HTTPS)

- [ ] **Generate a token encryption key** and add everything to the SWA:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

  ```bash
  az staticwebapp appsettings set \
    --name <your-swa-name> \
    --setting-names \
      GOOGLE_CLIENT_ID="..." \
      GOOGLE_CLIENT_SECRET="..." \
      GOOGLE_REDIRECT_URI="https://<your-swa>.azurestaticapps.net/api/google/oauth/callback" \
      TOKEN_ENCRYPTION_KEY="<the base64 value above>"
  ```

- [ ] **Share the household calendar with each family member's personal Google account.**
      Easy to forget, and without it the calendar shows on the wall tablet but not on
      anyone's phone. This is a Google-side sharing step, not something code can do.

- [ ] **Know the scope limit up front:** the dashboard will create/edit/delete single events
      and individual instances of recurring series. **Editing a whole series deep-links out to
      Google Calendar.** Full RRULE round-tripping is a bigger job than the entire points
      economy, so it's deliberately out of scope. Tell me now if that's not acceptable.

---

## 5. Before Phase 9 — the cron tick

- [ ] **Generate a shared secret and add it as a GitHub repo secret** named
      `CRON_SHARED_SECRET` (Settings → Secrets and variables → Actions):

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- [ ] **Add the same value to the SWA** as `CRON_SHARED_SECRET`.

- [ ] **Know the caveat:** GitHub Actions cron is best-effort — it runs 5–20 minutes late
      under load, and **GitHub disables scheduled workflows after 60 days of repo
      inactivity**. Nothing correctness-critical depends on it (materialization and calendar
      sync both run lazily on read), but it will drift. The clean escape hatch, if it becomes
      annoying, is SWA Standard (~$9/mo) plus a linked Function App, which gives real timer
      triggers.

---

## 6. Content — the stuff only your family knows

None of this blocks me building; it's what turns a working app into *your* app. Drop it in a
comment or a file whenever convenient and I'll seed it.

- [ ] **The roster:** names as they should appear, an emoji each, and who's a parent.
      (Placeholders today: Dad, Mom, Maya, Theo, Iris.)

- [ ] **PINs**, or tell me to leave the seeded ones and let everyone change their own. The
      rules the app enforces: 4 digits, not obviously guessable, not a plausible year, and
      distinct from every other family member's.

- [ ] **The chore list** — title, who it belongs to (or "anyone", or a rotation), how often,
      what time it's due, and what it's worth. This is where the points economy gets its
      feel: if everything is worth 10, nothing is.

- [ ] **The rewards catalog** — what points actually buy, and at what price. Screen time,
      picking dinner, skipping a chore, cash. The exchange rate matters more than the list.

- [ ] **Any household-specific words to add to the content filter.** There's a profanity
      denylist plus a per-household extra list; inside jokes that would land badly on a wall
      display go here.

---

## 7. Optional, but worth it

- [ ] **A real Azure storage account for testing** (can be the same one, different
      `HOUSEHOLD_ID`). Azurite's table implementation diverges from real Azure on exactly the
      semantics this design leans on — ETag behaviour and conditional create. I'd like to
      exercise the idempotent-materialization path against real Azure once per phase rather
      than trusting the emulator.

- [ ] **A custom domain** for the SWA, if you want something friendlier than
      `gentle-sky-0cf50a710.azurestaticapps.net` on the tablet.

---

## Quick reference — every setting the app reads

| Setting | Needed by | Notes |
|---|---|---|
| `TABLES_CONNECTION_STRING` | now | Azure Table Storage |
| `HOUSEHOLD_ID` | now | Prefixes every partition key. `preview` on PR environments. |
| `HOUSEHOLD_TZ` | now | IANA zone; all local-date partition keys derive from it |
| `ANTHROPIC_API_KEY` | Phase 5 | Server-side only, never shipped to the browser |
| `GOOGLE_CLIENT_ID` | Phase 6 | |
| `GOOGLE_CLIENT_SECRET` | Phase 6 | |
| `GOOGLE_REDIRECT_URI` | Phase 6 | Must match the console exactly |
| `TOKEN_ENCRYPTION_KEY` | Phase 6 | 32 random bytes, base64. Encrypts the stored refresh token. |
| `CRON_SHARED_SECRET` | Phase 9 | Same value in GitHub secrets and SWA settings |
