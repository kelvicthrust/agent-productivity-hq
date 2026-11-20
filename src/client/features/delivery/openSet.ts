import { useCallback, useMemo, useState } from 'react';

// Which PRs are open: the one set both renderers read, so a PR opened in the table is still open in the list when the window
// crosses 640px, and the other way round. The Delivery feature owns it as transient state: lost on reload and never written to
// the URL. Ids are the PRs' own (the GitHub node id).

export interface OpenSet {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
}

export function useOpenSet(): OpenSet {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  return useMemo(() => ({ has: (id) => open.has(id), toggle }), [open, toggle]);
}
