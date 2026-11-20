import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSpawner, ProgramNotAllowedError } from '../../../scripts/experiments/lib/spawn.ts';
import { cleanupTmp, makeTmp } from '../harness.ts';

afterAll(cleanupTmp);

function setup(allowed = ['fakeprog']) {
  const dir = makeTmp();
  const echo = join(dir, 'echo.mjs');
  writeFileSync(
    echo,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("err");process.exit(Number(process.env.EXIT ?? 0));',
  );
  const server = join(dir, 'server.mjs');
  writeFileSync(
    server,
    "import { createInterface } from 'node:readline';const rl=createInterface({input:process.stdin});rl.on('line',(l)=>{if(l==='quit')process.exit(0);process.stdout.write(JSON.stringify({echo:l})+'\\n');});",
  );
  const sleeper = join(dir, 'sleep.mjs');
  writeFileSync(sleeper, 'setTimeout(()=>{},60000);');
  const announced: string[] = [];
  const spawner = createSpawner({
    allowed,
    bins: new Map([
      ['fakeprog', echo],
      ['server', server],
      ['sleeper', sleeper],
      ['missing', join(dir, 'no-such-program')],
    ]),
    announce: (line) => announced.push(line),
  });
  return { spawner, announced };
}

describe('starting programs', () => {
  it('only starts programs the script listed', async () => {
    const { spawner, announced } = setup(['fakeprog']);
    await expect(spawner.run('curl', ['https://example.test'])).rejects.toBeInstanceOf(
      ProgramNotAllowedError,
    );
    await expect(spawner.run('sh', ['-c', 'echo hi'])).rejects.toBeInstanceOf(
      ProgramNotAllowedError,
    );
    await expect(spawner.session('bash', [])).rejects.toBeInstanceOf(ProgramNotAllowedError);
    expect(spawner.started()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('announces first, passes arguments as an array and never through a shell', async () => {
    const { spawner, announced } = setup();
    const nasty = '; echo INJECTED $(whoami) | cat > /tmp/should-not-exist';
    const result = await spawner.run('fakeprog', ['--version', nasty]);
    expect(announced).toEqual([`Will start: fakeprog --version ${JSON.stringify(nasty)}`]);
    expect(result.found).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(['--version', nasty]);
    expect(result.stderr).toBe('err');
    expect(result.status).toBe(0);
    expect(spawner.started()).toEqual(['fakeprog']);
  });

  it('reports a program that is not there instead of crashing', async () => {
    const { spawner } = setup(['missing']);
    const result = await spawner.run('missing', []);
    expect(result).toMatchObject({ found: false, status: null, timedOut: false });
    const session = await spawner.session('missing', []);
    expect(session.found).toBe(false);
    expect(await session.nextLine(50)).toBeNull();
  });

  it('kills a program that runs past its timeout', async () => {
    const { spawner } = setup(['sleeper']);
    const started = Date.now();
    const result = await spawner.run('sleeper', [], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops reading a program that prints too much', async () => {
    const dir = makeTmp();
    const flood = join(dir, 'flood.mjs');
    writeFileSync(flood, "for(let i=0;i<200;i++)process.stdout.write('x'.repeat(10000));");
    const spawner = createSpawner({
      allowed: ['flood'],
      bins: new Map([['flood', flood]]),
      announce: () => undefined,
    });
    const result = await spawner.run('flood', [], { maxOutputBytes: 50_000 });
    expect(result.stdout.length).toBeLessThanOrEqual(60_000);
  });
});

describe('talking to a program line by line', () => {
  it('sends and receives lines, times out quietly and is killed on request', async () => {
    const { spawner } = setup(['server']);
    const session = await spawner.session('server', []);
    expect(session.found).toBe(true);
    session.send('hello');
    expect(JSON.parse((await session.nextLine(5000)) ?? 'null')).toEqual({ echo: 'hello' });
    session.send('one');
    session.send('two');
    expect(JSON.parse((await session.nextLine(5000)) ?? 'null')).toEqual({ echo: 'one' });
    expect(JSON.parse((await session.nextLine(5000)) ?? 'null')).toEqual({ echo: 'two' });
    expect(await session.nextLine(100)).toBeNull();
    session.kill();
    expect(await session.nextLine(2000)).toBeNull();
  });

  it('killAll ends every program still running', async () => {
    const { spawner } = setup(['server', 'sleeper']);
    const a = await spawner.session('server', []);
    await spawner.session('sleeper', []);
    spawner.killAll();
    expect(await a.nextLine(2000)).toBeNull();
  });
});
