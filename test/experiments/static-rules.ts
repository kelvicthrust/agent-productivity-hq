// The rules that keep experiment scripts read-only, found by reading their source. The runtime guards in
// scripts/experiments/lib are the real fence; this scan makes sure no script goes around them.

/** Source with comments removed (a `//` right after a colon is a URL, not a comment). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w'"`])\/\/.*$/gm, '$1');
}

export function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.add(m[1]!);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(m[1]!);
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) found.add(m[1]!);
  return [...found].sort();
}

export function namedImports(source: string, module: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const pattern = new RegExp(
    `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${module.replace(/[/.]/g, '\\$&')}['"]`,
    'g',
  );
  for (const m of code.matchAll(pattern))
    out.push(
      ...m[1]!
        .split(',')
        .map(
          (n) =>
            n
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)[0]!,
        )
        .filter(Boolean),
    );
  return out.sort();
}

/** Node modules a script may import: no files, processes or sockets. */
export const SCRIPT_NODE_MODULES: ReadonlySet<string> = new Set([
  'node:path',
  'node:os',
  'node:url',
  'node:crypto',
  'node:zlib',
  'node:util',
  'node:buffer',
  'node:string_decoder',
  'node:events',
  'node:timers/promises',
]);

/** Packages a particular script may import. */
export const SCRIPT_PACKAGES: Readonly<Record<string, readonly RegExp[]>> = {
  E3: [/^@getpaseo\/(client|protocol)(\/.*)?$/],
  E6: [/^@napi-rs\/keyring$/],
};

const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'a write, delete or permission call',
    pattern:
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|chmod|chmodSync|chown|truncate|truncateSync|symlink|symlinkSync|link|linkSync|createWriteStream)\s*\(/,
  },
  {
    name: 'child_process or an exec call',
    pattern: /\bchild_process\b|\b(?:exec|execSync|execFile|execFileSync|spawnSync|fork)\s*\(/,
  },
  {
    name: 'a direct fetch (use ctx.fetch)',
    pattern:
      /(?<![\w.])fetch\s*\(|\b(?:globalThis|window|self)\.fetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/,
  },
  { name: 'eval or Function', pattern: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/ },
  {
    name: 'require or process.binding',
    pattern: /\brequire\s*\(|\bprocess\.binding\b|\bprocess\.dlopen\b/,
  },
  {
    name: 'printing outside ctx.out',
    pattern: /\bconsole\s*\.\s*\w+\s*\(|\bprocess\.std(?:out|err)\b/,
  },
  { name: 'process.env (read it through ctx.env)', pattern: /\bprocess\.env\b/ },
  {
    name: 'process.exit (return a verdict instead)',
    pattern: /\bprocess\.(?:exit|kill|chdir|abort)\b/,
  },
];

/** Problems with one script's source. Empty means it follows the rules. */
export function scanScript(id: string, source: string): string[] {
  const problems: string[] = [];
  const code = stripComments(source);
  for (const spec of importsOf(source)) {
    if (spec.startsWith('./lib/') && spec.endsWith('.ts')) continue;
    if (spec.startsWith('node:')) {
      if (!SCRIPT_NODE_MODULES.has(spec))
        problems.push(
          `imports ${spec}, which a script may not use (files, processes and sockets go through ctx)`,
        );
      continue;
    }
    if (!(SCRIPT_PACKAGES[id] ?? []).some((re) => re.test(spec)))
      problems.push(`imports "${spec}", which is not allowed for ${id}`);
  }
  for (const { name, pattern } of FORBIDDEN) if (pattern.test(code)) problems.push(`uses ${name}`);
  if (!/export\s+const\s+experiment\s*=\s*defineExperiment\s*\(/.test(code))
    problems.push('does not `export const experiment = defineExperiment(…)`');
  if (!/\brunIfMain\s*\(\s*import\.meta\s*,\s*experiment\s*\)/.test(code))
    problems.push('does not call runIfMain(import.meta, experiment)');
  return problems;
}

/** What each lib file may import from node: and, for node:fs, which functions. */
export const LIB_RULES: Readonly<
  Record<string, { node: readonly string[]; fs?: readonly string[] }>
> = {
  'args.ts': { node: [] },
  'cli.ts': { node: ['node:fs', 'node:os', 'node:path'], fs: ['realpathSync'] },
  'findings.ts': { node: ['node:fs', 'node:path'], fs: ['mkdirSync'] },
  'meta.ts': { node: ['node:path'] },
  'net.ts': { node: ['node:fs'], fs: ['readFileSync'] },
  'readonly.ts': {
    node: ['node:fs', 'node:path', 'node:zlib'],
    fs: [
      'closeSync',
      'existsSync',
      'openSync',
      'readdirSync',
      'readFileSync',
      'readSync',
      'realpathSync',
      'statSync',
    ],
  },
  'redact.ts': { node: [] },
  'runbook.ts': {
    node: ['node:fs', 'node:path', 'node:url'],
    fs: ['existsSync', 'readdirSync', 'readFileSync', 'writeFileSync'],
  },
  'secrets.ts': { node: [] },
  'shape.ts': { node: [] },
  'spawn.ts': { node: ['node:child_process'] },
  'types.ts': { node: [] },
  // The one lib file that opens a file for writing: it refuses a symlink or hard link at the final name.
  'safefile.ts': {
    node: ['node:fs'],
    fs: [
      'closeSync',
      'constants',
      'fstatSync',
      'ftruncateSync',
      'lstatSync',
      'openSync',
      'readFileSync',
      'writeSync',
    ],
  },
  'workspace.ts': {
    node: ['node:fs', 'node:os', 'node:path'],
    fs: ['existsSync', 'mkdirSync', 'mkdtempSync', 'readdirSync', 'realpathSync'],
  },
};

export function scanLibFile(name: string, source: string): string[] {
  const rule = LIB_RULES[name];
  if (!rule)
    return [
      `${name} is not in the lib rules: add it to test/experiments/static-rules.ts with what it may import`,
    ];
  const problems: string[] = [];
  const code = stripComments(source);
  for (const spec of importsOf(source)) {
    if (spec.startsWith('./')) continue;
    if (spec.startsWith('node:') && rule.node.includes(spec)) continue;
    problems.push(`imports ${spec}`);
  }
  if (rule.fs) {
    const extra = namedImports(source, 'node:fs').filter((n) => !rule.fs!.includes(n));
    if (extra.length > 0)
      problems.push(`imports from node:fs beyond its allowance: ${extra.join(', ')}`);
  }
  if (/\beval\s*\(|\bnew\s+Function\b/.test(code)) problems.push('uses eval or Function');
  // types.ts only declares the method; net.ts is the one place that calls it.
  if (name !== 'net.ts' && name !== 'types.ts' && /(?<![\w.])fetch\s*\(/.test(code))
    problems.push('uses fetch outside net.ts');
  return problems;
}
