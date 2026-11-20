// Design token generator: design-system/DESIGN.md -> the three generated theme files.
//
//   pnpm tokens:generate   write the files
//   pnpm tokens:check      regenerate in memory and fail if any file differs (no write)
//
// Canonical source: the YAML front matter of design-system/DESIGN.md (colors, typography, rounded, spacing).
// Layout, elevation and motion values exist only as prose in that file (Layout, Elevation & Depth and
// Motion sections). Until Design moves them into the YAML they are the named EXTENSIONS below, copied from
// the D4 prototype's tokens.css, which tests/tokens/parity.test.ts compares with the generated output.
//
// Runs under Node's built-in TypeScript support: erasable syntax only, explicit .ts import extensions.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface Token {
  name: string; // CSS custom property, e.g. --color-action
  value: string;
}
export interface TokenGroup {
  title: string;
  source: string;
  tokens: Token[];
}

interface TypographyRole {
  fontFamily: string;
  fontSize: string;
  fontWeight: number | string;
  lineHeight: string;
  letterSpacing?: string;
}
export interface Identity {
  colors: Record<string, string>;
  typography: Record<string, TypographyRole>;
  rounded: Record<string, string>;
  spacing: Record<string, string>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const IDENTITY_PATH = 'design-system/DESIGN.md';
export const OUT_DIR = 'src/client/theme/generated';
export const OUT_FILES = {
  tokens: `${OUT_DIR}/tokens.css`,
  tailwind: `${OUT_DIR}/tailwind.css`,
  theme: `${OUT_DIR}/crewTheme.ts`,
} as const;

// ---- Prose-only values (named extensions; see header) -------------------------------------------------
const LAYOUT_EXTENSIONS: Token[] = [
  { name: '--appbar-h', value: '60px' },
  { name: '--sidenav-w', value: '220px' },
  { name: '--control-h', value: '34px' },
  { name: '--control-h-sm', value: '28px' },
  { name: '--content-max', value: '1440px' },
  { name: '--bottomnav-h', value: '64px' },
];
const ELEVATION_EXTENSIONS: Token[] = [
  {
    name: '--shadow-card',
    value: '0 1px 2px rgba(31, 27, 22, 0.05), 0 4px 14px rgba(31, 27, 22, 0.05)',
  },
  {
    name: '--shadow-overlay',
    value: '0 14px 36px rgba(31, 27, 22, 0.16), 0 2px 6px rgba(31, 27, 22, 0.08)',
  },
  { name: '--shadow-press', value: 'inset 0 -2px 0 rgba(31, 27, 22, 0.22)' },
  { name: '--shadow-nav', value: '0 -4px 14px rgba(31, 27, 22, 0.06)' },
  { name: '--scroll-edge', value: 'rgba(31, 27, 22, 0.16)' },
  { name: '--scrim', value: 'rgba(31, 27, 22, 0.36)' },
];
const MOTION_EXTENSIONS: Token[] = [
  { name: '--ease-out', value: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  { name: '--ease-in-out', value: 'cubic-bezier(0.77, 0, 0.175, 1)' },
  { name: '--ease-drawer', value: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  { name: '--dur-press', value: '160ms' },
  { name: '--dur-popover', value: '200ms' },
  { name: '--dur-drawer', value: '320ms' },
  { name: '--dur-toast', value: '400ms' },
  { name: '--dur-pop', value: '300ms' },
];

// ---- Reading the identity -----------------------------------------------------------------------------
export function readIdentity(root: string = ROOT): Identity {
  const text = readFileSync(join(root, IDENTITY_PATH), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) throw new Error(`${IDENTITY_PATH}: no YAML front matter found`);
  const data = parse(match[1]) as Partial<Identity>;
  for (const key of ['colors', 'typography', 'rounded', 'spacing'] as const) {
    if (!data[key] || typeof data[key] !== 'object') {
      throw new Error(`${IDENTITY_PATH}: front matter has no "${key}" block`);
    }
  }
  return data as Identity;
}

const cssFontStack = (stack: string): string => stack.replaceAll("'", '"');

export function buildGroups(identity: Identity): TokenGroup[] {
  const { colors, typography, rounded, spacing } = identity;
  const metric = typography['metric'];
  const body = typography['body'];
  const mono = typography['mono'];
  if (!metric || !body || !mono) throw new Error('typography needs metric, body and mono roles');

  const stacks = {
    display: cssFontStack(metric.fontFamily),
    sans: cssFontStack(body.fontFamily),
    mono: cssFontStack(mono.fontFamily),
  };
  const familyVar = (family: string): string => {
    const css = cssFontStack(family);
    const hit = (Object.keys(stacks) as Array<keyof typeof stacks>).find((k) => stacks[k] === css);
    if (!hit) throw new Error(`typography family is not one of the three stacks: ${family}`);
    return `var(--font-${hit})`;
  };

  const typeTokens: Token[] = [];
  const trackingTokens: Token[] = [];
  for (const [role, spec] of Object.entries(typography)) {
    typeTokens.push({
      name: `--type-${role}`,
      value: `${spec.fontWeight} ${spec.fontSize}/${spec.lineHeight} ${familyVar(spec.fontFamily)}`,
    });
    if (spec.letterSpacing) {
      trackingTokens.push({ name: `--tracking-${role}`, value: spec.letterSpacing });
    }
  }

  return [
    {
      title: 'colors',
      source: `${IDENTITY_PATH} front matter: colors`,
      tokens: Object.entries(colors).map(([k, v]) => ({ name: `--color-${k}`, value: String(v) })),
    },
    {
      title: 'typography',
      source: `${IDENTITY_PATH} front matter: typography (font feature settings are not carried)`,
      tokens: [
        { name: '--font-sans', value: stacks.sans },
        { name: '--font-display', value: stacks.display },
        { name: '--font-mono', value: stacks.mono },
        ...typeTokens,
        ...trackingTokens,
      ],
    },
    {
      title: 'rounded',
      source: `${IDENTITY_PATH} front matter: rounded`,
      tokens: Object.entries(rounded).map(([k, v]) => ({ name: `--radius-${k}`, value: v })),
    },
    {
      title: 'spacing',
      source: `${IDENTITY_PATH} front matter: spacing`,
      tokens: Object.entries(spacing).map(([k, v]) => ({ name: `--space-${k}`, value: v })),
    },
    {
      title: 'layout (named extension)',
      source: `${IDENTITY_PATH} prose: Layout. Not in the YAML yet.`,
      tokens: LAYOUT_EXTENSIONS,
    },
    {
      title: 'elevation (named extension)',
      source: `${IDENTITY_PATH} prose: Elevation & Depth. Not in the YAML yet.`,
      tokens: ELEVATION_EXTENSIONS,
    },
    {
      title: 'motion (named extension)',
      source: `${IDENTITY_PATH} prose: Motion table. Not in the YAML yet.`,
      tokens: MOTION_EXTENSIONS,
    },
  ];
}

const flat = (groups: TokenGroup[]): Token[] => groups.flatMap((g) => g.tokens);
const valueOf = (groups: TokenGroup[], name: string): string => {
  const hit = flat(groups).find((t) => t.name === name);
  if (!hit) throw new Error(`token not found: ${name}`);
  return hit.value;
};

const HEADER = (what: string): string =>
  `GENERATED by scripts/generate-tokens.ts from ${IDENTITY_PATH}. ${what}\nDo not edit by hand: change the design file or the generator, then run \`pnpm tokens:generate\`.`;

// ---- tokens.css ---------------------------------------------------------------------------------------
export function renderTokensCss(groups: TokenGroup[]): string {
  const blocks = groups.map((g) => {
    const lines = g.tokens.map((t) => `  ${t.name}: ${t.value};`).join('\n');
    return `  /* ${g.title} (${g.source}) */\n${lines}`;
  });
  return `/*\n${HEADER('Same property names and values as the D4 prototype tokens.css.')}\n*/\n:root {\n${blocks.join('\n\n')}\n}\n`;
}

// ---- tailwind.css -------------------------------------------------------------------------------------
// Tailwind colour keys follow the CSS names, except three that would collide with the Astryx bridge
// (`muted` there is a background; `text` reads badly as `text-text`).
const COLOR_KEY_ALIASES: Record<string, string> = {
  text: 'ink',
  'text-muted': 'ink-muted',
  'surface-sunken': 'sunken',
};

// `text-body` would be ambiguous: Astryx's bridge also defines a `body` colour (bg-body), and Tailwind's `text-*`
// utility reads both the font-size and the colour namespaces. The body type role is `copy` in Tailwind.
const TYPE_KEY_ALIASES: Record<string, string> = { body: 'copy' };

export function renderTailwindCss(groups: TokenGroup[], identity: Identity): string {
  const colors = groups.find((g) => g.title === 'colors')?.tokens ?? [];
  const lines: string[] = [];
  lines.push('  /* colors: utilities such as bg-canvas, text-ink, bg-action, ring-focus */');
  for (const t of colors) {
    const key = t.name.replace('--color-', '');
    lines.push(`  --color-${COLOR_KEY_ALIASES[key] ?? key}: var(${t.name});`);
  }
  lines.push('', '  /* fonts, radii, shadows */');
  for (const f of ['sans', 'display', 'mono']) lines.push(`  --font-${f}: var(--font-${f});`);
  for (const k of Object.keys(identity.rounded)) lines.push(`  --radius-${k}: var(--radius-${k});`);
  for (const n of ['card', 'overlay', 'press', 'nav'])
    lines.push(`  --shadow-${n}: var(--shadow-${n});`);
  lines.push(
    '',
    '  /* type roles: text-metric, text-title-page ... (size, line height, weight, tracking) */',
  );
  for (const [role, spec] of Object.entries(identity.typography)) {
    const key = TYPE_KEY_ALIASES[role] ?? role;
    lines.push(`  --text-${key}: ${spec.fontSize};`);
    lines.push(`  --text-${key}--line-height: ${spec.lineHeight};`);
    lines.push(`  --text-${key}--font-weight: ${spec.fontWeight};`);
    if (spec.letterSpacing) lines.push(`  --text-${key}--letter-spacing: ${spec.letterSpacing};`);
  }
  lines.push('', '  /* motion curves: ease-crew-out, ease-crew-in-out, ease-crew-drawer */');
  lines.push(
    '  --ease-crew-out: var(--ease-out);',
    '  --ease-crew-in-out: var(--ease-in-out);',
    '  --ease-crew-drawer: var(--ease-drawer);',
  );
  return `/*\n${HEADER('Import after @astryxdesign/core/tailwind-theme.css so product keys win on a shared name.')}\nDurations have no Tailwind theme namespace: use duration-(--dur-press).\n*/\n@theme reference inline {\n${lines.join('\n')}\n}\n`;
}

// ---- crewTheme.ts -------------------------------------------------------------------------------------
// Astryx token <- product token. Where both use the SAME custom property name the theme sets the literal
// product value (a theme token cannot read itself): --color-border, --color-success, --color-warning.
const ASTRYX_COLOR_MAP: Array<[astryx: string, product: string]> = [
  ['--color-background-body', 'canvas'],
  ['--color-background-surface', 'surface'],
  ['--color-background-card', 'surface'],
  ['--color-background-popover', 'surface'],
  ['--color-background-muted', 'surface-sunken'],
  ['--color-background-inverted', 'text'],
  ['--color-text-primary', 'text'],
  ['--color-text-secondary', 'text-muted'],
  ['--color-text-accent', 'action'],
  ['--color-icon-primary', 'text'],
  ['--color-icon-secondary', 'text-muted'],
  ['--color-icon-accent', 'action'],
  ['--color-accent', 'action'],
  ['--color-accent-muted', 'selection-surface'],
  ['--color-on-accent', 'on-action'],
  ['--color-border', 'border'],
  ['--color-border-emphasized', 'border-strong'],
  ['--color-success', 'success'],
  ['--color-success-muted', 'success-surface'],
  ['--color-on-success', 'on-action'],
  ['--color-on-success-muted', 'success'],
  ['--color-text-success', 'success'],
  ['--color-icon-success', 'success'],
  ['--color-border-success', 'success'],
  ['--color-warning', 'warning'],
  ['--color-warning-muted', 'warning-surface'],
  ['--color-on-warning', 'on-action'],
  ['--color-on-warning-muted', 'warning'],
  ['--color-text-warning', 'warning'],
  ['--color-icon-warning', 'warning'],
  ['--color-border-warning', 'warning'],
  ['--color-error', 'danger'],
  ['--color-error-muted', 'danger-surface'],
  ['--color-on-error', 'on-action'],
  ['--color-on-error-muted', 'danger'],
  ['--color-text-error', 'danger'],
  ['--color-icon-error', 'danger'],
  ['--color-border-error', 'danger'],
];
const ASTRYX_OTHER_MAP: Array<[astryx: string, product: string]> = [
  ['--radius-element', '--radius-sm'],
  ['--radius-container', '--radius-md'],
  ['--radius-page', '--radius-lg'],
  ['--shadow-low', '--shadow-card'],
  ['--shadow-med', '--shadow-card'],
  ['--shadow-high', '--shadow-overlay'],
  ['--font-family-body', '--font-sans'],
  ['--font-family-heading', '--font-display'],
  ['--font-family-code', '--font-mono'],
];

export function themeEntries(groups: TokenGroup[]): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [astryx, product] of ASTRYX_COLOR_MAP) {
    const productVar = `--color-${product}`;
    // Same name on both sides: a self-reference would be a cycle, so use the literal value.
    entries.push([
      astryx,
      astryx === productVar ? valueOf(groups, productVar) : `var(${productVar})`,
    ]);
  }
  for (const [astryx, productVar] of ASTRYX_OTHER_MAP) {
    entries.push([
      astryx,
      astryx === productVar ? valueOf(groups, productVar) : `var(${productVar})`,
    ]);
  }
  return entries;
}

export function renderCrewTheme(groups: TokenGroup[]): string {
  const lines = themeEntries(groups).map(([k, v]) => `    '${k}': '${v}',`);
  return `/*\n${HEADER('Keys are checked by the TypeScript types of the installed @astryxdesign/core.')}\nLight only: the MVP ships the warm light theme (index.html sets data-theme="light").\n*/\nimport { defineTheme } from '@astryxdesign/core/theme';\nimport { stoneTheme } from '@astryxdesign/theme-stone';\n\nexport const crewTheme = defineTheme({\n  name: 'crew',\n  extends: stoneTheme,\n  tokens: {\n${lines.join('\n')}\n  },\n});\n`;
}

// ---- driver -------------------------------------------------------------------------------------------
export function generateAll(root: string = ROOT): Record<string, string> {
  const identity = readIdentity(root);
  const groups = buildGroups(identity);
  return {
    [OUT_FILES.tokens]: renderTokensCss(groups),
    [OUT_FILES.tailwind]: renderTailwindCss(groups, identity),
    [OUT_FILES.theme]: renderCrewTheme(groups),
  };
}

/** Files under `root` whose content differs from `files` (or that are missing). */
export function findDrift(root: string, files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([rel, content]) => {
      const abs = join(root, rel);
      return !existsSync(abs) || readFileSync(abs, 'utf8') !== content;
    })
    .map(([rel]) => rel);
}

function main(): void {
  const files = generateAll();
  const drift = findDrift(ROOT, files);
  if (process.argv.includes('--check')) {
    if (drift.length > 0) {
      console.error(
        `Token drift: ${drift.join(', ')} differ from ${IDENTITY_PATH}. Run: pnpm tokens:generate`,
      );
      process.exit(1);
    }
    console.log(`tokens: ${Object.keys(files).length} generated files match ${IDENTITY_PATH}`);
    return;
  }
  for (const rel of drift) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, files[rel] as string);
    console.log(`wrote ${rel}`);
  }
  console.log(`tokens: generated files are up to date with ${IDENTITY_PATH}`);
}

if (import.meta.main) main();
