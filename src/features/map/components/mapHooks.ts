/**
 * Hooks shared by the two map screens.
 *
 * These live next to the map components rather than in src/hooks because they
 * only make sense on a map: screen focus gating, a wall-clock tick for
 * time-relative labels, the debounced walking-route request, and the throttled
 * viewport used for marker culling.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useFocusEffect } from 'expo-router';
import { getWalkingRoute } from '../../../services/api';
import { haversineM } from '../../../utils/geo';
import { simplifyPath, type RegionLike } from '../mapUtils';

/* ── Screen focus ────────────────────────────────────────────── */

/**
 * True while this screen is the focused one in the native stack.
 *
 * expo-router keeps pushed-behind screens *mounted*, so without this a user
 * three lines deep has three bus polls, three arrival polls and three
 * animation loops all running at once.
 */
export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return focused;
}

/* ── Wall-clock tick ─────────────────────────────────────────── */

/**
 * Increments on every minute boundary.
 *
 * Anything computing `new Date()` inside a `useMemo` needs this in its deps or
 * it freezes: "last seen <1 min ago" stays there for an hour, and "Next: 14:05"
 * never advances past a departure that already left.
 */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 60_000));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Align to the boundary rather than drifting off a fixed 60s interval.
      const msToBoundary = 60_000 - (Date.now() % 60_000);
      timer = setTimeout(() => {
        setTick(Math.floor(Date.now() / 60_000));
        schedule();
      }, msToBoundary + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return tick;
}

/* ── Walking route ───────────────────────────────────────────── */

export interface WalkTarget {
  lat: number;
  lng: number;
  /** Identity of the destination — the walk result is discarded when it changes. */
  key: string;
}

export interface WalkingRouteState {
  coords: Array<{ latitude: number; longitude: number }>;
  walkMin: number | null;
}

const EMPTY_WALK: WalkingRouteState = { coords: [], walkMin: null };

/** Valhalla is a shared public demo instance — never fire on every GPS tick. */
const WALK_DEBOUNCE_MS = 700;
/** Minimum movement before the answer is worth asking for again. */
const WALK_MIN_MOVE_M = 25;
/** Valhalla returns a vertex every metre or two; nothing needs that on screen. */
const WALK_SIMPLIFY_M = 3;

/**
 * Walking route from `from` to `target`, debounced, distance-gated and
 * cancellable.
 *
 * The result is keyed to `target.key`: switching stops clears it immediately,
 * so a slow response for stop A can never land in stop B's card.
 */
export function useWalkingRoute(
  target: WalkTarget | null,
  from: { lat: number; lng: number } | null,
): WalkingRouteState {
  const [route, setRoute] = useState<WalkingRouteState>(EMPTY_WALK);
  const [moveTick, setMoveTick] = useState(0);

  const fromRef = useRef(from);
  fromRef.current = from;
  /** Origin the in-flight/last request was made from. */
  const originRef = useRef<{ lat: number; lng: number } | null>(null);
  /** Target the last request was made for — first request per target is instant. */
  const originKeyRef = useRef<string | null>(null);

  const targetKey = target?.key ?? null;
  const tLat = target?.lat ?? null;
  const tLng = target?.lng ?? null;

  useEffect(() => {
    setRoute(EMPTY_WALK);
    originRef.current = null;
  }, [targetKey]);

  // Distance gate. Walking directions do not change over a few metres, and a
  // POST per position update is both pointless and abusive.
  useEffect(() => {
    if (!from || targetKey == null) return;
    const o = originRef.current;
    if (o && haversineM(o.lat, o.lng, from.lat, from.lng) < WALK_MIN_MOVE_M) return;
    setMoveTick((t) => t + 1);
  }, [from, targetKey]);

  useEffect(() => {
    if (tLat == null || tLng == null) return;
    const origin = fromRef.current;
    if (!origin) return;

    originRef.current = origin;
    const isRefresh = originKeyRef.current === targetKey;
    originKeyRef.current = targetKey;

    const ac = new AbortController();
    const timer = setTimeout(() => {
      getWalkingRoute(origin.lat, origin.lng, tLat, tLng, { signal: ac.signal })
        .then((walk) => {
          // Superseded requests must not overwrite a newer answer.
          if (ac.signal.aborted || !walk || walk.coords.length < 2) return;
          // Valhalla shapes arrive as [lng, lat] at sub-metre resolution.
          const thinned = simplifyPath(
            walk.coords.map((c) => ({ lat: c[1], lng: c[0] })),
            WALK_SIMPLIFY_M,
          );
          setRoute({
            coords: thinned.map((p) => ({ latitude: p.lat, longitude: p.lng })),
            walkMin: Math.round(walk.durationSec / 60),
          });
        })
        .catch(() => {});
    }, isRefresh ? WALK_DEBOUNCE_MS : 0);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [tLat, tLng, targetKey, moveTick]);

  return route;
}

/* ── Viewport ────────────────────────────────────────────────── */

/** Region commits are throttled to this — a pan can fire several in a row. */
const REGION_THROTTLE_MS = 300;
/** Grace period after a gesture before we count the map as idle again. */
const PAN_SETTLE_MS = 400;

export interface VisibleRegion {
  /** Null until the map has reported a region — callers must not cull before
   *  then, or a missed first event leaves the map permanently empty. */
  region: RegionLike | null;
  /** Live pan/zoom flag for imperative checks — does not trigger renders. */
  panningRef: MutableRefObject<boolean>;
  onRegionChangeStart: () => void;
  onRegionChangeComplete: (r: RegionLike) => void;
}

/**
 * Throttled view of the map's current region, for viewport culling.
 *
 * Only `onRegionChangeComplete` feeds it — `onRegionChange` fires every frame
 * of a drag and would put us right back to re-rendering the screen at 60fps.
 */
export function useVisibleRegion(): VisibleRegion {
  const [region, setRegion] = useState<RegionLike | null>(null);
  const panningRef = useRef(false);
  const lastCommitRef = useRef(0);
  const pendingRef = useRef<RegionLike | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);
  }, []);

  const onRegionChangeStart = useCallback(() => {
    panningRef.current = true;
    if (settleRef.current) clearTimeout(settleRef.current);
  }, []);

  const commit = useCallback(() => {
    timerRef.current = null;
    lastCommitRef.current = Date.now();
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) setRegion(next);
  }, []);

  const onRegionChangeComplete = useCallback((r: RegionLike) => {
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => { panningRef.current = false; }, PAN_SETTLE_MS);

    pendingRef.current = r;
    const since = Date.now() - lastCommitRef.current;
    if (since >= REGION_THROTTLE_MS) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      commit();
    } else if (timerRef.current == null) {
      timerRef.current = setTimeout(commit, REGION_THROTTLE_MS - since);
    }
  }, [commit]);

  return { region, panningRef, onRegionChangeStart, onRegionChangeComplete };
}
