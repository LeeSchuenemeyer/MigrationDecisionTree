import { useSyncExternalStore } from 'react';

/**
 * Which physical surface the app is running on.
 *
 * `kiosk`   — the always-on wall tablet: fixed viewport, nothing scrolls,
 *             huge touch targets, no navigation chrome.
 * `compact` — a phone: bottom tab bar, sheets, independent scrolling.
 * `desktop` — a laptop with a mouse: sidebar nav, and the only surface where
 *             the parent-admin screens are comfortable to use.
 *
 * Resolution priority (highest first):
 *   1. An enrolled kiosk device token (authoritative — set by the server).
 *   2. An explicit `?kiosk=1` flag, persisted to localStorage.
 *   3. A device-shape heuristic.
 *
 * Steps 2 and 3 already ran in the inline script in index.html, before first
 * paint, so the kiosk never flashes the compact layout. This module reads that
 * result and lets the device token override it once known.
 */
export type Surface = 'kiosk' | 'compact' | 'desktop';

const STORAGE_KEY = 'fd.kiosk';

function readDomSurface(): Surface {
  const raw = document.documentElement.dataset['surface'];
  return raw === 'kiosk' ? 'kiosk' : detectNonKiosk();
}

function detectNonKiosk(): Surface {
  // A coarse pointer means touch; anything wide with a fine pointer is a laptop.
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const wide = window.matchMedia('(min-width: 900px)').matches;
  return !coarse && wide ? 'desktop' : 'compact';
}

const listeners = new Set<() => void>();
let current: Surface = typeof document === 'undefined' ? 'compact' : readDomSurface();

function emit(): void {
  for (const l of listeners) l();
}

function setSurface(next: Surface): void {
  if (next === current) return;
  current = next;
  document.documentElement.dataset['surface'] = next;
  emit();
}

/** Called once the session bootstrap reports an enrolled kiosk device. */
export function applyDeviceKind(deviceKind: 'kiosk' | 'personal' | null): void {
  if (deviceKind === 'kiosk') {
    localStorage.setItem(STORAGE_KEY, '1');
    setSurface('kiosk');
  } else if (deviceKind === 'personal') {
    // Only demote if the user has not explicitly pinned kiosk mode on this device.
    if (localStorage.getItem(STORAGE_KEY) !== '1') setSurface(detectNonKiosk());
  }
}

/** Manual override, for the settings screen. */
export function setKioskOverride(on: boolean | null): void {
  if (on === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  setSurface(on === true ? 'kiosk' : detectNonKiosk());
}

if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(orientation: landscape)');
  const onChange = () => {
    // Re-evaluate only when kiosk mode was not explicitly pinned.
    if (localStorage.getItem(STORAGE_KEY) === null) setSurface(readDomSurface());
    else if (localStorage.getItem(STORAGE_KEY) === '0') setSurface(detectNonKiosk());
  };
  mq.addEventListener('change', onChange);
  window.addEventListener('resize', onChange);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Surface {
  return current;
}

export function useSurface(): Surface {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'compact' as Surface);
}
