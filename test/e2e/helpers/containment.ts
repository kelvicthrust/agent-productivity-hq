import type { Locator, Page } from '@playwright/test';

// The layout containment check, as a Playwright helper. It is docs/design/prototype/containment-check.js ported (that file
// was a review tool "never executed by its author"; docs/tech/design-to-code.md maps it to this helper, run at 1280, 390
// and 320px, as the automated form of DESIGN.md's Capture checklist). It measures; it never resizes or changes anything.
//
// The prototype printed text. This returns data, so a spec asserts on it:
//   FAIL   the page scrolls sideways, or an element's right edge is past the window
//   CHECK  an element has content wider than its own box: it spills out of it, or is silently clipped
//   LOCAL  a deliberate sideways scroller (the Usage table's region) that is wider than it shows; expected, and everything
//          inside it is left out of the other two lists, as in the prototype
// `.sr-only` content is skipped (it is 1px by design), and so is anything marked `data-containment-skip`.
//
// `findWrappedCells` is the D7 addition: Provider, Model and Started cells must never wrap. It checks the rendered text, not
// the stylesheet, and requires `white-space: nowrap` as well, so a column cannot pass just because it happened to fit.

export interface ContainmentReport {
  /** The layout width of the window, in CSS pixels. */
  width: number;
  /** How far the page scrolls sideways (0 when it does not). A FAIL above 1. */
  sidewaysScroll: number;
  /** FAIL: elements that extend past the right edge of the window. */
  beyond: string[];
  /** CHECK: elements whose content is wider than their own box. */
  spill: string[];
  /** LOCAL: deliberate scrollers that are wider than they show. */
  scrollers: string[];
}

/** What a spec asserts is empty: every FAIL as a sentence. CHECK items are reported but are not failures in the prototype. */
export function failures(report: ContainmentReport): string[] {
  return [
    ...(report.sidewaysScroll > 1
      ? [`the page scrolls sideways by ${report.sidewaysScroll}px at ${report.width}px`]
      : []),
    ...report.beyond.map((item) => `extends past the window: ${item}`),
  ];
}

export async function measureContainment(
  page: Page,
  options: { root?: string } = {},
): Promise<ContainmentReport> {
  return page.evaluate((rootSelector) => {
    const SKIP = '.sr-only, [data-containment-skip]';

    function label(el: Element): string {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      const cls =
        typeof el.className === 'string'
          ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
          : [];
      if (cls.length) s += `.${cls.join('.')}`;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
      return s + (text ? ` "${text}"` : '');
    }

    function nearestLocalScroller(el: Element, stop: Element): Element | null {
      for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return p;
      }
      return null;
    }

    const root = document.documentElement;
    const app = document.querySelector(rootSelector);
    if (!app) throw new Error(`containment: nothing matches ${rootSelector}`);
    const vw = root.clientWidth;
    const beyond: string[] = [];
    const spill: string[] = [];
    const local: Element[] = [];

    for (const el of Array.from(app.querySelectorAll('*'))) {
      if (el.closest(SKIP)) continue;
      // Inside an <svg>: the drawing is measured as a whole, by the <svg> element itself.
      if (el instanceof SVGElement && el.ownerSVGElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;

      const scroller = nearestLocalScroller(el, app);
      if (scroller) {
        if (!local.includes(scroller) && scroller.scrollWidth > scroller.clientWidth + 1) {
          local.push(scroller);
        }
        continue;
      }
      const scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      if (scrolls && el.scrollWidth > el.clientWidth + 1) {
        if (!local.includes(el)) local.push(el);
      } else if (
        !scrolls &&
        cs.textOverflow !== 'ellipsis' &&
        !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) &&
        !(el instanceof SVGElement) &&
        el.clientWidth > 0 &&
        el.scrollWidth > el.clientWidth + 1
      ) {
        spill.push(`${label(el)} (content ${el.scrollWidth}px in a ${el.clientWidth}px box)`);
      }
      if (cs.position !== 'fixed' && r.right > vw + 1) {
        beyond.push(`${label(el)} (right edge at ${Math.round(r.right)}px)`);
      }
    }

    return {
      width: vw,
      sidewaysScroll: Math.max(0, root.scrollWidth - vw),
      beyond,
      spill,
      scrollers: local.map(label),
    };
  }, options.root ?? '#root');
}

export interface WrappedCellReport {
  /** How many data cells in the named columns had text to check. A spec asserts this is above 0, so it cannot pass empty. */
  checked: number;
  /** Cells that wrapped, or that are allowed to: "Model · claude-sonnet-5-5 · 2 lines · white-space: normal". */
  wrapped: string[];
}

/**
 * The data cells of `columns` (header texts) in `table` that wrap or may wrap. A cell is a problem when its text sits on more
 * than one line, and also when its `white-space` is not `nowrap`, because a column that fits today only by luck would
 * fail at the next longer value. Cells with no text (a group row's blanks) are skipped.
 */
export async function findWrappedCells(
  table: Locator,
  columns: readonly string[],
): Promise<WrappedCellReport> {
  return table.evaluate((element, names) => {
    const table = element as HTMLTableElement;
    const headerRow = table.tHead?.rows[0];
    if (!headerRow) throw new Error('wrapped cells: the table has no header row');
    const headers = Array.from(headerRow.cells).map((cell) => (cell.textContent ?? '').trim());

    /** The text's line boxes, as the distinct vertical centres of its client rects (3px apart is the same line). */
    function lineCentres(cell: HTMLElement): number[] {
      const centres: number[] = [];
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0) continue;
          const centre = rect.top + rect.height / 2;
          if (!centres.some((known) => Math.abs(known - centre) < 6)) centres.push(centre);
        }
      }
      return centres;
    }

    let checked = 0;
    const wrapped: string[] = [];
    for (const name of names) {
      const column = headers.indexOf(name);
      if (column === -1) throw new Error(`wrapped cells: no column named "${name}"`);
      for (const body of Array.from(table.tBodies)) {
        for (const row of Array.from(body.rows)) {
          // The logical column, so a colspan above or beside it cannot shift the lookup.
          let at = 0;
          for (const cell of Array.from(row.cells)) {
            if (at === column) {
              const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (text !== '') {
                checked += 1;
                const lines = lineCentres(cell).length;
                const whiteSpace = getComputedStyle(cell).whiteSpace;
                if (lines > 1 || whiteSpace !== 'nowrap') {
                  wrapped.push(
                    `${name} · ${text.slice(0, 40)} · ${lines} line${lines === 1 ? '' : 's'} · white-space: ${whiteSpace}`,
                  );
                }
              }
              break;
            }
            at += cell.colSpan;
          }
        }
      }
    }
    return { checked, wrapped };
  }, columns);
}

/**
 * The pieces inside the data cells of one column that wrap: a text node whose own text sits on more than one line. A cell that
 * is a stack by design (Delivery's Linked sessions: the providers, then "2 sessions") has several lines, so it cannot be held to
 * `findWrappedCells`; what it must still never do is break one of its pieces ("Claude" over "Code", "2" over "sessions").
 */
export async function findWrappedPieces(
  table: Locator,
  column: string,
): Promise<{ checked: number; wrapped: string[] }> {
  return table.evaluate((element, name) => {
    const table = element as HTMLTableElement;
    const headerRow = table.tHead?.rows[0];
    if (!headerRow) throw new Error('wrapped pieces: the table has no header row');
    const index = Array.from(headerRow.cells).findIndex(
      (cell) => (cell.textContent ?? '').trim() === name,
    );
    if (index === -1) throw new Error(`wrapped pieces: no column named "${name}"`);
    let checked = 0;
    const wrapped: string[] = [];
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        const cell = row.cells[index];
        if (!cell) continue;
        // As in findWrappedCells, a cell that fits only by luck is a failure too: it must be `white-space: nowrap`.
        const whiteSpace = getComputedStyle(cell).whiteSpace;
        if ((cell.textContent ?? '').trim() !== '' && whiteSpace !== 'nowrap')
          wrapped.push(
            `${name} · ${(cell.textContent ?? '').trim().slice(0, 40)} · white-space: ${whiteSpace}`,
          );
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!text || node.parentElement?.closest('.sr-only')) continue;
          checked += 1;
          const range = document.createRange();
          range.selectNodeContents(node);
          const centres: number[] = [];
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width === 0) continue;
            const centre = rect.top + rect.height / 2;
            if (!centres.some((known) => Math.abs(known - centre) < 6)) centres.push(centre);
          }
          if (centres.length > 1)
            wrapped.push(`${name} · ${text.slice(0, 40)} · ${centres.length} lines`);
        }
      }
    }
    return { checked, wrapped };
  }, column);
}

/**
 * A button or link whose label is cut shows less than its accessible name: a box that clips its text (overflow other than
 * visible) with more content than it has room for, which is how an ellipsis is made. Returns each such element as a sentence;
 * an empty list means the whole label is on screen. The same check, applied to the buttons that carry the wrapping-label classes
 * (src/client/lib/wrapLabel.ts), is what fails when the label is cut again.
 */
export async function cutLabels(target: Locator): Promise<string[]> {
  return target.evaluate((root) => {
    const cut: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      if (!(el instanceof HTMLElement) || el.clientWidth === 0) continue;
      const style = getComputedStyle(el);
      if (style.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        cut.push(
          `${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}" (content ${el.scrollWidth}px in a ${el.clientWidth}px box)`,
        );
      }
    }
    return cut;
  });
}
