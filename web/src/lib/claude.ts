import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Achievement } from '@shared/types';
import { api } from './api';
import { tickerKey } from './pulse';

/**
 * Generated-content controls and reads.
 *
 * Everything here degrades to nothing: with no API key the status endpoint
 * reports `configured: false`, the challenge falls back to a hand-written line,
 * and the trophy case shows badges named by the deterministic namer. No screen
 * in the app has an error state for Claude being unavailable, because there is
 * nothing a child in a kitchen can do about one.
 */

export const claudeStatusKey = ['claude-status'] as const;
export const challengeKey = ['challenge'] as const;
export const achievementsKey = (memberId: string) => ['achievements', memberId] as const;

export interface ClaudeStatus {
  configured: boolean;
  enabled: boolean;
  challengeEnabled: boolean;
  budget: { job: string; used: number; cap: number }[];
}

export interface Challenge {
  date: string;
  text: string;
  source: 'claude' | 'fallback';
}

export function useClaudeStatus() {
  return useQuery({
    queryKey: claudeStatusKey,
    queryFn: () => api.get<ClaudeStatus>('/claude/status'),
    staleTime: 60_000,
  });
}

export function useChallenge() {
  return useQuery({
    queryKey: challengeKey,
    queryFn: async () => (await api.get<{ challenge: Challenge | null }>('/challenge')).challenge,
    staleTime: 5 * 60_000,
  });
}

export function useAchievements(memberId: string | null) {
  return useQuery({
    queryKey: achievementsKey(memberId ?? ''),
    queryFn: async () =>
      (await api.get<{ achievements: Achievement[] }>(`/achievements/${encodeURIComponent(memberId!)}`))
        .achievements,
    enabled: memberId !== null,
  });
}

/**
 * "That wasn't ok."
 *
 * Optimistic on purpose, and the only optimistic mutation in the app that is
 * not about speed: the line is on a kitchen wall right now, so it comes off the
 * client's copy the instant the button is pressed and the server catches up.
 * A failed request is worth a silent retry-on-refetch; making a parent wait to
 * see it disappear is not.
 */
export function useSuppressFeedItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; date?: string; reason?: string }) =>
      api.post(`/feed/${encodeURIComponent(vars.id)}/suppress`, {
        date: vars.date,
        reason: vars.reason,
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: tickerKey });
      const previous = qc.getQueryData(tickerKey);
      qc.setQueryData(tickerKey, (old: { id: string }[] | undefined) =>
        old?.filter((item) => item.id !== `feed:${vars.id}`),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(tickerKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: tickerKey });
    },
  });
}

export function useUpdateClaudeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { commentaryEnabled?: boolean; challengeEnabled?: boolean }) =>
      api.post('/claude/settings', vars),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: claudeStatusKey });
      void qc.invalidateQueries({ queryKey: tickerKey });
      void qc.invalidateQueries({ queryKey: challengeKey });
    },
  });
}
