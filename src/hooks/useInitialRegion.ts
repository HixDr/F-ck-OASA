import { useMemo } from 'react';
import { getLocation } from '../services/location';

/**
 * Shared hook — builds the initial map region centred on the user's GPS position
 * (or Athens centre as fallback). Accepts a `delta` argument for zoom level.
 *
 * Replaces identical `useMemo(() => { const loc = getLocation(); ... }, [])` in 3 screens.
 */
export function useInitialRegion(delta = 0.05) {
  return useMemo(() => {
    const loc = getLocation();
    return {
      latitude: loc ? loc.lat : 37.9838,
      longitude: loc ? loc.lng : 23.7275,
      latitudeDelta: delta,
      longitudeDelta: delta,
    };
  }, []);
}
