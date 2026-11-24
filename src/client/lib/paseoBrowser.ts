export const PASEO_BROWSER_BASENAME = '/paseo';

export function isPaseoBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const { pathname } = window.location;
  return pathname === PASEO_BROWSER_BASENAME || pathname.startsWith(`${PASEO_BROWSER_BASENAME}/`);
}
