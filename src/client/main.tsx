import { Theme } from '@astryxdesign/core/theme';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { createAppRouter } from './app/router';
import { createQueryClient } from './lib/queryClient';
import './theme/globals.css';
import { crewTheme } from './theme/generated/crewTheme';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// Light only for the MVP (owner decision): mode="light" pins data-theme on <html>.
const queryClient = createQueryClient();
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Theme theme={crewTheme} mode="light">
        <RouterProvider router={createAppRouter()} />
      </Theme>
    </QueryClientProvider>
  </StrictMode>,
);
