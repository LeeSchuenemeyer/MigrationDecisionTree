import { type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { useClaudeStatus, useUpdateClaudeSettings } from '@/lib/claude';
import { useForceSync, useGoogleStatus, useRestoreEvent } from '@/lib/calendar';
import { formatBytes, timeAgo, useOps, useReconcile, type JobStatus } from '@/lib/ops';

/**
 * The parent screen.
 *
 * Deliberately one scrolling page rather than tabs. It is visited roughly
 * monthly, usually because something looks wrong, and the fastest way to answer
 * "is this thing healthy" is for everything to be visible at once.
 *
 * Nothing here is on the kiosk's critical path. It is reachable from the wall
 * tablet, but it is written for a phone or a laptop — which is where a parent
 * actually is when they care about any of this.
 */
export function Settings(): ReactNode {
  const session = useSession();
  const isParent = session.data?.member?.role === 'parent';

  const ops = useOps(isParent);
  const claude = useClaudeStatus();
  const google = useGoogleStatus();

  if (!isParent) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-ink-dim text-sm kiosk:text-xl">
          Settings are for parents. Tap a parent avatar at the top to sign in.
        </p>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4 kiosk:p-6">
      <h2 className="font-display text-ink-dim text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Settings &amp; health
      </h2>

      <Generated />

      <Panel
        title="Running costs"
        note={
          ops.data
            ? `At most about $${ops.data.claude.estimatedMonthlyUsd.toFixed(2)} a month — that is every job hitting its daily cap every day, which no household does.`
            : undefined
        }
      >
        {!ops.data?.claude.configured && (
          <p className="text-ink-faint text-xs kiosk:text-base">
            No Anthropic key configured. Everything still works — the ticker uses hand-written
            copy and badges get deterministic names.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {(ops.data?.claude.budget ?? []).map((line) => (
            <li key={line.job} className="flex items-center gap-3">
              <span className="text-ink-dim w-24 text-xs kiosk:w-36 kiosk:text-base">{line.job}</span>
              <span className="bg-panel-2 h-2 flex-1 overflow-hidden rounded-full">
                <span
                  className="bg-brand block h-full rounded-full"
                  style={{ width: `${Math.min(100, (line.used / line.cap) * 100)}%` }}
                />
              </span>
              <span className="text-ink-faint w-16 text-right font-mono text-xs tabular-nums kiosk:text-base">
                {line.used}/{line.cap}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-ink-faint text-xs kiosk:text-base">
          Caps are daily and reset overnight. Hitting one is not an error: generation falls
          back to hand-written copy and nothing on screen breaks.
        </p>
      </Panel>

      <Panel
        title="Calendar conflicts"
        note="Something was changed in Google after it was changed here. Google won — this puts your version back."
      >
        <Conflicts events={ops.data?.conflicts ?? []} />
        {google.data?.connected && (
          <ForceSyncButton />
        )}
      </Panel>

      <Panel
        title="Flagged lines"
        note="Everything a parent took down with “that wasn’t ok”, so the rubric can be tuned rather than argued with."
      >
        {(ops.data?.incidents ?? []).length === 0 ? (
          <Empty>Nothing has been flagged.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {(ops.data?.incidents ?? []).map((incident) => (
              <li key={incident.id} className="border-line bg-ground rounded-md border p-3">
                <p className="text-sm kiosk:text-lg">{incident.commentary ?? incident.headline}</p>
                <p className="text-ink-faint mt-1 font-mono text-xs kiosk:text-base">
                  {incident.reason} · {timeAgo(incident.reportedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Scheduled jobs"
        note="Driven by a GitHub Actions schedule, which is best-effort. Nothing here is load-bearing: chores and the calendar both also update when someone opens the app."
      >
        <Jobs jobs={ops.data?.jobs ?? []} />
        <ReconcileButton />
      </Panel>

      <Panel title="Backups" note="A nightly snapshot of everything except sessions. Kept 60 days.">
        {(ops.data?.backups ?? []).length === 0 ? (
          <Empty>No snapshots yet — the first runs on the next nightly tick.</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {(ops.data?.backups ?? []).map((b) => (
              <li key={b.name} className="text-ink-dim flex justify-between font-mono text-xs kiosk:text-base">
                <span className="truncate">{b.name}</span>
                <span className="text-ink-faint shrink-0 tabular-nums">{formatBytes(b.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {claude.isPending && ops.isPending && (
        <p className="text-ink-faint text-sm">Loading…</p>
      )}
    </section>
  );
}

/** The two product-level controls over generated text. */
function Generated(): ReactNode {
  const status = useClaudeStatus();
  const update = useUpdateClaudeSettings();

  return (
    <Panel
      title="Generated text"
      note="Turning commentary off leaves a facts-only ticker. Nothing breaks and nothing disappears — the lines just stop being witty."
    >
      <Toggle
        label="Ticker commentary"
        checked={status.data?.enabled ?? true}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ commentaryEnabled: v })}
      />
      <Toggle
        label="Daily challenge"
        checked={status.data?.challengeEnabled ?? true}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ challengeEnabled: v })}
      />
    </Panel>
  );
}

function Conflicts({ events }: { events: { id: string; googleEventId: string; title: string }[] }): ReactNode {
  const restore = useRestoreEvent();

  if (events.length === 0) return <Empty>No conflicts.</Empty>;

  return (
    <ul className="flex flex-col gap-2">
      {events.map((event) => (
        <li key={event.id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm kiosk:text-lg">{event.title}</span>
          <button
            type="button"
            disabled={restore.isPending}
            onClick={() => restore.mutate(event.googleEventId)}
            className="border-pending text-pending hover:bg-pending hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display shrink-0 rounded-full border px-4 text-[10px] tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-sm"
          >
            Use mine
          </button>
        </li>
      ))}
    </ul>
  );
}

function Jobs({ jobs }: { jobs: JobStatus[] }): ReactNode {
  if (jobs.length === 0) {
    return <Empty>The tick has not run yet. See docs/SETUP-TODO.md §5.</Empty>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {jobs.map((job) => (
        <li key={job.job} className="flex items-baseline justify-between gap-3">
          <span className="text-ink-dim text-sm kiosk:text-lg">{job.job}</span>
          <span className="text-ink-faint font-mono text-xs tabular-nums kiosk:text-base">
            {timeAgo(job.lastRunAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReconcileButton(): ReactNode {
  const reconcile = useReconcile();

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={reconcile.isPending}
        onClick={() => reconcile.mutate()}
        className="border-line text-ink-dim hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk font-display self-start rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-base"
      >
        {reconcile.isPending ? 'Checking…' : 'Check points now'}
      </button>
      {reconcile.data && (
        <p className="text-ink-faint text-xs kiosk:text-base">
          {reconcile.data.drift.length === 0
            ? `Checked ${reconcile.data.checked} — every balance matches the ledger.`
            : `Corrected ${reconcile.data.drift.length} of ${reconcile.data.checked}.`}
        </p>
      )}
    </div>
  );
}

function ForceSyncButton(): ReactNode {
  const sync = useForceSync();

  return (
    <button
      type="button"
      disabled={sync.isPending}
      onClick={() => sync.mutate()}
      className="border-line text-ink-dim hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk font-display self-start rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-base"
    >
      {sync.isPending ? 'Syncing…' : 'Sync calendar now'}
    </button>
  );
}

// ---------------------------------------------------------------------------

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-line bg-panel flex flex-col gap-3 rounded-md border p-4 kiosk:gap-4 kiosk:p-6">
      <h3 className="font-display text-ink-dim text-xs tracking-[0.14em] uppercase kiosk:text-base">
        {title}
      </h3>
      {note && <p className="text-ink-faint max-w-prose text-xs kiosk:text-base">{note}</p>}
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}): ReactNode {
  return (
    <label className="min-h-touch kiosk:min-h-touch-kiosk flex items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-brand h-5 w-5 kiosk:h-7 kiosk:w-7"
      />
      <span className="text-sm kiosk:text-xl">{label}</span>
    </label>
  );
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-ink-faint text-xs italic kiosk:text-base">{children}</p>;
}
