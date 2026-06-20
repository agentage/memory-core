import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
