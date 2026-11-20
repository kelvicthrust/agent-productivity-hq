import { useId, type CSSProperties } from 'react';

// The line boil's three wobble filters (ported from the mockup's hd-wobble-a/b/c: the same displacement, three noise seeds). One set
// per scene, with ids made from React's own so two scenes on a page never share one. The scene names them to the stylesheet through
// --hq-wobble-a/b/c, which is how the keyframes in globals.css find them.

const SEEDS = [3, 11, 27] as const;
const LETTERS = ['a', 'b', 'c'] as const;

export interface SceneFilterIds {
  style: CSSProperties;
  defs: { id: string; seed: number }[];
}

export function useSceneFilters(): SceneFilterIds {
  const base = `hq-wobble-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const defs = SEEDS.map((seed, i) => ({ id: `${base}-${LETTERS[i]}`, seed }));
  const style: Record<string, string> = {};
  defs.forEach(({ id }, i) => {
    style[`--hq-wobble-${LETTERS[i]}`] = `url(#${id})`;
  });
  return { style: style as CSSProperties, defs };
}

export function SceneFilters({ defs }: { defs: SceneFilterIds['defs'] }) {
  return (
    <svg
      width="0"
      height="0"
      className="pointer-events-none absolute"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {defs.map(({ id, seed }) => (
          <filter key={id} id={id} x="-3%" y="-3%" width="106%" height="106%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.04"
              numOctaves="2"
              seed={seed}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="2.4"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
