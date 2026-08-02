import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueueItem, TaskInstance } from '@shared/types';
import { api } from './api';
import { membersKey, sessionKey } from './session';

export const tasksKey = (from: string, to: string) => ['tasks', from, to] as const;
export const queueKey = ['queue'] as const;

interface TasksResponse {
  tasks: TaskInstance[];
  from: string;
  to: string;
  today: string;
}

export function useTasks(from: string, to: string = from) {
  return useQuery({
    queryKey: tasksKey(from, to),
    queryFn: () => api.get<TasksResponse>(`/tasks?from=${from}&to=${to}`),
  });
}

export function useQueue() {
  return useQuery({
    queryKey: queueKey,
    queryFn: async () => (await api.get<{ items: QueueItem[] }>('/queue')).items,
  });
}

/**
 * Tap a chore.
 *
 * Optimistic, because on a wall tablet the checkmark has to land the instant a
 * finger lifts — waiting on a round trip reads as a missed tap and people tap
 * again. The rollback on error matters just as much: a flaky tablet must not
 * leave a chore looking done when the server never heard about it.
 */
export function useCompleteTask(from: string, to: string) {
  const qc = useQueryClient();
  const key = tasksKey(from, to);

  return useMutation({
    mutationFn: (vars: { date: string; instanceId: string }) =>
      api.post<{ task: TaskInstance }>('/tasks/complete', vars),

    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TasksResponse>(key);

      qc.setQueryData<TasksResponse>(key, (old) =>
        old
          ? {
              ...old,
              tasks: old.tasks.map((t) =>
                t.id === vars.instanceId && t.dueDateLocal === vars.date
                  ? { ...t, status: 'pending' as const, overdue: false }
                  : t,
              ),
            }
          : old,
      );

      return { previous };
    },

    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: membersKey });
    },
  });
}

export function useResolveQueueItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; action: 'approve' | 'reject'; note?: string }) =>
      api.post(`/queue/${encodeURIComponent(vars.id)}/${vars.action}`, { note: vars.note }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: membersKey });
      void qc.invalidateQueries({ queryKey: sessionKey });
    },
  });
}
