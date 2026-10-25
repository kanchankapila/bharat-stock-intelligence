---
name: run-bharat-stock-intelligence
description: Build, start, and drive the Bharat Stock Intelligence web app (Express/tRPC + React/Vite frontend, plus 3 Python FastAPI services). Use when asked to run the app, start the dev server, take a screenshot of a dashboard, or click through/interact with the live UI.
---

This is a React 19 + Vite SPA served by an Express/tRPC backend (`server.ts`,
port 3000), backed by Python FastAPI services and Postgres. Internal project skill:
live-data pages and explicitly simulated concepts must be verified separately. Drive it with
the Playwright script-runner at
`.claude/skills/run-bharat-stock-intelligence/driver.mjs` (there is no
`chromium-cli` or `tmux` on this box — see Gotchas).

All paths below are relative to the repo root.
Use current evidence, not this document's historical session assertions, to establish that
dependencies, services and tests are ready. Browser inspection alone does not authorize
dependency installation, production writes or service restarts; launch/setup steps apply
when the request includes running or setting up the app. Preserve the check-before-launch rule.

## Route-target pre-flight

Before browser verification, read `src/main.tsx` and follow the application/route modules
it actually imports, including nested routes. Record the import chain for each target and
whether it is live-data, explicitly simulated, or present only in the working tree. Component
directories, old screenshots and generation names do not establish reachability or deployment.
Where still imported, inspect `src/v1/V1Routes.tsx` and `src/tala/TalaRoutes.tsx`; follow any
additional route tree the entry point now mounts rather than freezing this pair as an allowlist.

Drive the actual default landing page and a representative page in each mounted application.
Keep simulated pages such as `/concept` separate from live-data checks. Verify the deployed
build serves the intended routes; a catch-all that paints the default page for an unknown URL
does not prove the requested page exists. Do not call route coverage complete until each named
target has an active import chain and the observed page matches that target.

## Prerequisites

Check the current Node/Playwright installation on Windows before setup. When setup is authorized:

```bash
npm install -D playwright        # only if the current dependency installation needs it
npx playwright install chromium  # downloads Chrome for Testing, ~300MB, one-time
```

No `apt-get`/xvfb needed — Playwright's bundled Chromium runs headless
natively on Windows.

## Setup

The four services (`bharat-server`, `alphaquant-api`, `ml-api`, `chatbot`)
need `.env` (Postgres URL, API keys) and two separate dependency installs —
Node at repo root, and a Python venv at `backend-python/venv` (the three
Python services use that interpreter; see `ecosystem.config.cjs`). Check the current
configuration and running service inventory rather than relying on a previous session's state.

## Run (agent path)

**Check before launching anything — this app is normally kept running under
pm2, shared by other concurrent sessions on this box:**

```bash
pm2 list
```

If `bharat-server` shows `online`, it's already serving on `:3000` — go
straight to driving it, do not start a second copy (`EADDRINUSE`, plus it
doubles DB connections against a shared Postgres). Reuse the existing instance after checking
that the target page actually answers; process state alone is not application readiness.

If the requested run/setup requires launching services and none is running, check the current
operating manual and ecosystem configuration before using its launch command:

```bash
pm2 start ecosystem.config.cjs
```

Then drive it — pipe a script to the driver's stdin, same UX as
`chromium-cli`:

```bash
node .claude/skills/run-bharat-stock-intelligence/driver.mjs <<'EOF'
nav http://localhost:3000
wait-for text=Dashboard
sleep 4000
screenshot 01-dashboard
click-text Screener
sleep 1500
screenshot 02-screener
console-errors
EOF
```

Screenshots land in `.claude/skills/run-bharat-stock-intelligence/screenshots/`
(override with `SCREENSHOT_DIR`).

### Driver commands

| command | what it does |
|---|---|
| `nav <url>` | goto a URL |
| `wait-for text=<substr>` | poll `body.innerText` for a substring (10s timeout) |
| `wait-for <css-selector>` | `waitForSelector` (10s timeout) |
| `screenshot [name]` | PNG → `screenshots/<name-or-ts>.png` |
| `click <css-selector>` | DOM click via `evaluate` (bypasses overlay hit-testing) |
| `click-text <text>` | click first `button`/`a`/`[role=button]`/`[role=tab]` containing text |
| `fill <css-selector> <text>` | `locator.fill` (fires React's `onChange`, unlike `eval el.value=`) |
| `press <key>` | `keyboard.press` |
| `eval <js-expr>` | `page.evaluate`, prints JSON |
| `text [css-selector]` | print `innerText` (body if no selector) |
| `console-errors` | print `console.error`/`pageerror` seen since launch |
| `sleep <ms>` | last resort; prefer `wait-for` |

## Run (human path)

```bash
npm start   # concurrently: Vite dev server + tRPC/Express + ml-api + chatbot
```

Opens 4 processes in one terminal (no auto-restart on crash — that's what
`pm2 start ecosystem.config.cjs` is for). Visit `http://localhost:3000`.
Ctrl-C to stop. Useless in a headless session — use the agent path.

## Test

Run these when validating source changes; quote results only from the run actually observed:

```bash
npx tsc --noEmit                                            # typecheck
npx vitest run                                               # unit tests
backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ -q
```

## Gotchas

- **No `chromium-cli`, no `tmux` on this box.** `driver.mjs` is a one-shot
  script runner (pipe commands via stdin, same vocabulary as `chromium-cli`)
  rather than a REPL you `tmux send-keys` into — there's nothing to attach
  `tmux` to on Windows here. If a future agent has `tmux` available, this
  script can still be run interactively via `node driver.mjs` + a pipe, it
  just won't survive a detach.
- **The dashboard renders its shell immediately, then fills in via tRPC.**
  Every panel (`Market Command Center`, `Money Flow Pulse`, `Activity Feed`)
  shows `Loading...` for a few seconds after `nav`. `wait-for text=Dashboard`
  only proves the shell painted — screenshot too early and you get a page
  full of skeleton loaders, not the real data. Give it 3-4s after that
  before the screenshot that's supposed to prove real content loaded.
- **Resolve surfaces from imports, not remembered shell versions.** The historical v2–v6
  switcher is not a route inventory. Use the route-target pre-flight to discover the current
  root, separately mounted applications and nested surfaces before choosing screenshots.
- **Live-data pages are production reads, not fixtures.** Their values change over time;
  do not reset production to make screenshots repeatable. Explicitly simulated concept pages
  are a different verification surface: label them and never cite their values as live evidence.

## Troubleshooting

- **`nav` succeeds but the page never leaves `Loading...`**: check
  `pm2 logs bharat-server` — the Node server can be up while a downstream
  Python service (`ml-api`/`alphaquant-api`) it proxies to is down; `pm2
  list` shows each service's own status independently.
- **`click-text` returns `NOT_FOUND`**: the label is inside the collapsed
  sidebar or off-screen at the default 1400×900 viewport — `text` (no
  selector) to dump `body.innerText` and confirm what's actually rendered
  before assuming the selector is wrong.
