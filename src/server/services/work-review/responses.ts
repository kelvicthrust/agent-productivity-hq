import type { NetFetch } from '../../collectors/github/ports.ts';
import { NetError, WORK_REVIEW_MODELS_URL, WORK_REVIEW_RESPONSES_URL } from '../../lib/net.ts';
import { WorkReviewWorkerError, type WorkReviewWorkerErrorCode } from './worker-error.ts';

const MODEL = 'gpt-6-luna';
const EFFORT = 'low';
const TIMEOUT_MS = 60_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 512 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

export interface ModelRequest {
  instructions: string;
  input: string;
  outputSchema: Record<string, unknown>;
}

export interface ResponsesOptions {
  net: NetFetch;
  accessToken: (signal: AbortSignal) => Promise<string>;
  invalidateAccessToken: (rejected: string) => Promise<void>;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parse(text: string): Json {
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
}

// Work Review holds at most the stated response budget in memory. Closing the reader also
// stops the response when a limit, timeout, or caller cancellation ends the read early.
async function* bodyText(response: Response, signal: AbortSignal, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        yield decoder.decode();
        return;
      }
      bytes += value.byteLength;
      if (bytes > maximum) throw new WorkReviewWorkerError('invalid_output');
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    reader.releaseLock();
  }
}

async function readJson(response: Response, signal: AbortSignal, maximum: number): Promise<Json> {
  let text = '';
  for await (const chunk of bodyText(response, signal, maximum)) text += chunk;
  return parse(text);
}

function providerError(error: Json, status?: number): WorkReviewWorkerErrorCode {
  if (status === 401) return 'sign_in_required';
  switch (error['code']) {
    case 'subscription_sharing_invalid_user':
      return 'sign_in_required';
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
    case 'subscription_sharing_user_not_eligible':
      return 'not_eligible';
    case 'subscription_sharing_usage_limit_exceeded':
      return 'usage_limit';
    case 'model_not_found':
      return 'model_unavailable';
    case 'subscription_sharing_unsupported_capability':
      return error['param'] === 'model' || error['param'] === 'reasoning.effort'
        ? 'model_unavailable'
        : 'unsupported';
    case 'subscription_sharing_route_not_supported':
      return 'unsupported';
    default:
      if (status === 403) return 'not_eligible';
      if (status === 429) return 'usage_limit';
      return 'unavailable';
  }
}

async function checkResponse(response: Response, signal: AbortSignal): Promise<void> {
  if (response.ok) return;
  const body = await readJson(response, signal, MAX_ERROR_BYTES).catch((): Json => ({}));
  throw new WorkReviewWorkerError(providerError(record(body['error']), response.status));
}

function modelOffered(catalog: Json): boolean {
  return list(catalog['models'])
    .map(record)
    .some((model) => {
      if (model['slug'] !== MODEL || model['visibility'] !== 'list') return false;
      // Older catalogs omit this field. The inference request still fixes low effort.
      const levels = model['supported_reasoning_levels'];
      return (
        levels === undefined ||
        list(levels)
          .map(record)
          .some((level) => level['effort'] === EFFORT)
      );
    });
}

function completedText(event: Json): string {
  const response = record(event['response']);
  const model = response['model'];
  const effort = record(response['reasoning'])['effort'];
  // The API can return a dated snapshot for the exact requested model alias.
  if (
    (model !== MODEL &&
      !(typeof model === 'string' && /^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(model))) ||
    (effort !== undefined && effort !== EFFORT)
  ) {
    throw new WorkReviewWorkerError('model_unavailable');
  }
  if (response['status'] !== 'completed') throw new WorkReviewWorkerError('invalid_output');
  const output = list(response['output'])
    .map(record)
    .filter((item) => item['type'] !== 'reasoning');
  const message = output[0];
  if (output.length !== 1 || message?.['type'] !== 'message' || message['role'] !== 'assistant') {
    throw new WorkReviewWorkerError('invalid_output');
  }
  const content = list(message['content']).map(record);
  const part = content[0];
  if (
    content.length !== 1 ||
    part?.['type'] !== 'output_text' ||
    typeof part['text'] !== 'string'
  ) {
    throw new WorkReviewWorkerError('invalid_output');
  }
  return part['text'];
}

async function readOutput(response: Response, signal: AbortSignal): Promise<string> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'text/event-stream') {
    void response.body?.cancel().catch(() => undefined);
    throw new WorkReviewWorkerError('invalid_output');
  }
  let buffer = '';
  for await (const chunk of bodyText(response, signal, MAX_STREAM_BYTES)) {
    const events = (buffer + chunk).split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const item of events) {
      const data = item
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      const event = parse(data);
      switch (event['type']) {
        case 'response.completed':
          return completedText(event);
        case 'response.failed':
          throw new WorkReviewWorkerError(
            providerError(record(record(event['response'])['error'])),
          );
        case 'error':
          throw new WorkReviewWorkerError(providerError(event));
        case 'response.incomplete':
        case 'response.refusal.done':
          throw new WorkReviewWorkerError('invalid_output');
      }
    }
  }
  throw new WorkReviewWorkerError('invalid_output');
}

export function responsesModel({ net, accessToken, invalidateAccessToken }: ResponsesOptions) {
  return async (request: ModelRequest, callerSignal: AbortSignal): Promise<string> => {
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const signal = AbortSignal.any([callerSignal, deadline]);
    let usedToken: string | null = null;
    try {
      signal.throwIfAborted();
      const token = await accessToken(signal);
      signal.throwIfAborted();
      if (!/^[a-z\d._~+/-]+=*$/i.test(token) || /^sk-/i.test(token)) {
        throw new WorkReviewWorkerError('sign_in_required');
      }
      if (request.input.includes(token)) throw new WorkReviewWorkerError('invalid_input');
      usedToken = token;
      const authorization = `Bearer ${token}`;
      const catalog = await net(WORK_REVIEW_MODELS_URL, {
        headers: { authorization, accept: 'application/json' },
        signal,
      });
      await checkResponse(catalog, signal);
      if (!modelOffered(await readJson(catalog, signal, MAX_CATALOG_BYTES))) {
        throw new WorkReviewWorkerError('model_unavailable');
      }
      signal.throwIfAborted();
      const response = await net(WORK_REVIEW_RESPONSES_URL, {
        method: 'POST',
        headers: { authorization, accept: 'text/event-stream', 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: MODEL,
          reasoning: { effort: EFFORT },
          instructions: request.instructions,
          input: [{ role: 'user', content: request.input }],
          store: false,
          stream: true,
          tools: [],
          tool_choice: 'none',
          text: {
            format: {
              type: 'json_schema',
              name: 'work_review',
              strict: true,
              schema: request.outputSchema,
            },
          },
        }),
      });
      await checkResponse(response, signal);
      const output = await readOutput(response, signal);
      if (output.includes(token) || JSON.stringify(parse(output)).includes(token)) {
        throw new WorkReviewWorkerError('invalid_output');
      }
      return output;
    } catch (error) {
      if (
        usedToken &&
        error instanceof WorkReviewWorkerError &&
        error.code === 'sign_in_required'
      ) {
        try {
          await invalidateAccessToken(usedToken);
        } catch {
          throw new WorkReviewWorkerError('unavailable');
        }
      }
      if (callerSignal.aborted) throw new WorkReviewWorkerError('cancelled');
      if (deadline.aborted || (error instanceof NetError && error.kind === 'timeout')) {
        throw new WorkReviewWorkerError('timeout');
      }
      if (error instanceof WorkReviewWorkerError) throw error;
      throw new WorkReviewWorkerError('unavailable');
    }
  };
}
