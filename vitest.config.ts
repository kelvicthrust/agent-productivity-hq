import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Unit and integration tests (*.test.ts). Browser tests are *.spec.ts under test/e2e and run with Playwright (pnpm test:e2e).
// Component tests that need a DOM opt in with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // *.spec.ts files are Playwright's; *.bench.test.ts files are timed budgets and run with `pnpm bench` (vitest.bench.config.ts)
    exclude: ['test/**/*.spec.ts', 'test/**/*.bench.test.ts', 'node_modules/**'],
    environment: 'node',
    // Hermetic: a shell or harness exporting NODE_ENV=production would make React drop `act` (see test/env).
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
  },
});
