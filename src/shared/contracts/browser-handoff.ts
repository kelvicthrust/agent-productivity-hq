import { z } from 'zod';

export const PASEO_BROWSER_SESSION_HEADER = 'X-Agent-Productivity-Browser-Session';
export const PASEO_HANDOFF_PATH = '/api/paseo-handoff';
export const BrowserHandoffToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const BrowserHandoffRequest = z.strictObject({ ticket: BrowserHandoffToken });
export const BrowserHandoffResponse = z.strictObject({ credential: BrowserHandoffToken });
