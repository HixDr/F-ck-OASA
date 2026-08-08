/**
 * Network connectivity tracking.
 * Integrates @react-native-community/netinfo with React Query's
 * onlineManager so queries automatically pause when offline.
 */

import { useSyncExternalStore } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

/* ── Shared connectivity state ───────────────────────────────── */

/**
 * A single NetInfo subscription feeds every consumer.
 *
 * `useNetworkStatus` used to open its own native listener per component and
 * seed itself with `true`, so each mount duplicated the bridge subscription
 * *and* claimed "online" until the first callback landed — which is why the
 * offline banner flashed away and back on every navigation. Keeping the last
 * known state in a module variable means later mounts start from the truth.
 */
type OnlineListener = (online: boolean) => void;

const _subscribers = new Set<OnlineListener>();
/** `null` until NetInfo has reported once. Optimistically read as online. */
let _isOnline: boolean | null = null;
let _netInfoUnsub: (() => void) | null = null;

function apply(online: boolean): void {
  if (online === _isOnline) return;
  _isOnline = online;
  for (const fn of _subscribers) {
    try {
      fn(online);
    } catch {
      // A misbehaving subscriber must not stop the others.
    }
  }
}

/** Open the one shared NetInfo subscription. Safe to call repeatedly. */
function ensureSubscription(): void {
  if (_netInfoUnsub) return;
  _netInfoUnsub = NetInfo.addEventListener((state) => apply(!!state.isConnected));
  // addEventListener only fires on *changes* on some platforms; seed the
  // initial value so the first mount doesn't guess.
  NetInfo.fetch()
    .then((state) => apply(!!state.isConnected))
    .catch(() => {});
}

function subscribe(listener: OnlineListener): () => void {
  ensureSubscription();
  _subscribers.add(listener);
  return () => {
    _subscribers.delete(listener);
  };
}

/** Last known connectivity. Optimistic before NetInfo has answered. */
export function isOnline(): boolean {
  return _isOnline ?? true;
}

/**
 * True only once NetInfo has positively reported a connection.
 *
 * `isOnline()` is optimistic while NetInfo is still answering, which is right
 * for anything user-facing — the banner must not flash "offline" during every
 * cold start. It is wrong for deciding whether to *retry* a failed request.
 *
 * On a cold start with the radio already off, `NetInfo.fetch()` is still in
 * flight when the first query runs, so an optimistic read schedules a retry;
 * by the time that retry runs NetInfo has answered, React Query refuses to
 * fetch, and the retry parks — leaving the query `pending` with no error and no
 * data, which is indistinguishable from still loading. That is the difference
 * between "turned wifi off inside the app" (works) and "opened the app with
 * wifi already off" (used to hang forever).
 *
 * Retry decisions therefore ask this instead: unknown counts as offline.
 */
export function isOnlineConfirmed(): boolean {
  return _isOnline === true;
}

/* ── Wire React Query to NetInfo ─────────────────────────────── */

let _setupDone = false;

export function setupNetworkListener(): void {
  if (_setupDone) return;
  _setupDone = true;
  ensureSubscription();

  onlineManager.setEventListener((setOnline) => {
    setOnline(isOnline());
    return subscribe(setOnline);
  });
}

/* ── Hook for UI components ──────────────────────────────────── */

export function useNetworkStatus(): boolean {
  // useSyncExternalStore reads the snapshot during render, so a component
  // mounting while already offline never paints the "online" frame first.
  return useSyncExternalStore(subscribe, isOnline, isOnline);
}
