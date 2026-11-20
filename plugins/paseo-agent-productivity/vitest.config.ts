import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // The mock host renders the launcher with the repository's React DOM.
  resolve: { dedupe: ['react'] },
  test: {
    include: ['plugins/paseo-agent-productivity/test/*.test.tsx'],
    environment: 'jsdom',
    env: { NODE_ENV: 'test' },
  },
});
