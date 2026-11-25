import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, useLocation, type RouteObject } from 'react-router';
import { OverviewRoute } from '../features/overview/route';
import { SetupRoute } from '../features/setup/route';
import { isPaseoBrowser, PASEO_BROWSER_BASENAME } from '../lib/paseoBrowser';
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

function LegacyWorkReviewRedirect() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set('section', 'work-review');
  return <Navigate replace to={{ pathname: '/delivery', search: `?${params}`, hash }} />;
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
          { path: 'work-review', Component: LegacyWorkReviewRedirect },
          deferredRoute(
            'trends',
            async () => (await import('../features/trends/route')).TrendsRoute,
          ),
          deferredRoute('delivery', async () => {
            const [{ DeliveryRoute }, { WorkReviewSection }] = await Promise.all([
              import('../features/delivery/route'),
              import('../features/overview/work-review/Section'),
            ]);
            return function DeliveryWithWorkReview() {
              return <DeliveryRoute workReview={<WorkReviewSection />} />;
            };
          }),
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

export const createAppRouter = () =>
  createBrowserRouter(
    appRoutes,
    isPaseoBrowser() ? { basename: PASEO_BROWSER_BASENAME } : undefined,
  );
