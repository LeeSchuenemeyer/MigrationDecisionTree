import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginResult, Member, SessionInfo } from '@shared/types';
import { api, ApiError } from './api';
import { applyDeviceKind } from './surface';

export const sessionKey = ['session'] as const;
export const membersKey = ['members'] as const;

/**
 * Session state.
 *
 * `GET /api/auth/me` never 401s — a signed-out, unenrolled browser is the
 * wall tablet's normal resting state, not an error — so this query has no
 * error branch to render.
 */
export function useSession() {
  const query = useQuery({
    queryKey: sessionKey,
    queryFn: () => api.get<SessionInfo>('/auth/me'),
    staleTime: 30_000,
  });

  // Let an enrolled kiosk device override the pre-paint surface heuristic.
  useEffect(() => {
    if (query.data) applyDeviceKind(query.data.deviceKind);
  }, [query.data]);

  return query;
}

export function useMembers() {
  return useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.get<{ members: Member[] }>('/members')).members,
    staleTime: 60_000,
  });
}

export interface LoginError {
  message: string;
  retryAfterSeconds: number | null;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation<LoginResult, LoginError, { memberId: string; pin: string }>({
    mutationFn: async (vars) => {
      try {
        return await api.post<LoginResult>('/auth/login', vars);
      } catch (e) {
        if (e instanceof ApiError) {
          const body = e.body as { retryAfterSeconds?: number } | null;
          throw { message: e.message, retryAfterSeconds: body?.retryAfterSeconds ?? null };
        }
        throw { message: 'Could not reach the board.', retryAfterSeconds: null };
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKey });
      void qc.invalidateQueries({ queryKey: membersKey });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKey }),
  });
}

/**
 * Live countdown for the session chip.
 *
 * Ticks locally rather than polling — the server is the authority on expiry,
 * but asking it every second to render a clock would be absurd.
 */
export function useSessionCountdown(expiresInSeconds: number | null): number | null {
  const qc = useQueryClient();

  useEffect(() => {
    if (expiresInSeconds === null) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const left = expiresInSeconds - Math.floor((Date.now() - started) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        void qc.invalidateQueries({ queryKey: sessionKey });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresInSeconds, qc]);

  return expiresInSeconds;
}
