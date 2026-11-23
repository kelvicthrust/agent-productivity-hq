import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import type { JsonValue, PaseoRead } from '../shared/native.ts';

const agentOptions = z.object({
  filter: z.object({ includeArchived: z.boolean() }),
  page: z.object({ limit: z.number().int().positive().max(200), cursor: z.string().optional() }),
});

const parentLabel = 'paseo.parent-agent-id';
const json = (value: unknown): JsonValue => z.json().parse(JSON.parse(JSON.stringify(value)));

/** Borrow the daemon's client and send only the fields HQ's collectors read. */
export function paseoSource(paseo: PluginHandlerContext['paseo']): PaseoRead {
  return async (request) => {
    if (request.kind === 'usage') {
      const result = await paseo.providers.listUsage();
      return json({
        fetchedAt: result.fetchedAt,
        providers: result.providers
          .filter(({ providerId }) => providerId === 'codex' || providerId === 'claude')
          .map(({ providerId, status, fetchedAt, nextRefreshAt, windows }) => ({
            providerId,
            status,
            fetchedAt,
            nextRefreshAt,
            windows: windows.map(({ id, label, usedPct, remainingPct, resetsAt }) => ({
              id,
              label,
              usedPct,
              remainingPct,
              resetsAt,
            })),
          })),
      });
    }

    const { filter, page } = agentOptions.parse(request.options);
    const result = await paseo.agents.list({
      filter: { includeArchived: filter.includeArchived, includeBackground: true },
      page,
    });
    return json({
      entries: result.entries.map(({ agent, project }) => ({
        agent: {
          id: agent.id,
          provider: agent.provider,
          title: agent.title,
          workspaceId: agent.workspaceId,
          cwd: agent.cwd,
          labels: { [parentLabel]: agent.labels?.[parentLabel] },
          runtimeInfo: agent.runtimeInfo && { sessionId: agent.runtimeInfo.sessionId },
          archivedAt: agent.archivedAt,
          status: agent.status,
          activeTurn: agent.activeTurn && { startedAt: agent.activeTurn.startedAt },
          pendingPermissions: agent.pendingPermissions?.slice(0, 1).map(({ kind }) => ({ kind })),
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
          attentionTimestamp: agent.attentionTimestamp,
          updatedAt: agent.updatedAt,
          createdAt: agent.createdAt,
          providerUnavailable: agent.providerUnavailable,
        },
        project: project && { workspaceName: project.workspaceName },
      })),
      pageInfo: result.pageInfo,
    });
  };
}
