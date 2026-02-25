/**
 * Global location service — starts watching position on app init so GPS
 * is ready by the time the user navigates to the map screen.
 * Tracks both position and device heading for direction indicator.
 */

import * as Location from 'expo-location';

export type LatLng = { lat: number; lng: number };
type Listener = (loc: LatLng) => void;

let _location: LatLng | null = null;
let _heading: number | null = null;
let _sub: Location.LocationSubscription | null = null;
let _headingSub: Location.LocationSubscription | null = null;
const _listeners = new Set<Listener>();
const _headingListeners = new Set<(h: number | null) => void>();

/** Current cached position (may be null if not yet acquired). */
export function getLocation(): LatLng | null {
  return _location;
}

/** Current cached heading in degrees (0–360, null if unavailable). */
export function getHeading(): number | null {
  return _heading;
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

/** Subscribe to heading updates. Returns an unsubscribe function. */
export function subscribeHeading(cb: (h: number | null) => void): () => void {
  _headingListeners.add(cb);
  if (_heading !== null) cb(_heading);
  return () => { _headingListeners.delete(cb); };
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

  // Continuous watch — high accuracy, fast updates for real-time map use
  _sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1000 },
    (loc) => {
      _location = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      // Use GPS heading when moving (more accurate than compass)
      if (loc.coords.heading != null && loc.coords.heading >= 0 && loc.coords.speed != null && loc.coords.speed > 0.5) {
        _updateHeading(loc.coords.heading);
      }
      _listeners.forEach((cb) => cb(_location!));
    },
  );

  // Compass heading for when standing still — smoothed
  _headingSub = await Location.watchHeadingAsync((h) => {
    if (h.trueHeading >= 0) {
      _updateHeading(h.trueHeading);
    }
  });
}

/** Low-pass filter for heading: smooths jitter by blending old+new values.
 *  Only broadcasts when the visual change exceeds threshold. */
function _updateHeading(raw: number): void {
  if (_heading == null) {
    _heading = raw;
    _headingListeners.forEach((cb) => cb(_heading));
    return;
  }
  // Handle 360/0 wraparound
  let delta = raw - _heading;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  // Exponential smoothing (alpha 0.15 = very smooth)
  const smoothed = (_heading + delta * 0.15 + 360) % 360;
  // Only push to UI when visual change > 5°
  const uiDelta = Math.abs(smoothed - _heading);
  if (uiDelta > 5 || (uiDelta > 0 && Math.abs(delta) > 30)) {
    _heading = smoothed;
    _headingListeners.forEach((cb) => cb(_heading));
  } else {
    _heading = smoothed; // still update internal state
  }
}
