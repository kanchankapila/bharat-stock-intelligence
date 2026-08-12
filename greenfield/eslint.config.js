// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';

// Import-boundary matrix from BUILD_STAGE_0_2_SPEC.md Task 0.1. This is what
// enforces "api never imports ingestion/provider-sdk" etc. as a CI-checked fact,
// not a convention someone can forget.
const elementTypes = [
  // match: 'full' -- the plugin's default ('folder') is capture-group folder
  // matching, not a plain full-path glob; without this every element-types
  // check silently no-ops (caught by this file's own negative control).
  { type: 'app-api', pattern: 'apps/api/src/**', match: 'full' },
  { type: 'app-worker', pattern: 'apps/worker/src/**', match: 'full' },
  { type: 'app-web', pattern: 'apps/web/src/**', match: 'full' },
  { type: 'pkg-contracts', pattern: 'packages/contracts/src/**', match: 'full' },
  { type: 'pkg-db', pattern: 'packages/db/src/**', match: 'full' },
  { type: 'pkg-market-calendar', pattern: 'packages/market-calendar/src/**', match: 'full' },
  { type: 'pkg-provider-sdk', pattern: 'packages/provider-sdk/src/**', match: 'full' },
  { type: 'pkg-ingestion', pattern: 'packages/ingestion/src/**', match: 'full' },
  { type: 'pkg-observability', pattern: 'packages/observability/src/**', match: 'full' },
  { type: 'pkg-testing', pattern: 'packages/testing/src/**', match: 'full' },
];

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2023 },
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      boundaries,
    },
    settings: {
      'boundaries/elements': elementTypes,
      // boundaries needs to resolve bare "@greenfield/x" workspace-package
      // imports to their actual .ts entry file before it can classify them --
      // without this, the element-types rule silently no-ops on every
      // cross-package import (caught by this file's own negative control).
      'import/resolver': {
        // preserveSymlinks:false -- pnpm workspace deps are real symlinks
        // (apps/api/node_modules/@greenfield/ingestion -> ../../../packages/
        // ingestion); without this the resolver returns the symlink path,
        // which contains "node_modules" and gets classified as an external
        // dependency rather than the internal pkg-ingestion element it
        // actually is (caught by this file's own negative control).
        node: { extensions: ['.js', '.ts'], preserveSymlinks: false },
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      // TypeScript already reports genuinely undefined symbols with full type
      // information; base no-undef false-positives on ambient global types
      // like `NodeJS.ErrnoException` that only @types/node declares. Standard
      // typescript-eslint guidance is to turn this off for .ts files.
      'no-undef': 'off',

      // Task 0.1 matrix, enforced mechanically.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app-api', allow: ['pkg-contracts', 'pkg-db', 'pkg-observability'] },
            { from: 'app-worker', allow: ['pkg-contracts', 'pkg-db', 'pkg-observability', 'pkg-provider-sdk', 'pkg-ingestion', 'pkg-market-calendar'] },
            { from: 'app-web', allow: ['pkg-contracts'] },
            { from: 'pkg-ingestion', allow: ['pkg-contracts', 'pkg-db', 'pkg-provider-sdk', 'pkg-market-calendar', 'pkg-observability'] },
            { from: 'pkg-db', allow: ['pkg-contracts', 'pkg-observability'] },
            { from: 'pkg-provider-sdk', allow: ['pkg-contracts', 'pkg-observability'] },
            { from: 'pkg-market-calendar', allow: ['pkg-contracts'] },
            { from: 'pkg-observability', allow: ['pkg-contracts'] },
            { from: 'pkg-testing', allow: ['pkg-contracts', 'pkg-db', 'pkg-market-calendar', 'pkg-provider-sdk', 'pkg-observability'] },
            { from: 'pkg-contracts', allow: [] },
          ],
        },
      ],

      // "Only market-calendar computes trading dates" (recurring-bugs.md's #1
      // bug class) targets deriving a CALENDAR DATE / write anchor from the
      // wall clock -- new Date() with no args is how that bug always starts
      // (date.today()'s TS equivalent). Date.now() is deliberately NOT banned
      // here: it returns a plain millisecond epoch used for interval/duration
      // math (rate limiters, circuit-breaker cooldowns, retry backoff) that
      // has nothing to do with trading-date derivation -- banning it too was
      // over-broad and flagged legitimate code in provider-sdk.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() with no arguments is forbidden outside packages/market-calendar. Use market-calendar\'s logicalSession()/now-injection instead.',
        },
      ],

      // "Only provider-sdk performs outbound HTTP" / "only db issues SQL" —
      // enforced by banning the raw client libraries anywhere else. Uses the
      // TypeScript-aware rule (not base no-restricted-imports) specifically
      // so `import type pg from 'pg'` for a pg.Pool/pg.ClientBase PARAMETER
      // TYPE stays legal -- a package like ingestion that's allowed to call
      // db's exported functions still needs to type the handle it passes
      // them; only issuing SQL directly (a value-level import) is banned.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Raw pg import outside packages/db is forbidden. Use packages/db repositories.', allowTypeImports: true },
            { name: 'node:http', message: 'Raw HTTP outside packages/provider-sdk is forbidden.' },
            { name: 'node:https', message: 'Raw HTTPS outside packages/provider-sdk is forbidden.' },
            { name: 'undici', message: 'Raw HTTP client outside packages/provider-sdk is forbidden.' },
          ],
        },
      ],
    },
  },
  {
    // packages/db and packages/provider-sdk are the declared exceptions to the
    // two no-restricted-imports rules above -- they ARE the SQL/HTTP boundary.
    // packages/testing is also exempted: its job per A2 ("Postgres harness,
    // payload fixtures, negative controls") is to stand up ephemeral Postgres
    // state directly for tests, not to go through the db package's own
    // request-serving repositories.
    files: [
      'packages/db/src/**/*.ts',
      'packages/provider-sdk/src/**/*.ts',
      'packages/testing/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    // Test files across every package legitimately need direct DB/HTTP access
    // to set up realistic fixtures and local test servers (see provider-sdk's
    // own contract tests, or the Acceptance Gate 1 end-to-end test) -- the
    // boundary rules police PRODUCTION code paths, not test setup. Likewise a
    // test may need the real current wall-clock date to build a dynamic
    // assertion baseline (e.g. dq-checks.test.ts's todayRefWeekday()).
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
      'boundaries/element-types': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
