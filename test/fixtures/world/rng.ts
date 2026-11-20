/** The prototype's seeded generator (mulberry32). The same seed gives the same world as docs/design/prototype/data.js. */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hex4 = (r: () => number): string => {
  let s = '';
  for (let i = 0; i < 4; i++) s += '0123456789abcdef'[Math.floor(r() * 16)];
  return s;
};

export const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;
