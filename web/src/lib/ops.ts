import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentaryIncident } from '@shared/types';
import { api } from './api';
import type { CalendarEvent } from './calendar';

/**
 * The operations view.
 *
 * One request, not five. The question a parent has is "is this thing healthy",
 * and answering it across five endpoints means five loading states on a screen
 * nobody opens twice a month. Every section degrades to empty rather than
 * failing the request — a settings screen that errors because the calendar is
 * disconnected is a settings screen that cannot reconnect the calendar.
 */

export const opsKey = ['ops'] as const;

export interface BudgetLine {
  job: string;
  used: number;
  cap: number;
}

export interface JobStatus {
  job: string;
  lastRunDate: string | null;
  lastRunAt: string | null;
  lastResult: unknown;
}

export interface BackupSummary {
  name: string;
  takenAt: string | null;
  bytes: number;
}

export interface OpsSummary {
  claude: { configured: boolean; budget: BudgetLine[]; estimatedMonthlyUsd: number };
  jobs: JobStatus[];
  conflicts: CalendarEvent[];
  incidents: CommentaryIncident[];
  backups: BackupSummary[];
}

export function useOps(enabled: boolean) {
  return useQuery({
    queryKey: opsKey,
    queryFn: () => api.get<OpsSummary>('/ops'),
    enabled,
    staleTime: 30_000,
  });
}

export function useReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ checked: number; drift: unknown[] }>('/ops/reconcile'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: opsKey });
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

/** Bytes → something a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How long ago, in words.
 *
 * The useful reading of a job timestamp is "has this run recently", not the
 * exact minute — and "3 days ago" makes a stalled tick obvious in a way that a
 * date string does not.
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
