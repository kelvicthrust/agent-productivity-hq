import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the E7 harness page (test/e2e/harness): an Astryx Button and a Tailwind element on the product theme.
// Test-only: it writes to .harness-dist and is never part of `pnpm build`. base './' keeps asset URLs relative.
export default defineConfig({
  root: resolve(import.meta.dirname, 'test/e2e/harness'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(import.meta.dirname, '.harness-dist'), emptyOutDir: true },
});
