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
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: ['**/database.sqlite*', '**/redis/**'],
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
    },
  };
});
