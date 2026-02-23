import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use tsx for TypeScript execution
    globals: false,
    // Increase timeout for integration tests
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
