import type { ReactNode } from 'react';
import type { TaskInstance } from '@shared/types';

/**
 * One chore.
 *
 * Status is encoded twice on purpose — a coloured left stripe *and* a distinct
 * treatment — because this is read from across a kitchen, not up close, and
 * colour alone is neither big enough at that distance nor accessible.
 *
 * Pending is deliberately visually distinct from approved: the points show as
 * "+15 pending" and never fold into the ranked total, so the board never
 * implies work has been credited when a parent has not looked at it yet.
 */
export function TaskCard({
  task,
  canComplete,
  onComplete,
}: {
  task: TaskInstance;
  canComplete: boolean;
  onComplete: () => void;
}): ReactNode {
  const state = task.overdue && task.status === 'open' ? 'overdue' : task.status;
  const done = task.status === 'approved';
  const pending = task.status === 'pending';

  const stripe =
    state === 'overdue'
      ? 'border-l-overdue'
      : pending
        ? 'border-l-pending'
        : done
          ? 'border-l-approved'
          : 'border-l-ink-faint';

  const sub = pending
    ? 'waiting on a parent'
    : done
      ? 'approved'
      : state === 'overdue'
        ? `overdue${task.dueTimeLocal ? ` since ${task.dueTimeLocal}` : ''}`
        : task.dueTimeLocal
          ? `by ${task.dueTimeLocal}`
          : 'today';

  return (
    <button
      type="button"
      disabled={!canComplete || pending || done}
      onClick={onComplete}
      data-status={state}
      className={[
        'border-line bg-panel grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border border-l-[3px] px-3 text-left transition-colors',
        'min-h-touch kiosk:min-h-touch-kiosk kiosk:gap-5 kiosk:px-5',
        stripe,
        pending ? 'border-dashed bg-pending/10' : '',
        canComplete && !pending && !done ? 'hover:bg-panel-2 active:scale-[0.99]' : '',
        !canComplete && !pending && !done ? 'opacity-45' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'grid size-6 place-items-center rounded border-2 text-sm kiosk:size-10 kiosk:text-xl',
          done
            ? 'border-approved bg-approved text-ground'
            : pending
              ? 'border-pending text-pending'
              : 'border-ink-faint',
        ].join(' ')}
      >
        {done ? '✓' : pending ? '⏳' : ''}
      </span>

      <span className="min-w-0">
        <span
          className={[
            'block truncate kiosk:text-2xl',
            done ? 'text-ink-dim line-through' : '',
          ].join(' ')}
        >
          {task.icon ? `${task.icon} ` : ''}
          {task.title}
        </span>
        <span
          className={[
            'block font-mono text-xs kiosk:text-base',
            state === 'overdue' ? 'text-overdue' : 'text-ink-faint',
          ].join(' ')}
        >
          {sub}
          {task.assignedMemberName ? ` · ${task.assignedMemberName}` : ''}
        </span>
      </span>

      <span
        className={[
          'font-mono tabular-nums whitespace-nowrap kiosk:text-2xl',
          pending ? 'text-pending' : done ? 'text-approved' : 'text-brand',
        ].join(' ')}
      >
        {pending ? '+' : ''}
        {/* Once tapped, show what it is actually worth — base × wildcard ×
            streak, snapshotted at completion. Before then only the wildcard is
            known for certain, so an untouched chore shows its face value and
            the streak bonus arrives as an upward surprise. */}
        {task.awardedPoints ?? task.computedPoints ?? task.basePoints}
        {task.multiplier > 1 && task.computedPoints === null ? ` ×${task.multiplier}` : ''}
      </span>
    </button>
  );
}
