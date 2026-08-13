---
name: run-bharat-stock-intelligence
description: Build, start, and drive the Bharat Stock Intelligence web app (Express/tRPC + React/Vite frontend, plus 3 Python FastAPI services). Use when asked to run the app, start the dev server, take a screenshot of a dashboard, or click through/interact with the live UI.
---

This is a React 19 + Vite SPA served by an Express/tRPC backend (`server.ts`,
port 3000), backed by 3 separate Python FastAPI services and Postgres. It has
no test-mode stub data — every screen reads live tRPC queries. Drive it with
the Playwright script-runner at
`.claude/skills/run-bharat-stock-intelligence/driver.mjs` (there is no
`chromium-cli` or `tmux` on this box — see Gotchas).

All paths below are relative to the repo root.

## Prerequisites

Verified this session on Windows (Git Bash), Node v24.16.0:

```bash
npm install -D playwright        # already a project devDependency after this
npx playwright install chromium  # downloads Chrome for Testing, ~300MB, one-time
```

No `apt-get`/xvfb needed — Playwright's bundled Chromium runs headless
natively on Windows.

## Setup

The four services (`bharat-server`, `alphaquant-api`, `ml-api`, `chatbot`)
need `.env` (Postgres URL, API keys) and two separate dependency installs —
Node at repo root, and a Python venv at `backend-python/venv` (the three
Python services use that interpreter; see `ecosystem.config.cjs`). This
session found all of that **already done and already running** — see below.

## Run (agent path)

**Check before launching anything — this app is normally kept running under
pm2, shared by other concurrent sessions on this box:**

```bash
pm2 list
```

If `bharat-server` shows `online`, it's already serving on `:3000` — go
straight to driving it, do not start a second copy (`EADDRINUSE`, plus it
doubles DB connections against a shared Postgres). This is what this session
actually did: found all 4 services already `online` (`pm2 list`, verified),
and drove the running instance rather than restarting anything.

If nothing is running, the verified-working launch (from
`ecosystem.config.cjs`'s own header, not re-run this session since a live
copy was already up):

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

Verified this session, all passing against the current `main`:

```bash
npx tsc --noEmit                                            # typecheck
npx vitest run                                               # ~104 suites
python -m pytest src/server/__tests__/ src/server/tests/ -q  # ~1750 tests
```

`greenfield/` is a separate pnpm workspace with its own Postgres (port
5434) — its tests need `DATABASE_URL` pointed there explicitly or they
silently inherit the root `.env`'s `DATABASE_URL=database.sqlite` and fail
with `getaddrinfo ENOTFOUND base`. Not part of this skill's unit; see
`greenfield/`'s own tooling if driving that app instead.

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
- **`App.tsx`'s `dashboardVersion` (localStorage) picks which of 6 dashboard
  shells renders; a fresh session with no localStorage lands on `v6`
  ("Workbench", `WB` in the bottom-left switcher) — that's what the driver
  screenshots above are.** If you need a different shell, `eval` a
  `localStorage.setItem('dashboardVersion', 'v2')` before `nav`, or click
  the `V1`/`V2`/`V3`/`V5` buttons in the sidebar.
- **This app has no demo/offline mode.** Every screen is live production
  data off Postgres via tRPC — there's no seeded fixture state to reset
  between runs, so a screenshot today will show different numbers tomorrow.
  That's expected, not a bug in the driver.

## Troubleshooting

- **`nav` succeeds but the page never leaves `Loading...`**: check
  `pm2 logs bharat-server` — the Node server can be up while a downstream
  Python service (`ml-api`/`alphaquant-api`) it proxies to is down; `pm2
  list` shows each service's own status independently.
- **`click-text` returns `NOT_FOUND`**: the label is inside the collapsed
  sidebar or off-screen at the default 1400×900 viewport — `text` (no
  selector) to dump `body.innerText` and confirm what's actually rendered
  before assuming the selector is wrong.
