import { Button } from '@astryxdesign/core/Button';
import { Theme } from '@astryxdesign/core/theme';
import { createRoot } from 'react-dom/client';
import { crewTheme } from '../../../src/client/theme/generated/crewTheme';
import './harness.css';

// E7: one product token (--color-action) must reach an Astryx component and Tailwind-styled UI.
function Harness() {
  return (
    <Theme theme={crewTheme} mode="light">
      <main className="flex flex-col items-start gap-4 p-6">
        <h1 className="font-display text-title-page text-ink">E7 harness</h1>
        <Button label="Astryx primary" variant="primary" />
        <div
          data-testid="tailwind-box"
          className="rounded-md bg-action px-4 py-3 text-on-action shadow-card"
        >
          Tailwind-styled
        </div>
      </main>
    </Theme>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('harness has no #root element');
createRoot(root).render(<Harness />);
