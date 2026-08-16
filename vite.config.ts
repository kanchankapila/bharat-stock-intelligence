import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

// .claude/worktrees/ holds other concurrent sessions' checkouts of this same repo, so vitest was
// collecting a stale duplicate of every test file in each of them -- 1,010 test files instead of
// ~93, most of the run's wall-clock, and failures from other people's in-progress work. CI never
// saw this (the directory is gitignored, so a fresh checkout has none), which is worse, not
// better: the local suite disagreed with CI and the local red was easy to learn to ignore.
// Vitest's defaults are replaced wholesale when `exclude` is set, so node_modules/dist/build are
// restated here deliberately.
//
// greenfield/ is a separate pnpm workspace with its own isolated Postgres/Redis/S3 stack and its
// own per-package .env files (deliberately different ports -- see those files' own comments).
// This root config's `loadEnv(mode, '.', '')` loads the ROOT .env with an empty prefix (needed
// for GEMINI_API_KEY), and Vitest injects everything loadEnv returns into process.env for every
// collected test file -- so a root `npx vitest run` was clobbering greenfield's own DATABASE_URL
// with the root app's unrelated `DATABASE_URL=database.sqlite`. pg-connection-string then
// mis-parses that bare filename (no `://`) and extracts the literal substring "base" inside
// "database.sqlite" as the hostname, so every greenfield DB test failed with
// `getaddrinfo ENOTFOUND base` -- nothing wrong with greenfield's code, just the wrong env
// reaching it. greenfield has its own `pnpm -r run test` (run from greenfield/, confirmed to pick
// up its own .env correctly with no interference) -- excluded here the same way
// .claude/worktrees/ is, since it's an independently-configured tree, not part of this run.
//
// Shared by both projects below; a project's own `exclude` replaces the root one wholesale, so
// it has to be spread in rather than inherited.
const SHARED_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.claude/worktrees/**',
  '**/greenfield/**',
];

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    // NO `define` for GEMINI_API_KEY (removed 2026-08-15). `define` is a literal text
    // substitution into every module in the CLIENT graph, so it bakes the secret into the
    // browser bundle in plaintext for anyone to read via view-source.
    //
    // It was survivable only by accident: the sole consumers, src/services/aiService.ts and
    // src/services/geminiService.ts, happen to be imported exclusively from src/server/*, which
    // runs in Node under tsx and reads the real process.env -- never through this transform.
    // But CLAUDE.md documents src/services/ as the FRONTEND layer ("aiService (Ollama),
    // geminiService (fallback)"), next to marketService, which genuinely is frontend. One
    // component importing aiService as documented would have shipped the key, with nothing
    // failing loudly to say so.
    //
    // If a browser-side Gemini call is ever genuinely needed, it must go through a server
    // procedure, not a bundled key. Client-safe config belongs in a VITE_-prefixed var, which
    // Vite exposes on import.meta.env by design and which is understood to be public.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    optimizeDeps: {
      // App.tsx lazy-loads all six dashboard shells (React.lazy(() => import(...))), and
      // which one actually runs depends on a localStorage value the dep scanner can't
      // evaluate at cold start. The first time a browser session picks a non-default shell
      // (v1/v2/v3/v4/v5 -- v6 is the default fallback), Vite discovers that route's
      // dependencies for the first time and re-optimizes mid-session; a component already
      // mounted before that point keeps its old React module instance while the newly
      // discovered chunk gets a second one, crashing with "Invalid hook call" / "Cannot read
      // properties of null (reading 'useState')". Force every shell into the initial scan so
      // there's never a mid-session re-optimization to race against.
      entries: [
        'src/App.tsx',
        'src/v2/**/*.{ts,tsx}',
        'src/v3/**/*.{ts,tsx}',
        'src/v4/**/*.{ts,tsx}',
        'src/v5/**/*.{ts,tsx}',
        'src/v6/**/*.{ts,tsx}',
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        // `.claude/worktrees/` holds one FULL COPY of this repo per concurrent agent session
        // — 16 of them / ~1GB as of 2026-08-10. Chokidar walks the project root, so without
        // this it opens file handles across every copy and createViteServer() never returns.
        // Because server.ts awaits createViteServer() BEFORE httpServer.listen(), the symptom
        // is not a Vite error: it is port 3000 silently never opening while pm2 reports the
        // process "online" and BullMQ jobs keep running normally. The historical crash in
        // pm2-err.log is chokidar's own NodeFsHandler._addToNodeFs / createFsWatchInstance.
        // logs/ and graphify-out/ are excluded for the same reason: churn no page imports.
        ignored: [
          '**/database.sqlite*',
          '**/redis/**',
          '**/.claude/**',
          '**/logs/**',
          '**/graphify-out/**',
          '**/backend-python/venv/**',
          '**/.venv/**',
        ],
      },
    },
    build: {
      rollupOptions: {
        output: {
          // 2026-08-02 perf pass: the main entry chunk was 2.2MB because App.tsx (always
          // eagerly loaded -- it's the root component) statically imports several large,
          // independently-versioned vendor libraries used by its inline sub-components
          // (StockDetails/OptionChain/etc. aren't separately lazy-loaded files). Splitting
          // these into their own chunks doesn't reduce first-load bytes (everything reachable
          // from App.tsx still has to load before boot regardless of which file it's in), but
          // it does let the browser fetch them in parallel over HTTP/2 and -- the bigger win --
          // means a deploy that only touches app code no longer invalidates the cache for these
          // rarely-changing vendor libraries, so returning users skip re-downloading them.
          // Deliberately NOT splitting out react/react-dom or attempting to lazy-load App.tsx's
          // inline sub-components themselves -- both are real first-load-byte reductions but
          // are higher-risk refactors (React chunk-splitting has known hoisting pitfalls; the
          // inline components are large and this sandbox has no live browser to verify a visual
          // regression against) than this pass's git-history commitment can safely verify.
          manualChunks: {
            'vendor-firebase': ['firebase/app', 'firebase/auth'],
            'vendor-charts': ['recharts', 'lightweight-charts', 'd3'],
            'vendor-motion': ['motion'],
          },
        },
      },
    },
    test: {
      // Two projects, and the split is a correctness boundary, not organisation.
      //
      // `unit` runs against a private throwaway Postgres schema (vitest.globalSetup.ts creates
      // it, applies db/schema.postgres.sql into it, drops it CASCADE afterwards). `live` runs
      // the RUN_LIVE_DATASOURCE_TESTS canaries against REAL production Postgres, because a
      // live_datasource test's whole job is proving a fetcher writes correct real rows --
      // data-sources.md calls that write "genuine, correct production data".
      //
      // They must not share a process. Every *.live.test.ts loads `dotenv/config`, and under
      // one project with `singleFork: true` that mutated a single shared `process.env` for the
      // whole run -- so whichever file happened to run first decided which database every LATER
      // test file talked to. Measured 2026-08-16: 2,148 fabricated Saturday stock_ohlcv bars
      // written to production, and deliveryFetcher.live failing against empty SQLite in one run
      // and passing against production in the next. Separate projects means separate processes,
      // so the live half's credentials and dialect cannot reach the unit half at all.
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            exclude: [...SHARED_EXCLUDE, '**/*.live.test.ts', '**/mcapiProxy.test.ts'],
            globalSetup: ['./vitest.globalSetup.ts'],
            // Closes each file's own pg Pool; without it they accumulate past
            // max_connections. See vitest.setup.ts.
            setupFiles: ['./vitest.setup.ts'],
            pool: 'forks',
            poolOptions: { forks: { singleFork: true } },
          },
        },
        {
          extends: true,
          test: {
            name: 'live',
            include: ['**/*.live.test.ts', '**/mcapiProxy.test.ts'],
            exclude: SHARED_EXCLUDE,
            setupFiles: ['./vitest.setup.ts'],
            pool: 'forks',
            poolOptions: { forks: { singleFork: true } },
          },
        },
      ],
      // Single forked process: the suites serialise DB setup, and parallel workers race on
      // `UNIQUE _migrations.name`. Restated per-project above; kept here for a bare
      // `vitest --project` invocation.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      // .claude/worktrees/ holds other concurrent sessions' checkouts of this same repo, so
      // vitest was collecting a stale duplicate of every test file in each of them -- 1,010
      // test files instead of ~93, most of the run's wall-clock, and failures from other
      // people's in-progress work. CI never saw this (the directory is gitignored, so a fresh
      // checkout has none), which is worse, not better: the local suite disagreed with CI and
      // the local red was easy to learn to ignore. Vitest's defaults are replaced wholesale
      // when `exclude` is set, so node_modules/dist/build are restated here deliberately.
      //
      // greenfield/ is a separate pnpm workspace with its own isolated Postgres/Redis/S3 stack
      // and its own per-package .env files (deliberately different ports -- see those files'
      // own comments). This root config's `loadEnv(mode, '.', '')` loads the ROOT .env with an
      // empty prefix (needed for GEMINI_API_KEY), and Vitest injects everything loadEnv returns
      // into process.env for every collected test file -- so a root `npx vitest run` was
      // clobbering greenfield's own DATABASE_URL with the root app's unrelated
      // `DATABASE_URL=database.sqlite`. pg-connection-string then mis-parses that bare filename
      // (no `://`) and extracts the literal substring "base" inside "database.sqlite" as the
      // hostname, so every greenfield DB test failed with `getaddrinfo ENOTFOUND base` --
      // nothing wrong with greenfield's code, just the wrong env reaching it. greenfield has its
      // own `pnpm -r run test` (run from greenfield/, confirmed to pick up its own .env
      // correctly with no interference) -- excluded here the same way .claude/worktrees/ is,
      // since it's an independently-configured tree, not part of this vitest run.
      exclude: SHARED_EXCLUDE,
    },
  };
});
