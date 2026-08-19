---
description: Audit authorization coverage, the three unguarded Python services, injection surface, and secrets handling against this platform's ACTUAL auth layer (internalAuth.ts) — every finding must cite a file:line, no generic OWASP checklist items
---

# Security Audit

**This app is not unprotected. Do not report generic findings.** Verified 2026-08-19:

- `src/server/internalAuth.ts` provides `isLoopbackRequest`, `isAuthorizedInternalCaller`
  (`INTERNAL_API_SECRET`), `isAuthorizedUser`, `isAuthorizedInternalOrUser`, `makeRateLimiter`.
- `server.ts` sets baseline security headers — deliberately not full `helmet()` (no CSP,
  because it serves Vite's assets; the in-file comment explains why).
- Rate limits applied: `/mcapi` 60/min, export-picks 5/min, internal-notify 120/min.
- The server binds `0.0.0.0:3000`.

**The single hard rule for this audit: every finding must name a `file:line`.** A checklist item
with no located source is noise, and this repo has a specific history of evidence-shaped output
being committed and cited as real (5 fabricated audit scripts, one claiming a row count ~22,500×
the real value — see `recurring-bugs.md`).

## A. Authorization coverage — highest value, do this first

Enumerate **every** Express route and tRPC procedure (`src/server/router.ts`,
`src/server/routers/*.ts`) and build:

| procedure/route | `publicProcedure` or gated? | auth helper applied | rate limited | mutation? |

**Derive the list from the source tree, not by hand.** A hand-enumerated allowlist only guards
what someone remembered to list — that exact shape left `appeared_at` populated on **10 rows
platform-wide** while `screenerAppearedAt.test.ts` stayed green, because it listed 3 of 4 writers.

Flag every mutation with no gate. Cross-reference `/trpc-surface-review` for procedures already
reviewed on other axes.

## B. The other three services — the likeliest real gap

`ml-api` (:8000), `chatbot` (:8001), `alphaquant-api` (:8002) are separate FastAPI processes
under pm2. **The Node service's auth does not protect them.** For each, establish from source:

- What interface does it bind (`0.0.0.0` vs `127.0.0.1`)?
- Does it authenticate anything at all?
- Is it reachable from outside the host?
- What can it do — `ml-api` triggers training/scoring; `alphaquant-api` runs backtests and
  optimisation; `chatbot` executes SQL (see C).

## C. Injection surface

1. **`src/server/chatbot/tools/sql_tool.py`** — establish exactly what SQL it can construct, from
   what input, and what constrains it. Trace to the actual execution call.
2. **f-string SQL construction.** `mc_earnings_fetcher.fetch_actual_estimate_beats` builds a
   `FROM (VALUES ...)` clause by interpolating symbols directly. Determine whether every value on
   that path is provably internal (`nse_stocks`-resolved) or can carry vendor-supplied text.
   Grep for the general shape: `.format(` / f-strings inside `cur.execute(`.
3. Note that raw `%s` placeholders are already a flagged class in `check_recurring_bugs.py` — a
   hit there is a correctness bug *and* potentially an injection one.

## D. The rate limiter itself

`makeRateLimiter` is an in-memory `Map` keyed on `req.socket.remoteAddress`. Assess:

- **Unbounded growth** — is there eviction for keys that stop appearing?
- **Proxy behaviour** — `remoteAddress` behind any reverse proxy is the proxy, collapsing every
  client into one bucket (or, if `X-Forwarded-For` were trusted instead, trivially spoofable).
- **Per-process scope** — 4 services, and pm2 could run multiple instances of one.
- Note that `isLoopbackRequest`'s allowlist is checked against the **real TCP peer**, which is the
  correct choice; confirm nothing downstream weakened it to a header.

## E. Secrets and credentials

`docker-compose.yml` falls back to `bharat`/`bharat` and `bharatredis` when `.env` is absent —
its own comment marks this dev-only. Verify what production actually runs with. Then check:

- Credentials in logs (`logs/pm2-*.log`), in error responses, in committed files.
- The 4 Grafana dashboard JSONs under `grafana/`.
- `.env` handling in `ecosystem.config.cjs` — it parses `.env` and injects it into **every**
  service's environment.
- Whether any API key (Gemini, Telegram, NiftyTrader, provider cookies) reaches the client bundle
  via Vite's `define`/`import.meta.env`.

## F. Data exposure

export-picks is gated and rate-limited — verify that gate is actually correct, then check whether
any *other* endpoint returns the full recommendation set unauthenticated. The commit that added
that gate recorded the motivation: exposure to the internet with no auth was a real
resource-exhaustion vector, not only a data-leak one.

## Deliver

- **Vulnerability report** — one row per finding: severity · `file:line` · concrete attack
  scenario (who, from where, what they obtain) · the evidence used.
- **Separate CONFIRMED from SUSPECTED.** A finding you traced vs. one that needs verification.
  Do not present the second as the first.
- **Secure fix per finding**, preferring the existing `internalAuth` helpers over new mechanisms.
- **A negative-controlled test** per fix where testable (revert → confirm red → restore).
- **What you could not assess and why.**

Do not propose an auth framework migration. The existing helpers are small, readable, and already
handle the loopback/internal/user distinction this platform actually needs.
