import { defineConfig } from 'vitest/config';

export default defineConfig({
  configLoader: 'runner',
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
