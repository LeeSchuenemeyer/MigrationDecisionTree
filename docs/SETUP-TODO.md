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

- [x] ~~**Which tablet?**~~ **Decided: Android tablets and phones, plus an LG StanbyME 2.**
      See §2a below — the StanbyME needs one check from you before I can finish Phase 8.

- [x] ~~**Node 20 vs 22.**~~ **Resolved by not taking the dependency.** The plan called for
      `google-auth-library`, which declares `node >=22` against our pinned `node:20`. Building
      Phase 6 made the case for dropping it: what we actually needed was an authorize URL, a
      code exchange, and a refresh — three POSTs to one endpoint, ~60 lines of `fetch`. The
      library's value is service-account JWT signing and ADC discovery, neither of which
      applies to a single household OAuth connection. So there is no engine conflict to
      resolve, and the bundle is smaller.

      Still true but harmless: a few transitive `@azure/core-*` packages declare `node >=22`.
      They're dependencies of `@azure/data-tables`, which itself declares `node >=20`, and
      everything works. Worth a look if you ever move to `apiRuntime: "node:22"`, not before.

---

## 2a. Devices

**Android tablets and phones** — no problem at all. Chrome on Android is current, so
everything works, including the Phase 8 kiosk hardening. For whichever Android tablet
ends up wall-mounted, use **[Fully Kiosk Browser](https://www.fully-kiosk.com/)**: real
kiosk mode, screen-on control, auto-restart on crash, scheduled sleep/wake, remote admin.
It's the single biggest quality-of-life difference between "a browser tab on a wall" and
"an appliance." Point it at `https://<your-swa>/?kiosk=1`.

**LG StanbyME 2** — webOS, and there is one thing I need you to check.

- [ ] 🔍 **Open `https://<your-swa>/compat.html` in the StanbyME's Web Browser app and
      send me what it says.** It's a standalone diagnostic page — no framework, no bundle,
      ES5 only — so it renders even on an engine too old to run the app itself. It reports
      the Chromium version, whether touch reaches the page, and a plain-English verdict.

      Why it matters: webOS 24 ships Chromium 108, webOS 25 ships Chromium 120, and I
      can't tell from here which one your unit runs. The app bundle now targets Chromium
      108, so **either way it should run** — but between 108 and 111 the translucent tints
      fall back from `color-mix()` to plain hex alpha (a shade off, nothing broken), and
      below 108 it won't parse at all and you'd get a white screen with no error. The
      page tells you which world you're in in about ten seconds.

- [ ] **Try the browser route first, but know what you give up.** You asked whether we can
      just use the browser rather than the app store — yes, and I'd start there. The
      honest trade-off, so it isn't a surprise later:

      | | Android + Fully Kiosk | StanbyME 2 browser |
      |---|---|---|
      | Hide the URL bar / chrome | yes | no |
      | Prevent sleep / screen-off | yes (and Wake Lock) | device settings only |
      | Auto-restart after a crash | yes | no — someone re-opens it |
      | Auto-launch on power-on | yes | no |
      | Lock to one URL | yes | no |

      None of that is code I can write — we deliberately skipped a PWA, so kiosk behaviour
      comes from device configuration. On webOS there simply isn't a Fully Kiosk
      equivalent. **My recommendation: make an Android tablet the always-on wall display,
      and treat the StanbyME 2 as a portable second screen** — genuinely nice for the
      calendar in the kitchen, propped up during dinner, moved to wherever people are.
      That plays to what it's actually good at.

- [ ] **If you'd rather the StanbyME be the primary display, tell me** and I'll look into
      packaging a webOS app. It's a real option — webOS apps are just web apps with an
      `appinfo.json`, and `supportTouchMode: "full"` there gives proper touch events plus
      a launcher tile and auto-launch. The cost is an LG developer account, sideloading
      via the CLI, and a re-signing dance roughly every 7 days on a dev-mode device unless
      it's published. Worth it only if that screen is the centrepiece.

- [ ] **Confirm the wall tablet is landscape and ≥1024px wide.** Surface detection keys on
      `(min-width:1024px) and (pointer:coarse) and (orientation:landscape)`. The StanbyME 2
      is 27" QHD, so it qualifies easily — but it rotates to portrait, and in portrait it
      will render the phone layout. `?kiosk=1` pins it regardless; `/compat.html` shows you
      what the heuristic currently resolves to.

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

- [ ] 🚨 **Read the PG-13 rubric below and tell me if it's wrong for your family.** This is
      the one item on this whole list where your judgement genuinely beats mine. The
      realistic failure mode of this project isn't technical — it's a generated quip that
      lands as mocking one kid, on a kitchen wall, for a week.

      **The rule everything hangs off:** *tease the task, never the child.*

      | Allowed | Banned, without exception |
      |---|---|
      | Comic-book bombast about the chore | Profanity, including minced oaths (heck, darn, frick) |
      | Playful exaggeration of the event | Anything sexual, substance-related, or violent beyond cartoon |
      | Gentle teasing of the mess, the deadline, the laundry | Any comment on bodies, weight, appearance, or eating |
      | Dry understatement | Any comment on intelligence, character, laziness, effort, or worth |
      | Invented ranks and titles on badges | Comparing one family member to another, in any direction |
      | | Sarcasm aimed at a *person* rather than an *event* |
      | | Medical, religious, political |
      | | Links, @-mentions, ALL CAPS, hashtags |

      Examples it's told are **good**: *"The dishwasher never stood a chance."* ·
      *"Another sock rescued from under the bed."* · *"That deadline never saw it coming."*

      Examples it's told are **bad, with the reason** (this half does more work than every
      instruction above it): *"Finally, some effort from Theo."* — implies he's usually lazy ·
      *"Maya did better than her brother today."* — compares siblings · *"About time someone
      cleaned this pigsty."* — insults your home.

      **Six layers enforce it**, so no single one has to be perfect: the frozen rubric above,
      the good/bad few-shot examples, structured output (fields, not free prose), a
      deterministic post-filter (`shared/pg13.ts` — de-leetspeaks, strips zero-width
      characters, and rejects a member's name within four words of a negative adjective),
      fail-closed fallback to hand-written copy, and your two controls: a commentary
      on/off toggle and a one-tap **✕** on any Claude-written ticker line.

      **What I need from you:** anything in the banned column that's too strict for your
      family, anything missing, and any household-specific words to add — inside jokes,
      nicknames, "the incident" — that would land badly on a wall. Those go in the
      per-household denylist, which the filter checks in addition to the built-in list.

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

- [ ] **Optional: `GOOGLE_WEBHOOK_URL`.** Set it to
      `https://<your-swa>.azurestaticapps.net/api/google/webhook` and the calendar updates
      within seconds of a change instead of within five minutes. **Genuinely optional** — with
      it unset no push channel is created and the calendar falls back to syncing lazily on
      read, which bounds staleness at five minutes because the kiosk polls all day. It also
      can't work in local development, since Google can't reach localhost.

      ⚠️ Phase 6 asks for **read-only** scope (`calendar.readonly`). Phase 7 widens it to
      read-write, and Google will require re-consent at that point — that's expected, not a
      bug. I'd rather not ask for write access before anything writes.

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
| `TOKEN_ENCRYPTION_KEY` | Phase 6 | 32 random bytes, base64. AES-256-GCM on the stored refresh token. |
| `GOOGLE_WEBHOOK_URL` | Phase 6 (optional) | Enables push updates. Unset = lazy sync on read, 5-minute staleness. |
| `CRON_SHARED_SECRET` | Phase 9 | Same value in GitHub secrets and SWA settings |
