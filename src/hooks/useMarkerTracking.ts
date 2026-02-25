import { useEffect, useRef, useState } from 'react';

/**
 * Shared hook — enables `tracksViewChanges` on a react-native-maps Marker
 * for a short burst (default 500ms) whenever `deps` change, then disables it
 * to avoid continuous bitmap re-captures.
 *
 * Replaces the identical tracking-timer pattern used 6+ times across
 * LiveMapScreen and NearbyMapScreen (stopTracking, stampTracking,
 * userTracking, selectedTracking, etc.).
 */
export function useMarkerTracking(deps: unknown[], duration = 500): boolean {
  const [tracking, setTracking] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTracking(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTracking(false), duration);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return tracking;
}
