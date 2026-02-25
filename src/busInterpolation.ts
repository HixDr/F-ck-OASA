/**
 * Route-snapped bus position interpolation.
 *
 * Snaps raw GPS positions to the route polyline, then smoothly
 * interpolates movement along the route between API polls.
 * Runs at ~60fps via requestAnimationFrame.
 */

/* ── Types ───────────────────────────────────────────────────── */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface InterpolatedBus {
  id: string;
  lat: number;
  lng: number;
  bearing: number;
}

interface BusState {
  /** Distance along route (metres) at the start of interpolation. */
  fromDist: number;
  /** Distance along route (metres) at the target (latest API position). */
  toDist: number;
  /** Timestamp when this interpolation segment started. */
  startMs: number;
  /** Duration over which to interpolate (ms). */
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

export interface RouteIndex {
  /** Original polyline points. */
  points: LatLng[];
  /** Cumulative distance from start at each point (metres). */
  cumDist: number[];
  /** Total route length (metres). */
  totalDist: number;
}

/** Build a spatial index for a route polyline. */
export function buildRouteIndex(points: LatLng[]): RouteIndex {
  const cumDist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumDist.push(cumDist[i - 1] + haversine(points[i - 1], points[i]));
  }
  return { points, cumDist, totalDist: cumDist[cumDist.length - 1] ?? 0 };
}

/* ── Snap a point to the route and get distance along it ─────── */

/** Squared distance in LatLng space (no sqrt for comparison only). */
function distSq(a: LatLng, b: LatLng): number {
  const dx = a.lat - b.lat;
  const dy = a.lng - b.lng;
  return dx * dx + dy * dy;
}

/**
 * Project point P onto segment A→B, returning fraction t ∈ [0,1].
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.lat - a.lat;
  const dy = b.lng - a.lng;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return 0;
  return Math.max(0, Math.min(1, ((p.lat - a.lat) * dx + (p.lng - a.lng) * dy) / lenSq));
}

/**
 * Find the distance along the route closest to the given point.
 * Returns the snapped distance in metres.
 */
export function snapToRoute(point: LatLng, idx: RouteIndex): number {
  if (idx.points.length === 0) return 0;
  if (idx.points.length === 1) return 0;

  let bestDistSq = Infinity;
  let bestRouteDist = 0;

  for (let i = 0; i < idx.points.length - 1; i++) {
    const a = idx.points[i];
    const b = idx.points[i + 1];
    const t = projectOnSegment(point, a, b);
    const proj: LatLng = {
      lat: a.lat + t * (b.lat - a.lat),
      lng: a.lng + t * (b.lng - a.lng),
    };
    const d = distSq(point, proj);
    if (d < bestDistSq) {
      bestDistSq = d;
      const segLen = idx.cumDist[i + 1] - idx.cumDist[i];
      bestRouteDist = idx.cumDist[i] + t * segLen;
    }
  }

  return bestRouteDist;
}

/* ── Get LatLng at a given distance along the route ──────────── */

export function positionAtDist(dist: number, idx: RouteIndex): LatLng {
  if (idx.points.length === 0) return { lat: 0, lng: 0 };
  if (dist <= 0) return idx.points[0];
  if (dist >= idx.totalDist) return idx.points[idx.points.length - 1];

  // Binary search for the segment containing this distance
  let lo = 0;
  let hi = idx.cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (idx.cumDist[mid] <= dist) lo = mid;
    else hi = mid;
  }

  const segLen = idx.cumDist[hi] - idx.cumDist[lo];
  const t = segLen > 0 ? (dist - idx.cumDist[lo]) / segLen : 0;
  const a = idx.points[lo];
  const b = idx.points[hi];

  return {
    lat: a.lat + t * (b.lat - a.lat),
    lng: a.lng + t * (b.lng - a.lng),
  };
}

/* ── Bearing between two points ──────────────────────────────── */

function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = (b.lng - a.lng) * toRad;
  const y = Math.sin(dLng) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/* ── Interpolation engine ────────────────────────────────────── */

const INTERP_DURATION_MS = 10_000; // match the 10s poll interval

export class BusInterpolator {
  private routeIdx: RouteIndex | null = null;
  private states = new Map<string, BusState>();

  /** Set/update the route polyline. */
  setRoute(points: LatLng[]): void {
    this.routeIdx = points.length >= 2 ? buildRouteIndex(points) : null;
    this.states.clear();
  }

  /** Feed new API positions. Call this each time parsedBuses changes. */
  update(buses: Array<{ id: string; lat: number; lng: number }>): void {
    if (!this.routeIdx) return;
    const now = Date.now();

    const seen = new Set<string>();
    for (const bus of buses) {
      seen.add(bus.id);
      const newDist = snapToRoute(bus, this.routeIdx);
      const existing = this.states.get(bus.id);

      if (existing) {
        // Compute current interpolated distance as the new 'from'
        const elapsed = Math.min(now - existing.startMs, existing.durationMs);
        const t = existing.durationMs > 0 ? elapsed / existing.durationMs : 1;
        const currentDist = existing.fromDist + t * (existing.toDist - existing.fromDist);

        this.states.set(bus.id, {
          fromDist: currentDist,
          toDist: newDist,
          startMs: now,
          durationMs: INTERP_DURATION_MS,
        });
      } else {
        // First sighting — no interpolation, just snap
        this.states.set(bus.id, {
          fromDist: newDist,
          toDist: newDist,
          startMs: now,
          durationMs: INTERP_DURATION_MS,
        });
      }
    }

    // Remove buses that are no longer in the feed
    for (const id of this.states.keys()) {
      if (!seen.has(id)) this.states.delete(id);
    }
  }

  /** Get current interpolated positions for all buses. */
  getPositions(): InterpolatedBus[] {
    if (!this.routeIdx) return [];
    const now = Date.now();
    const result: InterpolatedBus[] = [];

    for (const [id, state] of this.states) {
      const elapsed = Math.min(now - state.startMs, state.durationMs);
      const t = state.durationMs > 0 ? elapsed / state.durationMs : 1;
      // Ease-out for smoother deceleration as we approach target
      const eased = 1 - (1 - t) * (1 - t);
      const dist = state.fromDist + eased * (state.toDist - state.fromDist);

      const pos = positionAtDist(dist, this.routeIdx);

      // Bearing: look slightly ahead on the route for direction
      const lookAhead = positionAtDist(dist + 5, this.routeIdx);
      const bearing = bearingDeg(pos, lookAhead);

      result.push({ id, lat: pos.lat, lng: pos.lng, bearing });
    }

    return result;
  }

  /** Clear all state. */
  clear(): void {
    this.states.clear();
    this.routeIdx = null;
  }
}
