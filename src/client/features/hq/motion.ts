// The scene's loops, as class names. Every loop is applied behind `motion-safe:`, so with reduced motion there is no animation at all
// and the scene is a still drawing (the first wobble filter, every mark in its rest pose). The keyframes are in theme/globals.css.
// All motion is stepped, like a drawing redrawn a few times a second, and none of it touches layout.
// Every utility is written out as a complete class string: Tailwind's scanner reads source text, so a class built by interpolation
// is never emitted. Keep them literal.

/** The ink's line boil: the group steps between three wobble filters about four times a second. The three entries stagger the groups. */
export const BOIL = [
  '[filter:var(--hq-wobble-a)] motion-safe:animate-[hq-boil_0.75s_steps(1,end)_infinite]',
  '[filter:var(--hq-wobble-a)] motion-safe:animate-[hq-boil_0.75s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.25s]',
  '[filter:var(--hq-wobble-a)] motion-safe:animate-[hq-boil_0.75s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.5s]',
] as const;

/** A scribble drawn three ways, one visible at a time (the other two carry `opacity="0"` at rest). */
export const SCRIB = [
  'motion-safe:animate-[hq-flick3_1.2s_steps(1,end)_infinite]',
  'motion-safe:animate-[hq-flick3_1.2s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.8s]',
  'motion-safe:animate-[hq-flick3_1.2s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.4s]',
] as const;

/** Two frames, one visible at a time: a cursor, steam, a pennant. */
export const FLICK = [
  'motion-safe:animate-[hq-flick2_1s_steps(1,end)_infinite]',
  'motion-safe:animate-[hq-flick2_1s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.5s]',
] as const;

/** Thinking dots light up in turn. */
export const DOT = [
  'motion-safe:animate-[hq-dot_1.2s_steps(1,end)_infinite]',
  'motion-safe:animate-[hq-dot_1.2s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.8s]',
  'motion-safe:animate-[hq-dot_1.2s_steps(1,end)_infinite] motion-safe:[animation-delay:-0.4s]',
] as const;

/** z marks drift up and fade. */
export const ZED = [
  '[transform-box:fill-box] origin-center motion-safe:animate-[hq-zed_2.4s_steps(5,end)_infinite]',
  '[transform-box:fill-box] origin-center motion-safe:animate-[hq-zed_2.4s_steps(5,end)_infinite] motion-safe:[animation-delay:-0.8s]',
  '[transform-box:fill-box] origin-center motion-safe:animate-[hq-zed_2.4s_steps(5,end)_infinite] motion-safe:[animation-delay:-1.6s]',
] as const;

/** The question bubble bobs. */
export const BOB =
  '[transform-box:fill-box] origin-[50%_100%] motion-safe:animate-[hq-bob_1.2s_steps(1,end)_infinite]';
/** The error mark shakes. */
export const SHAKE =
  '[transform-box:fill-box] origin-[50%_100%] motion-safe:animate-[hq-shake_0.6s_steps(1,end)_infinite]';
/** A reader's sheet tilts. */
export const TILT =
  '[transform-box:fill-box] origin-[0%_100%] motion-safe:animate-[hq-tilt_1.6s_steps(1,end)_infinite]';
/** An empty chair's backrest swings round and back: the half-turn of a swivel left spinning, in six steps. Turns about the chair's pole. */
export const SWIVEL =
  '[transform-box:view-box] [transform-origin:0_0] motion-safe:animate-[hq-swivel_3.6s_steps(1,end)_infinite]';
