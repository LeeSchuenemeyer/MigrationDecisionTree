import type { ReactNode } from 'react';

/** Reserved routes, so deep links and the nav work from Phase 0 onward. */
export function Placeholder({ title, phase }: { title: string; phase: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="font-display text-brand text-xs tracking-[0.18em] uppercase">{phase}</p>
      <h1 className="font-display text-2xl tracking-wide uppercase kiosk:text-4xl">{title}</h1>
      <p className="text-ink-faint text-sm">Not built yet.</p>
    </div>
  );
}
