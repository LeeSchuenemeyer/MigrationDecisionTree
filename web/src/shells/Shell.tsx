import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useSurface } from '@/lib/surface';
import { usePulse } from '@/lib/pulse';
import { SessionControl } from '@/components/SessionControl';
import { Ticker } from '@/components/Ticker';

/**
 * The surface shells.
 *
 * Density alone is not enough to serve a wall tablet and a phone from one
 * codebase — the information architecture genuinely differs. Shared leaf
 * components scale in place via the `kiosk:` variant; the composition is
 * swapped here.
 */

const NAV = [
  { to: '/', label: 'Board', end: true },
  { to: '/calendar', label: 'Calendar', end: false },
  { to: '/points', label: 'Points', end: false },
  { to: '/rewards', label: 'Rewards', end: false },
  { to: '/queue', label: 'Approvals', end: false },
  { to: '/me', label: 'Me', end: false },
] as const;

export function Shell(): ReactNode {
  const surface = useSurface();

  // Mounted once, here, for the whole app. This is the ONLY thing that polls;
  // every other query sits at staleTime: Infinity and is invalidated by what
  // this returns. See lib/pulse.ts.
  usePulse();

  if (surface === 'kiosk') return <KioskShell />;
  if (surface === 'desktop') return <DesktopShell />;
  return <MobileShell />;
}

/**
 * Wall tablet: fixed viewport, nothing scrolls anywhere, no navigation chrome,
 * ticker pinned to the bottom edge. Everything the family needs is on screen at
 * once — walking past it must be enough.
 */
function KioskShell(): ReactNode {
  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto] overflow-hidden">
      <TopBar />
      <main className="min-h-0 overflow-hidden">
        <Outlet />
      </main>
      <TickerSlot />
    </div>
  );
}

/** Phone: bottom tab bar, each tab scrolls independently, safe-area insets. */
function MobileShell(): ReactNode {
  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto_auto]">
      <TopBar />
      <main className="min-h-0 overflow-y-auto">
        <Outlet />
      </main>
      <Ticker />
      <nav
        className="border-line bg-panel flex justify-around border-t"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              [
                'min-h-touch flex flex-1 items-center justify-center px-2 font-display text-xs tracking-[0.12em] uppercase',
                isActive ? 'text-brand' : 'text-ink-faint',
              ].join(' ')
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Laptop: sidebar nav. The only surface where parent-admin work is comfortable. */
function DesktopShell(): ReactNode {
  return (
    <div className="grid h-full grid-cols-[190px_1fr]">
      <aside className="border-line bg-panel flex flex-col gap-1 border-r p-4">
        <div className="font-display text-brand mb-4 text-sm tracking-[0.18em] uppercase">
          Family HQ
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              [
                'min-h-touch flex items-center rounded px-3 font-display text-sm tracking-[0.12em] uppercase',
                isActive ? 'bg-panel-2 text-brand' : 'text-ink-dim hover:text-ink',
              ].join(' ')
            }
          >
            {n.label}
          </NavLink>
        ))}
      </aside>
      <div className="grid grid-rows-[auto_1fr] overflow-hidden">
        <TopBar />
        <main className="min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function TopBar(): ReactNode {
  return (
    <header className="border-line bg-panel flex items-center justify-between gap-4 border-b px-5 py-3">
      <div className="font-display flex items-center gap-2 text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        <span className="bg-approved inline-block size-2 rounded-full" />
        Family HQ
      </div>
      <Clock />
      <SessionControl />
    </header>
  );
}

function Clock(): ReactNode {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick on the minute boundary rather than every second — the display shows
    // minutes, and a wall tablet should not wake once a second to redraw.
    const tick = () => setNow(new Date());
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <div className="text-center leading-tight">
      <div className="font-mono text-lg tabular-nums kiosk:text-3xl">
        {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="font-display text-ink-dim text-[10px] tracking-[0.14em] uppercase kiosk:text-sm">
        {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  );
}

function TickerSlot(): ReactNode {
  return <Ticker />;
}
