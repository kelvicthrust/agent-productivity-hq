import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import {
  nunitoLicenseSource,
  nunitoNoticeFile,
  packageNotices,
  playpenLicenseSource,
  playpenNoticeFile,
  thirdPartyNoticesFile,
} from './scripts/third-party-notices.ts';

function browserNotices(): Plugin {
  return {
    name: 'browser-notices',
    apply: 'build',
    generateBundle(_, bundle) {
      // CSS inlined by Tailwind and Vite's injected browser helpers aren't npm JS modules.
      const dependencies = new Set(
        ['@astryxdesign/core', 'tailwindcss', 'vite'].map((name) =>
          join(this.environment.config.root, 'node_modules', name),
        ),
      );
      for (const entry of Object.values(bundle)) {
        if (entry.type !== 'chunk') continue;
        for (const id of entry.moduleIds) {
          if (id.startsWith('\0')) continue;
          const directory = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
          if (directory) dependencies.add(directory);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: thirdPartyNoticesFile,
        source: `Third-party notices for the dashboard\n\nNunito license: ${nunitoNoticeFile}\nPlaypen Sans license: ${playpenNoticeFile}\n\n${packageNotices(dependencies)}\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: nunitoNoticeFile,
        source: readFileSync(nunitoLicenseSource),
      });
      this.emitFile({
        type: 'asset',
        fileName: playpenNoticeFile,
        source: readFileSync(playpenLicenseSource),
      });
    },
  };
}

// The product SPA. The production server (a later milestone) serves dist/client. The E7 harness has its own
// config (vite.harness.config.ts) so no test page ever reaches this build.
export default defineConfig({
  plugins: [react(), tailwindcss(), browserNotices()],
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: true },
});
