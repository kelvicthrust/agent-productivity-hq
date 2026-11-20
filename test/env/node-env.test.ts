import { describe, expect, it } from 'vitest';

// The suite must not depend on whatever NODE_ENV the shell or a CI-style harness exported. Under "production"
// React drops `act`, and every component test fails with "React.act is not a function", which reads like a broken
// install. vitest.config.ts pins NODE_ENV to "test"; this fails if that pin is lost while the shell says otherwise.
describe('test environment', () => {
  it('runs as NODE_ENV=test whatever the shell exported', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});
