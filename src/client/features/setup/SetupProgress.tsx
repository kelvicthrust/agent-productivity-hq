import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { SETUP_COPY } from './copy';

// The Setup indicator: D7's three pills (docs/design/prototype/app.js › pageSetup emits `<ol class="stepper">`; app.css › setup draws it), and
// not the Astryx Stepper's connected progress track (TECH design-to-code › Setup indicator reconciliation, which supersedes the old
// component-map choice). The pills sit in one wrapping row at every width: on a phone the third drops under the first two where the row runs
// out, with no vertical orientation and no rail between them.
//
// It is informational: an ordered list, not buttons or tabs, so it adds no keyboard stop, and it owns no query, mutation or state. It is
// positional: a step before the current one was PASSED (Continue or Skip), which does not mean a source was found, an account connected or a
// repository added. Exactly one item carries aria-current="step"; a passed one says "(done)" to assistive technology and shows a check.

/** Which step is showing: 0 Local sources, 1 Accounts, 2 Repositories. The route's own `step`, so the body, the app bar and this agree. */
export function SetupProgress({ activeStep }: { activeStep: number }) {
  return (
    <ol aria-label={SETUP_COPY.progress} className="flex flex-wrap gap-2">
      {SETUP_COPY.steps.map((label, index) => {
        const done = index < activeStep;
        const current = index === activeStep;
        return (
          <li
            key={label}
            aria-current={current ? 'step' : undefined}
            className={cx(
              'flex items-center gap-2 rounded-pill py-[6px] pr-3 pl-[6px] text-label',
              current ? 'bg-selection-surface font-semibold text-ink' : 'bg-sunken text-ink-muted',
            )}
          >
            {/* The marker only repeats what the words say, so it is hidden from assistive technology; the check is not colour alone. */}
            <span
              aria-hidden="true"
              className={cx(
                'inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border text-caption font-bold',
                current && 'border-action bg-action text-on-action',
                done && 'border-success bg-success-surface text-success',
                !current && !done && 'border-control-border bg-surface text-ink',
              )}
            >
              {done ? <Icon name="check" size={12} /> : index + 1}
            </span>
            {label}
            {done && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}
