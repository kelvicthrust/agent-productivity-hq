import { LEDGER_COPY } from '../lib/copy';
import { cx } from '../lib/cx';
import { int } from '../lib/format';

// The provider token ledger on the Usage page (ported from app.js catCard and app.css .cat-table). Each provider keeps its
// own categories and its own total, which is never added to the other provider's. Codex's cached input and reasoning are
// subsets of input and output: they are indented with an elbow and say "included in ...", and the total leaves them out.
// Numbers never wrap; labels may.

type Count = number | null | undefined;

export type TokenLedgerProps =
  | {
      provider: 'codex';
      tokens: {
        input?: Count;
        /** A subset of input. */
        cachedInput?: Count;
        output?: Count;
        /** A subset of output. */
        reasoning?: Count;
        /** input + output. */
        total?: Count;
      };
      /** Appended to the rule under the table, for example "Covers Mar 14, 2026 onward only." */
      note?: string;
    }
  | {
      provider: 'claude';
      tokens: {
        inputUncached?: Count;
        cacheWrite?: Count;
        cacheRead?: Count;
        output?: Count;
        /** The sum of the four. */
        total?: Count;
      };
      note?: string;
    };

interface Row {
  label: string;
  value: Count;
  /** Small note under the label. */
  note?: string;
  /** A subset of the row above it. */
  subset?: boolean;
}

function rowsFor(props: TokenLedgerProps): Row[] {
  if (props.provider === 'codex') {
    const { input, cachedInput, output, reasoning } = props.tokens;
    const c = LEDGER_COPY.codex;
    return [
      { label: c.input, value: input },
      { label: c.cachedInput, value: cachedInput, note: c.cachedInputNote, subset: true },
      { label: c.output, value: output },
      { label: c.reasoning, value: reasoning, note: c.reasoningNote, subset: true },
    ];
  }
  const { inputUncached, cacheWrite, cacheRead, output } = props.tokens;
  const c = LEDGER_COPY.claude;
  return [
    { label: c.inputUncached, value: inputUncached },
    { label: c.cacheWrite, value: cacheWrite },
    { label: c.cacheRead, value: cacheRead },
    { label: c.output, value: output },
  ];
}

// Borders are drawn per cell (the table is not collapsed) so a row's divider can be left off where an elbow or the total's
// stronger rule meets it.
const LABEL = 'w-full py-1.5 align-top';
const VALUE = 'whitespace-nowrap py-1.5 pl-3 text-right align-top tabular-nums';
const ELBOW =
  "relative pl-7 text-ink-muted before:absolute before:left-2.5 before:top-0 before:h-[15px] before:w-2.5 before:rounded-bl-[5px] before:border-b-[1.5px] before:border-l-[1.5px] before:border-border-strong before:content-['']";

export function TokenLedger(props: TokenLedgerProps) {
  const rows = rowsFor(props);
  const rule = LEDGER_COPY[props.provider].rule;
  return (
    <>
      <table className="w-full border-separate border-spacing-0 text-data">
        <caption className="sr-only">{LEDGER_COPY.caption(props.provider)}</caption>
        <tbody>
          {rows.map((row, index) => {
            // No divider under a row that the next row hangs from, or above the total (it has its own rule).
            const divider = index < rows.length - 1 && !rows[index + 1]?.subset;
            const border = divider ? 'border-b border-border' : '';
            return (
              <tr key={row.label} className={row.subset ? 'text-ink-muted' : undefined}>
                <td className={cx(LABEL, border, row.subset && ELBOW)}>
                  <span className="block">{row.label}</span>
                  {row.note && (
                    <span className="block text-caption text-ink-muted">{row.note}</span>
                  )}
                </td>
                <td className={cx(VALUE, border)}>{int(row.value ?? 0)}</td>
              </tr>
            );
          })}
          <tr className="font-bold">
            <td className={cx(LABEL, 'border-t border-border-strong')}>{LEDGER_COPY.total}</td>
            <td className={cx(VALUE, 'border-t border-border-strong')}>
              {int(props.tokens.total ?? 0)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-caption text-ink-muted">
        {rule}
        {props.note ? ` ${props.note}` : ''}
      </p>
    </>
  );
}
