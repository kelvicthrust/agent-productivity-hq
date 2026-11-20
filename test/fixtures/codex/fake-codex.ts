// A stand-in for `codex app-server` for the self-test. It speaks JSON-RPC over standard input and output, one JSON
// object per line, and answers only `initialize` and `thread/list`. It lists three invented threads: two live ones on
// separate pages (the second page follows a cursor) and one archived. DRAFT-documented-shape, see README.md.
import { createInterface } from 'node:readline';

const live = [
  [
    {
      id: 'aaaaaaaa-1111-4111-8111-00000000000a',
      sessionId: 'aaaaaaaa-1111-4111-8111-00000000000a',
      name: 'SENTINEL_TITLE_a1b2c3',
      preview: 'SENTINEL_PREVIEW_a1b2c3',
      createdAt: 1791795600,
      archived: false,
    },
  ],
  [
    {
      id: 'bbbbbbbb-2222-4222-8222-00000000000b',
      sessionId: 'aaaaaaaa-1111-4111-8111-00000000000a',
      name: 'SENTINEL_TITLE_d4e5f6',
      preview: 'SENTINEL_PREVIEW_d4e5f6',
      createdAt: 1791795902,
      archived: false,
    },
  ],
];
const archived = [
  {
    id: 'cccccccc-3333-4333-8333-00000000000c',
    sessionId: 'cccccccc-3333-4333-8333-00000000000c',
    name: null,
    preview: 'SENTINEL_PREVIEW_e5f6a1',
    createdAt: 1790626200,
    archived: true,
  },
];
const nextPage = 'SENTINEL_CURSOR_a1b2c3';

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: { id?: number; method?: string; params?: { archived?: boolean; cursor?: string } };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification such as `initialized`
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.50.0' } });
  } else if (message.method === 'thread/list') {
    if (message.params?.archived) {
      send({ id: message.id, result: { data: archived, nextCursor: null } });
    } else if (message.params?.cursor === nextPage) {
      send({ id: message.id, result: { data: live[1], nextCursor: null } });
    } else {
      send({ id: message.id, result: { data: live[0], nextCursor: nextPage } });
    }
  } else {
    send({ id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
