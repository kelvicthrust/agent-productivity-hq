import { useCallback, useMemo, useState } from 'react';

// Which rows of the Usage tree are open: the one expanded-set both renderers read (TECH T5-2: "Two renderers of one data
// set; one shared expanded-set"). The Usage feature owns it as transient state: it is lost on reload, kept while the
// window crosses 640px and the table gives way to the list (or back), and never written to the URL.
//
// Ids are strings so one set can hold every kind of row without them colliding.

export const groupId = (key: string): string => `group:${key}`;
export const sessionId = (id: number): string => `session:${id}`;
export const unknownId = (key: string): string => `unknown:${key}`;

export interface ExpandedSet {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
}

export function useExpandedSet(): ExpandedSet {
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
