/**
 * RAPTOR Index — builds the pre-computed spatial/route index from offline data.
 */

import { haversine } from '../map/busInterpolation';
import { getCachedRoutesForStop, getCachedStops } from '../../services/storage';
import type { OasaBulkStop, OasaRoute } from '../../types';
import type { RaptorIndex } from './types';
import {
  TRANSFER_WALK_RADIUS_M,
  TRANSFER_FLAT_PENALTY_MIN,
  WALK_SPEED_M_PER_MIN,
  AVG_BUS_SPEED_M_PER_MIN,
} from './constants';

/**
 * Build RAPTOR index from cached offline data.
 * Scoped to the given candidate stop codes for performance.
 */
export async function buildRaptorIndex(
  candidateStopCodes: Set<string>,
  allStops: OasaBulkStop[],
): Promise<RaptorIndex> {
  const routePaths = new Map<string, string[]>();
  const routeStopIndex = new Map<string, Map<string, number>>();
  const routesAtStop = new Map<string, string[]>();
  const travelTimesMin = new Map<string, number[]>();
  const routeMeta = new Map<string, OasaRoute>();
  const stopInfo = new Map<string, { name: string; lat: number; lng: number }>();
  const transfers = new Map<string, Array<{ target: string; walkMin: number }>>();

  // Populate stopInfo for all allStops (we'll need it for transfer calculation)
  for (const s of allStops) {
    stopInfo.set(s.stop_code, {
      name: s.stop_descr_eng || s.stop_descr,
      lat: parseFloat(s.stop_lat),
      lng: parseFloat(s.stop_lng),
    });
  }

  // Collect all routes touching candidate stops (parallel)
  const routesSeen = new Set<string>();
  const routeQueue: OasaRoute[] = [];

  const routeResults = await Promise.all(
    [...candidateStopCodes].map((stopCode) => getCachedRoutesForStop(stopCode)),
  );
  for (const routes of routeResults) {
    if (!routes) continue;
    for (const r of routes) {
      if (routesSeen.has(r.RouteCode)) continue;
      routesSeen.add(r.RouteCode);
      routeQueue.push(r);
    }
  }

  // Load stop sequences for each route in parallel
  const stopsResults = await Promise.all(
    routeQueue.map((route) => getCachedStops(route.RouteCode).then((stops) => ({ route, stops }))),
  );

  for (const { route, stops } of stopsResults) {
    if (!stops || stops.length < 2) continue;

    const path: string[] = [];
    const idxMap = new Map<string, number>();
    const cumTimes: number[] = [0];

    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      path.push(s.StopCode);
      idxMap.set(s.StopCode, i);

      // Populate stopInfo if missing
      if (!stopInfo.has(s.StopCode)) {
        stopInfo.set(s.StopCode, {
          name: s.StopDescrEng || s.StopDescr,
          lat: parseFloat(s.StopLat),
          lng: parseFloat(s.StopLng),
        });
      }

      // Compute cumulative travel time from haversine distance
      if (i > 0) {
        const prev = stops[i - 1];
        const dist = haversine(
          { lat: parseFloat(prev.StopLat), lng: parseFloat(prev.StopLng) },
          { lat: parseFloat(s.StopLat), lng: parseFloat(s.StopLng) },
        );
        // Convert distance to time at average bus speed, min 0.5 min per hop
        const hopMin = Math.max(0.5, dist / AVG_BUS_SPEED_M_PER_MIN);
        cumTimes.push(cumTimes[i - 1] + hopMin);
      }

      // Register route at this stop
      const existing = routesAtStop.get(s.StopCode);
      if (existing) {
        if (!existing.includes(route.RouteCode)) existing.push(route.RouteCode);
      } else {
        routesAtStop.set(s.StopCode, [route.RouteCode]);
      }
    }

    routePaths.set(route.RouteCode, path);
    routeStopIndex.set(route.RouteCode, idxMap);
    travelTimesMin.set(route.RouteCode, cumTimes);
    routeMeta.set(route.RouteCode, route);
  }

  // Build walking transfers using a spatial grid for O(n·k) instead of O(n²).
  // Grid cell size ~400m in lat/lng at Athens latitude (~38°N).
  const GRID_SIZE = 0.004;
  const grid = new Map<string, string[]>();
  const indexedStops = [...routesAtStop.keys()];

  for (const stopCode of indexedStops) {
    const info = stopInfo.get(stopCode);
    if (!info) continue;
    const gx = Math.floor(info.lat / GRID_SIZE);
    const gy = Math.floor(info.lng / GRID_SIZE);
    const key = `${gx},${gy}`;
    const arr = grid.get(key);
    if (arr) arr.push(stopCode);
    else grid.set(key, [stopCode]);
  }

  for (const stopCode of indexedStops) {
    const info = stopInfo.get(stopCode);
    if (!info) continue;
    const gx = Math.floor(info.lat / GRID_SIZE);
    const gy = Math.floor(info.lng / GRID_SIZE);
    const xfers: Array<{ target: string; walkMin: number }> = [];

    // Check 9 neighbouring cells
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (!cell) continue;
        for (const otherCode of cell) {
          if (otherCode === stopCode) continue;
          const otherInfo = stopInfo.get(otherCode);
          if (!otherInfo) continue;
          const dist = haversine(
            { lat: info.lat, lng: info.lng },
            { lat: otherInfo.lat, lng: otherInfo.lng },
          );
          if (dist <= TRANSFER_WALK_RADIUS_M) {
            const walkMin = dist < 50
              ? TRANSFER_FLAT_PENALTY_MIN
              : Math.max(TRANSFER_FLAT_PENALTY_MIN, Math.round(dist / WALK_SPEED_M_PER_MIN));
            xfers.push({ target: otherCode, walkMin });
          }
        }
      }
    }

    if (xfers.length > 0) transfers.set(stopCode, xfers);
  }

  return { routePaths, routeStopIndex, routesAtStop, travelTimesMin, routeMeta, stopInfo, transfers };
}
