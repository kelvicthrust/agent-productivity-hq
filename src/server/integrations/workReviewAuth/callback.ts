import { createAdaptorServer } from '@hono/node-server';
import type { Server } from 'node:http';

const LOOPBACK = '127.0.0.1';
const PATH = '/auth/callback';

export interface CallbackResult {
  status: number;
  message: string;
}

export interface CallbackListener {
  uri: string;
  close(force?: boolean): Promise<void>;
}

function reply({ status, message }: CallbackResult): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    },
  });
}

/** One short-lived listener with one callback path. The main dashboard cannot receive a browser OAuth code. */
export async function listenForWorkReviewCallback(
  handle: (query: URLSearchParams) => Promise<CallbackResult>,
): Promise<CallbackListener> {
  let origin = '';
  let host = '';
  const server = createAdaptorServer({
    overrideGlobalObjects: false,
    serverOptions: { maxHeaderSize: 8192, requestTimeout: 10_000 },
    fetch: async (_request, { incoming: request }) => {
      if (request.headers.host !== host || request.socket.remoteAddress !== LOOPBACK)
        return reply({
          status: 421,
          message: 'Open the callback on the Work Review installation computer.',
        });
      const raw = request.url ?? '';
      if (request.method !== 'GET' || !raw.startsWith(`${PATH}?`))
        return reply({ status: 404, message: 'The ChatGPT sign-in callback was not found.' });
      try {
        return reply(await handle(new URL(raw, origin).searchParams));
      } catch {
        return reply({
          status: 502,
          message: 'ChatGPT sign-in could not be completed. Return to Work Review and try again.',
        });
      }
    },
  }) as Server;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The ChatGPT callback address is unavailable.');
  }
  host = `${LOOPBACK}:${address.port}`;
  origin = `http://${host}`;

  let closed: Promise<void> | null = null;
  return {
    uri: `${origin}${PATH}`,
    close(force = false) {
      closed ??= new Promise((resolve) => server.close(() => resolve()));
      if (force) server.closeAllConnections();
      return closed;
    },
  };
}
