import { defineConfig } from 'vitest/config';

export default defineConfig({
  configLoader: 'runner',
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    // Browser fixtures and bcrypt are resource-sensitive; serial file execution
    // prevents unrelated suites from starving their lifecycle/time budgets.
    fileParallelism: false,
    // Keep a stuck integration or cleanup hook diagnosable in CI instead of
    // leaving the workspace test command alive indefinitely.
    testTimeout: 30_000,
    hookTimeout: 45_000,
  },
});
