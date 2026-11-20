import { defineExperiment } from '../../../../scripts/experiments/lib/cli.ts';
import { safeText } from '../../../../scripts/experiments/lib/redact.ts';
import { FieldInventory } from '../../../../scripts/experiments/lib/shape.ts';

// A small, well-behaved experiment the lib tests drive. Flags choose what it does, so each guard can be provoked.
export const experiment = defineExperiment({
  meta: {
    id: 'E1',
    script: 'scripts/experiments/e1-support.ts',
    title: 'Support experiment',
    question: 'Does the harness behave?',
    criteria: [
      { id: 'reads-lines', text: 'It reads at least one line.' },
      { id: 'program-ran', text: 'The allowed program answers.' },
      { id: 'host-answered', text: 'The allowed host answers 200.' },
    ],
    reads: ['The folder given with --root'],
    prints: ['Counts and verdicts'],
    writes: ['docs/implementation/experiments/E1.md (the findings)'],
    network: ['api.example.test'],
    spawns: ['fakeprog'],
    selftest: [
      {
        name: 'reads only',
        args: [],
        expect: {
          exit: 0,
          verdicts: { 'reads-lines': 'pass', 'program-ran': 'not-run', 'host-answered': 'not-run' },
        },
      },
    ],
  },
  async run(ctx) {
    const root = ctx.willRead('support folder', ctx.args.get('root') ?? '');
    const inventory = new FieldInventory();
    let lines = 0;
    let unreadable = 0;
    for (const file of ctx.fs.walk(root, { match: /\.jsonl$/ }).files) {
      for (const line of ctx.fs.lines(file)) {
        lines++;
        try {
          inventory.add(JSON.parse(line));
        } catch {
          unreadable++;
        }
      }
    }
    ctx.findings.criterion(
      'reads-lines',
      lines > 0 && !ctx.args.has('fail') ? 'pass' : 'fail',
      safeText`${lines} lines, ${unreadable} unreadable`,
    );
    ctx.findings.fact('Field list', 'fields', inventory.paths());
    ctx.findings.fact('Field list', 'lines', lines);

    if (ctx.args.has('with-program')) {
      const result = await ctx.spawn(
        ctx.args.get('with-program') === 'true' ? 'fakeprog' : ctx.args.get('with-program')!,
        ['--version', ctx.args.get('shell-arg') ?? 'x'],
      );
      ctx.findings.criterion(
        'program-ran',
        result.found && result.status === 0 ? 'pass' : 'not-run',
      );
    }
    if (ctx.args.has('with-net')) {
      const response = await ctx.fetch(
        ctx.args.get('with-net') === 'true'
          ? 'https://api.example.test/ping'
          : ctx.args.get('with-net')!,
      );
      ctx.findings.criterion('host-answered', response.status === 200 ? 'pass' : 'fail');
    }
    if (ctx.args.has('read-elsewhere')) ctx.fs.readText(ctx.args.get('read-elsewhere')!);
  },
});
