/**
 * Shared toggle for the auto-redirect-on-phase-change behavior.
 *
 * Stored in localStorage so it persists across navigations within the same
 * browser. Defaults to ON. Use the `Pin page` toggle in the TopBar to flip it
 * when you want to stay on one route while the pipeline advances (handy for
 * inspecting analyze + segment output without being pushed away).
 */
'use client';

import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'emberforge:autoRedirect';
const EVENT = 'emberforge:autoRedirectChanged';

function read(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(KEY) !== 'off';
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) cb();
  });
  return () => window.removeEventListener(EVENT, handler);
}

export function useAutoRedirectEnabled(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, read, () => true);

  // Ensure default value is written so other tabs see it on first load.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(KEY) === null) {
      window.localStorage.setItem(KEY, 'on');
    }
  }, []);

  const setEnabled = (next: boolean) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(EVENT));
  };

  return [enabled, setEnabled];
}
