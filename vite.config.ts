import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
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
      // Single forked process: the test suites share one SQLite migration table, and
      // parallel workers race on `UNIQUE _migrations.name`. Serialising avoids it without
      // each run needing `--pool=forks --poolOptions.forks.singleFork` on the CLI.
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
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.claude/worktrees/**',
        '**/greenfield/**',
      ],
    },
  };
});
