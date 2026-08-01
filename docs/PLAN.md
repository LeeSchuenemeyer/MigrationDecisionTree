# Family Dashboard — Touch Kiosk, Shared Calendar, Tasks & Claude-Powered Gamification

## Context

Lee wants a touch-enabled family dashboard: a shared calendar, an assigned task list, a
news-ticker-style "updates crawler," and a points/gamification layer — with Claude
generating lively **PG-13** achievements for completing tasks, chaining daily goals into
streaks, and hitting long-term accomplishments. The goal is engagement: make tracking and
finishing household activities genuinely fun rather than another chore board nobody looks at.

The repo (`LeeSchuenemeyer/MigrationDecisionTree`) is effectively **greenfield**. It holds
one static page — `default.html`, a "VMware to Azure Decision Matrix" — a byte-identical
duplicate under `main/`, an MIT license, and a two-line README. No package manager, build
system, framework, backend, database, tests, or linting.

What we inherit is valuable: a working **Azure Static Web Apps** pipeline at
`.github/workflows/azure-static-web-apps-gentle-sky-0cf50a710.yml` with an **unused Azure
Functions API slot** (`api_location: ""`). That slot is where the backend and the Anthropic
API key must live — the key can never ship to the browser.

Note: `output_location: "/"` with no `index.html` means the deployed site root **404s
today**; only `/default.html` resolves. After this work the root finally serves something.

Intended outcome: an always-on wall tablet the family walks past and taps, with phones and
laptops as first-class secondary clients, backed by real shared state.

## Settled decisions

Confirmed with the user — not open for re-litigation during implementation:

| Area | Decision |
|---|---|
| **Backend** | Azure Functions + Azure Table Storage via the existing empty `api_location`. Real cross-device sync; Anthropic key server-side. |
| **Devices** | Wall tablet kiosk (primary, always-on, landscape), phones, laptop. **No PWA** — no service workers, offline sync, or push. |
| **Calendar** | Full **two-way** Google Calendar sync. OAuth/token-refresh/conflict cost accepted. |
| **Ticker** | Family activity feed + Claude PG-13 commentary + upcoming events/deadlines. **No** external news/RSS/weather. |
| **Identity** | Tap avatar + **4-digit PIN**, every device including the kiosk. No per-user Google login. |
| **Points** | All four: leaderboard/streaks/badges; rewards catalog with spend ledger; parent-approved completion; bonus multipliers & wildcards. |

**Resolved tension:** PINs handle app identity; Google Calendar still needs OAuth. Resolved
as a **single household-level Google connection** — one parent does a one-time consent, and
the refresh token is stored server-side (AES-256-GCM encrypted), never in the browser.

## Two hard constraints that shape everything

1. **SWA managed Functions are HTTP-trigger-only — there is no timer trigger.** Every
   "scheduled" behavior must be driven by an HTTP caller or run lazily on read (§4).
2. **No cross-table transactions in Table Storage.** Entity-group transactions require the
   same table *and* partition. The ledger write and the balance update can't be atomic —
   see the ordering rule in §3.

---

## 0.5. Prototype (built — settles the look before the backend exists)

`prototype/kiosk-prototype.html` is a self-contained, dependency-free clickable mock of the
wall-tablet kiosk, published as an artifact. It exists to settle the visual identity and
prove the core interaction loop *before* committing to schema and endpoints — the cheapest
point at which to change our minds about either.

**Design identity: a kitchen scoreboard, not a dashboard.** Deep slate ground (`#12181F`)
because the thing is lit on a wall at night; trophy amber (`#F0A830`) reserved strictly for
points and achievements; a separate semantic set for state (pending `#7FA8D9`, approved
`#57C98A`, overdue `#E8705F`) so status reads across the room rather than needing to be
read up close. Condensed uppercase display type for scoreboard labels, tabular figures for
every number, status encoded as *both* a left severity stripe and a pill. No webfont URLs —
the artifact CSP drops them silently, so the type is a curated system stack.

**What it demonstrates (all fake data, no network):**
- Tap a face → 4-digit keypad → 10-minute session with a live countdown.
- Only the signed-in member's chores are tappable; everyone else's are visibly locked.
- Tap a chore → dashed border + blue "pending", **never** folded into the ranked total.
- Switch to a parent → unified approvals queue → approve → points land, the ticker gains a
  Claude-labelled line, and an achievement toast fires.
- A `data-surface` wrapper flips between the kiosk and phone layouts — the same
  composition-swap architecture §2 specifies for the real app.
- Ticker items are labelled **Claude** / **Next** / unlabelled-fact, which makes the
  degradation story visible: with the API off, the unlabelled facts still carry the ticker.

**Carry forward into the build:** the token names map 1:1 onto the Tailwind `@theme` block
in §2, so the palette moves over as-is. The prototype is *not* a code source for the React
app — it is deliberately vanilla and throwaway at the implementation level. Keep it in the
repo as the visual reference and update it when the design changes.

## 1. Repo layout & the SWA workflow

```
/
├── .github/workflows/
│   ├── azure-static-web-apps-gentle-sky-0cf50a710.yml   ← rewritten
│   ├── ci.yml                                            ← NEW: typecheck/lint/test, every branch
│   └── cron-tick.yml                                     ← NEW: the missing timer trigger
├── .gitignore                                            ← NEW, in the FIRST commit (see R1)
├── staticwebapp.config.json                              ← NEW
├── swa-cli.config.json                                   ← NEW
├── shared/          ← plain TS source consumed by both sides (no npm workspaces)
│   ├── keys.ts      ← every PartitionKey/RowKey format. Highest-leverage file in the repo.
│   ├── types.ts  schemas.ts (Zod)  time.ts (Luxon)
│   ├── recurrence.ts  points.ts  streaks.ts  achievements.ts
│   ├── pg13.ts       ← deterministic content filter
│   └── fallbackCopy.ts
├── web/             ← own package.json + lockfile
│   ├── public/legacy/decision-matrix.html   ← preserved default.html, byte-identical
│   └── src/
└── api/             ← own package.json + lockfile
```

**No npm workspaces.** SWA's Oryx build and workspace hoisting interact badly, and the
failure mode (missing deps at runtime, zero functions registered, no obvious error) is slow
to diagnose. `web/` and `api/` are self-contained; `shared/` is *source* both pull in via
bundler resolution — Vite `resolve.alias` (`@shared` → `../shared`, plus
`server.fs.allow: ['..']`), esbuild via a relative import.

**Bundle the API with esbuild into one file**, `@azure/functions` external (the host
resolves it) and everything else inlined — so `@azure/data-tables`, `@anthropic-ai/sdk`,
`zod`, and `luxon` can live in devDependencies. Use `google-auth-library` + raw `fetch`
against the three Calendar endpoints we need rather than `googleapis`, which is large and
bundles poorly (~200 lines vs. a heavyweight dep).

**Workflow rewrite** — build in explicit steps, hand SWA finished artifacts:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '20', cache: 'npm', cache-dependency-path: '**/package-lock.json' }
- run: npm ci --prefix web && npm run build --prefix web
- run: npm ci --prefix api && npm run build --prefix api
- run: npm ci --omit=dev --prefix api          # prune to @azure/functions only
- uses: Azure/static-web-apps-deploy@v1
  with:
    app_location: "web/dist"
    api_location: "api"
    output_location: ""
    skip_app_build: true
    skip_api_build: true
```

Also bump `actions/checkout@v3`→`v4` and `actions/github-script@v6`→`v7`; the OIDC step is
fine as-is. `staticwebapp.config.json` sets `platform.apiRuntime: "node:20"`, a SPA
`navigationFallback` that **excludes `/legacy/*`** (or the SPA router silently swallows the
decision tree), a 301 from `/default.html` → `/legacy/decision-matrix.html`, and CSP
headers. No `allowedRoles` — SWA built-in auth is unused; all authorization is enforced in
the Functions from the session cookie.

**Delete `main/`.** Byte-identical, unreferenced, content survives in git and at the legacy
path — and its name shadows the branch, which is why `git diff main` fails today.

**Previewing:** the workflow triggers on `main` only, so pushing this branch deploys
nothing. Open a PR into `main` for a SWA staging environment. **Staging shares production
app settings and therefore production storage** — set `HOUSEHOLD_ID=preview` as an
environment-scoped setting *before the first PR*, and every partition key (all
household-prefixed) gives total isolation with zero schema change. Do 95% of development
locally (§8). **The workflow change and the first buildable `web/`+`api/` must land in the
same commit** — a merged workflow pointing at `web/dist` with no `web/` takes the site down.

## 2. Frontend

**React + Vite + TypeScript.** TS is load-bearing, not decorative: Table Storage is
stringly-typed with no schema, so a shared type + Zod contract in `shared/schemas.ts` is the
only thing preventing entity-shape drift between the Functions and the UI. Vite, not
Next.js — SWA's static hosting wants a plain SPA.

**Data: TanStack Query v5** + a ~40-line Zustand store for session identity and surface
mode. The polling design matters more than the library: maintain a monotonic `rev` counter
per household, and have the kiosk poll **one** endpoint — `GET /api/pulse?since=<rev>` →
`{rev, changed:["tasks","feed"]}`, ~150 bytes — every 10s, invalidating only changed slices.
Everything else is `staleTime: Infinity`. That's ~40 MB/month for a 24/7 tablet against
SWA Free's 100 GB cap.

**Tailwind v4** via `@tailwindcss/vite`, preserving the token discipline from `default.html`
in `@theme` (`--color-brand: #0078D4` carried over, `--spacing-touch: 2.75rem`,
`--spacing-touch-kiosk: 4.5rem`). Hand-rolled CSS was right for one 200-line page and wrong
for ~30 components in two structurally different layouts. Radix for the few headless
primitives; no component library.

**One codebase, two surfaces — three layers:**
- **Surface detection** (`useSurface()`): kiosk device token → `?kiosk=1` in localStorage →
  `matchMedia('(min-width:1024px) and (pointer:coarse) and (orientation:landscape)')`.
  Written to `<html data-surface>` by an inline script before first paint.
- **Density** via one Tailwind custom variant:
  `@custom-variant kiosk (&:where([data-surface="kiosk"] *));` — then shared leaves scale in
  place (`text-base kiosk:text-3xl min-h-touch kiosk:min-h-touch-kiosk`). `TaskCard`,
  `MemberAvatar`, `EventChip`, `StreakFlame` are written once.
- **Composition swap at the shell**, because the information architecture differs:
  `<KioskShell>` (fixed viewport, no scroll anywhere, 3-column grid, ticker pinned bottom,
  no nav chrome), `<MobileShell>` (bottom tabs, sheets, safe-area insets), `<DesktopShell>`
  (sidebar; the only comfortable home for parent-admin screens).

**Kiosk hardening is code, not polish:** `touch-action: manipulation` + `user-select: none`
globally, `overscroll-behavior: none`, `navigator.wakeLock` with re-acquire on
`visibilitychange`, night dim + 1px/60s burn-in drift after 22:00, and a top-level error
boundary that **auto-reloads after 30s** — an unattended wall tablet must never sit on a
white screen.

## 3. Table Storage schema

Ground rules: all PKs carry a household prefix; partition-key dates are **local** (household
IANA zone via `shared/time.ts`), property timestamps UTC ISO 8601; denormalization is
deliberate and marked; anything that would otherwise be a cross-partition filter scan gets
an index partition instead.

| Table | PK | RK | Serves |
|---|---|---|---|
| `Members` | `member\|{hh}` | `{memberId}` | One point-partition scan = the whole family (first call the kiosk makes) |
| `TaskDefs` | `taskdef\|{hh}` | `{taskDefId}` | One scan; `recurrenceJson` is a small structured object, not RRULE |
| `TaskInstances` | `ti\|{hh}\|{YYYY-MM-DD}` | `{taskDefId}\|{memberId}\|{seq}` | **The crux.** "Today" = one partition; "this week" = a PK **range** query over 7 partitions |
| `ActionQueue` | `queue\|{hh}\|pending` | `{createdAtTicks:019d}\|{kind}\|{refId}` | Approvals **and** redemptions in one queue — one parent badge, one screen, one habit |
| `Ledger` | `ledger\|{hh}\|{memberId}\|{YYYY-MM}` | `{inverseTicks:019d}\|{entryId}` | Newest-first with no client sort; month bucketing bounds partitions forever |
| `Streaks` | `streak\|{hh}\|{memberId}` | `{streakKey}` | All of a member's streaks in one read |
| `AchievementDefs` | `achdef\|{hh}` | `{achievementDefId}` | `criteriaJson` is machine-checkable, not prose |
| `AchievementAwards` | `ach\|{hh}\|{memberId}` | `{achievementDefId}` | **"Already earned?" is a point read** — this is why the evaluator is cheap enough to run on every approval |
| `Rewards` / `Redemptions` | `reward\|{hh}` / `redemption\|{hh}\|{memberId}` | id / inverse-ticks | Catalog + per-member spend history |
| `Events` | `event\|{hh}\|{YYYY-MM}` | `{startUtcTicks:019d}\|{eventId}` | Month partitions arrive **already chronological** |
| `EventMap` | `evmap\|{hh}` | `{googleEventId}` | **Non-negotiable.** Incremental sync hands you a Google id and nothing else |
| `SyncState` | `sync\|{hh}` | `google:{calendarId}` | syncToken, channel id/expiry, failure count |
| `Feed` | `feed\|{hh}\|{YYYY-MM-DD}` | `{inverseTicks:019d}\|{feedId}` | Ticker = today's top-40, newest-first, no sort |
| `Sessions` / `Devices` / `PinAttempts` | `sess\|{hh}` etc. | `sha256(token)` | Token is **never stored**, only its hash |
| `Config` / `ClaudeCache` / `Budget` | `config\|{hh}` etc. | `household`\|`google_oauth`\|`rev`\|… | Encrypted refresh token, pulse counter, cost caps |

**Deliberate denormalization:** `TaskInstances` snapshots `basePoints` at materialization
(editing a def must not retroactively change what a completed chore was worth) and copies
`title`/`icon`/`assignedMemberName`; `ActionQueue` copies enough display data that the
parent screen renders from **one query with zero fan-out**; `Redemptions` copies
`rewardTitle` since the catalog entry may be deleted.

**`Member.pointsBalance` is a cache; the ledger is authoritative.** Because the two live in
different tables, the write order is fixed: (1) no-op if the instance is already approved
(makes approve idempotent), (2) write ledger, (3) update instance, (4) update balance with
ETag-conditional retry on 412, (5) **delete the queue row last**. A crash anywhere converges
on retry; an orphaned local row is recoverable, an orphaned index row is not. A daily
reconciler recomputes balances from the ledger and logs drift.

**Sharp edge:** editing an event's start date can change its month — i.e. its partition key —
and Table Storage entities cannot move. The update path must detect this and do
delete-then-insert, updating `EventMap` in the same operation.

## 4. Recurring tasks & the missing timer

`materialize(hh, throughLocalDate)` in `api/src/services/materializer.ts`: read the
watermark → return immediately if already current → scan `TaskDefs` (tens of rows) → for
each date × def call the pure `occursOn()` → resolve assignee (`fixed` / `rotate` /
`anyone`→`"*"`, claimed on first tap) → build the **deterministic** RK and `createEntity`,
**swallowing 409 `EntityAlreadyExists`** → advance the watermark with an ETag-conditional
update. That 409 swallow is the entire idempotency guarantee, and it's why the same function
is safe to call from three different triggers. Horizon: **14 days**.

Three triggers, in order of reliability:
1. **Lazy on read (primary).** `GET /api/tasks` and `/api/bootstrap` call it first; the
   watermark check makes that a single point read 99.9% of the time. Because the kiosk polls
   all day, this alone keeps the critical path correct.
2. **`POST /api/cron/tick` driven by `.github/workflows/cron-tick.yml`** (hourly `curl` with
   a `timingSafeEqual`-checked `x-cron-secret`). Also expires yesterday's open instances and
   breaks streaks, evaluates end-of-day streaks, generates tomorrow's Claude challenge,
   flushes batched ticker commentary, renews the Google watch channel, sweeps sessions, and
   runs the reconciler — each with a "already ran for this local day" guard in `Config`.
3. **Manual** `POST /api/admin/materialize` from parent settings.

⚠️ GitHub Actions cron is delayed 5–20 min under load and **GitHub disables scheduled
workflows after 60 days of repo inactivity.** Nothing correctness-critical depends on it.
The clean escape hatch if it becomes annoying is SWA Standard (~$9/mo) + a linked Function
App, which gives real timer triggers.

**Never `new Date().toISOString().slice(0,10)`** — that's UTC and silently creates wrong-day
partitions west of Greenwich and double-fires on DST transitions. All local-date math goes
through `shared/time.ts` (Luxon + household zone).

## 5. PIN auth

**Threat model, honestly:** the real adversary is a motivated 11-year-old with physical
access to the kiosk trying to approve their own chores or spend a sibling's points. Second
is a shoulder-surfing sibling. Third is an internet scanner finding the public
`*.azurestaticapps.net` URL. Not nation-states.

Proportionate: server-side verification, `scrypt` (N=16384, 16-byte per-member salt,
`pinAlgo` version tag, `timingSafeEqual`), aggressive lockout, HttpOnly/Secure/SameSite
cookies, opaque tokens stored only as hashes, no PII beyond first names and emoji. **Not**
proportionate, do not build: MFA, WebAuthn, request signing, SIEM, IP allowlisting.

Be honest about the ceiling: **4 digits is 10,000 possibilities** — no hash makes that hard
offline. The hash protects against a storage dump; the load-bearing control is the online
limiter (5 failures / 15 min → 15-min lock, without leaking whether the PIN was right), and
the *most effective* control is social: on the 5th failure, write a Feed item —
**"Someone tried Maya's PIN five times and struck out. 🕵️"** That's ten lines, and in a
household social visibility deters better than any cryptographic control.

**Two layered credentials keep the kiosk usable while still gating writes:**
- **Device credential** — a parent visits `/kiosk/enroll` once, authenticates, names the
  tablet, and gets a 1-year `fd_device` cookie granting **household read scope only**. The
  wall display now renders forever with nobody logged in.
- **Member credential** — every mutating endpoint requires a member session. Tap avatar →
  large numeric keypad → **10-minute** session with a visible countdown, 60s inactivity
  drop back to ambient. Personal devices get 30 days sliding.

**Parent verification:** approval endpoints resolve the cookie → `Sessions` row → then do a
**point read of the `Members` row and check `role === 'parent'` there.** Never trust the
cached role for privileged ops — it's cheap, and a role change takes effect immediately.
Client-side button hiding is cosmetic only. **Step-up** (`elevatedUntil = now + 5min`) is
required for manual point adjustment, deleting a member, changing a PIN, revoking a device,
and connecting/disconnecting Google — but *not* for ordinary chore approval, which would
train everyone to hate the app.

## 6. Google Calendar two-way sync

🚨 **The single thing that kills projects like this: leaving the OAuth consent screen in
"Testing" status, where refresh tokens expire after 7 days** and the calendar silently stops
syncing every week. **Publish the app to "In production"** during setup, not after the first
mysterious outage. Calendar is a sensitive scope, so an unverified published app shows an
interstitial once and caps at 100 users — both fine for a family. Use `prompt=consent` on
the authorize URL or Google won't re-issue a refresh token.

**Push webhooks (`events.watch`) primary, two-layer fallback.** The webhook is a *thin*
notification (headers only) — verify `X-Goog-Channel-Token` against the stored secret,
ignore `resource_state: sync`, **return 200 immediately**, then sync. Channels expire ~7
days; the cron renews within 24h of expiry. Fallbacks: `GET /api/events` runs an incremental
sync if `lastIncrementalAt` is >5 min old (this is the one that matters — the kiosk polls
all day, so staleness is bounded at 5 minutes even with webhooks entirely broken), plus the
hourly cron and a daily full reconcile. Handle **HTTP 410 Gone** on the sync token as
routine, not as an error — drop the token and full-list `today-30d … today+180d`.

**Echo-loop prevention — all three layers, because a naive implementation loops forever:**
1. `extendedProperties.private = {fdOrigin, fdRev}` on every event we write; skip inbound
   changes where both match (Google's own supported mechanism, survives restarts).
2. `lastPushedEtag` comparison — catches stripped extended properties.
3. `suppressEchoUntil = now + 30s` — belt-and-braces against the webhook arriving before the
   push response is persisted, which is a real race.

**Deletions:** treat 404/410 from Google as success; soft-delete locally (30-day undo);
**always delete the `EventMap` row last.** **Conflicts:** last-writer-wins with remote
winning (Google is where most edits actually happen), but store the discarded local version
in `conflictSnapshotJson`, set `syncState='conflict'`, and write a Feed item with a one-tap
"actually, use mine." Do **not** build field-level three-way merge — weeks of work for
something that happens a few times a year and a human resolves in five seconds.

**Scoped out (stated, not discovered in week five):** the dashboard creates/edits/deletes
single events and individual instances of Google-originated series; **series-level editing
deep-links to Google Calendar.** Pull with `singleEvents=true` so recurring events arrive
expanded — 100% of the display value, ~90% of the edit value. Full RRULE round-tripping,
EXDATE, and "this and following" is comfortably the largest chunk of work in the project,
larger than the entire points economy.

## 7. Claude integration

**The one invariant that makes cost tractable: the wall tablet never triggers a Claude
call.** Every read path — `/api/pulse`, `/api/feed`, `/api/tasks`, `/api/events` — is pure
Table Storage. Generation happens only on *writes* and on the cron tick, so cost scales with
family activity (~40 events/day, bounded) rather than polling frequency (unbounded).

| Job | Model | Why |
|---|---|---|
| Ticker commentary | `claude-haiku-4-5` | Batched, one-line output, low stakes ($1/$5 per MTok) |
| Achievements — bronze/silver | `claude-sonnet-5` | Creative naming is the deliverable ($3/$15; $2/$10 intro through 2026-08-31) |
| Gold/legendary + daily challenge | `claude-opus-5` | The 100-day-streak badge is a keepsake ($5/$25) |

Skip `claude-fable-5` — $10/$50 and a 30-day retention requirement to write a joke about the
dishwasher. **Model-specific footguns:** `effort` is unsupported on `claude-haiku-4-5` (it
errors — omit `thinking` entirely there); `claude-opus-5` **thinks by default** and
`max_tokens` caps thinking *plus* output, so budget ~2000 for a 200-token badge and set
`output_config: {effort: 'low'}` (these are creative micro-tasks, not reasoning problems);
and **check `stop_reason` before touching `content`** — `"refusal"` returns HTTP 200 with an
empty or partial array, so `content[0].text` crashes. Opt into `fallbacks: "default"` with
the `server-side-fallback-2026-07-01` beta so a refusal is re-served rather than lost.

**Structured output** via `output_config.format` with a JSON schema makes an achievement
land as a record (`name`/`description`/`flavorText`/`tier`/`iconEmoji`/`pointsReward`)
rather than prose to parse. The supported schema subset **does not honor
`minLength`/`maxLength`/numeric bounds** — enforce those after parsing (truncate `name` >40
chars, clamp `pointsReward` 5–200, reject multi-codepoint `iconEmoji`).

**PG-13 enforcement, six layers** — no single one suffices, and the failure mode here is
*social*, not technical:
1. A frozen system prompt with a **concrete rubric**, both lists spelled out. Allowed:
   comic-book bombast, playful exaggeration, gentle teasing of the *task*. Banned: profanity
   incl. minced oaths; anything sexual, substance-related, or violent beyond cartoon;
   commentary on bodies, weight, appearance, or eating; anything about intelligence,
   character, laziness, or worth; sibling comparisons framed as one being better; medical,
   religious, political; sarcasm aimed at a *person* rather than an *event*.
2. **Few-shot: three good, three bad, each bad one with a one-line reason.** In practice the
   "bad with reason" half does more work than every instruction combined.
3. Structured output, so you validate fields not free text.
4. **A deterministic post-filter** (`shared/pg13.ts`) on every generated string before
   storage: Unicode-normalize, de-leetspeak (`4→a`, `3→e`, `!→i`, `0→o`, strip zero-width
   and combining marks), profanity denylist + household extras, reject URLs, `@`-mentions,
   ALL-CAPS runs, over-length; plus a targeting heuristic — reject if a member's name
   appears within 4 tokens of a negative adjective.
5. **Fail closed.** Reject → retry once with the reason appended → reject again → **static
   fallback + log to a parent-visible list.** Unvalidated model text never reaches an
   unattended kitchen display. Non-negotiable.
6. Two product controls: a parent `commentaryEnabled` toggle (facts-only ticker, nothing
   breaks) and a one-tap **"that wasn't ok"** that suppresses the item immediately and
   records the prompt/output pair.

**Cost control:** debounce + batch (one haiku call annotates 8 feed items, never 8 calls);
content-addressed `ClaudeCache` keyed on `sha256` of sorted feed ids + prompt version, so a
duplicated cron tick costs zero; hard daily `Budget` caps (40 haiku / 10 sonnet / 3 opus)
that silently fall back on exhaustion — the circuit breaker that makes a runaway loop cost
pennies; 8s/20s `AbortController` timeouts (SWA times out ~45s). Achievement generation runs
**synchronously** inside the approval handler — a kid is standing at the tablet waiting for
their badge, and sonnet-5 at low effort returns in 2–4s. Commentary is deferred; nobody is
waiting on a joke. **Realistic total: under $1/month.**

Prompt caching won't engage for the ticker (haiku's minimum cacheable prefix is **4096
tokens**, vs 1024 on sonnet-5 and 512 on opus-5, against a ~600-token prompt). **Don't pad
the prompt chasing it** — haiku input is $1/MTok and it's noise at this volume.

**Graceful degradation at every call site:** ~50 hand-written PG-13 templates in
`shared/fallbackCopy.ts` selected by `kind` and seeded by `hash(feedId)` so they're stable
and don't repeat; a deterministic achievement namer (`${tierAdjective} ${criteriaNoun}` →
"Gilded Dish Slayer") plus a parent-only "regenerate name" button so a badge earned during
an outage gets upgraded later; 30 pre-written daily challenges. **The UI has no error state
for Claude being down** — there's nothing a child can do about it, and an error toast on a
wall display is worse than a slightly less witty joke.

**Key lives in the SWA Application Setting `ANTHROPIC_API_KEY`** (`az staticwebapp
appsettings set`), with a separate lower-limit key for the PR-preview environment. Same for
`GOOGLE_CLIENT_ID/SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SHARED_SECRET`,
`TABLES_CONNECTION_STRING`, `HOUSEHOLD_ID`, `HOUSEHOLD_TZ`.

## 8. Delivery phases

Riskiest infrastructure first, and something usable early. Nothing is cut — this is sequencing.

| Phase | Contents | Demoable |
|---|---|---|
| **0 — Pipeline** | Layout, `.gitignore`, SWA config, workflow rewrite, `ci.yml`, legacy page + 301, delete `main/`, React shell, `/api/health`, storage account, `shared/keys.ts` | Root serves the shell, `/legacy/…` works, `/default.html` redirects. *First on purpose — the deploy pipeline is the highest-risk unknown and cheap to prove empty.* |
| **1 — Identity** | Members/Sessions/Devices/PinAttempts, scrypt, login/logout/step-up, kiosk enrollment, avatar grid + keypad, **seed script** | Tap avatar → PIN → "Hey Maya" |
| **2 — Tasks core** | TaskDefs/Instances/ActionQueue/Ledger, recurrence, materializer, today view, complete→pending, parent queue, approve→ledger | **First genuinely useful build** — the family can run real chores through it |
| **3 — Points** | Leaderboard, ledger view, streaks, multipliers & wildcards, rewards catalog, redemptions into the unified queue | Kids see standings and spend points |
| **4 — Feed & ticker** | Feed writes, `/api/pulse`, ETag/304, marquee w/ reduced-motion fallback, upcoming events | **First build that looks like the product.** Factual ticker — the fallback path proven *before* Claude |
| **5 — Claude** | Client wrapper + budget + cache + `pg13.ts` + fallbacks; batched commentary; achievement evaluation on approval; daily challenge; parent toggle + "that wasn't ok" | **First build that feels like the pitch** |
| **6 — Calendar (read)** | Google Cloud + **publish consent screen**, OAuth, encrypted token, calendar picker, full + incremental sync, EventMap, webhook + renewal, calendar UI | Family calendar on the wall, updating within seconds |
| **7 — Calendar (write)** | Create/edit/delete → Google, all three echo layers, deletions both ways, conflict UI, month-move | True two-way. *Split deliberately — read-only is ~60% of the value at ~30% of the risk, and proves the plumbing first* |
| **8 — Kiosk polish** | Wake lock, night dim, auto-reload boundary, celebrations, `prefers-reduced-motion`, a11y pass, Playwright smoke | |
| **9 — Ops** | `cron-tick.yml` + all tick jobs, reconciler, nightly blob backup, cost view, conflict list, Claude incident log | |

Phase 2 is the earliest point where stopping still leaves something the family uses daily.

## 9. Verification

```bash
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4 azurite
azurite --silent --location .azurite --skipApiVersionCheck   # table svc on 10002
cd api && npm run build && func start                        # :7071
cd web && npm run dev                                        # :5173
swa start                                                    # :4280  ← always use this URL
```

**Always develop against `:4280`**, never `:5173` — only the SWA CLI applies
`staticwebapp.config.json` routing, the `/api` proxy, and the same-origin cookie behavior
the session design depends on. `api/local.settings.json` (gitignored from commit one) uses
`UseDevelopmentStorage=true`.

⚠️ **Azurite's table implementation is not byte-identical to Azure** — ETag semantics,
conditional create, and entity-group-transaction edges are the known divergences. Since
idempotent materialization depends on `createEntity` throwing 409, **exercise that path
against a real (~$0.05/mo) storage account once per phase**, not just Azurite. Google
webhooks can't reach localhost; the lazy-sync path covers development, or use
`cloudflared tunnel` to exercise the handler. Cron:
`curl -X POST localhost:4280/api/cron/tick -H "x-cron-secret: $CRON_SHARED_SECRET"`.

**`api/scripts/seed.ts` is a Phase 1 deliverable, not an afterthought** — two parents, three
kids with known PINs, ~12 task defs across every recurrence shape, a rewards catalog, and
**30 days of backdated ledger/feed history**. Without backdated history you cannot
meaningfully evaluate the ticker, leaderboard, or streak logic.

**Smoke checklist before each phase merge:** cold load → kiosk mode with no session; wrong
PIN ×5 → locked out + feed item; correct PIN → tap task → instant check → "pending" shown
*distinctly* from earned; parent approves on phone → points land, feed fires, kiosk picks it
up within one 10s pulse with no reload; full day of tasks → streak + multiplier on next
award; cross a badge threshold → achievement with name/tier/icon, verified in storage;
**block `api.anthropic.com` in `/etc/hosts` and repeat → badge still awarded with fallback
copy, no error surfaced**; redeem a reward end-to-end; create event → appears in Google
within seconds **and does not bounce back as a duplicate**; edit in Google → appears on the
wall; delete each direction, including deleting something already deleted; move an event
across a month boundary → row moved partitions, `EventMap` still resolves; **run the cron
tick twice → no duplicate instances, ledger entries, or feed items**; restart Azurite
mid-session → recovers on next poll, no white screen; idle kiosk 15 min → session dropped,
still rendering.

**Automated tests, right-sized:**
- **Tier 1 — Vitest on `shared/`, where nearly all the value is.** Every module is a pure
  function encoding rules that are easy to get subtly wrong and painful to debug in
  production: `recurrence.ts` (weekly-by-weekday across a month boundary, `until`
  inclusivity, **DST 23- and 25-hour days**, leap day), `points.ts` (multiplier stacking
  order, rounding), `streaks.ts` (miss-a-day break, freeze consumption, same-day
  double-qualify), `achievements.ts` (n-1/n/n+1 per criteria type), `keys.ts`
  (**round-trip property tests** — `parse(build(x)) === x`; a malformed key is the #1
  Table Storage bug class and it is silent), `pg13.ts` (leetspeak, homoglyphs, zero-width
  joiners, the name-targeting heuristic — include the specific strings a determined
  11-year-old would try). Target >85%; runs in under a second, needs no infrastructure.
- **Tier 2 — ~15 Vitest integration tests against Azurite** in CI: idempotent
  materialization (run twice, assert once), the full approve→ledger→balance→feed flow, the
  ActionQueue crash-consistency ordering, event month-move, `EventMap` resolution, session
  expiry, ETag-conflict retry on `pointsBalance`.
- **Tier 3 — exactly one Playwright test** against `swa start`: PIN login → complete task →
  parent approve → assert leaderboard and ticker. One end-to-end test catches integration
  breakage; ten become maintenance you resent.
- **Tier 4 — `ci.yml` on every branch push** (not just `main`): `tsc --noEmit`, ESLint,
  Vitest 1+2, build both packages. This is the *only* feedback loop available on
  `claude/family-dashboard-gamification-ycon4f`, given the SWA workflow's `main`-only trigger.
- **Zod contracts as a test substitute:** define every request/response shape in
  `shared/schemas.ts`, parse inbound bodies in each Function, derive the web client's types
  from the same schemas. Kills the frontend/backend drift bug class more cheaply than the
  tests you'd otherwise write, and doubles as API documentation.

## Risks & sharp edges

**R1 — The repo has no `.gitignore` today**, and `api/local.settings.json` will hold the
Anthropic key, Google client secret, and token encryption key. This is the single most
likely way this project leaks a credential. `.gitignore` in the first commit of Phase 0,
before any secret file exists.

**R2 — OAuth consent screen in "Testing" expires refresh tokens after 7 days.** Publish it.
Breaks more projects like this than any other single item.

**R3 — Preview environments share production app settings and storage.** Set
`HOUSEHOLD_ID=preview` before the first PR, not after.

**R4 — The realistic failure of this project is social, not technical.** The most likely bad
outcome is a Claude-generated quip that lands as mocking one kid, displayed permanently on a
kitchen wall. The post-filter, fail-closed retry policy, parent toggle, and "that wasn't ok"
button are the feature's safety mechanism and belong in Phase 5's definition of done.

**R5 — Pending points must not lie.** With parent approval, a kid's visible balance diverges
from what they've "earned." Render pending distinctly everywhere (dashed border, muted,
"+15 pending") and never fold it into the ranked leaderboard total.

**R6 — Node runtime must be pinned** (`platform.apiRuntime: "node:20"`, `@azure/functions`
^4, valid `"main"`). Getting either wrong produces a deploy that "succeeds" with zero
functions registered and no obvious error.

**R7 — "Not installable" has a practical consequence.** Skipping the PWA is right, but a
plain browser tab is a poor kiosk (URL bar, sleep, accidental navigation). The substitute is
**device configuration, not code**: Fully Kiosk Browser on Android, or Guided Access +
Safari on iPad, pinned to `/?kiosk=1`. Decide the tablet platform early — Fully Kiosk is
meaningfully better for this than iPad Guided Access.

**R8 — Attribution.** Dashboard-created events show as authored by the one household Google
account, and each family member must have the household calendar *shared to* their personal
Google account for it to appear on their phone. That's a Google-side setup step, easy to
forget during Phase 6.

**R9 — Store dates as ISO strings, not `Edm.DateTime`,** for anything filtered or sorted
lexically. `@azure/data-tables` maps `Date` to `Edm.DateTime`, which round-trips through
timezone conversion and will surprise you inside a partition key.

**R10 — Feed and ActionQueue are single hot partitions.** Fine at ~80 writes/day (the limit
is ~2000/sec/partition); would not survive multi-tenancy. Stated so it isn't a later mystery.

**R11 — Total running cost:** SWA Free $0 + Storage ~$0.05/mo + Claude <$1/mo ≈ **under
$2/month.** SWA Free has no SLA and a 100 GB/mo bandwidth cap; the pulse design keeps a 24/7
tablet at ~40 MB/month.

## Critical files

- `.github/workflows/azure-static-web-apps-gentle-sky-0cf50a710.yml` — gates everything else deploying
- `staticwebapp.config.json` — `apiRuntime`, SPA fallback with the `/legacy/*` exclusion, the 301
- `shared/keys.ts` — single source of truth for every PK/RK format; a typo here is a silent data bug
- `api/src/services/materializer.ts` — idempotent recurrence → dated instances, lazy + cron
- `api/src/services/googleSync.ts` — incremental sync, EventMap, three echo layers, conflicts. Highest-complexity module
- `shared/pg13.ts` — the filter gating every Claude string before it reaches an unattended display
