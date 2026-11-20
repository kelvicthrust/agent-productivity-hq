import { cx } from '../lib/cx';

// A 12-week trend beside a figure (Cozy Logbook, Refined). It is a hint of shape, not a chart: no axes, no tooltip, its own
// min and max, so two sparklines are never compared by height. A week with no figure is a gap in the line (the line is cut
// there), never a zero; the current week is the one filled dot. The picture is hidden from assistive technology and the
// wrapper says the same numbers in words, oldest to newest.

export type SparklineKind = 'delivery' | 'codex' | 'claude';

const WIDTH = 64;
const HEIGHT = 20;
/** Room for the current week's dot, so it is never cut by the edge of the picture. */
const PAD = 3;

const STROKE: Record<SparklineKind, string> = {
  delivery: 'stroke-series-delivery',
  codex: 'stroke-series-codex',
  claude: 'stroke-series-claude',
};
const FILL: Record<SparklineKind, string> = {
  delivery: 'fill-series-delivery',
  codex: 'fill-series-codex',
  claude: 'fill-series-claude',
};

interface Point {
  index: number;
  x: number;
  y: number;
}

/** The runs of weeks that have a figure, in order; a missing week ends the run. */
function runsOf(points: readonly (Point | null)[]): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (point) {
      run.push(point);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

const round = (n: number): string => String(Math.round(n * 100) / 100);

export function Sparkline({
  values,
  currentIndex,
  kind,
  label,
  format = String,
  className,
}: {
  /** One figure per week, oldest first; null where that week has none. */
  values: readonly (number | null)[];
  /** Which of `values` is the current week. */
  currentIndex: number;
  kind: SparklineKind;
  /** Names the series in the spoken summary ("Codex 12-week trend, …"). Leave out where the tile already names it. */
  label?: string;
  /** How a figure is said in the summary. */
  format?: (value: number) => string;
  className?: string;
}) {
  const real = values.filter((value): value is number => value !== null);
  const low = real.length > 0 ? Math.min(...real) : 0;
  const high = real.length > 0 ? Math.max(...real) : 0;
  const step = values.length > 1 ? (WIDTH - 2 * PAD) / (values.length - 1) : 0;
  const top = PAD;
  const bottom = HEIGHT - PAD;
  const points = values.map<Point | null>((value, index) =>
    value === null
      ? null
      : {
          index,
          x: PAD + index * step,
          // A flat series sits on the middle line; otherwise the highest week is at the top.
          y:
            high === low
              ? (top + bottom) / 2
              : bottom - ((value - low) / (high - low)) * (bottom - top),
        },
  );
  const runs = runsOf(points);
  const said = (value: number | null | undefined) =>
    value === null || value === undefined ? 'no data' : format(value);
  const summary = `${label ? `${label} ` : ''}${values.length}-week trend, oldest to newest: ${values
    .map(said)
    .join(', ')}; this week ${said(values[currentIndex])}`;
  const current = points[currentIndex];

  return (
    <span role="img" aria-label={summary} className={cx('inline-flex', className)}>
      <svg
        aria-hidden="true"
        focusable="false"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block overflow-visible"
      >
        {runs.map((run) =>
          run.length > 1 ? (
            <path
              key={run[0]!.index}
              data-segment=""
              d={run.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ')}
              fill="none"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={STROKE[kind]}
            />
          ) : (
            <circle
              key={run[0]!.index}
              data-lone=""
              cx={round(run[0]!.x)}
              cy={round(run[0]!.y)}
              r={1}
              className={FILL[kind]}
            />
          ),
        )}
        {current && (
          <circle
            data-current=""
            cx={round(current.x)}
            cy={round(current.y)}
            r={2.5}
            className={FILL[kind]}
          />
        )}
      </svg>
    </span>
  );
}
