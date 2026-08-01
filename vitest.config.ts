import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['shared/**/*.ts'],
      exclude: ['shared/**/*.test.ts'],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
});
