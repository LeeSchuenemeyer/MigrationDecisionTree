import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getHealth } from '@/lib/api';

/**
 * Phase 0 placeholder. The three-column scoreboard lands across Phases 2–4;
 * for now this proves the full stack is wired: SPA route → /api → Table Storage.
 */
export function Board(): ReactNode {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, retry: false });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <p className="font-display text-brand text-xs tracking-[0.18em] uppercase">Phase 0</p>
      <h1 className="font-display text-3xl tracking-wide uppercase kiosk:text-6xl">
        The board is wired up
      </h1>
      <p className="text-ink-dim max-w-prose text-sm kiosk:text-lg">
        Deploy pipeline, surface detection, and the API round-trip are in place. Chores,
        points, the ticker, and the calendar land in the phases that follow.
      </p>

      <dl className="border-line bg-panel mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border p-5 text-left font-mono text-sm">
        <dt className="text-ink-faint">API</dt>
        <dd>
          {health.isPending && <span className="text-ink-dim">checking…</span>}
          {health.isError && <span className="text-overdue">unreachable</span>}
          {health.data && <span className="text-approved">ok · v{health.data.version}</span>}
        </dd>

        <dt className="text-ink-faint">Storage</dt>
        <dd>
          {health.data ? (
            <span className={health.data.storage === 'ok' ? 'text-approved' : 'text-overdue'}>
              {health.data.storage}
            </span>
          ) : (
            <span className="text-ink-dim">—</span>
          )}
        </dd>

        <dt className="text-ink-faint">Household</dt>
        <dd>{health.data?.householdId ?? '—'}</dd>

        <dt className="text-ink-faint">Local date</dt>
        <dd>
          {health.data ? `${health.data.localDate} (${health.data.timezone})` : '—'}
        </dd>
      </dl>

      {health.isError && (
        <p className="text-ink-faint max-w-prose text-xs">
          Not reachable from the Vite dev server on :5173 — the API is only proxied by the
          SWA CLI. Run <code className="text-ink-dim">swa start</code> and use :4280.
        </p>
      )}
    </div>
  );
}
