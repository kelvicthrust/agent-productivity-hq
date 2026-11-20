import { existsSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WRAPPER_MARKER,
  buildWrapper,
  isWrapper,
  previousCommandOf,
  shellQuote,
} from '../../src/server/integrations/claudeCapture/wrapper.ts';
import {
  testSnapshotPath,
  fixture,
  fixtureBytes,
  installByHand,
  rig,
  runChild,
} from './helpers.ts';

// The command Claude Code runs. The shape is checked as text, and then by running it in a real shell from a folder whose path has a
// space, the way Claude Code does.

const sh = (command: string, stdin: Buffer | string = '') =>
  runChild('/bin/sh', ['-c', command], { stdin });

describe('shellQuote', () => {
  it('uses double quotes for an ordinary path, a space included, as the contract shows', () => {
    expect(
      shellQuote('/Users/k/Library/Application Support/agent-productivity/claude-statusline.mjs'),
    ).toBe('"/Users/k/Library/Application Support/agent-productivity/claude-statusline.mjs"');
  });

  it.each([
    "/tmp/it's here/node",
    '/tmp/$HOME/node',
    '/tmp/`id`/node',
    '/tmp/say "hi"/node',
    '/tmp/back\\slash/node',
    '/tmp/bang!/node',
    '/tmp/new\nline/node',
    '/tmp/all of \' " $ ` \\ ! them/node',
  ])('quotes %j so the shell reads it back as exactly that one word', async (path) => {
    const run = await sh(`printf '%s' ${shellQuote(path)}`);
    expect(run.stdout.toString('utf8')).toBe(path);
  });
});

describe('buildWrapper', () => {
  const node = '/opt/node/bin/node';
  const script = '/Users/k/Library/Application Support/agent-productivity/claude-statusline.mjs';

  it('is the contract’s shape on one line, with the marker first and `true` when there is no previous command', () => {
    expect(buildWrapper({ node, script, previousCommand: null })).toBe(
      `${WRAPPER_MARKER} if [ -x "${node}" ] && [ -f "${script}" ]; then "${node}" "${script}"; else true; fi`,
    );
  });

  it('puts the owner’s command text in the else branch', () => {
    const wrapper = buildWrapper({
      node,
      script,
      previousCommand: '~/bin/statusline.sh --compact',
    });
    expect(wrapper).toContain('; else ~/bin/statusline.sh --compact; fi');
  });

  it('puts `fi` on its own line when the command ends in a comment or spans lines', () => {
    expect(buildWrapper({ node, script, previousCommand: 'echo hi # note' })).toMatch(
      /; else echo hi # note\nfi$/,
    );
    expect(buildWrapper({ node, script, previousCommand: 'echo a\necho b\n' })).toMatch(
      /; else echo a\necho b\nfi$/,
    );
  });

  it('is recognised as the dashboard’s own, whichever Node or data folder it names', () => {
    expect(isWrapper(buildWrapper({ node, script, previousCommand: null }))).toBe(true);
    expect(
      isWrapper(buildWrapper({ node: '/x/node', script: '/y/s.mjs', previousCommand: 'echo' })),
    ).toBe(true);
    expect(isWrapper('echo hi')).toBe(false);
    expect(isWrapper('echo ": kelvin-agent-crew-hook;"')).toBe(false);
  });

  it('recognises the wrapper from before the rename and can read its original command', () => {
    const legacy =
      ': kelvin-agent-crew-hook; if [ -x "/opt/node" ] && [ -f "/old/claude-statusline.mjs" ]; then "/opt/node" "/old/claude-statusline.mjs"; else ~/bin/statusline.sh; fi';
    expect(isWrapper(legacy)).toBe(true);
    expect(previousCommandOf(legacy)).toBe('~/bin/statusline.sh');
  });
});

describe('previousCommandOf (reading a wrapper back)', () => {
  const nodes = ['/opt/node/bin/node', "/opt/it's/node", '/opt/with space/node'];
  const scripts = [
    '/data/s.mjs',
    '/Users/k/Library/Application Support/x/claude-statusline.mjs',
    '/d/$x/s.mjs',
  ];
  const commands = [
    'echo hi',
    '~/bin/statusline.sh --compact',
    'echo "quoted; fi" && echo done',
    'if true; then echo a; fi',
    "echo 'single' # trailing comment",
    'echo a\necho b',
    'cat <<EOF\nheredoc\nEOF',
    '   leading spaces kept',
  ];

  it.each(commands)('round-trips the owner’s command %j through every quoting form', (command) => {
    for (const node of nodes) {
      for (const script of scripts) {
        const wrapper = buildWrapper({ node, script, previousCommand: command });
        expect(previousCommandOf(wrapper)).toBe(command);
      }
    }
  });

  it('reads `true` as "there was none"', () => {
    expect(
      previousCommandOf(buildWrapper({ node: '/n', script: '/s', previousCommand: null })),
    ).toBeNull();
  });

  it('gives up on a command that only starts like a wrapper (someone edited it by hand)', () => {
    expect(previousCommandOf(`${WRAPPER_MARKER} echo edited by hand`)).toBeUndefined();
    expect(previousCommandOf('echo hi')).toBeUndefined();
  });
});

describe('the wrapper as Claude Code runs it, from a path containing a space', () => {
  async function installed(settings: string | undefined) {
    const world = rig(settings === undefined ? {} : { settings });
    installByHand(world);
    const wrapper = (world.readSettingsJson()['statusLine'] as { command: string }).command;
    return { ...world, wrapper };
  }

  it('runs the hook: snapshot saved, compact line printed when it is the only status line', async () => {
    const world = await installed(undefined);
    expect(world.dataDir).toContain(' ');
    const run = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.code).toBe(0);
    expect(run.stdout.toString('utf8')).toBe('5h 24% · 7d 41%\n');
    expect(existsSync(testSnapshotPath(world.dataDir))).toBe(true);
  });

  it('runs the hook and then the owner’s own status line, whose output alone comes back', async () => {
    const world = await installed('command-with-padding.json');
    const run = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe(
      '\u001b[1mSENTINEL_LINE_ONE\u001b[0m\nSENTINEL_LINE_TWO\n',
    );
    expect(JSON.parse(readFileSync(testSnapshotPath(world.dataDir), 'utf8'))).toMatchObject({
      five_hour: { used_percentage: 23.5 },
    });
  });

  it('falls back to the owner’s original status line, with stdin passed through, when the data folder is gone', async () => {
    const world = await installed('command-with-padding.json');
    rmSync(world.dataDir, { recursive: true, force: true });
    const run = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.code).toBe(0);
    expect(run.stdout.toString('utf8')).toBe(
      '\u001b[1mSENTINEL_LINE_ONE\u001b[0m\nSENTINEL_LINE_TWO\n',
    );
    expect(existsSync(testSnapshotPath(world.dataDir))).toBe(false);
  });

  it('hands the original command the very bytes it was sent, when it falls back', async () => {
    const world = rig({ settings: 'command-plain.json' });
    const raw = JSON.parse(fixture('settings', 'command-plain.json')) as { statusLine: object };
    world.writeSettings({ statusLine: { ...raw.statusLine, command: 'cat' } });
    installByHand(world);
    rmSync(world.dataDir, { recursive: true, force: true });
    const stdin = fixtureBytes('stdin', 'full.json');
    const run = await sh(
      (world.readSettingsJson()['statusLine'] as { command: string }).command,
      stdin,
    );
    expect(run.stdout.equals(stdin)).toBe(true);
  });

  it('falls back when Node is missing, too', async () => {
    const world = rig({ settings: 'command-plain.json', nodePath: '/no/such/dir/node' });
    const plan = world.capture.plan();
    world.capture.change({ action: 'prepare_install', confirm: plan.previewDigest });
    const wrapper = plan.wrapperCommand;
    const run = await sh(wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_PLAIN_LINE\n');
    expect(existsSync(testSnapshotPath(world.dataDir))).toBe(false);
  });

  it('prints nothing, and does not fail, when there was no status line and the data folder is gone', async () => {
    const world = await installed(undefined);
    rmSync(world.dataDir, { recursive: true, force: true });
    const run = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBe(0);
  });

  it('keeps a previous command that ends in a comment working', async () => {
    const world = await installed('command-trailing-comment.json');
    const run = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(run.stdout.toString('utf8')).toBe('SENTINEL_COMMENT_LINE\n');
    rmSync(world.dataDir, { recursive: true, force: true });
    const fallback = await sh(world.wrapper, fixtureBytes('stdin', 'full.json'));
    expect(fallback.stdout.toString('utf8')).toBe('SENTINEL_COMMENT_LINE\n');
  });
});
