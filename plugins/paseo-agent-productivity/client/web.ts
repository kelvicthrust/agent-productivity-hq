import { nunito } from './native-nunito.generated.ts';

const family = 'Agent HQ Nunito';
export const dashboardDisplayFont = `"${family}", ui-rounded, system-ui`;

let initialized = false;

/** Paseo plugins can register the web font through the platform's font set. */
export function loadDashboardFont() {
  if (initialized) return;
  const browser = globalThis as typeof globalThis & {
    document?: { fonts?: { add(font: object): void } };
    FontFace?: new (
      family: string,
      source: string,
      options: { weight: string; display: string },
    ) => object;
  };
  if (!browser.document?.fonts || !browser.FontFace) return;
  browser.document.fonts.add(
    new browser.FontFace(family, `url(data:font/woff2;base64,${nunito})`, {
      weight: '600 800',
      display: 'swap',
    }),
  );
  initialized = true;
}
