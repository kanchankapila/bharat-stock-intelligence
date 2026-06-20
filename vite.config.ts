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
    test: {
      // Single forked process: the test suites share one SQLite migration table, and
      // parallel workers race on `UNIQUE _migrations.name`. Serialising avoids it without
      // each run needing `--pool=forks --poolOptions.forks.singleFork` on the CLI.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  };
});
