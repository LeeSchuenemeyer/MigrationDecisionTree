import { useState, type ReactNode } from 'react';
import type { LeaderboardRow, LedgerEntry, StreakView } from '@shared/types';
import { useLeaderboard, useMemberPoints } from '@/lib/points';
import { useSession } from '@/lib/session';

/**
 * Standings.
 *
 * Two rules this screen exists to make visible, and which it must never
 * quietly break:
 *
 *   1. Pending points are shown but never ranked. A leaderboard that counts
 *      unapproved work is one kids stop trusting the first time a chore gets
 *      sent back and the numbers move backwards.
 *   2. A lapsed streak advertises nothing. The server already zeroes the
 *      multiplier once a streak dies, so a flame on this screen always means a
 *      live one.
 */
export function Points(): ReactNode {
  const session = useSession();
  const board = useLeaderboard();
  const me = session.data?.member ?? null;

  const [selected, setSelected] = useState<string | null>(null);
  const focus = selected ?? me?.id ?? board.data?.rows[0]?.member.id ?? null;
  const detail = useMemberPoints(focus);

  if (board.isPending) return <p className="text-ink-faint p-6 text-sm">Loading standings…</p>;

  if (board.isError) {
    return <p className="text-overdue p-6 text-sm">Could not reach the scoreboard.</p>;
  }

  const rows = board.data?.rows ?? [];

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 kiosk:overflow-hidden kiosk:p-6">
      <h2 className="font-display text-ink-dim text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Standings
      </h2>

      <ol className="flex flex-col gap-2">
        {rows.map((row) => (
          <StandingRow
            key={row.member.id}
            row={row}
            isMe={me?.id === row.member.id}
            isFocused={focus === row.member.id}
            onSelect={() => setSelected(row.member.id)}
          />
        ))}
        {rows.length === 0 && (
          <p className="text-ink-faint py-6 text-center text-sm italic">
            Nobody on the board yet. Points appear once a chore is approved.
          </p>
        )}
      </ol>

      {detail.data && (
        <div className="flex min-h-0 flex-col gap-3">
          <StreakPanel streak={detail.data.streak} name={detail.data.displayName} />
          <LedgerList entries={detail.data.entries} name={detail.data.displayName} />
        </div>
      )}
    </section>
  );
}

function StandingRow({
  row,
  isMe,
  isFocused,
  onSelect,
}: {
  row: LeaderboardRow;
  isMe: boolean;
  isFocused: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={[
          'border-line bg-panel grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-3 rounded-md border px-3 text-left transition-colors',
          'min-h-touch kiosk:min-h-touch-kiosk kiosk:gap-5 kiosk:px-5',
          isFocused ? 'border-brand/60 bg-panel-2' : 'hover:bg-panel-2',
        ].join(' ')}
      >
        <span className="font-display text-ink-faint w-6 text-center text-sm tabular-nums kiosk:text-xl">
          {row.rank}
        </span>
        <span className="text-2xl kiosk:text-4xl" aria-hidden="true">
          {row.member.avatarEmoji}
        </span>

        <span className="min-w-0">
          <span className="block truncate kiosk:text-2xl">
            {row.member.displayName}
            {isMe && <span className="text-ink-faint text-xs kiosk:text-base"> · you</span>}
          </span>
          <span className="text-ink-faint block font-mono text-xs kiosk:text-base">
            {row.streakAlive && row.streakDays > 0 ? (
              <span className="text-brand">
                🔥 {row.streakDays}d
                {row.streakMultiplier > 1 ? ` · ${row.streakMultiplier}×` : ''}
              </span>
            ) : (
              'no streak'
            )}
            {/* Shown, deliberately never ranked. */}
            {row.pendingPoints > 0 && (
              <span className="text-pending"> · +{row.pendingPoints} pending</span>
            )}
          </span>
        </span>

        <span className="text-brand font-mono text-xl tabular-nums kiosk:text-4xl">
          {row.points}
        </span>
      </button>
    </li>
  );
}

function StreakPanel({ streak, name }: { streak: StreakView; name: string }): ReactNode {
  return (
    <div className="border-line bg-panel flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-md border p-3 kiosk:p-5">
      <span className="font-display text-ink-dim text-xs tracking-[0.14em] uppercase kiosk:text-base">
        {name}&rsquo;s streak
      </span>

      {streak.alive && streak.current > 0 ? (
        <span className="text-brand font-mono text-lg tabular-nums kiosk:text-3xl">
          🔥 {streak.current} days · {streak.multiplier}×
        </span>
      ) : (
        <span className="text-ink-faint font-mono text-sm kiosk:text-xl">
          not running — finish everything today to start one
        </span>
      )}

      <span className="text-ink-faint font-mono text-xs kiosk:text-base">
        best {streak.longest}
      </span>

      {/* The nudge is the whole point of showing this: "2 more days" moves
          behaviour in a way a bare number does not. */}
      {streak.alive && streak.daysToNextTier !== null && (
        <span className="text-ink-dim font-mono text-xs kiosk:text-base">
          {streak.daysToNextTier} more {streak.daysToNextTier === 1 ? 'day' : 'days'} →{' '}
          {streak.nextTierMultiplier}×
        </span>
      )}
    </div>
  );
}

function LedgerList({ entries, name }: { entries: LedgerEntry[]; name: string }): ReactNode {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <h3 className="font-display text-ink-dim text-xs tracking-[0.14em] uppercase kiosk:text-base">
        {name} — recent
      </h3>

      {entries.length === 0 && (
        <p className="text-ink-faint text-sm italic">No points yet.</p>
      )}

      {/* Rows arrive newest-first from storage: the row key is inverse ticks,
          so there is no sort here and never should be. */}
      <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {entries.map((e) => (
          <li
            key={e.id}
            className="border-line/60 grid grid-cols-[1fr_auto] items-baseline gap-3 border-b py-1.5 last:border-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm kiosk:text-xl">{e.description}</span>
              <span className="text-ink-faint block font-mono text-[11px] kiosk:text-sm">
                {new Date(e.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
                {' · '}
                {e.kind.replace(/_/g, ' ')}
              </span>
            </span>
            <span
              className={[
                'font-mono tabular-nums kiosk:text-xl',
                e.delta >= 0 ? 'text-approved' : 'text-ink-dim',
              ].join(' ')}
            >
              {e.delta > 0 ? '+' : ''}
              {e.delta}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
