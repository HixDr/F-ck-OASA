/**
 * RAPTOR Index — builds the pre-computed spatial/route index from offline data.
 *
 * The index depends only on the *set of routes* pulled in by the candidate
 * stops, never on the pin coordinates themselves, so it is cached: nudging a
 * pin a hundred metres almost always keeps the same route set and skips the
 * rebuild entirely. Rebuilding it per search was hundreds of milliseconds and
 * tens of megabytes of allocation churn on Hermes.
 */

import { getCachedRoutesForStop, getCachedStops, onOfflineDataCleared } from '../../services/storage';
import { haversineM, lngScaleAt } from '../../utils/geo';
import type { OasaRoute, OasaStop } from '../../types';
import type { RaptorIndex } from './types';
import type { StopTable } from './stopTable';
import {
  TRANSFER_WALK_RADIUS_M,
  TRANSFER_FLAT_PENALTY_MIN,
  WALK_SPEED_M_PER_MIN,
  AVG_BUS_SPEED_M_PER_MIN,
  MAX_TRANSFERS_PER_STOP,
} from './constants';

/** Metres per degree of latitude. */
const M_PER_DEG_LAT = 111_320;
/** Representative latitude for Attica, used to size the longitude grid. */
const ATHENS_LAT = 37.98;

/* ── Index cache ─────────────────────────────────────────────── */

interface CacheEntry {
  key: string;
  idx: RaptorIndex;
}
/** Small LRU. Two entries covers "home ↔ work" without pinning too many
 *  transfer graphs in memory at once. */
const CACHE_LIMIT = 2;
const _cache: CacheEntry[] = [];

function cacheGet(key: string): RaptorIndex | null {
  const i = _cache.findIndex((e) => e.key === key);
  if (i < 0) return null;
  const [entry] = _cache.splice(i, 1);
  _cache.unshift(entry);
  return entry.idx;
}

function cachePut(key: string, idx: RaptorIndex): void {
  _cache.unshift({ key, idx });
  if (_cache.length > CACHE_LIMIT) _cache.length = CACHE_LIMIT;
}

/** Drop the cached indexes — call when offline data is replaced. */
export function clearRaptorIndexCache(): void {
  _cache.length = 0;
}

// Correctness does not depend on this — the cache key includes the offline
// data timestamp, so a stale index can never be served. It exists to release
// the retained structures promptly instead of holding tens of MB until the
// next search evicts them. Registered here rather than called from storage so
// that storage stays a leaf module and this code is only reachable for users
// who actually opened the planner.
onOfflineDataCleared(clearRaptorIndexCache);

/* ── Build ───────────────────────────────────────────────────── */

/**
 * Sort a route's stops by RouteStopOrder.
 *
 * Nothing else in the app did this: array position was treated as route
 * position, which silently reverses or scrambles legs whenever the API returns
 * stops in another order. Rows without an order keep their relative position.
 */
function orderStops(stops: OasaStop[]): OasaStop[] {
  let needsSort = false;
  for (let i = 0; i < stops.length; i++) {
    const o = Number(stops[i].RouteStopOrder);
    if (!Number.isFinite(o)) return stops;      // no order data — trust the array
    if (i > 0 && o < Number(stops[i - 1].RouteStopOrder)) needsSort = true;
  }
  if (!needsSort) return stops;
  return stops.slice().sort((a, b) => Number(a.RouteStopOrder) - Number(b.RouteStopOrder));
}

/**
 * Build (or reuse) the RAPTOR index for the routes serving `candidateStopCodes`.
 *
 * `offlineTs` is part of the cache key so a re-download of the offline data
 * invalidates every cached index even when the route codes are unchanged —
 * the stop *sequences* inside them may not be.
 */
export async function buildRaptorIndex(
  candidateStopCodes: Set<string>,
  table: StopTable,
  offlineTs: number | null,
): Promise<RaptorIndex> {
  // Collect all routes touching candidate stops. These lookups hit the
  // in-memory dict cache, so they are cheap enough to run before the cache key
  // exists — and the route set *is* the cache key.
  const routeResults = await Promise.all(
    [...candidateStopCodes].map((stopCode) => getCachedRoutesForStop(stopCode)),
  );
  const routeByCode = new Map<string, OasaRoute>();
  for (const routes of routeResults) {
    if (!routes) continue;
    for (const r of routes) if (!routeByCode.has(r.RouteCode)) routeByCode.set(r.RouteCode, r);
  }
  if (routeByCode.size === 0) {
    return {
      routePaths: new Map(), routeStopIndex: new Map(), routesAtStop: new Map(),
      travelTimesMin: new Map(), routeMeta: new Map(), stopInfo: new Map(), transfers: new Map(),
    };
  }

  const cacheKey = `${offlineTs ?? 0}#${[...routeByCode.keys()].sort().join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const routePaths = new Map<string, string[]>();
  const routeStopIndex = new Map<string, Map<string, number>>();
  const routesAtStop = new Map<string, string[]>();
  const travelTimesMin = new Map<string, number[]>();
  const routeMeta = new Map<string, OasaRoute>();
  // Scoped to stops that are actually on an indexed route. Populating it for
  // all 9,382 network stops built a map 5-10x larger than anything we read.
  const stopInfo = new Map<string, { name: string; lat: number; lng: number }>();
  const transfers = new Map<string, Array<{ target: string; walkMin: number }>>();

  const routeQueue = [...routeByCode.values()];
  const stopsResults = await Promise.all(
    routeQueue.map((route) => getCachedStops(route.RouteCode).then((stops) => ({ route, stops }))),
  );

  for (const { route, stops: rawStops } of stopsResults) {
    if (!rawStops || rawStops.length < 2) continue;
    const stops = orderStops(rawStops);

    const path: string[] = new Array(stops.length);
    const idxMap = new Map<string, number>();
    const cumTimes: number[] = new Array(stops.length);
    cumTimes[0] = 0;

    let prevLat = 0;
    let prevLng = 0;

    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const code = s.StopCode;
      path[i] = code;
      // First occurrence wins: circular routes list the same StopCode twice and
      // the scan must be able to start from the earliest one.
      if (!idxMap.has(code)) idxMap.set(code, i);

      let info = stopInfo.get(code);
      if (!info) {
        const t = table.byCode.get(code);
        info = t !== undefined
          ? { name: table.names[t], lat: table.lat[t], lng: table.lng[t] }
          : {
              name: s.StopDescrEng || s.StopDescr,
              lat: parseFloat(s.StopLat),
              lng: parseFloat(s.StopLng),
            };
        stopInfo.set(code, info);
      }

      if (i > 0) {
        // Cold-start ride estimate only. rideTimes.ts upgrades this to a
        // measured span for the trips we actually show.
        const dist = haversineM(prevLat, prevLng, info.lat, info.lng);
        const hopMin = Math.max(0.5, dist / AVG_BUS_SPEED_M_PER_MIN);
        cumTimes[i] = cumTimes[i - 1] + hopMin;
      }
      prevLat = info.lat;
      prevLng = info.lng;

      const existing = routesAtStop.get(code);
      if (existing) {
        if (!existing.includes(route.RouteCode)) existing.push(route.RouteCode);
      } else {
        routesAtStop.set(code, [route.RouteCode]);
      }
    }

    routePaths.set(route.RouteCode, path);
    routeStopIndex.set(route.RouteCode, idxMap);
    travelTimesMin.set(route.RouteCode, cumTimes);
    routeMeta.set(route.RouteCode, route);
  }

  buildTransfers(routesAtStop, stopInfo, transfers);

  const idx: RaptorIndex = {
    routePaths, routeStopIndex, routesAtStop, travelTimesMin, routeMeta, stopInfo, transfers,
  };
  cachePut(cacheKey, idx);
  return idx;
}

/**
 * Walking-transfer graph, via a spatial grid.
 *
 * Two things the old grid got wrong:
 *   - one cell size for both axes. 0.004° is 445 m of latitude but only 351 m
 *     of longitude at 38°N, so a 3x3 neighbourhood guaranteed just 351 m
 *     east-west against a 400 m radius: real 351-400 m transfers on an
 *     east-west axis were silently dropped. Each axis now gets its own cell
 *     size equal to the radius, which makes 3x3 exactly sufficient.
 *   - nine template-string keys per stop — 45k-54k throwaway strings. The keys
 *     are numeric now.
 */
function buildTransfers(
  routesAtStop: Map<string, string[]>,
  stopInfo: Map<string, { name: string; lat: number; lng: number }>,
  out: Map<string, Array<{ target: string; walkMin: number }>>,
): void {
  const latCell = TRANSFER_WALK_RADIUS_M / M_PER_DEG_LAT;
  const lngCell = TRANSFER_WALK_RADIUS_M / (M_PER_DEG_LAT * lngScaleAt(ATHENS_LAT));
  // Pack (gx, gy) into one safe integer. The offset keeps both halves
  // non-negative for southern/western coordinates; 1e6 leaves ample headroom.
  const OFF = 500_000;
  const cellKey = (gx: number, gy: number) => (gx + OFF) * 1_000_000 + (gy + OFF);

  // Planar metres-per-degree at Athens. Over a 400 m window the flat-earth
  // approximation is good to well under a metre, and it replaces a haversine
  // (two sines, two cosines, a sqrt and an atan2) with three multiplies in the
  // hottest loop of the whole index build.
  const mPerLat = M_PER_DEG_LAT;
  const mPerLng = M_PER_DEG_LAT * lngScaleAt(ATHENS_LAT);
  const radiusSq = TRANSFER_WALK_RADIUS_M * TRANSFER_WALK_RADIUS_M;

  const indexedStops = [...routesAtStop.keys()];
  const grid = new Map<number, string[]>();

  for (const stopCode of indexedStops) {
    const info = stopInfo.get(stopCode);
    if (!info) continue;
    const key = cellKey(Math.floor(info.lat / latCell), Math.floor(info.lng / lngCell));
    const arr = grid.get(key);
    if (arr) arr.push(stopCode);
    else grid.set(key, [stopCode]);
  }

  const scratch: Array<{ target: string; walkMin: number; distM: number }> = [];

  for (const stopCode of indexedStops) {
    const info = stopInfo.get(stopCode);
    if (!info) continue;
    const gx = Math.floor(info.lat / latCell);
    const gy = Math.floor(info.lng / lngCell);
    scratch.length = 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(cellKey(gx + dx, gy + dy));
        if (!cell) continue;
        for (const otherCode of cell) {
          if (otherCode === stopCode) continue;
          const otherInfo = stopInfo.get(otherCode);
          if (!otherInfo) continue;
          const dy = (otherInfo.lat - info.lat) * mPerLat;
          const dx = (otherInfo.lng - info.lng) * mPerLng;
          const dSq = dy * dy + dx * dx;
          if (dSq > radiusSq) continue;
          const distM = Math.sqrt(dSq);
          const walkMin = distM < 50
            ? TRANSFER_FLAT_PENALTY_MIN
            : Math.max(TRANSFER_FLAT_PENALTY_MIN, Math.round(distM / WALK_SPEED_M_PER_MIN));
          scratch.push({ target: otherCode, walkMin, distM });
        }
      }
    }

    if (scratch.length === 0) continue;
    // Keep only the nearest few. A central stop has 30+ neighbours inside
    // 400 m and the far ones never win a transfer, but they do multiply the
    // graph — and the graph is the single largest allocation in the planner.
    if (scratch.length > MAX_TRANSFERS_PER_STOP) {
      scratch.sort((a, b) => a.distM - b.distM);
      scratch.length = MAX_TRANSFERS_PER_STOP;
    }
    out.set(stopCode, scratch.map((x) => ({ target: x.target, walkMin: x.walkMin })));
  }
}
