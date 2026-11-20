export interface ClaudeUsageRank {
  sidechain: boolean;
  total: number;
  hasSpeed: boolean;
  path?: string;
}

/** An exact tie keeps the first line of the same file. */
export function prefersClaudeUsage(next: ClaudeUsageRank, previous: ClaudeUsageRank): boolean {
  if (next.sidechain !== previous.sidechain) return previous.sidechain;
  if (next.total !== previous.total) return next.total > previous.total;
  if (next.hasSpeed !== previous.hasSpeed) return next.hasSpeed;
  return next.path !== undefined && previous.path !== undefined && next.path < previous.path;
}
