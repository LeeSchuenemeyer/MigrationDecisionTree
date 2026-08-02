import type { HttpRequest } from '@azure/functions';

/**
 * Minimal stand-in for the parts of HttpRequest our auth layer touches.
 *
 * The real class is constructed by the Functions host and is awkward to build
 * by hand; everything under test reads cookies via `headers.get('cookie')` and
 * nothing else, so this is a faithful surface rather than a mock of behavior.
 */
export function fakeRequest(options: { cookies?: Record<string, string>; body?: unknown } = {}): HttpRequest {
  const cookieHeader = Object.entries(options.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const headers = new Map<string, string>();
  if (cookieHeader) headers.set('cookie', cookieHeader);

  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    params: {},
    query: new URLSearchParams(),
    json: async () => options.body,
  } as unknown as HttpRequest;
}

/** Extract a cookie value from a Set-Cookie string produced by lib/auth. */
export function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=').slice(1).join('=');
}
