// Hand-drawn strokes for the parts of the scene that must fit a room of any size (walls, floors, signs, washes). The ported props
// carry their own wobble; these draw the same kind of line, deterministically from a seed so a room never changes between polls.

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pt = (x: number, y: number) => `${r1(x)} ${r1(y)}`;

/** A small stable number from a string, to seed a room's strokes. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One slightly bowed, slightly overshooting line, as a cubic path. */
export function sketchLine(x1: number, y1: number, x2: number, y2: number, seed: number): string {
  const rnd = random(seed);
  const jitter = (amount: number) => (rnd() - 0.5) * 2 * amount;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const bow = Math.min(1.6, length / 60);
  const a = jitter(bow);
  const b = jitter(bow);
  return (
    `M${pt(x1 + jitter(0.8), y1 + jitter(0.8))} ` +
    `C${pt(x1 + dx / 3 + nx * a, y1 + dy / 3 + ny * a)} ` +
    `${pt(x1 + (2 * dx) / 3 + nx * b, y1 + (2 * dy) / 3 + ny * b)} ` +
    `${pt(x2 + jitter(0.8), y2 + jitter(0.8))}`
  );
}

/** Four sketched sides. */
export function sketchBox(x: number, y: number, w: number, h: number, seed: number): string {
  return [
    sketchLine(x, y, x + w, y, seed),
    sketchLine(x + w, y, x + w, y + h, seed + 1),
    sketchLine(x + w, y + h, x, y + h, seed + 2),
    sketchLine(x, y + h, x, y, seed + 3),
  ].join(' ');
}

/** A loosely closed blob over a rectangle: a wash that does not quite meet its outline. */
export function washBox(x: number, y: number, w: number, h: number, seed: number): string {
  const rnd = random(seed);
  const jitter = (amount: number) => (rnd() - 0.5) * 2 * amount;
  const corner = (cx: number, cy: number) => pt(cx + jitter(2.2), cy + jitter(2.2));
  const midX = x + w / 2;
  const midY = y + h / 2;
  return (
    `M${corner(x, y)} ` +
    `Q${pt(midX, y + jitter(2))} ${corner(x + w, y)} ` +
    `Q${pt(x + w + jitter(2), midY)} ${corner(x + w, y + h)} ` +
    `Q${pt(midX, y + h + jitter(2))} ${corner(x, y + h)} ` +
    `Q${pt(x + jitter(2), midY)} ${pt(x + jitter(1), y + jitter(1))}Z`
  );
}
