import { Button } from '@astryxdesign/core/Button';
import { useId, useState } from 'react';
import { formatDayLong } from '../../../shared/domain/periods';
import {
  checkCustomRange,
  type FilterContext,
  type Filters,
  type Period,
  type PeriodPreset,
} from '../../lib/filters';
import { COPY, lookbackHint, QUICK_RANGES, rangeProblem } from './copy';
import { FilterIcon } from './icons';

// Quick ranges plus hand-typed dates. The inputs are native date inputs: the phone gets the system picker, a keyboard
// user can type, and the inputs are 16px below 720px so iOS does not zoom the page on focus (design-to-code).
const DATE_INPUT =
  'h-11 min-w-0 rounded-sm border border-control-border bg-surface px-3 text-[16px] text-ink min-[720px]:h-[var(--control-h)] min-[720px]:text-copy aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

interface Props {
  ctx: FilterContext;
  filters: Filters;
  period: Period;
  onPreset: (preset: PeriodPreset) => void;
  onApply: (range: { start: string; end: string }) => void;
  onCancel: () => void;
}

export function CustomRangePanel({ ctx, filters, period, onPreset, onApply, onCancel }: Props) {
  const ids = useId();
  // Starts from what is showing; a week or month that runs past today is capped at today, the latest a custom date can be.
  const [draft, setDraft] = useState({
    start: filters.start,
    end: filters.end < ctx.today ? filters.end : ctx.today,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const earliest = formatDayLong(ctx.lookbackStart);

  function apply() {
    const check = checkCustomRange(draft.start, draft.end, ctx);
    if (check.ok) {
      onApply(draft);
    } else {
      setProblem(
        check.reason === 'outside' ? rangeProblem.outside(earliest) : rangeProblem[check.reason],
      );
    }
  }

  const field = (key: 'start' | 'end', label: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${ids}-${key}`} className="text-label font-semibold">
        {label}
      </label>
      <input
        id={`${ids}-${key}`}
        type="date"
        className={DATE_INPUT}
        min={ctx.lookbackStart}
        max={ctx.today}
        value={draft[key]}
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? `${ids}-problem` : undefined}
        onChange={(event) => {
          setDraft({ ...draft, [key]: event.target.value });
          setProblem(null);
        }}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-label font-semibold">{COPY.quickRanges}</h2>
      <div className="flex flex-wrap gap-2">
        {QUICK_RANGES.map(({ preset, label }) => (
          <Button
            key={preset}
            label={label}
            size="sm"
            variant="secondary"
            aria-pressed={period === preset}
            className="aria-pressed:bg-selection-surface aria-pressed:font-semibold max-[719px]:min-h-11"
            onClick={() => onPreset(preset)}
          />
        ))}
      </div>
      <h2 className="text-label font-semibold">{COPY.customDates}</h2>
      <div className="flex flex-wrap items-start gap-2">
        {field('start', COPY.from)}
        {field('end', COPY.to)}
      </div>
      {problem !== null && (
        <p
          id={`${ids}-problem`}
          role="alert"
          className="flex items-start gap-1.5 text-caption text-danger"
        >
          <FilterIcon name="error" className="mt-px flex-none" />
          <span>{problem}</span>
        </p>
      )}
      <p className="text-caption text-ink-muted">{lookbackHint(earliest)}</p>
      <div className="flex justify-end gap-2">
        <Button
          label={COPY.cancel}
          size="sm"
          variant="secondary"
          className="max-[719px]:min-h-11"
          onClick={onCancel}
        />
        <Button
          label={COPY.apply}
          size="sm"
          variant="primary"
          className="max-[719px]:min-h-11"
          onClick={apply}
        />
      </div>
    </div>
  );
}
