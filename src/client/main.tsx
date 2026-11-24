import { Theme } from '@astryxdesign/core/theme';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { PaseoBrowserStatus } from './app/PaseoBrowserStatus';
import { createAppRouter } from './app/router';
import { openPaseoSession } from './lib/api';
import { isPaseoBrowser } from './lib/paseoBrowser';
import { createQueryClient } from './lib/queryClient';
import './theme/globals.css';
import { crewTheme } from './theme/generated/crewTheme';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// Light only for the MVP (owner decision): mode="light" pins data-theme on <html>.
const queryClient = createQueryClient();
const app = createRoot(root);

function render(content: ReactNode) {
  app.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Theme theme={crewTheme} mode="light">
          {content}
        </Theme>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function renderDashboard() {
  render(<RouterProvider router={createAppRouter()} />);
}

if (isPaseoBrowser()) {
  const session = openPaseoSession(window, () => {
    queryClient.clear();
    render(<PaseoBrowserStatus state="reopen" focusHeading />);
  });
  render(<PaseoBrowserStatus state="loading" />);
  void session.then(
    (opened) => (opened ? renderDashboard() : render(<PaseoBrowserStatus state="reopen" />)),
    () => render(<PaseoBrowserStatus state="reopen" />),
  );
} else {
  renderDashboard();
}
