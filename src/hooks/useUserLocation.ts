import { useEffect, useRef, useState } from 'react';
import {
  getLocation,
  getHeading,
  subscribe as subscribeLocation,
  subscribeHeading,
} from '../services/location';

export type LatLng = { lat: number; lng: number };

/**
 * Shared hook — subscribes to GPS position + heading, keeps a ref for
 * imperative access and state values for render.
 *
 * Replaces the identical subscription boilerplate in LiveMapScreen and
 * NearbyMapScreen (each ~15 lines of hook code).
 *
 * @param onLocationUpdate Optional callback invoked on every location change —
 *        allows the consumer to perform side-effects (e.g. update walkCoords).
 */
export function useUserLocation(onLocationUpdate?: (loc: LatLng) => void) {
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

  return { userLocationRef, userLoc, userHeading };
}
