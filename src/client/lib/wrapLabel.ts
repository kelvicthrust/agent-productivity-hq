/**
 * Classes for a phone-width button whose label is long: the label wraps inside the button instead of being cut with an ellipsis
 * (Astryx's own label style truncates it, so a name such as "Open the ChatGPT sign-in page" lost its end at 320px). The button
 * grows to hold the lines, still at least 44px tall, and from 720px up it is the single line it always was.
 */
export const WRAPPING_LABEL =
  'max-[719px]:h-auto max-[719px]:min-h-11 max-[719px]:py-2 max-[719px]:[&_span]:overflow-visible max-[719px]:[&_span]:whitespace-normal max-[719px]:[&_span]:text-clip max-[719px]:[&_span]:text-left';
