import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { reportOperations } from './report-contracts.ts';

const nativeOperations = z.enum([
  'bootstrap',
  'roster',
  'discover',
  'sources',
  'finish',
  'githubConnect',
  'githubPoll',
  'githubDisconnect',
  'githubApp',
  'chatgptConnect',
  'chatgptPoll',
  'chatgptDisconnect',
  'repos',
  'repoDiscover',
  'repoAdd',
  'repoRecheck',
  'repoRemove',
  'usage',
  'usageFallback',
  ...reportOperations,
]);

const request = z.strictObject({
  operation: nativeOperations,
  parameters: z.record(z.string(), z.json()).optional(),
});
const failure = z.object({
  ok: z.literal(false),
  reason: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.object({ runId: z.int().positive() }).optional(),
});
const result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.json() }),
  failure,
]);

export const nativeDashboard = defineRpc({
  name: 'dashboard.native',
  input: request,
  output: result,
});
export const nativeRuntimeInstall = defineRpc({
  name: 'dashboard.native-runtime-install',
  input: z.strictObject({ action: z.enum(['start', 'status']) }),
  output: z.discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('installing') }),
    z.object({
      state: z.literal('finished'),
      result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true) }), failure]),
    }),
  ]),
});

export type NativeOperation = z.infer<typeof nativeOperations>;
export type NativeRequest = z.infer<typeof request>;
export type NativeFailure = z.infer<typeof failure>;
export type NativeResult = z.infer<typeof result>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export type NativeRuntimeInstallStatus = z.infer<typeof nativeRuntimeInstall.output>;
export type PaseoRead = (
  request: { kind: 'agents'; options: JsonValue } | { kind: 'usage' },
) => Promise<JsonValue>;
