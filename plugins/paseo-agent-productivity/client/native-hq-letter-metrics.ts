import { playpen } from './native-hq-font.generated.ts';

const SEPARATOR = ' · ';

export function playpenWidth(text: string, fontSize: number, weight = 400): number {
  return Array.from(text.normalize('NFC')).reduce(
    (width, character) => width + (playpen[weight]?.[character]?.[0] ?? 0.6) * fontSize,
    0,
  );
}

function truncate(text: string, max: number, measure: (text: string) => number): string {
  if (measure(text) <= max) return text;
  const ellipsis = '…';
  if (measure(ellipsis) > max) return '';
  const characters = Array.from(text);
  while (characters.length) {
    characters.pop();
    const candidate = `${characters.join('').trimEnd()}${ellipsis}`;
    if (measure(candidate) <= max) return candidate;
  }
  return ellipsis;
}

/** The sign keeps its crew or state when a repository name takes too much space. */
export function fitRoomLettering(
  text: string,
  max: number,
  measure: (text: string) => number,
  priority?: string,
): string {
  if (measure(text) <= max) return text;
  if (!priority) return truncate(text, max, measure);
  const suffix = `${SEPARATOR}${priority}`;
  if (text.endsWith(suffix)) {
    const place = truncate(text.slice(0, -suffix.length), max - measure(suffix), measure);
    if (Array.from(place).length >= 4) return place + suffix;
  }
  return truncate(priority, max, measure);
}
