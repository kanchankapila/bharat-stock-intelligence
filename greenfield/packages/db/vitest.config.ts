import { defineConfig } from 'vitest/config';

// Without a config file here, Vite's config search walks up past this
// package (and past `greenfield/` entirely) to the legacy repo's root
// `vite.config.ts` -- whose `test.globalSetup` path then resolves against
// THIS directory as root (Vite sets `root` to the CWD, not to the config
// file's own directory), throwing "Cannot find module
// .../greenfield/packages/db/vitest.globalSetup.ts". Same fix
// packages/ingestion/vitest.config.ts already applies, for the same reason.
export default defineConfig({
  test: {
    // These tests hit a real local Postgres -- same generous timeout as
    // packages/ingestion/vitest.config.ts, and for the same measured reason
    // (genuine disk I/O wait, not a slow query plan).
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
