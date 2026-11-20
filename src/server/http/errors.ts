import { randomUUID } from 'node:crypto';
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { ApiError, type ErrorEnvelope } from '../../shared/contracts/errors.ts';
import type { Logger } from '../lib/logger.ts';

export type HttpEnv = { Variables: { correlationId: string } };

/** Gives each request a correlation id, returned in `details.correlationId` of an internal error and written to the log. */
export function correlation(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    c.set('correlationId', randomUUID());
    await next();
  };
}

const envelope = (
  code: ErrorEnvelope['error']['code'],
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): ErrorEnvelope => ({ error: { code, message, retryable, ...(details ? { details } : {}) } });

/** A zod failure becomes invalid_input with `details.fields`: field → plain reason. */
function fieldsOf(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  return fields;
}

export function errorHandler(logger: Logger): ErrorHandler<HttpEnv> {
  return (error, c) => {
    const correlationId = c.get('correlationId');
    if (error instanceof ApiError) {
      return c.json(error.toEnvelope(), error.status as 400);
    }
    if (error instanceof ZodError) {
      return c.json(
        envelope('invalid_input', 'Some values are not valid.', false, { fields: fieldsOf(error) }),
        400,
      );
    }
    if (error instanceof HTTPException && error.status < 500) {
      return c.json(
        envelope('invalid_input', 'The request could not be read.', false),
        error.status as 400,
      );
    }
    logger.error('unhandled error', { source: 'http', code: 'internal', correlationId, error });
    return c.json(
      envelope('internal', 'Something went wrong on this computer. Try again.', true, {
        correlationId,
      }),
      500,
    );
  };
}

/** Unknown /api paths answer with the error envelope; anything else falls through to the SPA. */
export const apiNotFound: NotFoundHandler<HttpEnv> = (c) =>
  c.json(envelope('not_found', 'There is nothing at this address.', false), 404);
