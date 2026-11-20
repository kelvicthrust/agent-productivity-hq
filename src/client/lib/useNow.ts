import { useEffect, useState } from 'react';

/** Update clock-driven labels and enable a blocked action when its cooldown ends. */
export function useNow(retryAt: string | null = null): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const interval = window.setInterval(update, 30_000);
    const delay = retryAt === null ? 0 : Date.parse(retryAt) - Date.now();
    const timeout =
      delay > 0 && delay < 2_147_483_647 ? window.setTimeout(update, delay) : undefined;
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [retryAt]);

  return now;
}
