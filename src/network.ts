/**
 * Network connectivity tracking.
 * Integrates @react-native-community/netinfo with React Query's
 * onlineManager so queries automatically pause when offline.
 */

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

/* ── Wire React Query to NetInfo ─────────────────────────────── */

let _setupDone = false;

export function setupNetworkListener(): void {
  if (_setupDone) return;
  _setupDone = true;

  onlineManager.setEventListener((setOnline) => {
    return NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected);
    });
  });
}

/* ── Hook for UI components ──────────────────────────────────── */

export function useNetworkStatus(): boolean {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(!!state.isConnected);
    });
    return unsubscribe;
  }, []);

  return isOnline;
}
