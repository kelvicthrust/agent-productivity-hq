// The contract every experiment script (E1 to E9) is written against. A script exports one `experiment` made with
// defineExperiment() (cli.ts); the lib gives it guarded ways to read, start programs and contact hosts, and a findings
// builder that only accepts metadata. test/experiments proves the guards hold. Read CONTRACT.md before writing a script.

export const EXPERIMENT_IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E8', 'E9'] as const;
export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

/** `not-run` means the script could not evaluate the criterion here (tool or data absent). It is never a pass. */
export type Verdict = 'pass' | 'fail' | 'not-run';

export interface Criterion {
  /** Stable id, unique within the experiment, e.g. `reconcile-3-sessions`. Lowercase, digits and dashes. */
  id: string;
  /** TECH's pass criterion in one sentence. */
  text: string;
}

export interface SelftestCase {
  /** What this world shows, e.g. "all three sessions reconcile". */
  name: string;
  /**
   * Flags for the script. `{fixtures}` becomes <repo>/test/fixtures, `{tmp}` a fresh empty folder for this case and
   * `{root}` the repo root. The harness adds --out, --json, --now and a bare HOME.
   */
  args: string[];
  /** Extra environment variables; the same placeholders apply. */
  env?: Record<string, string>;
  expect: {
    /** 0 no criterion failed, 1 at least one failed, 2 the script itself stopped. */
    exit: 0 | 1 | 2;
    /** Expected verdict per criterion id. The first case of every script must name every criterion. */
    verdicts: Record<string, Verdict>;
    /** Text the standard output must contain (identifier-shaped, never message text). */
    stdoutIncludes?: string[];
  };
}

export interface ExperimentMeta {
  id: ExperimentId;
  /** Repo-relative path of the script, e.g. `scripts/experiments/e1-claude.ts`. */
  script: string;
  title: string;
  /** TECH's question for this experiment, one sentence. */
  question: string;
  criteria: Criterion[];
  /** Exactly what the script reads, one item per source, with default paths. The runbook prints these as written. */
  reads: string[];
  /** Exactly what it prints to the terminal. */
  prints: string[];
  /** Exactly what it writes. Always includes the findings file `docs/implementation/experiments/<id>.md`. */
  writes: string[];
  /** Hostnames it may contact, optionally with a port (`127.0.0.1:6767`). Empty when it uses no network. */
  network: string[];
  /** Program names it may start (`gh`, `codex`). Empty when it starts none. */
  spawns: string[];
  /** Optional example command line shown in the runbook; defaults to `node <script>`. */
  example?: string;
  selftest: SelftestCase[];
}

/** A value a finding may carry: numbers, booleans and identifier-shaped strings only. */
export type Fact = number | boolean | string | number[] | string[];

export interface FindingsCriterion {
  id: string;
  text: string;
  verdict: Verdict;
  detail?: string;
}

export interface FindingsFact {
  section: string;
  label: string;
  value: Fact;
}

/** What the run touched, counted by the guards (not self-reported). */
export interface RunTrace {
  filesRead: number;
  bytesRead: number;
  programsStarted: string[];
  hostsContacted: string[];
  workspaceFolders: number;
}

export interface FindingsDoc {
  id: ExperimentId;
  title: string;
  ranAt: string;
  overall: Verdict;
  environment: { node: string; platform: string; arch: string; tools: Record<string, string> };
  criteria: FindingsCriterion[];
  facts: FindingsFact[];
  notes: string[];
  trace: RunTrace;
}

export interface FileEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

/** Read-only file access, limited to the roots the script announced with ctx.willRead(). There is no write method. */
export interface ReadOnlyFs {
  readBytes(path: string, options?: { maxBytes?: number }): Uint8Array;
  readText(path: string, options?: { maxBytes?: number }): string;
  /** Reads `.zst` files through Node's zstd decoder; throws DecoderMissingError when there is none. */
  readMaybeCompressed(path: string, options?: { maxBytes?: number }): Uint8Array;
  readHead(path: string, bytes: number): Uint8Array;
  /** Lines of a file in 64 KB chunks, so very large JSONL files never sit in memory whole. Never print them. */
  lines(path: string): Generator<string>;
  list(dir: string): FileEntry[];
  stat(path: string): FileStat;
  exists(path: string): boolean;
  /** Files below `dir`, sorted. Does not follow symlinked folders. */
  walk(
    dir: string,
    options?: { match?: RegExp; maxFiles?: number; maxDepth?: number },
  ): { files: string[]; truncated: boolean };
  zstdAvailable(): boolean;
}

export interface SpawnResult {
  /** False when the program does not exist on this machine. */
  found: boolean;
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  timeoutMs?: number;
  input?: string;
  maxOutputBytes?: number;
}

/** A started program you talk to line by line (JSON-RPC over stdio). Always killed when the run ends. */
export interface ProcessSession {
  found: boolean;
  send(line: string): void;
  /** The next line of standard output, or null when the timeout passes or the program exited. */
  nextLine(timeoutMs: number): Promise<string | null>;
  kill(): void;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  text(): string;
  json(): unknown;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** A folder this run created under the system temp folder. It is the only place a script may write besides findings. */
export interface TempWorkspace {
  dir: string;
  path(relative: string): string;
  write(relative: string, data: string | Uint8Array): string;
  append(relative: string, data: string | Uint8Array): string;
  mkdir(relative: string): string;
  read(relative: string): string;
  list(relative?: string): string[];
}

export interface ParsedArgs {
  get(name: string): string | undefined;
  all(name: string): string[];
  has(name: string): boolean;
  names(): string[];
}

export interface FindingsSink {
  tool(name: string, version: string): void;
  criterion(id: string, verdict: Verdict, detail?: string): void;
  fact(section: string, label: string, value: Fact): void;
  note(text: string): void;
}

export interface ExperimentContext {
  meta: ExperimentMeta;
  args: ParsedArgs;
  env: Readonly<Record<string, string | undefined>>;
  /** The owner's home folder, or --home. Build default paths from it. */
  home: string;
  now(): number;
  /** Announces a source ("Will read: <label>: <path>") and allows reads below it. Returns the absolute path. */
  willRead(label: string, path: string): string;
  fs: ReadOnlyFs;
  /** Runs a program from meta.spawns by argument array, never through a shell. Its output is yours; never print it. */
  spawn(program: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
  session(program: string, args: string[]): Promise<ProcessSession>;
  /** HTTPS only, to hosts in meta.network. With --net-fixture it answers from a file and touches no network. */
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  workspace: { create(prefix: string): TempWorkspace; open(dir: string): TempWorkspace };
  /** The only way to print. Throws if the line looks like it holds a token or credential. */
  out: { line(text: string): void };
  findings: FindingsSink;
}

export interface Experiment {
  meta: ExperimentMeta;
  run(ctx: ExperimentContext): Promise<void>;
}
