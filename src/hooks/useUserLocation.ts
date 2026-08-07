import { useEffect, useRef, useState } from 'react';
import {
  getLocation,
  getHeading,
  requestHighAccuracy,
  subscribe as subscribeLocation,
  subscribeHeading,
} from '../services/location';

export type LatLng = { lat: number; lng: number };

export interface UseUserLocationOptions {
  /** Side-effect on every position change (walk route refresh, query key, …). */
  onLocationUpdate?: (loc: LatLng) => void;
  /**
   * Lease 1 Hz GPS while true.
   *
   * The service defaults to a cheap Balanced/10s tier; only the map screens
   * need better, and only while they are actually on screen. expo-router's
   * native stack keeps pushed-behind screens mounted, so pass the screen's
   * focus state rather than a bare `true`.
   */
  highAccuracy?: boolean;
}

/**
 * Shared hook — subscribes to GPS position + heading, keeps a ref for
 * imperative access and state values for render.
 *
 * Replaces the identical subscription boilerplate in LiveMapScreen and
 * NearbyMapScreen (each ~15 lines of hook code).
 */
export function useUserLocation({
  onLocationUpdate,
  highAccuracy = false,
}: UseUserLocationOptions = {}) {
  const userLocationRef = useRef<LatLng | null>(getLocation());
  const [userLoc, setUserLoc] = useState<LatLng | null>(getLocation());
  const [userHeading, setUserHeading] = useState<number | null>(getHeading());

  // Keep callback ref stable to avoid re-subscribing on every render
  const onLocRef = useRef(onLocationUpdate);
  onLocRef.current = onLocationUpdate;

  useEffect(() => {
    const unLoc = subscribeLocation((loc) => {
      userLocationRef.current = loc;
      setUserLoc(loc);
      onLocRef.current?.(loc);
    });
    const unHead = subscribeHeading((h) => setUserHeading(h));
    return () => { unLoc(); unHead(); };
  }, []);

  useEffect(() => {
    if (!highAccuracy) return;
    // Lease-counted, so overlapping map screens behave and the last release
    // drops the watcher back to the cheap tier.
    return requestHighAccuracy();
  }, [highAccuracy]);

  return { userLocationRef, userLoc, userHeading };
}
