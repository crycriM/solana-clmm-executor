import { defineConfig } from 'vitest/config';

// Live functional suites (tests/functional) are opt-in: they are only
// collected when RUN_LIVE=1 is set by the test runner — `npm run test:live`.
// Ordinary `npm test` runs the offline contract + component suites and the
// src suites, never a live campaign (plan §7).
const live = process.env['RUN_LIVE'] === '1';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: live
      ? ['**/node_modules/**', '**/dist/**']
      : ['tests/functional/**', '**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
