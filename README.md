# Family Dashboard

A touch-first family dashboard for an always-on wall tablet: shared calendar, assigned
chores, a live activity ticker, and a points/gamification layer with Claude-written
(PG-13) achievements.

Runs on Azure Static Web Apps — a React SPA plus managed Azure Functions, backed by Azure
Table Storage. Total running cost is under about $2/month.

> **Note on this repository's history.** It previously held a single static page, an
> Azure/VMware migration decision matrix. That page is preserved verbatim at
> [`web/public/legacy/decision-matrix.html`](web/public/legacy/decision-matrix.html) and
> the old `/default.html` URL 301-redirects to it.

## Layout

```
shared/     Pure TypeScript shared by both sides — keys, time, recurrence, points,
            streaks, achievements, the PG-13 filter. Not an npm package: web/ and api/
            each compile it into their own bundle.
web/        React + Vite + TypeScript SPA. Self-contained package.
api/        Azure Functions (node:20), bundled to a single file by esbuild.
e2e/        One Playwright smoke test, run against a live `swa start`. Owns the SWA CLI
            and Functions core tools so the fast CI job does not have to install them.
docs/       PLAN.md (the design, with an "as built" note per phase) and SETUP-TODO.md
            (everything that needs a human — credentials, cloud config, hardware).
prototype/  Standalone clickable mock of the kiosk. No build step, no backend.
```

`web/` and `api/` are deliberately **not** npm workspaces: SWA's Oryx build and workspace
hoisting interact badly, and the failure mode is a deploy that "succeeds" with zero
functions registered.

## Prototype

Open `prototype/kiosk-prototype.html` in a browser — no install required. It is the visual
reference for the design and demonstrates the core loop (sign in with a PIN, tick off a
chore, approve it as a parent) against fake in-page data.

## Development

```bash
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4 azurite

cp api/local.settings.example.json api/local.settings.json   # then fill in secrets

azurite --silent --location .azurite --skipApiVersionCheck   # table service on :10002
(cd api && npm run build && func start)                      # :7071
(cd web && npm run dev)                                      # :5173
swa start                                                    # :4280  ← use this one
```

**Always develop against `http://localhost:4280`, never `:5173`.** Only the SWA CLI applies
`staticwebapp.config.json` routing, proxies `/api`, and preserves the same-origin cookie
behavior the session design depends on. Bugs that appear only at :4280 are real; bugs that
appear only at :5173 are usually the missing proxy.

### Tests

```bash
npm test                        # unit tests over shared/ — pure functions, no infrastructure
npm test --prefix api           # integration tests against Azurite (start it first)
npm test --prefix e2e           # the one end-to-end test; needs `swa start` already running

npm run typecheck               # shared/
npm run typecheck --prefix web
npm run typecheck --prefix api
npm run typecheck --prefix e2e
```

Nearly all the test value is in `shared/`: recurrence across DST and month boundaries,
streak state transitions, key round-trips, and the PG-13 filter are all pure functions
encoding rules that are easy to get subtly wrong and painful to debug on a kitchen wall.

⚠️ Azurite's table implementation is not byte-identical to Azure — ETag semantics and
conditional-create behavior are the known divergences. Because idempotent task
materialization depends on `createEntity` throwing 409, exercise that path against a real
storage account (about $0.05/month) before relying on it, not just against Azurite.

## Configuration

Secrets live in SWA Application Settings in production and `api/local.settings.json`
locally. Never commit the latter — it is gitignored.

| Setting | Purpose |
|---|---|
| `TABLES_CONNECTION_STRING` | Azure Table Storage |
| `HOUSEHOLD_ID` | Prefixes every partition key. Set to `preview` on PR environments so a preview deploy cannot touch live family data. |
| `HOUSEHOLD_TZ` | IANA timezone; all local-date partition keys derive from it |
| `ANTHROPIC_API_KEY` | Server-side only — never shipped to the browser |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Calendar sync |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts the stored Google refresh token. |
| `GOOGLE_WEBHOOK_URL` | Optional. Set it for push updates; unset, the calendar syncs lazily on read and staleness is bounded at five minutes. |
| `CRON_SHARED_SECRET` | Authenticates `POST /api/cron/tick`. Needed in **both** SWA settings and GitHub repo secrets. |
| `TICK_URL` | GitHub repo secret only. The cron workflow no-ops without it. |

Everything degrades: with no Anthropic key the ticker uses hand-written copy and badges get
deterministic names; with no Google connection the calendar screen offers a Connect button
and nothing else changes; with no cron secrets, chores and the calendar still update
whenever somebody opens the app.

**[docs/SETUP-TODO.md](docs/SETUP-TODO.md) is the checklist for all of it** — it is written
for the person holding the Azure and Google accounts, not for a developer.

## Two constraints worth knowing before you change anything

1. **SWA managed Functions are HTTP-trigger only — there is no timer trigger.** Scheduled
   work runs lazily on read, or via `POST /api/cron/tick` driven by a GitHub Actions
   schedule. Nothing correctness-critical may depend on the cron firing on time.
2. **Table Storage has no cross-table transactions.** The points ledger is authoritative;
   `Member.pointsBalance` is only a cache. The approval path has a fixed write ordering so
   that a crash at any point converges on retry, and a daily reconciler recomputes balances
   from the ledger.

## License

MIT — see [LICENSE](LICENSE).
