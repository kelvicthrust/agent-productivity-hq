export type DashboardDestination = 'sources' | 'work-review';

interface LaunchRequest {
  id: string;
  hostId: string;
  destination?: DashboardDestination;
}

// An in-memory request authorizes one launch. Route history can keep its ID but cannot replay it.
export function createLaunchRequests() {
  let pending: LaunchRequest | undefined;
  let sequence = 0;
  return {
    issue(hostId: string, destination?: DashboardDestination): string {
      const id = `${Date.now()}-${++sequence}`;
      pending = { id, hostId, ...(destination === undefined ? {} : { destination }) };
      return id;
    },
    take(id: string | undefined, hostId: string): LaunchRequest | undefined {
      if (!pending || pending.id !== id) return;
      const request = pending;
      pending = undefined;
      if (request.hostId === hostId) return request;
    },
  };
}

export type LaunchRequests = ReturnType<typeof createLaunchRequests>;
