import type { HttpResponseInit } from '@azure/functions';

/** Consistent JSON responses, so the web client's error handling has one shape. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponseInit {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    jsonBody: body,
  };
}

export function error(message: string, status: number, extra: Record<string, unknown> = {}): HttpResponseInit {
  return json({ error: message, ...extra }, status);
}

export const badRequest = (m = 'Bad request') => error(m, 400);
export const unauthorized = (m = 'Sign in first') => error(m, 401);
export const forbidden = (m = 'Not allowed') => error(m, 403);
export const notFound = (m = 'Not found') => error(m, 404);
export const conflict = (m = 'Conflict') => error(m, 409);

/** 429 with the wait time the client should honor. */
export const tooManyRequests = (retryAfterSeconds: number, m = 'Too many attempts') =>
  json({ error: m, retryAfterSeconds }, 429, { 'retry-after': String(retryAfterSeconds) });

/** 304-able response: returns Not Modified when the client's ETag still matches. */
export function withETag(
  body: unknown,
  etag: string,
  ifNoneMatch: string | null | undefined,
): HttpResponseInit {
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { status: 304, headers: { etag } };
  }
  return json(body, 200, { etag, 'cache-control': 'no-cache' });
}
