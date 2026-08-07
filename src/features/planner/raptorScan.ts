/**
 * RAPTOR Scan — the core round-based scan algorithm.
 */

import type { RaptorIndex, RaptorResult, Connection } from './types';
import { MAX_ROUNDS, INF } from './constants';

/**
 * Best boarding position on a route, given how early we can be at each stop.
 *
 * Arrival at stop `si` when boarding at `bi` is
 *     prevArrival(bi) + times[si] − times[bi]
 * so the quantity to minimise is `prevArrival(bi) − times[bi]`, NOT
 * `prevArrival(bi)` on its own. Minimising the arrival alone always boards at
 * whichever stop the walk reaches first, which on any route that passes the
 * origin twice — every circular line, and every line whose outbound and inbound
 * halves both pass the user — means boarding at the *upstream* position and
 * riding the entire loop. Worked case: origin 240 m from stop P (walk 3,
 * times[3]=6) and 800 m from stop Q (walk 10, times[20]=42), destination at
 * times[30]=60. Boarding P arrives at 57; boarding Q arrives at 28. The old
 * rule chose P because 3 < 10 — 29 minutes wrong, and it sent the user to the
 * wrong stop.
 */
export function raptorScan(
  originStops: Array<{ code: string; walkMin: number }>,
  nowMin: number,
  idx: RaptorIndex,
): RaptorResult {
  const bestArrivals = new Map<string, number>();
  const kArrivals: Array<Map<string, number>> = [];
  const kConnections: Array<Map<string, Connection>> = [];

  // Round 0 — walk from the origin pin to nearby stops, then propagate one
  // walking transfer so stops just outside the candidate radius are reachable.
  const round0 = new Map<string, number>();
  const conn0 = new Map<string, Connection>();
  let markedStops = new Set<string>();

  for (const { code, walkMin } of originStops) {
    const arrTime = nowMin + walkMin;
    round0.set(code, arrTime);
    bestArrivals.set(code, arrTime);
    markedStops.add(code);

    const xfers = idx.transfers.get(code);
    if (!xfers) continue;
    for (const { target, walkMin: xWalk } of xfers) {
      const xTime = arrTime + xWalk;
      if (xTime < (round0.get(target) ?? INF)) {
        round0.set(target, xTime);
        bestArrivals.set(target, Math.min(bestArrivals.get(target) ?? INF, xTime));
        markedStops.add(target);
      }
    }
  }

  kArrivals.push(round0);
  kConnections.push(conn0);

  for (let k = 1; k <= MAX_ROUNDS; k++) {
    const arrivals = new Map<string, number>();
    const connections = new Map<string, Connection>();
    const prevArrivals = kArrivals[k - 1];

    // Queue: every route through a marked stop, entered at its earliest
    // marked position.
    const queue = new Map<string, number>();
    for (const stopCode of markedStops) {
      const routes = idx.routesAtStop.get(stopCode);
      if (!routes) continue;
      for (const routeCode of routes) {
        const stopIdx = idx.routeStopIndex.get(routeCode)?.get(stopCode);
        if (stopIdx === undefined) continue;
        const existing = queue.get(routeCode);
        if (existing === undefined || stopIdx < existing) queue.set(routeCode, stopIdx);
      }
    }

    for (const [routeCode, fromIdx] of queue) {
      const path = idx.routePaths.get(routeCode);
      const times = idx.travelTimesMin.get(routeCode);
      if (!path || !times) continue;

      let boardStop: string | null = null;
      let boardIdx = -1;
      // prevArrival(boardIdx) − times[boardIdx]; adding times[si] gives the
      // arrival at si, so a smaller offset dominates at *every* later stop.
      let bestOffset = INF;

      for (let si = fromIdx; si < path.length; si++) {
        const stopCode = path[si];

        const prevArrival = prevArrivals.get(stopCode);
        if (prevArrival !== undefined && prevArrival < INF) {
          const offset = prevArrival - times[si];
          if (boardStop === null || offset < bestOffset) {
            boardStop = stopCode;
            boardIdx = si;
            bestOffset = offset;
          }
        }

        if (boardStop === null || si === boardIdx) continue;

        const arriveTime = bestOffset + times[si];
        if (arriveTime < (bestArrivals.get(stopCode) ?? INF)) {
          arrivals.set(stopCode, arriveTime);
          bestArrivals.set(stopCode, arriveTime);
          connections.set(stopCode, {
            type: 'ride',
            routeCode,
            boardStop,
            boardIdx,
            alightIdx: si,
          });
        }
      }
    }

    // Walking transfers out of everything improved this round.
    const newMarked = new Set<string>();
    for (const stopCode of [...arrivals.keys()]) {
      const arrTime = arrivals.get(stopCode) ?? INF;
      const xfers = idx.transfers.get(stopCode);
      if (!xfers) continue;

      for (const { target, walkMin } of xfers) {
        const xTime = arrTime + walkMin;
        if (xTime < (bestArrivals.get(target) ?? INF) && xTime < (arrivals.get(target) ?? INF)) {
          arrivals.set(target, xTime);
          bestArrivals.set(target, xTime);
          connections.set(target, { type: 'transfer', fromStop: stopCode, walkMin });
          newMarked.add(target);
        }
      }
    }

    kArrivals.push(arrivals);
    kConnections.push(connections);

    markedStops = new Set([...arrivals.keys(), ...newMarked]);
    if (markedStops.size === 0) break;
  }

  return { bestArrivals, kArrivals, kConnections };
}
