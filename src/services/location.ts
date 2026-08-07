/**
 * Global location service — one GPS + compass subscription shared by every
 * screen, started at app init so a fix is ready by the time the map opens.
 *
 * Three invariants this file exists to hold:
 *  - `initLocation()` never rejects. It used to, and a rejection behind the OS
 *    permission dialog left the app on an infinite boot spinner. Failures are
 *    reported as a status object instead.
 *  - Listeners fire only when the position actually changed. The map keys its
 *    walking-route request off this callback, so an unconditional broadcast at
 *    1 Hz meant a Valhalla POST every second.
 *  - Nothing keeps running that nobody is looking at: the watchers stop while
 *    the app is backgrounded, and 1 Hz GPS only runs while a screen has asked
 *    for it via `requestHighAccuracy()`.
 */

import * as Location from 'expo-location';
import { onAppActiveChange, isAppActive } from './appState';
import { angleDeltaDeg, haversineM } from '../utils/geo';

export type LatLng = { lat: number; lng: number };
type Listener = (loc: LatLng) => void;

export type LocationStatus =
  /** Watching. */
  | 'ok'
  /** The user refused (or has not granted) the foreground permission. */
  | 'denied'
  /** Permission granted but the OS refused to start a watch — Location
   *  Services switched off system-wide is the common cause. */
  | 'unavailable'
  /** Anything else expo-location threw. */
  | 'error';

export interface LocationInit {
  status: LocationStatus;
  /** True when a compass stream is running. False on devices with no
   *  magnetometer — the direction beam must be hidden in that case. */
  heading: boolean;
  /** Present when `status !== 'ok'`. Safe to show to the user. */
  message?: string;
}

/* ── Tuning ───────────────────────────────────────────────────── */

/** Exponential smoothing factor — responsive yet free of GPS "snapping". */
const _POS_ALPHA = 0.35;
/** Broadcast only once the smoothed position has moved this far from the
 *  value the UI last rendered. */
const _POS_MIN_DELTA_M = 0.5;
/** Beyond this the reading is a real move (or a large fix correction), not
 *  jitter. Smoothing it would leave the marker crawling for a dozen updates. */
const _POS_SNAP_M = 25;
const _HEADING_ALPHA = 0.15;
const _HEADING_MIN_DELTA_DEG = 5;

type AccuracyTier = 'low' | 'high';

const _WATCH_OPTIONS: Record<AccuracyTier, Location.LocationOptions> = {
  // Fused/network assisted on a slow duty cycle. This is what runs on every
  // non-map screen, so it is the setting that decides the app's idle battery
  // cost. Accurate enough to rank nearby stops.
  low: { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 10_000 },
  // Real GPS at 1 Hz — only while a map screen holds a high-accuracy lease.
  high: { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1_000 },
};

/* ── State ────────────────────────────────────────────────────── */

/** Smoothed position. Always advanced, even when we do not broadcast. */
let _location: LatLng | null = null;
/** The last value handed to listeners — the gate for the next broadcast. */
let _broadcast: LatLng | null = null;
/** Smoothed heading. Same split as above. */
let _heading: number | null = null;
let _lastBroadcastHeading: number | null = null;

let _posSub: Location.LocationSubscription | null = null;
let _headingSub: Location.LocationSubscription | null = null;
let _activeTier: AccuracyTier | null = null;
let _headingSupported = true;

let _started = false;
let _highAccuracyLeases = 0;
let _appUnsub: (() => void) | null = null;
let _init: LocationInit = {
  status: 'denied',
  heading: false,
  message: 'Location has not been requested yet.',
};

/** Serialises watcher (re)starts. `watchPositionAsync` is async, so two
 *  overlapping syncs would orphan a subscription that then runs forever. */
let _queue: Promise<void> = Promise.resolve();

const _listeners = new Set<Listener>();
const _headingListeners = new Set<(h: number | null) => void>();

/* ── Reads ────────────────────────────────────────────────────── */

/** Current cached position (may be null if not yet acquired). */
export function getLocation(): LatLng | null {
  return _location;
}

/** Current cached heading in degrees (0–360, null if unavailable). */
export function getHeading(): number | null {
  return _heading;
}

/** Outcome of the last `initLocation()`. */
export function getLocationStatus(): LocationInit {
  return _init;
}

/**
 * Subscribe to live position updates. Returns an unsubscribe function.
 *
 * NOTE: if a fix is already known the callback is invoked **synchronously,
 * before this function returns** — do not assume it only ever fires later.
 * A `useEffect` that calls `setState` from here will therefore schedule a
 * render during the effect, which is fine, but any local variable the
 * callback closes over must already be initialised.
 */
export function subscribe(cb: Listener): () => void {
  _listeners.add(cb);
  if (_location) cb(_location);
  return () => { _listeners.delete(cb); };
}

/** Subscribe to heading updates. Fires immediately if a heading is known —
 *  same synchronous-first-call caveat as `subscribe`. */
export function subscribeHeading(cb: (h: number | null) => void): () => void {
  _headingListeners.add(cb);
  if (_heading !== null) cb(_heading);
  return () => { _headingListeners.delete(cb); };
}

/* ── Lifecycle ────────────────────────────────────────────────── */

/**
 * Start location tracking. Call once at app startup.
 *
 * Resolves with a status object and **never rejects** — every caller so far
 * has been a fire-and-forget at boot, and a rejection there is unrecoverable.
 */
export async function initLocation(): Promise<LocationInit> {
  if (_started) return _init;

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      _init = { status: 'denied', heading: false, message: 'Location permission was not granted.' };
      return _init;
    }
  } catch (err) {
    _init = { status: 'error', heading: false, message: _describe(err) };
    return _init;
  }

  _started = true;
  _init = { status: 'ok', heading: false };

  // Last known fix first — an instant marker while the GPS warms up.
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last) _acceptPosition(last.coords.latitude, last.coords.longitude, true);
  } catch {
    // Purely an optimisation; the watch below is the real source.
  }

  if (!_appUnsub) {
    // Watching from a pocket burns battery for nobody.
    _appUnsub = onAppActiveChange(() => { void _sync(); });
  }
  await _sync();
  _init = { ..._init, heading: _headingSub !== null };
  return _init;
}

/** Stop all watchers and release the AppState hook. Idempotent. */
export function stopLocation(): void {
  _started = false;
  _highAccuracyLeases = 0;
  _appUnsub?.();
  _appUnsub = null;
  void _sync();
}

/**
 * Ask for 1 Hz GPS while a screen needs it (map screens). Returns a release
 * function — call it on unmount. Leases are counted, so overlapping screens
 * behave, and the last release drops back to the cheap tier.
 */
export function requestHighAccuracy(): () => void {
  _highAccuracyLeases++;
  void _sync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _highAccuracyLeases = Math.max(0, _highAccuracyLeases - 1);
    void _sync();
  };
}

/* ── Watcher management ───────────────────────────────────────── */

function _sync(): Promise<void> {
  const task = async () => {
    if (!_started || !isAppActive()) {
      _posSub?.remove();
      _posSub = null;
      _activeTier = null;
      _headingSub?.remove();
      _headingSub = null;
      return;
    }

    const tier: AccuracyTier = _highAccuracyLeases > 0 ? 'high' : 'low';
    if (!_posSub || _activeTier !== tier) {
      const prev = _posSub;
      try {
        // Start the replacement before dropping the old one so a tier change
        // does not leave a gap with no fixes at all.
        _posSub = await Location.watchPositionAsync(_WATCH_OPTIONS[tier], _onPosition);
        _activeTier = tier;
        if (_init.status !== 'ok') _init = { ..._init, status: 'ok', message: undefined };
      } catch (err) {
        // Rejects with E_LOCATION_UNAVAILABLE when Location Services are off
        // system-wide, even though the app permission is granted.
        _posSub = null;
        _activeTier = null;
        _init = { ..._init, status: 'unavailable', message: _describe(err) };
      } finally {
        prev?.remove();
      }
    }

    if (!_headingSub && _headingSupported) {
      try {
        _headingSub = await Location.watchHeadingAsync(_onHeading);
      } catch {
        // No magnetometer. Permanent — never retry, and tell callers so the
        // direction beam can be hidden rather than frozen at north.
        _headingSupported = false;
        _init = { ..._init, heading: false };
      }
    }
  };

  _queue = _queue.then(task, task);
  return _queue;
}

function _describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── Position ─────────────────────────────────────────────────── */

function _onPosition(loc: Location.LocationObject): void {
  _acceptPosition(loc.coords.latitude, loc.coords.longitude, false);
  // GPS course beats the compass while actually moving.
  const { heading, speed } = loc.coords;
  if (heading != null && heading >= 0 && speed != null && speed > 0.5) {
    _updateHeading(heading);
  }
}

/**
 * Low-pass position smoothing — eliminates GPS "snapping" / jumping.
 *
 * The smoothed value is *always* kept. An earlier version returned the previous
 * position when the step was below the broadcast threshold, which discarded the
 * smoothed value: sub-threshold steps never accumulated and the marker trailed
 * reality permanently. Only the broadcast is gated now.
 */
function _acceptPosition(lat: number, lng: number, force: boolean): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  if (!_location || force) {
    _location = { lat, lng };
  } else if (haversineM(_location.lat, _location.lng, lat, lng) > _POS_SNAP_M) {
    _location = { lat, lng };
  } else {
    _location = {
      lat: _location.lat + (lat - _location.lat) * _POS_ALPHA,
      lng: _location.lng + (lng - _location.lng) * _POS_ALPHA,
    };
  }

  if (
    _broadcast &&
    haversineM(_broadcast.lat, _broadcast.lng, _location.lat, _location.lng) < _POS_MIN_DELTA_M
  ) {
    return;
  }
  _broadcast = _location;
  const snapshot = _location;
  _listeners.forEach((cb) => {
    try { cb(snapshot); } catch { /* one bad consumer must not stop the rest */ }
  });
}

/* ── Heading ──────────────────────────────────────────────────── */

function _onHeading(h: Location.LocationHeadingObject): void {
  // trueHeading needs a geomagnetic model fix; magHeading is the raw compass.
  if (h.trueHeading >= 0) _updateHeading(h.trueHeading);
  else if (h.magHeading >= 0) _updateHeading(h.magHeading);
}

/**
 * Low-pass filter for heading.
 *
 * The drift test compares the smoothed value against what the UI last
 * *rendered*, not against the value we just advanced. Comparing against the
 * advanced value only ever asked "did this single step exceed 5°", which a
 * slow continuous turn never does — so nothing was ever broadcast and the
 * rendered beam could end up 180° out.
 */
function _updateHeading(raw: number): void {
  if (!Number.isFinite(raw)) return;

  if (_heading == null) {
    _heading = ((raw % 360) + 360) % 360;
    _emitHeading();
    return;
  }

  // angleDeltaDeg is wraparound-correct: 359° → 1° is +2, not -358.
  _heading = (_heading + angleDeltaDeg(_heading, raw) * _HEADING_ALPHA + 360) % 360;

  const drift = _lastBroadcastHeading == null
    ? 360
    : Math.abs(angleDeltaDeg(_lastBroadcastHeading, _heading));
  if (drift >= _HEADING_MIN_DELTA_DEG) _emitHeading();
}

function _emitHeading(): void {
  _lastBroadcastHeading = _heading;
  const h = _heading;
  _headingListeners.forEach((cb) => {
    try { cb(h); } catch { /* see _acceptPosition */ }
  });
}
