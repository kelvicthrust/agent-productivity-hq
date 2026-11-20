import { useState } from 'react';
import { Outlet } from 'react-router';
import { AppBar } from './AppBar';
import { ProjectCredit } from './ProjectCredit';

/** Setup: app bar and content only, with no navigation or filters. */
export function SetupLayout() {
  // The app bar's right side belongs to the screen on Setup ("Step N of 3"): the layout hands the slot down through the outlet.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[var(--appbar-h)_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:shadow-overlay"
      >
        Skip to content
      </a>
      <AppBar setup actionsRef={setBarSlot} />
      <main
        id="main"
        tabIndex={-1}
        className="row-start-2 min-w-0 px-4 pt-4 pb-12 min-[720px]:px-6 min-[720px]:pt-6"
      >
        {/* D7's .setup: 760px wide with 24px of padding (712px of content), 24px above on a desktop and 16px on a phone. */}
        <div className="mx-auto max-w-[44.5rem]">
          <Outlet context={barSlot} />
          <ProjectCredit />
        </div>
      </main>
    </div>
  );
}
