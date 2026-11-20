import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { OverviewRoute } from '../features/overview/route';
import { SetupRoute } from '../features/setup/route';
import { NotFoundRoute } from './NotFoundRoute';
import { RootLayout } from './RootLayout';
import { RouteLoadError, RouteLoading } from './RouteState';
import { SetupLayout } from './SetupLayout';
import { ShellLayout } from './ShellLayout';

function deferredRoute(path: string, load: () => Promise<ComponentType>): RouteObject {
  return {
    path,
    lazy: async () => ({ Component: await load() }),
    HydrateFallback: RouteLoading,
    ErrorBoundary: RouteLoadError,
  };
}

export const appRoutes: RouteObject[] = [
  {
    // Pathless: it adds no segment, it only holds what both layouts share (the page title and route focus).
    Component: RootLayout,
    children: [
      {
        path: '/',
        Component: ShellLayout,
        children: [
          { index: true, Component: OverviewRoute },
          deferredRoute(
            'trends',
            async () => (await import('../features/trends/route')).TrendsRoute,
          ),
          deferredRoute(
            'delivery',
            async () => (await import('../features/delivery/route')).DeliveryRoute,
          ),
          deferredRoute('usage', async () => (await import('../features/usage/route')).UsageRoute),
          deferredRoute('hq', async () => (await import('../features/hq/route')).HqRoute),
          deferredRoute(
            'sources',
            async () => (await import('../features/sources/route')).SourcesRoute,
          ),
          { path: '*', Component: NotFoundRoute },
        ],
      },
      {
        path: '/setup',
        Component: SetupLayout,
        children: [{ index: true, Component: SetupRoute }],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
