import { describe, expect, it, vi } from 'vitest';
import {
  createNet,
  NetError,
  WORK_REVIEW_JWKS_URL,
  WORK_REVIEW_MODELS_URL,
  WORK_REVIEW_RESPONSES_URL,
  WORK_REVIEW_REVOKE_URL,
  WORK_REVIEW_TOKEN_URL,
} from '../../src/server/lib/net.ts';
import type { NetFetch } from '../../src/server/collectors/github/ports.ts';
import { createWorkReviewWorker } from '../../src/server/services/work-review/worker.ts';

const token = 'synthetic.oauth.access-token';
const input = {
  date: '2026-11-24',
  title: 'Prototype exploration',
  turns: [
    { role: 'user' as const, text: 'Sketch a compact layout for the report builder.' },
    {
      role: 'assistant' as const,
      text: 'I created an alternative builder layout for narrow screens.',
    },
  ],
};
const notes = [{ kind: 'progress', text: 'I sketched a more compact report builder.' }];
const signal = new AbortController().signal;

function catalog(models: unknown[] = [{ slug: 'gpt-6-luna', visibility: 'list' }]): Response {
  return Response.json({ models });
}

function completed(text = JSON.stringify({ notes }), model = 'gpt-6-luna') {
  return {
    type: 'response.completed',
    response: {
      model,
      status: 'completed',
      output: [
        { type: 'reasoning' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
    },
  };
}

function stream(...events: unknown[]): Response {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const midpoint = Math.floor(frames.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(frames.slice(0, midpoint)));
      controller.enqueue(encoder.encode(frames.slice(midpoint)));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function workerTest() {
  const net = vi.fn<NetFetch>();
  const accessToken = vi.fn(async () => token);
  const invalidateAccessToken = vi.fn(async () => {});
  return {
    net,
    accessToken,
    invalidateAccessToken,
    worker: createWorkReviewWorker({ net, accessToken, invalidateAccessToken }),
  };
}

describe('Work Review subscription inference', () => {
  it('checks the exact model with the supplied grant and makes a stateless tool-free request', async () => {
    const { net, worker } = workerTest();
    net.mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(completed()));
    await expect(worker.extract(input, signal)).resolves.toEqual(notes);
    expect(net).toHaveBeenCalledTimes(2);
    expect(net.mock.calls[0]).toMatchObject([
      WORK_REVIEW_MODELS_URL,
      { headers: { authorization: `Bearer ${token}` } },
    ]);
    const [url, post] = net.mock.calls[1]!;
    expect(url).toBe(WORK_REVIEW_RESPONSES_URL);
    expect(post).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'model',
        'reasoning',
        'instructions',
        'input',
        'store',
        'stream',
        'tools',
        'tool_choice',
        'text',
      ].sort(),
    );
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
      store: false,
      stream: true,
      tools: [],
      tool_choice: 'none',
      input: [{ role: 'user', content: JSON.stringify(input) }],
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          schema: { type: 'object', additionalProperties: false, required: ['notes'] },
        },
      },
    });
    expect(post?.body).not.toContain(token);
  });

  it.each([
    [{ slug: 'gpt-6.2-sol', visibility: 'list' }],
    [{ slug: 'gpt-6-luna', visibility: 'hide' }],
    [
      {
        slug: 'gpt-6-luna',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'medium' }],
      },
    ],
  ])('keeps excerpts local when the account catalog has no permitted Luna model', async (model) => {
    const { net, worker } = workerTest();
    net.mockResolvedValueOnce(catalog([model]));
    await expect(worker.extract(input, signal)).rejects.toMatchObject({
      code: 'model_unavailable',
    });
    expect(net).toHaveBeenCalledTimes(1);
    expect(net.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('does not send an API key through the subscription scope', async () => {
    const { net, accessToken, worker } = workerTest();
    accessToken.mockResolvedValueOnce('sk-' + 'Z'.repeat(20));
    await expect(worker.extract(input, signal)).rejects.toMatchObject({ code: 'sign_in_required' });
    expect(net).not.toHaveBeenCalled();
  });

  it.each([
    [
      stream({ type: 'response.output_text.delta', delta: JSON.stringify({ notes }) }),
      'invalid_output',
    ],
    [stream(completed(JSON.stringify({ notes }), 'gpt-6-sol')), 'model_unavailable'],
    [stream({ type: 'response.incomplete' }), 'invalid_output'],
    [
      stream({
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'private diagnostic',
          },
        },
      }),
      'usage_limit',
    ],
    [
      Response.json(
        {
          error: { code: 'subscription_sharing_user_not_eligible', message: 'private diagnostic' },
        },
        { status: 403 },
      ),
      'not_eligible',
    ],
    [
      Response.json({ error: { code: 'chatpass_v2_scope_not_authorized' } }, { status: 403 }),
      'not_eligible',
    ],
  ])(
    'fails closed on incomplete output, model substitution, or provider admission failure',
    async (response, code) => {
      const { net, worker, invalidateAccessToken } = workerTest();
      net.mockResolvedValueOnce(catalog()).mockResolvedValueOnce(response as Response);
      await expect(worker.extract(input, signal)).rejects.toMatchObject({ code, message: code });
      expect(invalidateAccessToken).not.toHaveBeenCalled();
    },
  );

  it('stops reading an active stream when the caller cancels', async () => {
    const { net, worker } = workerTest();
    const cancel = vi.fn();
    const controller = new AbortController();
    let ready = () => {};
    const running = new Promise<void>((resolve) => {
      ready = resolve;
    });
    net.mockResolvedValueOnce(catalog()).mockImplementationOnce(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          ready();
        },
        cancel,
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const result = worker.extract(input, controller.signal);
    await running;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('maps a network deadline to a retryable worker timeout', async () => {
    const { net, worker } = workerTest();
    net.mockRejectedValueOnce(new NetError('timeout', 'api.openai.com', '/v1/models'));
    await expect(worker.extract(input, signal)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('Work Review outbound scopes', () => {
  it('allows only the exact URL, HTTP method and request body used by each scope', async () => {
    const send = vi.fn(async () => new Response(null));
    const signIn = createNet({ scope: 'work-review-auth', fetch: send });
    const inference = createNet({ scope: 'work-review', fetch: send });
    const post = { method: 'POST' as const, body: 'body' };
    await inference(WORK_REVIEW_MODELS_URL);
    await inference(WORK_REVIEW_RESPONSES_URL, post);
    await signIn(WORK_REVIEW_JWKS_URL);
    await signIn(WORK_REVIEW_TOKEN_URL, post);
    await signIn(WORK_REVIEW_REVOKE_URL, post);
    const refused = [
      () => inference(WORK_REVIEW_RESPONSES_URL),
      () => inference(WORK_REVIEW_RESPONSES_URL, { method: 'POST' }),
      () => inference(WORK_REVIEW_MODELS_URL, post),
      () => inference(`${WORK_REVIEW_MODELS_URL}?query=private`),
      () => inference('https://api.openai.com/v1/chat/completions', post),
      () => inference('https://user:pass@api.openai.com/v1/responses', post),
      () => inference(WORK_REVIEW_TOKEN_URL, post),
      () => signIn(WORK_REVIEW_RESPONSES_URL, post),
      () => signIn(`${WORK_REVIEW_TOKEN_URL}#unexpected`, post),
      () => signIn(WORK_REVIEW_JWKS_URL, post),
      () => signIn('https://auth.openai.com/oauth/token', post),
    ];
    for (const request of refused)
      await expect(request()).rejects.toMatchObject({ kind: 'refused' });
    expect(send).toHaveBeenCalledTimes(5);
  });
});
