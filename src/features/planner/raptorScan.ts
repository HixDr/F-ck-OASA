/**
 * RAPTOR Scan — the core round-based scan algorithm.
 */

import type { RaptorIndex, RaptorResult, Connection } from './types';
import { MAX_ROUNDS, INF } from './constants';

/**
 * Run the RAPTOR scan.
 * @param originStops - stops near origin with walk times
 * @param nowMin - current time in minutes since midnight
 * @param idx - the pre-built RAPTOR index
 */
export function raptorScan(
  originStops: Array<{ code: string; walkMin: number }>,
  nowMin: number,
  idx: RaptorIndex,
): RaptorResult {
  const bestArrivals = new Map<string, number>();
  const kArrivals: Array<Map<string, number>> = [];
  const kConnections: Array<Map<string, Connection>> = [];

  // Initialize round 0 with walking from origin to nearby stops
  const round0 = new Map<string, number>();
  const conn0 = new Map<string, Connection>();
  let markedStops = new Set<string>();

  for (const { code, walkMin } of originStops) {
    const arrTime = nowMin + walkMin;
    round0.set(code, arrTime);
    bestArrivals.set(code, arrTime);
    markedStops.add(code);

    // Also propagate walking transfers from origin stops
    const xfers = idx.transfers.get(code);
    if (xfers) {
      for (const { target, walkMin: xWalk } of xfers) {
        const xTime = nowMin + walkMin + xWalk;
        const prev = round0.get(target) ?? INF;
        if (xTime < prev) {
          round0.set(target, xTime);
          bestArrivals.set(target, Math.min(bestArrivals.get(target) ?? INF, xTime));
          markedStops.add(target);
        }
      }
    }
  }

  kArrivals.push(round0);
  kConnections.push(conn0);

  // RAPTOR rounds
  for (let k = 1; k <= MAX_ROUNDS; k++) {
    const arrivals = new Map<string, number>();
    const connections = new Map<string, Connection>();

    // Get queue: routes passing through marked stops → earliest marked stop
    const queue = new Map<string, { routeCode: string; fromIdx: number }>();
    for (const stopCode of markedStops) {
      const routes = idx.routesAtStop.get(stopCode);
      if (!routes) continue;
      for (const routeCode of routes) {
        const stopIdx = idx.routeStopIndex.get(routeCode)?.get(stopCode);
        if (stopIdx === undefined) continue;
        const existing = queue.get(routeCode);
        if (!existing || stopIdx < existing.fromIdx) {
          queue.set(routeCode, { routeCode, fromIdx: stopIdx });
        }
      }
    }

    // Scan each queued route
    for (const [routeCode, { fromIdx }] of queue) {
      const path = idx.routePaths.get(routeCode);
      const times = idx.travelTimesMin.get(routeCode);
      if (!path || !times) continue;

      // Walk the route forward from the earliest marked stop.
      // At each stop, check if we can board (have a previous arrival),
      // then propagate to subsequent stops using travel times.
      let boardStop: string | null = null;
      let boardIdx = -1;
      let boardTime = INF; // time we depart from boardStop

      for (let si = fromIdx; si < path.length; si++) {
        const stopCode = path[si];

        // Can we board here? Check if previous round has an arrival.
        const prevArrival = kArrivals[k - 1].get(stopCode) ?? INF;
        if (prevArrival < INF) {
          // Board here if it gives an earlier departure
          const departTime = prevArrival; // board immediately on arrival
          if (boardStop === null || departTime < boardTime) {
            boardStop = stopCode;
            boardIdx = si;
            boardTime = departTime;
          }
        }

        // If we're on a bus, check if alighting here improves arrival
        if (boardStop !== null) {
          const rideMin = times[si] - times[boardIdx];
          const arriveTime = boardTime + rideMin;

          const prevBest = bestArrivals.get(stopCode) ?? INF;
          if (arriveTime < prevBest && si !== boardIdx) {
            arrivals.set(stopCode, arriveTime);
            bestArrivals.set(stopCode, arriveTime);
            connections.set(stopCode, {
              type: 'ride',
              routeCode,
              boardStop: boardStop,
              boardIdx,
              alightIdx: si,
            });
          }
        }
      }
    }

    // Scan transfers: walk from newly improved stops to nearby stops
    const newMarked = new Set<string>();
    const stopsToTransfer = [...arrivals.keys()];
    for (const stopCode of stopsToTransfer) {
      const arrTime = arrivals.get(stopCode) ?? INF;
      const xfers = idx.transfers.get(stopCode);
      if (!xfers) continue;

      for (const { target, walkMin } of xfers) {
        const xTime = arrTime + walkMin;
        const prevBest = bestArrivals.get(target) ?? INF;
        const prevRound = arrivals.get(target) ?? INF;
        if (xTime < prevBest && xTime < prevRound) {
          arrivals.set(target, xTime);
          bestArrivals.set(target, xTime);
          connections.set(target, {
            type: 'transfer',
            fromStop: stopCode,
            walkMin,
          });
          newMarked.add(target);
        }
      }
    }

    kArrivals.push(arrivals);
    kConnections.push(connections);

    // Marked stops for next round = stops improved in this round
    markedStops = new Set([...arrivals.keys(), ...newMarked]);
    if (markedStops.size === 0) break; // no improvement, done
  }

  return { bestArrivals, kArrivals, kConnections };
}
