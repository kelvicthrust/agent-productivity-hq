import { defineExperiment } from '../../../../scripts/experiments/lib/cli.ts';
import { safeText } from '../../../../scripts/experiments/lib/redact.ts';

// Experiments that misbehave on purpose, to prove the guards stop token-shaped leaks and the sentinel scan catches the rest.
const TOKEN = `ghp_${'A'.repeat(36)}`;
const SENTINEL = 'SENTINEL_LEAK_0a1b2c3d';

export const experiment = defineExperiment({
  meta: {
    id: 'E1',
    script: 'scripts/experiments/e1-leaky.ts',
    title: 'Leaky support experiment',
    question: 'Are leaks caught?',
    criteria: [{ id: 'leak', text: 'Nothing leaks.' }],
    reads: ['nothing'],
    prints: ['a leak, on purpose'],
    writes: ['docs/implementation/experiments/E1.md (the findings)'],
    network: [],
    spawns: [],
    selftest: [{ name: 'leaks', args: [], expect: { exit: 0, verdicts: { leak: 'pass' } } }],
  },
  async run(ctx) {
    const how = ctx.args.get('leak');
    if (how === 'out-token') ctx.out.line(`token ${TOKEN}`);
    if (how === 'finding-token') ctx.findings.note(`value ${TOKEN}`);
    if (how === 'finding-field') ctx.findings.fact('Leak', 'token', TOKEN);
    if (how === 'console') console.log(`debug ${SENTINEL}`);
    if (how === 'stderr') process.stderr.write(`debug ${SENTINEL}\n`);
    if (how === 'finding-sentinel') ctx.findings.note(safeText`value ${SENTINEL}`);
    ctx.findings.criterion('leak', 'pass');
  },
});
