/**
 * App foreground/background wiring.
 *
 * Without this, React Query's `focusManager` never learns the app was
 * backgrounded, so every `refetchInterval` keeps firing while the phone is in
 * the user's pocket. It also gives other services a single place to subscribe
 * to "app became active / inactive" instead of each one registering its own
 * AppState listener.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { focusManager } from '@tanstack/react-query';

type ActiveListener = (active: boolean) => void;

const _listeners = new Set<ActiveListener>();
let _active = AppState.currentState === 'active';
let _installed = false;

function handleChange(status: AppStateStatus) {
  const next = status === 'active';
  if (next === _active) return;
  _active = next;
  // Drives React Query's focus-based refetch pausing.
  focusManager.setFocused(next);
  for (const l of _listeners) {
    try {
      l(next);
    } catch {
      // A misbehaving listener must not stop the others.
    }
  }
}

/** Install the AppState bridge. Safe to call more than once. */
export function setupAppState(): () => void {
  if (_installed) return () => {};
  _installed = true;
  focusManager.setFocused(_active);
  const sub = AppState.addEventListener('change', handleChange);
  return () => {
    sub.remove();
    _installed = false;
  };
}

/** True while the app is in the foreground. */
export function isAppActive(): boolean {
  return _active;
}

/** Subscribe to foreground/background transitions. Returns an unsubscribe fn. */
export function onAppActiveChange(listener: ActiveListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}
