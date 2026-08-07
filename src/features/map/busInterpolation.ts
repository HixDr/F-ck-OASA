/**
 * Route-snapped bus position interpolation.
 *
 * Turns the 10-second-cadence stream of raw OASA fixes into an *animation plan*
 * per vehicle: an ordered list of waypoints along the route polyline plus the
 * time to spend on each leg. The map layer hands those legs to `Animated`
 * (see components/BusLayer.tsx), so the motion never touches React state.
 *
 * The previous design returned a position snapshot and expected the caller to
 * poll it from a 60fps requestAnimationFrame loop, which re-rendered the whole
 * map screen every frame forever — even with every bus parked.
 */

import { bearingBetween, lngScaleAt } from '../../utils/geo';

/* ── Types ───────────────────────────────────────────────────── */

export interface LatLng {
  lat: number;
  lng: number;
}

/** One animation leg: where to be next, and how long to take getting there. */
export interface BusLeg {
  latitude: number;
  longitude: number;
  durationMs: number;
}

/** What the renderer should do with one vehicle for the current poll. */
export interface BusPlan {
  id: string;
  /** Jump straight here, no animation (first sighting, or an implausible jump). */
  snapTo: { latitude: number; longitude: number } | null;
  /** Where the animation starts — the marker's position right now. Non-null
   *  whenever `legs` is non-empty, so the renderer never has to guess. */
  from: { latitude: number; longitude: number } | null;
  /** Waypoints to animate through, in order. Empty when `snapTo` is set, and
   *  also empty when the vehicle has not moved — the "parked bus" case. */
  legs: BusLeg[];
  /** Heading along the route at the end of the plan, degrees clockwise from N. */
  bearing: number;
}

interface BusState {
  /** Distance along route (metres) at the start of the current animation. */
  fromDist: number;
  /** Distance along route (metres) the current animation targets. */
  toDist: number;
  /** Timestamp when the current animation started. */
  startMs: number;
  /** Duration of the current animation (ms). */
  durationMs: number;
}

/* ── Haversine distance (metres) ─────────────────────────────── */

const R = 6_371_000; // Earth radius in metres
const toRad = Math.PI / 180;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ── Precomputed route data ──────────────────────────────────── */

/** Metres per degree of latitude. Constant enough over a city. */
const M_PER_DEG_LAT = 111_320;

export interface RouteIndex {
  /** Original polyline points. */
  points: LatLng[];
  /** Cumulative distance from start at each point (metres). */
  cumDist: number[];
  /** Total route length (metres). */
  totalDist: number;
  /** cos(lat) at the route's mid-latitude, for planar maths on raw degrees.
   *  Without it east-west error is over-weighted by ~27% at Athens. */
  lngScale: number;
}

/** Build a spatial index for a route polyline. */
export function buildRouteIndex(points: LatLng[]): RouteIndex {
  const cumDist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumDist.push(cumDist[i - 1] + haversine(points[i - 1], points[i]));
  }
  const midLat = points.length > 0 ? points[points.length >> 1].lat : 0;
  return {
    points,
    cumDist,
    totalDist: cumDist[cumDist.length - 1] ?? 0,
    lngScale: lngScaleAt(midLat),
  };
}

/* ── Snap a point to the route and get distance along it ─────── */

/**
 * Project point P onto segment A→B, returning fraction t ∈ [0,1].
 * Works in local metres so the projection is not skewed by latitude.
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng, lngScale: number): number {
  const dx = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dy = (b.lng - a.lng) * M_PER_DEG_LAT * lngScale;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return 0;
  const px = (p.lat - a.lat) * M_PER_DEG_LAT;
  const py = (p.lng - a.lng) * M_PER_DEG_LAT * lngScale;
  return Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
}

/** Squared planar distance in metres² (no sqrt — comparison only). */
function distSqM(a: LatLng, b: LatLng, lngScale: number): number {
  const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * M_PER_DEG_LAT * lngScale;
  return dLat * dLat + dLng * dLng;
}

/** Index of the segment (i → i+1) containing `dist`, clamped to the route. */
function segIndexAtDist(idx: RouteIndex, dist: number): number {
  const last = idx.points.length - 2;
  if (last < 0) return 0;
  if (dist <= 0) return 0;
  if (dist >= idx.totalDist) return last;
  let lo = 0;
  let hi = idx.cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (idx.cumDist[mid] <= dist) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, last);
}

export interface SnapResult {
  /** Distance along the route, metres. */
  dist: number;
  /** Perpendicular distance from the route at that point, metres. */
  offRouteM: number;
}

/** How far either side of the last known position we look first. */
export const SNAP_WINDOW_M = 800;
/** Beyond this the windowed candidate is rejected and we search globally. */
export const SNAP_MAX_OFFROUTE_M = 150;

function searchSegments(point: LatLng, idx: RouteIndex, loSeg: number, hiSeg: number): SnapResult {
  let bestSq = Infinity;
  let bestDist = 0;
  for (let i = loSeg; i <= hiSeg; i++) {
    const a = idx.points[i];
    const b = idx.points[i + 1];
    const t = projectOnSegment(point, a, b, idx.lngScale);
    const proj: LatLng = {
      lat: a.lat + t * (b.lat - a.lat),
      lng: a.lng + t * (b.lng - a.lng),
    };
    const d = distSqM(point, proj, idx.lngScale);
    if (d < bestSq) {
      bestSq = d;
      bestDist = idx.cumDist[i] + t * (idx.cumDist[i + 1] - idx.cumDist[i]);
    }
  }
  return { dist: bestDist, offRouteM: Math.sqrt(bestSq) };
}

/**
 * Find the distance along the route closest to the given point.
 *
 * When `nearDist` is supplied the search is constrained to a window around it.
 * Athens routes self-overlap constantly — terminal loops, U-turns, out-and-back
 * legs — so a globally-nearest search flips a bus between two points kilometres
 * apart on alternate polls, and the marker then slides the whole length of the
 * route and back. Only when the windowed candidate is implausibly far off the
 * road (the bus was rerouted, or we lost it for several polls) do we fall back
 * to a global search.
 */
export function snapToRoute(point: LatLng, idx: RouteIndex, nearDist?: number): SnapResult {
  const n = idx.points.length;
  if (n < 2) return { dist: 0, offRouteM: Infinity };
  const lastSeg = n - 2;

  if (nearDist != null) {
    const lo = segIndexAtDist(idx, nearDist - SNAP_WINDOW_M);
    const hi = segIndexAtDist(idx, nearDist + SNAP_WINDOW_M);
    const windowed = searchSegments(point, idx, lo, Math.min(hi, lastSeg));
    if (windowed.offRouteM <= SNAP_MAX_OFFROUTE_M) return windowed;
  }

  return searchSegments(point, idx, 0, lastSeg);
}

/* ── Get LatLng at a given distance along the route ──────────── */

export function positionAtDist(dist: number, idx: RouteIndex): LatLng {
  if (idx.points.length === 0) return { lat: 0, lng: 0 };
  if (dist <= 0) return idx.points[0];
  if (dist >= idx.totalDist) return idx.points[idx.points.length - 1];

  const lo = segIndexAtDist(idx, dist);
  const hi = lo + 1;
  const segLen = idx.cumDist[hi] - idx.cumDist[lo];
  const t = segLen > 0 ? (dist - idx.cumDist[lo]) / segLen : 0;
  const a = idx.points[lo];
  const b = idx.points[hi];

  return {
    lat: a.lat + t * (b.lat - a.lat),
    lng: a.lng + t * (b.lng - a.lng),
  };
}

/* ── Bearing along the route ─────────────────────────────────── */

const BEARING_SPAN_M = 5;

/**
 * Heading of the route at `dist`, degrees clockwise from north.
 *
 * The span is always taken *backwards* from a point clamped to the route end.
 * Looking forward from the terminus returns the same coordinate twice, and
 * `atan2(0, 0)` is 0 — which snapped every bus at a terminus to due north.
 */
export function bearingAtDist(dist: number, idx: RouteIndex): number {
  if (idx.points.length < 2 || idx.totalDist <= 0) return 0;
  const to = Math.min(Math.max(dist, 0) + BEARING_SPAN_M, idx.totalDist);
  const from = Math.max(to - BEARING_SPAN_M * 2, 0);
  if (to - from < 1e-6) return 0;
  const a = positionAtDist(from, idx);
  const b = positionAtDist(to, idx);
  return bearingBetween(a.lat, a.lng, b.lat, b.lng);
}

/* ── Interpolation engine ────────────────────────────────────── */

/** Default tween length. Callers should pass the real poll interval so the
 *  animation lands exactly as the next sample arrives (see BUS_POLL_MS). */
export const INTERP_DURATION_MS = 10_000;

/** Fastest an Athens bus plausibly travels. Anything above is a mis-snap. */
const MAX_SPEED_MPS = 22; // ~80 km/h
/** Backwards slack we tolerate before hard-snapping (GPS + snap jitter). */
const BACKWARD_TOLERANCE_M = 25;
/** Below this the vehicle counts as stationary — emit no animation at all. */
const MIN_MOVE_M = 0.5;

/** How far ahead of the sample we aim, to offset feed + tween latency. */
const LEAD_MS = 3_000;
/** Cap on that lead, so a bus never overshoots into the next intersection. */
const MAX_LEAD_M = 80;
/** Only extrapolate for vehicles actually moving; parked ones must stay put. */
const MIN_LEAD_SPEED_MPS = 1.5;

export class BusInterpolator {
  private routeIdx: RouteIndex | null = null;
  private states = new Map<string, BusState>();

  /** Set/update the route polyline. */
  setRoute(points: LatLng[]): void {
    this.routeIdx = points.length >= 2 ? buildRouteIndex(points) : null;
    // Distances along the old geometry mean nothing on the new one.
    this.states.clear();
  }

  /** True once a usable route is loaded. */
  hasRoute(): boolean {
    return this.routeIdx != null;
  }

  /** Where the marker for `id` currently is along the route, in metres. */
  private currentDist(state: BusState, now: number): number {
    // Lower clamp matters: an NTP correction can move the clock backwards,
    // and a negative elapsed extrapolates the bus off the start of the route.
    const elapsed = Math.max(0, Math.min(now - state.startMs, state.durationMs));
    const t = state.durationMs > 0 ? elapsed / state.durationMs : 1;
    return state.fromDist + t * (state.toDist - state.fromDist);
  }

  /**
   * Feed a fresh poll and get one animation plan per vehicle in the feed.
   *
   * Vehicles that vanished from the feed are dropped from internal state; the
   * caller decides what to do with their markers.
   */
  update(
    buses: Array<{ id: string; lat: number; lng: number }>,
    durationMs: number = INTERP_DURATION_MS,
    nowMs: number = Date.now(),
  ): BusPlan[] {
    const idx = this.routeIdx;
    if (!idx) return [];

    const plans: BusPlan[] = [];
    const seen = new Set<string>();

    for (const bus of buses) {
      if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng)) continue;
      seen.add(bus.id);

      const prev = this.states.get(bus.id);
      const curDist = prev ? this.currentDist(prev, nowMs) : null;
      const snapped = snapToRoute(bus, idx, curDist ?? undefined);

      if (curDist == null) {
        // First sighting — place it, don't slide it in from wherever.
        const pos = positionAtDist(snapped.dist, idx);
        this.states.set(bus.id, {
          fromDist: snapped.dist, toDist: snapped.dist, startMs: nowMs, durationMs,
        });
        plans.push({
          id: bus.id,
          snapTo: { latitude: pos.lat, longitude: pos.lng },
          from: null,
          legs: [],
          bearing: bearingAtDist(snapped.dist, idx),
        });
        continue;
      }

      const dtSec = Math.max(0.5, (nowMs - prev!.startMs) / 1000);
      const delta = snapped.dist - curDist;

      // Monotonicity / plausibility guard. Animating a backwards jump smoothly
      // is the single most confusing thing the map can do, and a forward jump
      // faster than any bus is a mis-snap, not movement.
      if (delta < -BACKWARD_TOLERANCE_M || delta > MAX_SPEED_MPS * dtSec) {
        const pos = positionAtDist(snapped.dist, idx);
        this.states.set(bus.id, {
          fromDist: snapped.dist, toDist: snapped.dist, startMs: nowMs, durationMs,
        });
        plans.push({
          id: bus.id,
          snapTo: { latitude: pos.lat, longitude: pos.lng },
          from: null,
          legs: [],
          bearing: bearingAtDist(snapped.dist, idx),
        });
        continue;
      }

      // The rendered bus is already a poll interval behind an API sample that
      // is itself seconds stale. Aim a little ahead at the observed speed so
      // the perceived lag drops, but never for a vehicle that looks stopped.
      const observedMps = delta / dtSec;
      const lead = observedMps > MIN_LEAD_SPEED_MPS
        ? Math.min(observedMps * (LEAD_MS / 1000), MAX_LEAD_M)
        : 0;
      const target = Math.max(0, Math.min(snapped.dist + lead, idx.totalDist));

      this.states.set(bus.id, {
        fromDist: curDist, toDist: target, startMs: nowMs, durationMs,
      });

      const fromPos = positionAtDist(curDist, idx);
      plans.push({
        id: bus.id,
        snapTo: null,
        from: { latitude: fromPos.lat, longitude: fromPos.lng },
        legs: buildLegs(curDist, target, durationMs, idx),
        bearing: bearingAtDist(target, idx),
      });
    }

    for (const id of [...this.states.keys()]) {
      if (!seen.has(id)) this.states.delete(id);
    }

    return plans;
  }

  /** Clear all state. */
  clear(): void {
    this.states.clear();
    this.routeIdx = null;
  }
}

/**
 * Split the move from `fromDist` to `toDist` into legs that follow the actual
 * polyline vertices, each given a share of `durationMs` proportional to its
 * length. Constant speed, and the marker traces the road instead of cutting
 * the corner off every turn.
 */
function buildLegs(fromDist: number, toDist: number, durationMs: number, idx: RouteIndex): BusLeg[] {
  const span = toDist - fromDist;
  if (Math.abs(span) < MIN_MOVE_M) return [];

  const forward = span > 0;
  const cuts: number[] = [];
  let i = segIndexAtDist(idx, fromDist);
  if (forward) {
    // Vertices strictly between from and to, in travel order.
    for (i = i + 1; i < idx.cumDist.length - 1 && idx.cumDist[i] < toDist; i++) {
      if (idx.cumDist[i] > fromDist) cuts.push(idx.cumDist[i]);
    }
  } else {
    for (; i > 0 && idx.cumDist[i] > toDist; i--) {
      if (idx.cumDist[i] < fromDist) cuts.push(idx.cumDist[i]);
    }
  }
  cuts.push(toDist);

  const legs: BusLeg[] = [];
  let prevDist = fromDist;
  for (const d of cuts) {
    const legLen = Math.abs(d - prevDist);
    const ms = (legLen / Math.abs(span)) * durationMs;
    // Sub-millisecond legs only add Animated bookkeeping; fold them forward.
    if (ms < 1 && d !== toDist) continue;
    const p = positionAtDist(d, idx);
    legs.push({ latitude: p.lat, longitude: p.lng, durationMs: ms });
    prevDist = d;
  }
  return legs;
}
