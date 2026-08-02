/**
 * Thin fetch wrapper for the Functions API.
 *
 * Every request is same-origin and carries the session/device cookies, which is
 * why development must go through the SWA CLI on :4280 rather than Vite on
 * :5173 — only the CLI proxies /api and preserves same-origin cookie behavior.
 */

export class ApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) }),
  patch: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'PATCH', body: payload === undefined ? undefined : JSON.stringify(payload) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface HealthResponse {
  ok: boolean;
  version: string;
  householdId: string;
  timezone: string;
  localDate: string;
  storage: 'ok' | 'unconfigured' | 'error';
}

export const getHealth = () => api.get<HealthResponse>('/health');
