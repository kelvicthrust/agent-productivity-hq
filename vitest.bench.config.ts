import { defineConfig } from 'vitest/config';

// `pnpm bench` (C10): the performance budgets TECH names, measured with a clock. They run apart from `pnpm test` so a timing
// assertion on a busy machine can never make the main suite flaky, and they are real timings: each file seeds the year-scale
// world (150,000 usage events, 6,000 sessions, 2,000 merged PRs) before it measures, so it takes a few seconds.
export default defineConfig({
  test: {
    include: ['test/**/*.bench.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    testTimeout: 120_000,
    // One file at a time: two seeds and two measurements sharing the CPU would measure each other.
    fileParallelism: false,
  },
});
