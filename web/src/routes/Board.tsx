import { useMemo, type ReactNode } from 'react';
import type { Member, TaskInstance } from '@shared/types';
import { useCompleteTask, useTasks } from '@/lib/tasks';
import { useMembers, useSession } from '@/lib/session';
import { useSurface } from '@/lib/surface';
import { TaskCard } from '@/components/TaskCard';
import { useChallenge } from '@/lib/claude';

/**
 * Today's board.
 *
 * On the kiosk this is the middle column of the scoreboard and never scrolls;
 * on a phone it is the whole screen. Chores are grouped by person because that
 * is how a family reads a chore board — "what do I still have to do" beats a
 * flat chronological list.
 */
export function Board(): ReactNode {
  const surface = useSurface();
  const session = useSession();
  const members = useMembers();
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const tasks = useTasks(today);
  const complete = useCompleteTask(today, today);
  const challenge = useChallenge();

  const me = session.data?.member ?? null;

  const grouped = useMemo(() => {
    const list = tasks.data?.tasks ?? [];
    const byMember = new Map<string, TaskInstance[]>();
    for (const t of list) {
      const key = t.assignedMemberId;
      const arr = byMember.get(key) ?? [];
      arr.push(t);
      byMember.set(key, arr);
    }
    return byMember;
  }, [tasks.data]);

  const order = useMemo(() => {
    const list = members.data ?? [];
    // Whoever is signed in floats to the top — on a shared display the person
    // standing there cares about their own chores first.
    return [...list].sort((a, b) => {
      if (me && a.id === me.id) return -1;
      if (me && b.id === me.id) return 1;
      return a.sortOrder - b.sortOrder;
    });
  }, [members.data, me]);

  const remaining = (tasks.data?.tasks ?? []).filter(
    (t) => t.status === 'open' || t.status === 'expired',
  ).length;

  if (tasks.isPending) {
    return <p className="text-ink-faint p-6 text-sm">Loading the board…</p>;
  }

  if (tasks.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-overdue text-sm">Could not reach the board.</p>
        <p className="text-ink-faint max-w-prose text-xs">
          If you are running locally, use <code className="text-ink-dim">swa start</code> on
          port 4280 — the Vite dev server alone does not proxy the API.
        </p>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4 kiosk:p-6">
      <h2 className="font-display text-ink-dim flex items-baseline justify-between text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Today&rsquo;s board
        <span className="text-ink-faint font-mono text-xs tracking-normal kiosk:text-base">
          {remaining} left
        </span>
      </h2>

      {/* One goal for the whole family. Present whether or not generation is
          available — there are 30 hand-written challenges behind it. */}
      {challenge.data && (
        <div className="border-line border-l-brand bg-panel flex items-center gap-3 rounded-md border border-l-[3px] px-3 py-2 kiosk:px-5 kiosk:py-3">
          <span aria-hidden="true" className="text-lg kiosk:text-3xl">
            🎯
          </span>
          <span className="min-w-0">
            <span className="font-display text-ink-faint block text-[10px] tracking-[0.14em] uppercase kiosk:text-sm">
              Today&rsquo;s challenge
              {challenge.data.source === 'claude' && ' · Claude'}
            </span>
            <span className="block truncate text-sm kiosk:text-xl">{challenge.data.text}</span>
          </span>
        </div>
      )}

      <div
        className={[
          'flex min-h-0 flex-col gap-2',
          // The kiosk never scrolls; a phone does.
          surface === 'kiosk' ? 'overflow-hidden' : 'overflow-y-auto',
        ].join(' ')}
      >
        {order.map((member) => {
          const mine = grouped.get(member.id) ?? [];
          const unclaimed = member.id === order[0]?.id ? (grouped.get('*') ?? []) : [];
          const all = [...mine, ...unclaimed];
          if (all.length === 0) return null;

          return (
            <MemberGroup
              key={member.id}
              member={member}
              tasks={all}
              canComplete={me?.id === member.id || me?.role === 'parent'}
              onComplete={(t) => complete.mutate({ date: today, instanceId: t.id })}
            />
          );
        })}

        {(tasks.data?.tasks.length ?? 0) === 0 && (
          <p className="text-ink-faint py-6 text-center text-sm italic">
            Nothing on the board today. Add chores from the Tasks screen.
          </p>
        )}
      </div>
    </section>
  );
}

function MemberGroup({
  member,
  tasks,
  canComplete,
  onComplete,
}: {
  member: Member;
  tasks: TaskInstance[];
  canComplete: boolean;
  onComplete: (t: TaskInstance) => void;
}): ReactNode {
  return (
    // `group`, not `region`: five landmarks on one screen is landmark spam,
    // but the chores still need to be attributable to a person when the visual
    // grouping is not available.
    <div role="group" aria-label={`${member.displayName}'s chores`} className="flex flex-col gap-1.5">
      <div className="font-display text-ink-faint flex items-center gap-2 pt-1 text-xs tracking-[0.12em] uppercase kiosk:text-base">
        <span aria-hidden="true">{member.avatarEmoji}</span>
        {member.displayName}
        {member.pendingPoints > 0 && (
          <span className="text-pending font-mono tracking-normal normal-case">
            +{member.pendingPoints} pending
          </span>
        )}
      </div>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} canComplete={canComplete} onComplete={() => onComplete(t)} />
      ))}
    </div>
  );
}
