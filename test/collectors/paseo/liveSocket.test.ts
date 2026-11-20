import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { openPaseoLiveClient } from '../../../src/server/collectors/paseo/open.ts';

// Two checks of the same thing, the SDK Node transport's hard teardown (`terminate()` on the `ws` socket when the client is closed):
// an in-memory one that needs no listener, so it runs in a sandbox, and the real one over a loopback socket, which is skipped, and
// says so, where the sandbox refuses to listen (the pattern of test/server/managed.test.ts).
//
// The real opener over a real loopback socket, to a peer that completes the WebSocket handshake and then says nothing at all: the
// case where a close frame is never answered. Node's own WebSocket stays in CLOSING there (undici has no close timeout; observed
// for more than 125 s on Node 26.3.1). The live client's transport must drop the connection when it is closed.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Whether this process may listen on loopback. A sandbox that forbids it fails the listen with EPERM (or EACCES). */
const loopbackAvailable = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    console.warn(
      'liveSocket: the real-socket teardown test was NOT run because the sandbox forbids listening on loopback',
    );
    resolve(false);
  });
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});
let server: Server | undefined;
const accepted: Socket[] = [];

afterEach(async () => {
  for (const socket of accepted.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A server that answers the upgrade and then ignores every frame. `ended` resolves when its socket is gone. */
async function silentPeer(): Promise<{
  port: number;
  shaken: Promise<void>;
  ended: Promise<void>;
}> {
  let shake: () => void = () => undefined;
  let end: () => void = () => undefined;
  const shaken = new Promise<void>((resolve) => (shake = resolve));
  const ended = new Promise<void>((resolve) => (end = resolve));
  server = createServer((socket) => {
    accepted.push(socket);
    let head = '';
    let answered = false;
    socket.on('data', (chunk) => {
      if (answered) {
        // The client's hello proves the upgrade reached it. Closing earlier could simply abort a pending upgrade.
        shake();
        return;
      }
      head += chunk.toString('latin1');
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1];
      if (!head.includes('\r\n\r\n') || !key) return;
      answered = true;
      const accept = createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    socket.on('error', () => undefined);
    socket.on('close', end);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, shaken, ended };
}

it.skipIf(!loopbackAvailable)(
  'closing the live client drops the socket at once even though the peer never answers the close',
  async () => {
    const peer = await silentPeer();
    const client = await openPaseoLiveClient(`ws://127.0.0.1:${peer.port}/ws`);
    const connecting = client.connect().then(
      () => 'connected',
      () => 'rejected',
    );
    await peer.shaken;

    await client.close();
    const outcome = await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve('still open'), 2_000);
      void peer.ended.then(() => {
        clearTimeout(timeout);
        resolve('dropped');
      });
    });
    expect(outcome).toBe('dropped');
    expect(await connecting).toBe('rejected'); // the connect that was waiting for the daemon's hello ended with the close
  },
);

// No listener and no peer: the SDK's own `ws` class, with `terminate` observed (the same class the SDK's Node transport constructs).
it('closing the live client terminates its socket, not only sends a close frame', async () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@getpaseo/client/node'));
  const { WebSocket: SdkSocket } = sdkRequire('ws') as {
    WebSocket: { prototype: { terminate(): void } };
  };
  const terminate = vi.spyOn(SdkSocket.prototype, 'terminate');
  const client = await openPaseoLiveClient('ws://127.0.0.1:9/ws');
  const connecting = client.connect().then(
    () => 'connected',
    () => 'rejected',
  );
  try {
    await client.close();
    expect(terminate).toHaveBeenCalled();
    expect(await connecting).toBe('rejected');
  } finally {
    terminate.mockRestore();
  }
});
