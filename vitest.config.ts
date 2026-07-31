import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real git IO on shared CI runners: a 5s default invites mid-test timeouts
    // whose queued writes then drain into later tests. Fail slow, fail clean.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
