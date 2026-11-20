// The shared base of the local-history adapters (Codex, Claude Code). One place for how files are found, read in bounded
// pieces, tracked and committed, and how outcomes are reported, so the two adapters differ only in what their formats mean.
// See CONTRACT.md in this folder for the adapter contract.
export * from './commit.ts';
export * from './errors.ts';
export * from './fields.ts';
export * from './files.ts';
export * from './lines.ts';
export * from './repo.ts';
export * from './tally.ts';
