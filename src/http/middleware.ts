import crypto from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { errorResponse } from './errors.js';

export function authMiddleware(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (!config.apiKey) {
      await next();
      return;
    }

    const header = c.req.header('authorization') ?? '';
    const prefix = 'Bearer ';
    const candidate = header.startsWith(prefix) ? header.slice(prefix.length) : '';

    if (!timingSafeEqual(candidate, config.apiKey)) {
      return errorResponse(c, 401, 'unauthorized', 'unauthorized');
    }

    await next();
  };
}

export function requestLoggingMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    const path = new URL(c.req.url).pathname;
    const started = performance.now();

    try {
      await next();
    } finally {
      c.header('x-request-id', requestId);
      if (path === '/v1/health') {
        return;
      }
      logger.info(
        {
          method: c.req.method,
          path,
          status: c.res.status,
          durationMs: Math.round(performance.now() - started),
          requestId
        },
        'request'
      );
    }
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(right, right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
