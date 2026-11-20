// The page's greeting (D2 voice: "Morning, Kelvin"). The prototype fixed it at a 9:52 AM clock and a fixture name
// (design-to-code › reuse audit: "GREETING constant → replace with … real timers and server time"). Here the part of the day
// is the hour in the report's timezone, which is the clock every date on the page already uses, and the name is the
// first word of the GitHub profile name (`greetingName`), or nothing: "Good morning".

function hourIn(epochMs: number, timeZone: string | undefined): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(epochMs);
    return Number(parts.find((part) => part.type === 'hour')?.value ?? 'NaN');
  } catch {
    // A zone name this browser does not know: the machine's own clock is the next best thing.
    return new Date(epochMs).getHours();
  }
}

export function greeting(
  epochMs: number,
  timeZone: string | undefined,
  name: string | null | undefined,
): string {
  const hour = hourIn(epochMs, timeZone);
  const part = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const who = name?.trim();
  return who ? `${part}, ${who}` : `Good ${part.toLowerCase()}`;
}
