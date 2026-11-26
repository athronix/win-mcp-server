import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/core/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    reporters: ['default'],
  },
});