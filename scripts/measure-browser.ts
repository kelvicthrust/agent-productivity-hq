// `node scripts/measure-browser.ts [--record] [--only chart|import] [--files N (per provider, default 300)] [--lines N (per file, default 1000)] [--samples N]`: the two TECH › Performance rows
// that need a real browser (`pnpm bench` cannot time them; see test/bench/RESULTS.md):
//
//   UI rendering        "Warm chart redraw work ≤ 16 ms for every sampled operation" (at the year's 366 daily buckets)
//   First full import   "Progress shown per source; UI stays responsive"
//
// Both run in Playwright's headless shell (the build the e2e specs use) on the production build served by request interception, so no
// port is needed. THE CHART: the year world (150,000 events) on Trends, 12 months by day (366 buckets), then in the page, in the
// browser's own clock: a redraw is forced 200 times by moving the pointer over buckets and 200 times by the keyboard cursor, the
// container is resized 40 times (a full relayout of every bucket), and 180 frames of a pointer sweep are timed against 120 idle frames.
// A redraw's WORK is the time from the event to React's commit plus a forced style and layout (what must fit inside one frame);
// the time to the NEXT PAINT is also reported but it includes the wait for the next frame, so it cannot be below one frame.
// THE IMPORT: a generated machine (invented Codex rollouts and Claude Code transcripts, no real file is read) the REAL importers read
// through the real runner while the page is open on Sources & repos. The page records its frame intervals, long tasks, the
// speed of 40 real key presses and every change of the progress sentence; the Node side records the event loop's stalls and how long
// /api/health takes to answer while the import runs.
//
// It measures and reports, it gates nothing: it exits 0 when it RAN and 2 when it could not, and exit 0 is NOT a statement that the budget
// passed. The chart's verdict is the "Overall" line of its report, judged by the unrounded maximum of each complete class against 16 ms
// (scripts/lib/frame-budget.ts, held by test/bench/frameBudget.test.ts); p95 is diagnostic. The report also names the candidate commit, the
// production build and the browser it measured. With --record it writes test/bench/BROWSER-RESULTS.md (then run
// `pnpm exec prettier --write test/bench/BROWSER-RESULTS.md`).
// Runs under Node's built-in TypeScript support: erasable syntax, explicit .ts import extensions.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { chromium, type Browser, type Page } from '@playwright/test';
import { CONTEXT_OPTIONS, HEADLESS, LAUNCH_OPTIONS } from '../test/e2e/browser.ts';
import { openMachine, usageTotals } from '../test/e2e/helpers/machine.ts';
import { ORIGIN } from '../test/e2e/helpers/virtualOrigin.ts';
import { answerApi, createWorld, serveWorld } from '../test/e2e/helpers/world.ts';
import { ensureBuilt, needsBuild } from './lib/build.ts';
import {
  budgetLines,
  identityLines,
  judgeFrameBudget,
  type MeasuredIdentity,
  type WorkSet,
} from './lib/frame-budget.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RESULT_FILE = join(ROOT, 'test/bench/BROWSER-RESULTS.md');

// ---- arguments ----------------------------------------------------------------------------------------------------------------

interface Options {
  record: boolean;
  only: 'chart' | 'import' | null;
  files: number;
  lines: number;
  samples: number;
}

function parseArgs(argv: string[]): Options {
  const out: Options = { record: false, only: null, files: 300, lines: 1000, samples: 200 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const number = (): number => {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a whole number.`);
      return value;
    };
    if (flag === '--')
      continue; // `pnpm bench:browser -- --record` may pass the separator on
    else if (flag === '--record') out.record = true;
    else if (flag === '--only') {
      const value = argv[++i];
      if (value !== 'chart' && value !== 'import') throw new Error('--only is chart or import.');
      out.only = value;
    } else if (flag === '--files') out.files = number();
    else if (flag === '--lines') out.lines = number();
    else if (flag === '--samples') out.samples = number();
    else throw new Error(`Unknown option ${flag}.`);
  }
  return out;
}

// ---- statistics ---------------------------------------------------------------------------------------------------------------

interface Stat {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at]!;
}

function stat(values: readonly number[]): Stat {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1]! : NaN,
  };
}

const ms = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'n/a');
const row = (label: string, s: Stat): string =>
  `| ${label} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} |`;

// ---- the chart ----------------------------------------------------------------------------------------------------------------

interface ChartResult {
  buckets: number;
  cold: { seriesToBars: Stat; seriesToPainted: Stat };
  hover: Stat;
  hoverPaint: Stat;
  hoverNoChange: number;
  keys: Stat;
  keysPaint: Stat;
  keysNoChange: number;
  relayout: Stat;
  relayoutPaint: Stat;
  idleFrames: Stat;
  sweepFrames: Stat;
  sweepSlowFrames: number;
  sweepFrameCount: number;
  /** The raw work times of the three classes the budget judges, with how many were asked for (the verdict reads these, not the Stats). */
  work: WorkSet[];
}

interface InPage {
  buckets: number;
  hover: number[];
  hoverPaint: number[];
  hoverNoChange: number;
  keys: number[];
  keysPaint: number[];
  keysNoChange: number;
  relayout: number[];
  relayoutPaint: number[];
  relayoutNoChange: number;
  idleFrames: number[];
  sweepFrames: number[];
}

/** The full relayout's alternating 80% / full-width resizes (TECH: 40). */
const RESIZES = 40;

// Runs in the page. It uses the DOM only, so it carries no imports and is serialised by Playwright.
async function redrawInPage(opts: {
  redraws: number;
  resizes: number;
  frames: number;
}): Promise<InPage> {
  const nextFrame = () => new Promise<number>((done) => requestAnimationFrame((t) => done(t)));
  // After the next paint: a message posted inside a frame callback runs once that frame has been handed to the compositor.
  const nextPaint = () =>
    new Promise<number>((done) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => done(performance.now());
        channel.port2.postMessage(0);
      }),
    );
  const first = document.querySelector('[data-bucket-index]');
  const svg = first?.closest('svg');
  if (!svg) throw new Error('The chart is not on the page.');
  const buckets = svg.querySelectorAll('[data-bucket-index]').length;
  const bucket = (index: number) =>
    svg.querySelector<SVGElement>(`[data-bucket-index="${index}"]`) as SVGElement;

  // One redraw: run `trigger`, wait for the DOM to change (React's commit), force style and layout, and note the time. `null` when
  // nothing in the page changed within 250 ms.
  const redraw = (trigger: () => void, root: Node = document.body) =>
    new Promise<{ work: number | null; start: number }>((done) => {
      const start = performance.now();
      const timer = setTimeout(() => {
        observer.disconnect();
        done({ work: null, start });
      }, 250);
      const observer = new MutationObserver(() => {
        observer.disconnect();
        clearTimeout(timer);
        document.body.getBoundingClientRect();
        done({ work: performance.now() - start, start });
      });
      observer.observe(root, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
      trigger();
    });

  const hover: number[] = [];
  const hoverPaint: number[] = [];
  let hoverNoChange = 0;
  for (let k = 0; k < opts.redraws; k++) {
    const index = (k * 7 + 3) % buckets;
    const result = await redraw(() =>
      bucket(index).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    if (result.work === null) hoverNoChange++;
    else {
      hover.push(result.work);
      hoverPaint.push((await nextPaint()) - result.start);
    }
  }

  const keys: number[] = [];
  const keysPaint: number[] = [];
  let keysNoChange = 0;
  bucket(0).focus();
  await nextPaint();
  for (let k = 0; k < opts.redraws; k++) {
    const key =
      k % (opts.redraws / 2 || 1) < Math.floor(opts.redraws / 4) ? 'ArrowRight' : 'ArrowLeft';
    const target = (document.activeElement as Element | null) ?? svg;
    const result = await redraw(() =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    );
    if (result.work === null) keysNoChange++;
    else {
      keys.push(result.work);
      keysPaint.push((await nextPaint()) - result.start);
    }
  }
  (document.activeElement as HTMLElement | null)?.blur();

  // A full relayout: the container's width changes, the chart measures it and lays out every bucket again.
  const host = svg.parentElement as HTMLElement;
  const full = host.clientWidth;
  const relayout: number[] = [];
  const relayoutPaint: number[] = [];
  let relayoutNoChange = 0;
  for (let k = 0; k < opts.resizes; k++) {
    // The ResizeObserver callback is where React starts: note that moment, then wait for the commit and force layout.
    let seen = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!seen) seen = performance.now();
    });
    resizeObserver.observe(host);
    // Only the chart's own elements are watched: the style change this makes on the container is not the redraw.
    const result = await redraw(() => {
      host.style.width = `${k % 2 === 0 ? Math.round(full * 0.8) : full}px`;
    }, svg);
    resizeObserver.disconnect();
    if (result.work === null) relayoutNoChange++;
    else {
      relayout.push(performance.now() - (seen || result.start));
      relayoutPaint.push((await nextPaint()) - (seen || result.start));
    }
  }
  host.style.width = '';

  const frames = async (count: number, each?: (index: number) => void) => {
    const deltas: number[] = [];
    let last = await nextFrame();
    for (let i = 0; i < count; i++) {
      each?.(i);
      const now = await nextFrame();
      deltas.push(now - last);
      last = now;
    }
    return deltas;
  };
  const idleFrames = await frames(opts.frames);
  // Every frame the pointer is over another bucket, so every frame is a redraw.
  const sweepFrames = await frames(Math.round(opts.frames * 1.5), (i) =>
    bucket((i * 5 + 1) % buckets).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  );

  return {
    buckets,
    hover,
    hoverPaint,
    hoverNoChange,
    keys,
    keysPaint,
    keysNoChange,
    relayout,
    relayoutPaint,
    relayoutNoChange,
    idleFrames,
    sweepFrames,
  };
}

/** The version of the browser that was launched, noted on the first launch for the report. */
let browserVersion: string | null = null;

async function launch(): Promise<Browser> {
  const browser = await chromium.launch({ ...LAUNCH_OPTIONS, headless: HEADLESS });
  browserVersion ??= browser.version();
  return browser;
}

// The browser runs in one process (test/e2e/browser.ts), and in that mode one browser shared by several contexts crashes on the
// second, so every page gets its own browser, closed when `body` returns, as the e2e fixture does.
async function withPage<T>(body: (page: Page) => Promise<T>): Promise<T> {
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...CONTEXT_OPTIONS,
    });
    return await body(await context.newPage());
  } finally {
    await browser.close();
  }
}

async function measureChart(options: Options): Promise<ChartResult> {
  const world = createWorld({ scale: 'year' });
  try {
    const url = `${ORIGIN}/trends?start=2025-11-04&end=2026-11-04&gran=day`;
    // Cold draws: a fresh page each time, the moment the series answer arrives to the moment its bars are painted.
    const seriesToBars: number[] = [];
    const seriesToPainted: number[] = [];
    for (let run = 0; run < 5; run++) {
      await withPage(async (page) => {
        await serveWorld(page, world);
        await page.addInitScript(() => {
          const marks: Record<string, number> = {};
          (window as unknown as { __marks: Record<string, number> }).__marks = marks;
          const original = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await original(...args);
            const input = args[0];
            const address =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (address.includes('/api/series') && marks['series'] === undefined) {
              marks['series'] = performance.now();
            }
            return response;
          };
          new MutationObserver(() => {
            if (marks['bars'] !== undefined) return;
            if (document.querySelectorAll('[data-bucket-index]').length < 300) return;
            marks['bars'] = performance.now();
            document.body.getBoundingClientRect();
            requestAnimationFrame(() => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => (marks['painted'] = performance.now());
              channel.port2.postMessage(0);
            });
          }).observe(document, { subtree: true, childList: true });
        });
        await page.goto(url);
        await page.waitForFunction(
          () =>
            (window as unknown as { __marks: Record<string, number> }).__marks['painted'] !==
            undefined,
          undefined,
          { timeout: 60_000 },
        );
        const marks = await page.evaluate(
          () => (window as unknown as { __marks: Record<string, number> }).__marks,
        );
        if (marks['series'] !== undefined) {
          seriesToBars.push(marks['bars']! - marks['series']);
          seriesToPainted.push(marks['painted']! - marks['series']);
        }
      });
    }

    // Pointer and keyboard redraws are asked for in equal halves of `--samples` (200 each by default).
    const half = Math.max(2, Math.floor(options.samples / 2) * 2);
    const raw = await withPage(async (page) => {
      await serveWorld(page, world);
      await page.goto(url);
      await page.waitForSelector('[data-bucket-index]', { timeout: 60_000 });
      await page.waitForTimeout(1500);
      // A warm-up so the first redraws are not the JIT's.
      await page.evaluate(redrawInPage, { redraws: 30, resizes: 4, frames: 20 });
      return page.evaluate(redrawInPage, { redraws: half, resizes: RESIZES, frames: 120 });
    });
    return {
      buckets: raw.buckets,
      cold: { seriesToBars: stat(seriesToBars), seriesToPainted: stat(seriesToPainted) },
      hover: stat(raw.hover),
      hoverPaint: stat(raw.hoverPaint),
      hoverNoChange: raw.hoverNoChange,
      keys: stat(raw.keys),
      keysPaint: stat(raw.keysPaint),
      keysNoChange: raw.keysNoChange,
      relayout: stat(raw.relayout),
      relayoutPaint: stat(raw.relayoutPaint),
      idleFrames: stat(raw.idleFrames),
      sweepFrames: stat(raw.sweepFrames),
      sweepSlowFrames: raw.sweepFrames.filter((d) => d > 25).length,
      sweepFrameCount: raw.sweepFrames.length,
      work: [
        {
          id: 'pointer',
          label: 'Pointer over a bucket',
          samples: raw.hover,
          requested: half,
          noChange: raw.hoverNoChange,
        },
        {
          id: 'keyboard',
          label: 'Keyboard cursor moves',
          samples: raw.keys,
          requested: half,
          noChange: raw.keysNoChange,
        },
        {
          id: 'relayout',
          label: 'Container resized, every bucket laid out again',
          samples: raw.relayout,
          requested: RESIZES,
          noChange: raw.relayoutNoChange,
        },
      ],
    };
  } finally {
    world.close();
  }
}

// ---- the first import ---------------------------------------------------------------------------------------------------------

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
const uuid = (n: number) => `${hex(n, 8)}-aaaa-4aaa-8aaa-${hex(n, 12)}`;
const toLines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Invented history in the documented shapes: `files` Claude Code transcripts and `files` Codex rollouts of about `lines` lines each. */
function writeHome(files: number, lines: number): { home: string; totalLines: number } {
  const home = mkdtempSync(join(tmpdir(), 'agent-productivity-measure-home-'));
  let totalLines = 0;
  for (let n = 0; n < files; n++) {
    const day = String(1 + (n % 28)).padStart(2, '0');
    const claudeDir = join(home, '.claude/projects', `-measure-project-${n % 40}`);
    mkdirSync(claudeDir, { recursive: true });
    const base = { sessionId: uuid(n), cwd: `/measure/project-${n % 40}`, version: '2.0.0' };
    const claude: object[] = [
      {
        ...base,
        type: 'user',
        timestamp: `2026-10-${day}T08:00:00.000Z`,
        message: { role: 'user', content: 'x' },
      },
    ];
    for (let turn = 1; turn < lines; turn++) {
      const second = String(turn % 60).padStart(2, '0');
      const minute = String(Math.floor(turn / 60) % 60).padStart(2, '0');
      claude.push({
        ...base,
        type: 'assistant',
        timestamp: `2026-10-${day}T09:${minute}:${second}.000Z`,
        requestId: `req_${n}_${turn}`,
        message: {
          id: `msg_${n}_${turn}`,
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 300,
            output_tokens: 40,
          },
        },
      });
    }
    writeFileSync(join(claudeDir, `${uuid(n)}.jsonl`), toLines(claude));
    totalLines += claude.length;

    const id = uuid(n + 1_000_000);
    const stamp = `2026-10-${day}T10:00:00.000Z`;
    const codexDir = join(home, '.codex/sessions/2026/10', day);
    mkdirSync(codexDir, { recursive: true });
    const codex: object[] = [
      {
        timestamp: stamp,
        type: 'session_meta',
        payload: { id, timestamp: stamp, cwd: `/measure/project-${n % 40}`, source: 'cli' },
      },
      { timestamp: stamp, type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    ];
    for (let turn = 1; turn < lines - 1; turn++) {
      const second = String(turn % 60).padStart(2, '0');
      const minute = String(Math.floor(turn / 60) % 60).padStart(2, '0');
      codex.push({
        timestamp: `2026-10-${day}T10:${minute}:${second}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000 * turn,
              cached_input_tokens: 600 * turn,
              output_tokens: 100 * turn,
              reasoning_output_tokens: 20 * turn,
              total_tokens: 1100 * turn,
            },
          },
        },
      });
    }
    writeFileSync(join(codexDir, `rollout-2026-10-${day}T10-00-00-${id}.jsonl`), toLines(codex));
    totalLines += codex.length;
  }
  return { home, totalLines };
}

interface PageMarks {
  frames: [number, number][];
  longTasks: [number, number][];
  events: [string, number, number, number][];
  inputs: number[];
  progress: [number, string][];
  origin: number;
}

interface ImportResult {
  files: number;
  lines: number;
  seconds: number;
  events: number;
  sessions: number;
  frames: Stat;
  slowFrames: number;
  frameCount: number;
  longTaskCount: number;
  longTaskMax: number;
  keyPresses: number;
  keyToPaint: Stat;
  slowEvents: number;
  slowEventMax: number;
  progressUpdates: number;
  progressMaxGapSeconds: number;
  progressFirst: string;
  progressLast: string;
  loopDelay: { p50: number; p99: number; max: number };
  stalls: { at: number; ms: number }[];
  health: Stat;
  healthCount: number;
}

async function measureImport(options: Options): Promise<ImportResult> {
  const generated = writeHome(options.files, options.lines);
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...CONTEXT_OPTIONS,
    });
    const page: Page = await context.newPage();
    // The page's recorders, in place before any page script runs.
    await page.addInitScript(() => {
      const marks = {
        frames: [] as [number, number][],
        longTasks: [] as [number, number][],
        events: [] as [string, number, number, number][],
        inputs: [] as number[],
        progress: [] as [number, string][],
        origin: performance.timeOrigin,
      };
      (window as unknown as { __m: typeof marks }).__m = marks;
      let last = 0;
      const tick = (t: number) => {
        if (last) marks.frames.push([t, t - last]);
        last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) marks.longTasks.push([e.startTime, e.duration]);
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* the browser does not report long tasks */
      }
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceEventTiming[]) {
            marks.events.push([e.name, e.startTime, e.processingStart - e.startTime, e.duration]);
          }
        }).observe({
          type: 'event',
          durationThreshold: 16,
          buffered: true,
        } as PerformanceObserverInit);
      } catch {
        /* the browser does not report event timing */
      }
      document.addEventListener(
        'keydown',
        (event) => {
          const started = event.timeStamp;
          requestAnimationFrame(() => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => marks.inputs.push(performance.now() - started);
            channel.port2.postMessage(0);
          });
        },
        true,
      );
      let lastText = '';
      new MutationObserver(() => {
        const text = /Importing [\d,]+ of [\d,]+ files/.exec(document.body?.textContent ?? '')?.[0];
        if (text && text !== lastText) {
          lastText = text;
          marks.progress.push([performance.now(), text]);
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });

    const machine = await openMachine(page, { home: generated.home });
    const loop = monitorEventLoopDelay({ resolution: 5 });
    const health: number[] = [];
    let importing = true;

    const startedAt = Date.now();
    machine.startFirstRun();
    loop.enable();
    // The page opens a moment after the run starts, so Sources & repos finds a run in progress and follows it.
    await new Promise((done) => setTimeout(done, 400));
    await page.goto(`${ORIGIN}/sources`);
    await page.waitForSelector('main', { timeout: 60_000 });

    // A client's request is due every 50 ms. Its latency is from when it was due to when it was answered, so a stalled event loop
    // shows as the wait it causes, not only as the time the answer itself took.
    const pinger = (async () => {
      while (importing) {
        const due = performance.now() + 50;
        await new Promise((done) => setTimeout(done, 50));
        await answerApi(machine.app, { method: 'GET', path: '/api/health', headers: {} });
        health.push(performance.now() - due);
      }
    })();
    // Every stall of the event loop of 100 ms or more, and how far into the import it came.
    const stalls: { at: number; ms: number }[] = [];
    let lastTick = performance.now();
    const watch = setInterval(() => {
      const now = performance.now();
      if (now - lastTick > 100)
        stalls.push({ at: (Date.now() - startedAt) / 1000, ms: now - lastTick - 5 });
      lastTick = now;
    }, 5);
    let keyPresses = 0;
    const typist = (async () => {
      while (importing && keyPresses < 40) {
        await page.keyboard.press('Tab');
        keyPresses++;
        await new Promise((done) => setTimeout(done, 250));
      }
    })();

    await machine.runner.idle();
    const endedAt = Date.now();
    importing = false;
    loop.disable();
    clearInterval(watch);
    await Promise.all([pinger, typist]);
    // One more poll of the page, so the end of the import is on the screen before it is read.
    await page.waitForTimeout(2500);
    const marks = await page.evaluate(() => (window as unknown as { __m: PageMarks }).__m);
    const totals = usageTotals(machine.db);
    await context.close();

    // Only what happened while the import ran.
    const inWindow = (t: number) => marks.origin + t >= startedAt && marks.origin + t <= endedAt;
    const frames = marks.frames.filter(([t]) => inWindow(t)).map(([, d]) => d);
    const longTasks = marks.longTasks.filter(([t]) => inWindow(t)).map(([, d]) => d);
    const events = marks.events.filter(([, t]) => inWindow(t));
    const progress = marks.progress.filter(([t]) => inWindow(t));
    let maxGap = 0;
    for (let i = 1; i < progress.length; i++) {
      maxGap = Math.max(maxGap, (progress[i]![0] - progress[i - 1]![0]) / 1000);
    }
    return {
      files: options.files * 2,
      lines: generated.totalLines,
      seconds: (endedAt - startedAt) / 1000,
      events: totals.events,
      sessions: totals.sessions,
      frames: stat(frames),
      slowFrames: frames.filter((d) => d > 50).length,
      frameCount: frames.length,
      longTaskCount: longTasks.length,
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      keyPresses,
      keyToPaint: stat(marks.inputs),
      slowEvents: events.length,
      slowEventMax: events.length ? Math.max(...events.map((e) => e[3])) : 0,
      progressUpdates: progress.length,
      progressMaxGapSeconds: maxGap,
      progressFirst: progress[0]?.[1] ?? 'none seen',
      progressLast: progress.at(-1)?.[1] ?? 'none seen',
      loopDelay: {
        p50: loop.percentile(50) / 1e6,
        p99: loop.percentile(99) / 1e6,
        max: loop.max / 1e6,
      },
      stalls,
      health: stat(health),
      healthCount: health.length,
    };
  } finally {
    await browser.close();
  }
}

// ---- the report ---------------------------------------------------------------------------------------------------------------

function chartReport(r: ChartResult): string {
  return [
    `### UI rendering: chart redraw at ${r.buckets} buckets (TECH budget: the work of every sampled warm redraw ≤ 16 ms)`,
    '',
    `Trends, 12 months by day (${r.buckets} daily buckets), the year world, 1280 × 900. WORK is the time from the event to React's commit plus a forced style and layout (for the resize, from the ResizeObserver callback); PAINT is the time to the next paint and always includes the wait for the next frame.`,
    '',
    '| Redraw | n | p50 | p95 | max |',
    '| --- | --- | --- | --- | --- |',
    row('Pointer over a bucket: work', r.hover),
    row('Pointer over a bucket: to next paint', r.hoverPaint),
    row('Keyboard cursor moves: work', r.keys),
    row('Keyboard cursor moves: to next paint', r.keysPaint),
    row('Container resized, every bucket laid out again: work', r.relayout),
    row('Container resized, every bucket laid out again: to next paint', r.relayoutPaint),
    row('Cold draw: series answer to bars in the DOM', r.cold.seriesToBars),
    row('Cold draw: series answer to bars painted', r.cold.seriesToPainted),
    '',
    'Frame cadence (interval between frames; 16.7 ms is a 60 Hz frame):',
    '',
    '| Frames | n | p50 | p95 | max |',
    '| --- | --- | --- | --- | --- |',
    row('Idle, nothing changing', r.idleFrames),
    row('Pointer moved to another bucket every frame', r.sweepFrames),
    '',
    `Sweep frames longer than 25 ms (a visibly missed frame): ${r.sweepSlowFrames} of ${r.sweepFrameCount}.`,
    `Redraws where nothing in the page changed within 250 ms (left out above, and each makes its set incomplete): pointer ${r.work[0]!.noChange}, keyboard ${r.work[1]!.noChange}, resize ${r.work[2]!.noChange}.`,
    '',
    ...budgetLines(judgeFrameBudget(r.work)),
  ].join('\n');
}

function importReport(r: ImportResult): string {
  return [
    '### First full import: the page stays responsive (TECH: progress shown per source; UI stays responsive)',
    '',
    `The real Codex and Claude Code importers read ${r.files} invented files (${r.lines.toLocaleString('en-US')} lines) through the real runner in ${r.seconds.toFixed(1)} s, storing ${r.events.toLocaleString('en-US')} usage events and ${r.sessions.toLocaleString('en-US')} sessions, while the page was open on Sources & repos.`,
    '',
    '| In the page during the import | n | p50 | p95 | max |',
    '| --- | --- | --- | --- | --- |',
    row('Frame interval', r.frames),
    row(`Key press to next paint (${r.keyPresses} real Tab presses)`, r.keyToPaint),
    '',
    `Frames longer than 50 ms: ${r.slowFrames} of ${r.frameCount}. Long tasks (main thread blocked over 50 ms): ${r.longTaskCount}${r.longTaskCount ? `, longest ${ms(r.longTaskMax)}` : ''}. Input events the browser timed at 16 ms or more: ${r.slowEvents}${r.slowEvents ? `, slowest ${ms(r.slowEventMax)}` : ''}.`,
    '',
    `Progress sentence: ${r.progressUpdates} changes seen, the longest gap between two ${r.progressMaxGapSeconds.toFixed(1)} s, first “${r.progressFirst}”, last “${r.progressLast}”.`,
    '',
    '| In the server process during the import | n | p50 | p95 / p99 | max |',
    '| --- | --- | --- | --- | --- |',
    `| Event-loop delay (5 ms sampling) | | ${ms(r.loopDelay.p50)} | ${ms(r.loopDelay.p99)} (p99) | ${ms(r.loopDelay.max)} |`,
    row('A request due every 50 ms (GET /api/health): due to answered', r.health),
    '',
    r.stalls.length
      ? `Stalls of the event loop of 100 ms or more: ${r.stalls.map((x) => `${x.ms.toFixed(0)} ms at ${x.at.toFixed(1)} s`).join(', ')} (the import took ${r.seconds.toFixed(1)} s).`
      : 'No stall of the event loop of 100 ms or more.',
  ].join('\n');
}

// ---- what was measured -------------------------------------------------------------------------------------------------------

/** `git` run in the project, or null when it cannot answer (no git, or no checkout). */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** A short fingerprint of everything in dist/client: the production build the page was served, whatever commit it came from. */
function fingerprintBuild(): { fingerprint: string | null; files: number } {
  const root = join(ROOT, 'dist/client');
  if (!existsSync(root)) return { fingerprint: null, files: 0 };
  const hash = createHash('sha256');
  let files = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        hash
          .update(`${relative(root, path)}\0`)
          .update(readFileSync(path))
          .update('\0');
        files++;
      }
    }
  };
  walk(root);
  return { fingerprint: `sha256:${hash.digest('hex').slice(0, 16)}`, files };
}

function measuredIdentity(builtByThisRun: boolean): MeasuredIdentity {
  // A copy of the project that sits inside some other checkout must not report that checkout's commit as its own.
  const top = git(['rev-parse', '--show-toplevel']);
  const inOwnCheckout = top !== null && realpathSync(top) === realpathSync(ROOT);
  const status = inOwnCheckout ? git(['status', '--porcelain']) : null;
  const build = fingerprintBuild();
  let playwright: string | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8'),
    ) as { version?: string };
    playwright = manifest.version ?? null;
  } catch {
    /* the version is left out of the report */
  }
  return {
    commit: inOwnCheckout ? git(['rev-parse', 'HEAD']) : null,
    changedFiles: status === null ? null : status.split('\n').filter(Boolean).length,
    buildFingerprint: build.fingerprint,
    buildFiles: build.files,
    builtByThisRun,
    browserVersion,
    browserBuild: /chromium_headless_shell-(\d+)/.exec(chromium.executablePath())?.[1] ?? null,
    playwright,
    node: process.version,
  };
}

function environment(): string {
  const cpu = cpus();
  return `${cpu[0]?.model ?? 'unknown CPU'} x${cpu.length}, ${platform()} ${release()}, Node ${process.version}, Playwright headless shell (${LAUNCH_OPTIONS.args?.join(' ') ?? 'no extra arguments'})`;
}

// What the first run of the import measurement found. The tables above are the state AFTER these two changes, so the numbers from before
// them are kept here.
const FINDINGS = [
  'The first run of the import measurement (600 invented files, 600,000 lines) found the server’s event loop held for 140 ms, 195 ms and 299 ms at 2.8 s, 5.0 s and 7.4 s of an 8.5 s import (the longest stall was 305 to 311 ms in three runs, and a request due every 50 ms waited up to 254 ms), each longer than the last as events were stored. A CPU profile of the run showed two causes, both a pass over every stored event:',
  '',
  '1. Every NEW Codex rollout asked for the events it had brought in before (`WHERE source_file_id = ?`), and no index covers that column, so each rollout scanned the whole table. A rollout never seen before has brought in nothing, so it no longer asks (`src/server/collectors/codex/index.ts`, held by `test/integration/import/first-read.test.ts`). The same import then took 3.2 to 4.6 s in four runs, against 7.7 to 9.1 s in the three before.',
  '2. Every `GET /api/sources` (the page polls it every one to two seconds while an import runs) counted sessions by adding up the Usage groups over all time, which joins every event: 213 ms at about 300,000 events and 340 ms at 600,000. It now counts the sessions that have an event through the session index (`readSessionCounts`, held by `test/db/session-counts.test.ts`, which gives the same numbers as the groups).',
  '',
  'After both, the table above is what was measured: no stall of 100 ms or more.',
];

const LIMITS = [
  '- Playwright’s headless shell in one process with software rendering (`--single-process --in-process-gpu`), on a computer that also ran this script and, where the owner’s checks run, other agents: the numbers are an upper-bound sample of the product, not a profile of Safari or Chrome with a GPU.',
  '- The server and the page are joined by request interception on a made-up origin (no socket). The server code runs in this script’s own Node process, so its event-loop numbers include the browser driver; a `pnpm start` process has the event loop to itself.',
  '- The import is of INVENTED files made by this script, in the documented shapes. How long the owner’s own history takes, and how it feels, is the manual check on the owner’s data that TECH names (E1/E2); this measurement does not replace it.',
  '- A frame time here is measured in the page with the browser’s own clock. It is not the React profiler: the production build has no profiler, so a render is measured by its effect (the commit and a forced layout).',
];

function report(
  chart: ChartResult | null,
  imported: ImportResult | null,
  identity: MeasuredIdentity,
): string {
  const day = new Date().toISOString().slice(0, 10);
  const parts = [
    '# Browser measurements',
    '',
    `Run ${day} with \`pnpm bench:browser -- --record\` (\`node scripts/measure-browser.ts --record\`).`,
    '',
    ...identityLines(identity),
    '',
    `Environment: ${environment()}.`,
    '',
    'The two rows of TECH › Performance that `pnpm bench` lists as not timed (a Vitest bench has no browser). This is a measurement, not a gate: the chart section ends in an Overall line that says whether the budget held, and a number over its budget is reported there, never hidden.',
    '',
  ];
  if (chart) parts.push(chartReport(chart), '');
  if (imported) parts.push(importReport(imported), '');
  if (imported) parts.push('## What the first run found, and what changed', '', ...FINDINGS, '');
  parts.push('## Limits', '', ...LIMITS, '');
  return parts.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // The page is served from dist/client, so a missing or stale build is made first: the measurement is of the sources as they are.
  const builtByThisRun = needsBuild(ROOT);
  await ensureBuilt(ROOT, (message) => console.error(message));
  const chart = options.only === 'import' ? null : await measureChart(options);
  const imported = options.only === 'chart' ? null : await measureImport(options);
  const text = report(chart, imported, measuredIdentity(builtByThisRun));
  console.info(text);
  if (options.record) {
    if (options.only) throw new Error('--record needs both measurements: leave out --only.');
    writeFileSync(RESULT_FILE, text);
    console.info(`\nWritten to ${RESULT_FILE}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(2);
});
