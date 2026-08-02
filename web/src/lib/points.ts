import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaderboardRow, LedgerEntry, Redemption, Reward, StreakView } from '@shared/types';
import { api } from './api';
import { membersKey, sessionKey } from './session';
import { queueKey } from './tasks';

export const leaderboardKey = ['leaderboard'] as const;
export const rewardsKey = ['rewards'] as const;
export const memberPointsKey = (memberId: string, month?: string) =>
  ['points', memberId, month ?? 'current'] as const;

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  today: string;
}

export interface MemberPointsResponse {
  memberId: string;
  displayName: string;
  pointsBalance: number;
  pendingPoints: number;
  lifetimePoints: number;
  entries: LedgerEntry[];
  streak: StreakView;
  redemptions: Redemption[];
}

export function useLeaderboard() {
  return useQuery({
    queryKey: leaderboardKey,
    queryFn: () => api.get<LeaderboardResponse>('/leaderboard'),
  });
}

/**
 * One member's month: ledger, streak, and redemption history in a single call.
 *
 * Deliberately one endpoint rather than three — the three reads are all point
 * queries against partitions the server already has to touch, and a wall tablet
 * making three round trips to render one panel is the thing the pulse design
 * exists to avoid.
 */
export function useMemberPoints(memberId: string | null, month?: string) {
  return useQuery({
    queryKey: memberPointsKey(memberId ?? '', month),
    queryFn: () =>
      api.get<MemberPointsResponse>(
        `/points/${encodeURIComponent(memberId!)}${month ? `?month=${month}` : ''}`,
      ),
    enabled: memberId !== null,
  });
}

export function useRewards() {
  return useQuery({
    queryKey: rewardsKey,
    queryFn: async () => (await api.get<{ rewards: Reward[] }>('/rewards')).rewards,
  });
}

/**
 * Redeem.
 *
 * Not optimistic, unlike completing a chore. A chore tap has to feel instant
 * and is trivially reversible; spending points is neither — showing a balance
 * drop that then bounces back because the server refused would be worse than a
 * half-second wait.
 */
export function useRedeem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rewardId: string) =>
      api.post<{ redemptionId: string; cost: number }>(
        `/rewards/${encodeURIComponent(rewardId)}/redeem`,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: rewardsKey });
      void qc.invalidateQueries({ queryKey: leaderboardKey });
      void qc.invalidateQueries({ queryKey: ['points'] });
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: membersKey });
      void qc.invalidateQueries({ queryKey: sessionKey });
    },
  });
}
