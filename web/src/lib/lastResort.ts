/**
 * The net under the error boundary.
 *
 * A React error boundary catches render-phase errors and nothing else. The
 * failures that actually leave a wall tablet on a white screen are the ones it
 * cannot see: a chunk that fails to load after a deploy, a throw during module
 * evaluation before React mounts at all, an unhandled rejection in a background
 * effect. "The boundary handles it" is true and insufficient.
 *
 * So: a window-level listener that reloads the kiosk, with two rules that keep
 * it from becoming the problem.
 *
 *   1. Only reload if the app never mounted, or a hard reload is the only
 *      remedy. A stray rejection from a failed fetch must not restart a page
 *      somebody is typing into.
 *   2. Never reload more than once in a REARM_MS window. A fault that survives
 *      the reload would otherwise reload forever, which on a wall display looks
 *      exactly like a dead tablet and burns bandwidth all night.
 */

const RELOAD_DELAY_MS = 30_000;
const REARM_MS = 10 * 60_000;
const STAMP_KEY = 'fd.lastAutoReload';

function recentlyReloaded(): boolean {
  try {
    const raw = sessionStorage.getItem(STAMP_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < REARM_MS;
  } catch {
    // Private mode, or storage disabled. Treat as "no record" — one reload is
    // the safer failure here than none.
    return false;
  }
}

function stamp(): void {
  try {
    sessionStorage.setItem(STAMP_KEY, String(Date.now()));
  } catch {
    /* nothing to do */
  }
}

/** A module or chunk that never loaded — the page is not going to recover. */
function isFatalLoadFailure(message: string): boolean {
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /ChunkLoadError/i.test(message)
  );
}

export function installLastResortReload(enabled: boolean): void {
  if (!enabled) return;

  let scheduled = false;

  const scheduleReload = (why: string) => {
    if (scheduled || recentlyReloaded()) return;
    scheduled = true;
    stamp();
    console.error(`Kiosk will reload in ${RELOAD_DELAY_MS / 1000}s: ${why}`);
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
  };

  window.addEventListener('error', (e) => {
    const message = e.message ?? '';
    // A failed <script> or <img> fires an error event with no message; the
    // interesting case is the module graph, which does carry one.
    if (isFatalLoadFailure(message)) return scheduleReload(message);
    if (!appMounted()) scheduleReload(message || 'error before mount');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const message = String((e.reason as { message?: string } | undefined)?.message ?? e.reason ?? '');
    if (isFatalLoadFailure(message)) return scheduleReload(message);
    if (!appMounted()) scheduleReload(message || 'rejection before mount');
  });
}

/**
 * Did React ever render anything?
 *
 * An empty #root after load is the white screen this whole module exists for.
 * Checking the DOM rather than tracking a flag means it stays true even if the
 * failure happened inside React's own bootstrap.
 */
function appMounted(): boolean {
  const root = document.getElementById('root');
  return Boolean(root && root.childElementCount > 0);
}
