/**
 * Global location service — starts watching position on app init so GPS
 * is ready by the time the user navigates to the map screen.
 */

import * as Location from 'expo-location';

type LatLng = { lat: number; lng: number };
type Listener = (loc: LatLng) => void;

let _location: LatLng | null = null;
let _sub: Location.LocationSubscription | null = null;
const _listeners = new Set<Listener>();

/** Current cached position (may be null if not yet acquired). */
export function getLocation(): LatLng | null {
  return _location;
}

/**
 * Subscribe to live position updates. Returns an unsubscribe function.
 * If a position is already known, the callback fires immediately.
 */
export function subscribe(cb: Listener): () => void {
  _listeners.add(cb);
  if (_location) cb(_location);
  return () => { _listeners.delete(cb); };
}

/** Start location tracking. Call once at app startup. */
export async function initLocation(): Promise<void> {
  if (_sub) return; // already running

  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return;

  // Use last known position for an instant first fix
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last) {
      _location = { lat: last.coords.latitude, lng: last.coords.longitude };
      _listeners.forEach((cb) => cb(_location!));
    }
  } catch {}

  // Continuous watch for live updates
  _sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 3000 },
    (loc) => {
      _location = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      _listeners.forEach((cb) => cb(_location!));
    },
  );
}
