/**
 * Trip Planner — RAPTOR-based algorithm for finding bus routes between two map pins.
 *
 * Supports direct routes and up to 2 transfers (3 buses).
 * Uses a round-based RAPTOR scan with synthetic travel times derived from
 * haversine distances between consecutive stops (~16 km/h average bus speed).
 */

import { haversine, type LatLng } from './busInterpolation';
import { parseSchedule } from './scheduleUtils';
import {
  getAllCachedStops,
  getCachedRoutesForStop,
  getCachedStops,
  getCachedRoutes,
  getCachedSchedule,
} from './storage';
import { getStopArrivals } from './api';
import type { OasaBulkStop, OasaRoute, OasaStop, OasaLine, OasaArrival } from './types';

/* ── Types ───────────────────────────────────────────────────── */

/** A single leg of a trip (one bus ride). */
export interface TripLeg {
  lineCode: string;
  lineId: string;
  lineDescr: string;
  routeCode: string;
  boardStop: {
    code: string;
    name: string;
    lat: number;
    lng: number;
    orderInRoute: number;
  };
  alightStop: {
    code: string;
    name: string;
    lat: number;
    lng: number;
    orderInRoute: number;
  };
  stopCount: number;
  rideTimeMin: number;
  waitTimeMin: number | null;
  waitSource: 'live' | 'scheduled' | null;
  scheduledTime: string | null;
}

/** A complete trip from origin to destination. */
export interface TripOption {
  legs: TripLeg[];
  walkToOriginMin: number;
  walkFromDestMin: number;
  transferWalkMin: number;             // sum of all transfer walks
  totalTimeMin: number;
  originStop: { code: string; name: string; lat: number; lng: number };
  destStop: { code: string; name: string; lat: number; lng: number };
}

/** Stop candidate with distance from pin. */
export interface StopCandidate {
  code: string;
  name: string;
  lat: number;
  lng: number;
  distM: number;
}

/* ── Constants ───────────────────────────────────────────────── */

const CANDIDATE_RADIUS_M = 1200;
const WALK_SPEED_M_PER_MIN = 80;       // ~4.8 km/h
const TRANSFER_WALK_RADIUS_M = 400;    // max walk between stops for a transfer
const TRANSFER_FLAT_PENALTY_MIN = 3;   // minimum transfer time even at same stop
const UNKNOWN_WAIT_MIN = 10;
const FALLBACK_MIN_PER_STOP = 2;
const TOO_CLOSE_M = 200;
const MAX_RESULTS = 10;
const MAX_ROUNDS = 3;                  // up to 3 bus legs (2 transfers)
const AVG_BUS_SPEED_M_PER_MIN = 267;   // ~16 km/h in metres per minute
const INF = 999999;

/* ── RAPTOR Index ────────────────────────────────────────────── */

/** Pre-computed data for the RAPTOR scan, built from offline cached data. */
interface RaptorIndex {
  /** routeCode → ordered array of stop codes */
  routePaths: Map<string, string[]>;
  /** routeCode → map of stopCode → position index in route */
  routeStopIndex: Map<string, Map<string, number>>;
  /** stopCode → array of routeCodes serving this stop */
  routesAtStop: Map<string, string[]>;
  /** routeCode → cumulative travel time in minutes from first stop to each stop */
  travelTimesMin: Map<string, number[]>;
  /** routeCode → OasaRoute (for lineCode, descr, etc.) */
  routeMeta: Map<string, OasaRoute>;
  /** stopCode → { name, lat, lng } */
  stopInfo: Map<string, { name: string; lat: number; lng: number }>;
  /** stopCode → array of { target, walkMin } for walking transfers */
  transfers: Map<string, Array<{ target: string; walkMin: number }>>;
}

/**
 * Build RAPTOR index from cached offline data.
 * Scoped to the given candidate stop codes for performance.
 */
async function buildRaptorIndex(
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

  // Collect all routes touching candidate stops
  const routesSeen = new Set<string>();
  const routeQueue: OasaRoute[] = [];

  for (const stopCode of candidateStopCodes) {
    const routes = await getCachedRoutesForStop(stopCode);
    if (!routes) continue;
    for (const r of routes) {
      if (routesSeen.has(r.RouteCode)) continue;
      routesSeen.add(r.RouteCode);
      routeQueue.push(r);
    }
  }

  // Load stop sequences for each route and build travel times
  for (const route of routeQueue) {
    const stops = await getCachedStops(route.RouteCode);
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

/* ── RAPTOR Scan ─────────────────────────────────────────────── */

/** Connection record: how we reached a stop in a given round. */
type RideConnection = {
  type: 'ride';
  routeCode: string;
  boardStop: string;
  boardIdx: number;
  alightIdx: number;
};
type TransferConnection = {
  type: 'transfer';
  fromStop: string;
  walkMin: number;
};
type Connection = RideConnection | TransferConnection;

interface RaptorResult {
  /** bestArrivals[stopCode] = earliest known arrival time (minutes) */
  bestArrivals: Map<string, number>;
  /** kArrivals[round][stopCode] = earliest arrival at stop in this round */
  kArrivals: Array<Map<string, number>>;
  /** kConnections[round][stopCode] = how we reached this stop in this round */
  kConnections: Array<Map<string, Connection>>;
}

/**
 * Run the RAPTOR scan.
 * @param originStops - stops near origin with walk times
 * @param nowMin - current time in minutes since midnight
 * @param idx - the pre-built RAPTOR index
 */
function raptorScan(
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

/* ── Extract Trips from RAPTOR Connections ────────────────────── */

/** Raw leg data before conversion to TripLeg. */
interface RawLeg {
  routeCode: string;
  boardStop: string;
  boardIdx: number;
  alightStop: string;
  alightIdx: number;
  rideMin: number;
}

/**
 * Trace backward from a stop through kConnections to recover prior legs.
 * Returns the legs and accumulated transfer walk times, or null on failure.
 */
function traceLegsBack(
  startStop: string,
  startRound: number,
  result: RaptorResult,
  idx: RaptorIndex,
): { legs: RawLeg[]; transferWalks: number[] } | null {
  const legs: RawLeg[] = [];
  const transferWalks: number[] = [];
  let curStop = startStop;
  let curRound = startRound;

  while (curRound >= 1) {
    const conn = result.kConnections[curRound].get(curStop);
    if (!conn) break;

    if (conn.type === 'transfer') {
      transferWalks.push(conn.walkMin);
      curStop = conn.fromStop;
      // Stay in same round — the ride that got us to fromStop is also in this round
      continue;
    }

    // It's a ride
    const path = idx.routePaths.get(conn.routeCode);
    const times = idx.travelTimesMin.get(conn.routeCode);
    if (!path || !times) return null;

    const rideMin = times[conn.alightIdx] - times[conn.boardIdx];
    legs.unshift({
      routeCode: conn.routeCode,
      boardStop: conn.boardStop,
      boardIdx: conn.boardIdx,
      alightStop: path[conn.alightIdx],
      alightIdx: conn.alightIdx,
      rideMin,
    });

    curStop = conn.boardStop;
    curRound -= 1;
  }

  return legs.length > 0 ? { legs, transferWalks } : null;
}

/**
 * Build a TripOption from raw legs, transfer walks, and origin/dest context.
 */
function buildTripOption(
  rawLegs: RawLeg[],
  transferWalks: number[],
  dest: { code: string; walkMin: number },
  originStops: Array<{ code: string; walkMin: number; distM: number }>,
  idx: RaptorIndex,
  linesMap: Map<string, OasaLine>,
): TripOption | null {
  if (rawLegs.length === 0) return null;

  // Find which origin stop was used (the boardStop of the first leg)
  const firstBoardCode = rawLegs[0].boardStop;
  const originMatch = originStops.find((o) => o.code === firstBoardCode);
  // If firstBoardCode isn't directly an origin stop, it might be reachable
  // via walk from an origin stop. Find the closest origin.
  const walkToOriginMin = originMatch
    ? originMatch.walkMin
    : (() => {
        const info = idx.stopInfo.get(firstBoardCode);
        if (!info) return 15; // fallback
        let best = INF;
        for (const o of originStops) {
          const oInfo = idx.stopInfo.get(o.code);
          if (!oInfo) continue;
          const d = haversine({ lat: oInfo.lat, lng: oInfo.lng }, { lat: info.lat, lng: info.lng });
          const wk = d / WALK_SPEED_M_PER_MIN;
          if (wk < best) best = wk;
        }
        return best < INF ? best : 15;
      })();

  // Build TripLeg objects
  const tripLegs: TripLeg[] = [];
  for (const leg of rawLegs) {
    const meta = idx.routeMeta.get(leg.routeCode);
    const lineCode = meta?.LineCode ?? '';
    const lineInfo = linesMap.get(lineCode);
    const boardInfo = idx.stopInfo.get(leg.boardStop);
    const alightInfo = idx.stopInfo.get(leg.alightStop);

    tripLegs.push({
      lineCode,
      lineId: lineInfo?.LineID ?? lineCode,
      lineDescr: lineInfo?.LineDescrEng ?? lineInfo?.LineDescr ?? meta?.RouteDescrEng ?? '',
      routeCode: leg.routeCode,
      boardStop: {
        code: leg.boardStop,
        name: boardInfo?.name ?? leg.boardStop,
        lat: boardInfo?.lat ?? 0,
        lng: boardInfo?.lng ?? 0,
        orderInRoute: leg.boardIdx,
      },
      alightStop: {
        code: leg.alightStop,
        name: alightInfo?.name ?? leg.alightStop,
        lat: alightInfo?.lat ?? 0,
        lng: alightInfo?.lng ?? 0,
        orderInRoute: leg.alightIdx,
      },
      stopCount: leg.alightIdx - leg.boardIdx,
      rideTimeMin: Math.max(1, Math.round(leg.rideMin)),
      waitTimeMin: null,
      waitSource: null,
      scheduledTime: null,
    });
  }

  const totalTransferWalk = transferWalks.reduce((a, b) => a + b, 0);
  const walkFromDestMin = dest.walkMin;
  const totalRideMin = tripLegs.reduce((sum, l) => sum + l.rideTimeMin, 0);
  const totalWaitEstimate = tripLegs.length * UNKNOWN_WAIT_MIN;

  const total = Math.round(
    walkToOriginMin + totalWaitEstimate + totalRideMin + totalTransferWalk + walkFromDestMin,
  );

  const firstBoard = tripLegs[0].boardStop;
  const lastAlight = tripLegs[tripLegs.length - 1].alightStop;

  return {
    legs: tripLegs,
    walkToOriginMin: Math.round(walkToOriginMin),
    walkFromDestMin: Math.round(walkFromDestMin),
    transferWalkMin: Math.round(totalTransferWalk),
    totalTimeMin: total,
    originStop: { code: firstBoard.code, name: firstBoard.name, lat: firstBoard.lat, lng: firstBoard.lng },
    destStop: { code: lastAlight.code, name: lastAlight.name, lat: lastAlight.lat, lng: lastAlight.lng },
  };
}

/**
 * Trace back from destination stops through kConnections to build TripOption[].
 *
 * Pass 1: Standard RAPTOR extraction — traces the single best connection per stop.
 * Pass 2: Route enumeration — tries ALL routes serving each dest stop as the
 *         final leg, catching near-optimal alternatives that RAPTOR pruned
 *         (e.g. a slightly slower bus that may have live tracking).
 */
function extractTrips(
  result: RaptorResult,
  destStops: Array<{ code: string; walkMin: number; distM: number }>,
  originStops: Array<{ code: string; walkMin: number; distM: number }>,
  idx: RaptorIndex,
  linesMap: Map<string, OasaLine>,
): TripOption[] {
  const trips: TripOption[] = [];
  const seenKeys = new Set<string>();

  // === Pass 1: Standard RAPTOR extraction ===
  for (const dest of destStops) {
    for (let k = 1; k < result.kArrivals.length; k++) {
      const arrTime = result.kArrivals[k].get(dest.code);
      if (arrTime === undefined || arrTime >= INF) continue;

      const traced = traceLegsBack(dest.code, k, result, idx);
      if (!traced) continue;

      const key = traced.legs.map((l) => l.routeCode).join('|');
      seenKeys.add(key);

      const trip = buildTripOption(traced.legs, traced.transferWalks, dest, originStops, idx, linesMap);
      if (trip) trips.push(trip);
    }
  }

  // === Pass 2: Route enumeration at dest stops ===
  // For each dest stop, try ALL routes serving it as the final leg.
  // This discovers alternative route combos that RAPTOR pruned because
  // a faster route already reached the same stop in the same round.
  const ENUM_RELAX_MIN = 20; // max minutes slower than RAPTOR best at dest

  for (const dest of destStops) {
    const routesHere = idx.routesAtStop.get(dest.code);
    if (!routesHere) continue;

    for (const routeCode of routesHere) {
      const path = idx.routePaths.get(routeCode);
      const times = idx.travelTimesMin.get(routeCode);
      const destIdxInRoute = idx.routeStopIndex.get(routeCode)?.get(dest.code);
      if (!path || !times || destIdxInRoute === undefined || destIdxInRoute === 0) continue;

      // Try each round k: the enumerated route is the leg in round k,
      // so the boarding stop must be reachable in round k−1.
      for (let k = 1; k < result.kArrivals.length; k++) {
        const prevRoundArrivals = result.kArrivals[k - 1];
        if (!prevRoundArrivals) continue;

        // Find best boarding stop on this route reachable in round k−1
        let bestBoardStop: string | null = null;
        let bestBoardIdx = -1;
        let bestDepartTime = INF;

        for (let si = 0; si < destIdxInRoute; si++) {
          const stopCode = path[si];
          const prevArr = prevRoundArrivals.get(stopCode);
          if (prevArr !== undefined && prevArr < INF && prevArr < bestDepartTime) {
            bestDepartTime = prevArr;
            bestBoardStop = stopCode;
            bestBoardIdx = si;
          }
        }

        if (bestBoardStop === null) continue;

        const rideMin = times[destIdxInRoute] - times[bestBoardIdx];
        const arriveAtDest = bestDepartTime + rideMin;

        // Only consider if within relaxation margin of the RAPTOR-optimal arrival
        const bestAtDest = result.bestArrivals.get(dest.code) ?? INF;
        if (arriveAtDest > bestAtDest + ENUM_RELAX_MIN) continue;

        // Build the final leg
        const lastLeg: RawLeg = {
          routeCode,
          boardStop: bestBoardStop,
          boardIdx: bestBoardIdx,
          alightStop: dest.code,
          alightIdx: destIdxInRoute,
          rideMin,
        };

        // Trace back from the boarding stop in round k−1
        let allLegs: RawLeg[];
        let transferWalks: number[] = [];

        if (k === 1) {
          // Direct route — no prior legs to trace
          allLegs = [lastLeg];
        } else {
          const traced = traceLegsBack(bestBoardStop, k - 1, result, idx);
          if (!traced) continue;
          allLegs = [...traced.legs, lastLeg];
          transferWalks = traced.transferWalks;
        }

        // Skip already-discovered route combos
        const key = allLegs.map((l) => l.routeCode).join('|');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const trip = buildTripOption(allLegs, transferWalks, dest, originStops, idx, linesMap);
        if (trip) trips.push(trip);
      }
    }
  }

  // === Pass 3: Direct 2-leg feeder enumeration ===
  // RAPTOR stores one connection per stop, so the Pass 2 trace-back always
  // returns the RAPTOR-optimal feeder route.  For example, night line 400
  // may win the connection even though daytime line 421 is the practical
  // choice.  This pass bypasses RAPTOR connections entirely and tries ALL
  // feeder routes that can connect origin → transfer → last-leg route.
  const bestTotalSoFar = trips.length > 0 ? Math.min(...trips.map((t) => t.totalTimeMin)) : INF;
  const pass3Cutoff = Math.max(bestTotalSoFar * 1.8, bestTotalSoFar + 30);

  for (const dest of destStops) {
    const routesHere = idx.routesAtStop.get(dest.code);
    if (!routesHere) continue;

    for (const r2Code of routesHere) {
      const r2Path = idx.routePaths.get(r2Code);
      const r2Times = idx.travelTimesMin.get(r2Code);
      const destIdx2 = idx.routeStopIndex.get(r2Code)?.get(dest.code);
      if (!r2Path || !r2Times || destIdx2 === undefined || destIdx2 === 0) continue;

      // For each possible boarding stop on R2, collect reachable
      // feeder-alight stops (the R2 stop itself + walking neighbours).
      for (let bi = 0; bi < destIdx2; bi++) {
        const r2BoardStop = r2Path[bi];

        // Stops from which we can walk to r2BoardStop (including itself)
        const feedSources = new Map<string, number>(); // stopCode → walkMin
        feedSources.set(r2BoardStop, 0);
        const xfers = idx.transfers.get(r2BoardStop);
        if (xfers) {
          for (const { target, walkMin: xw } of xfers) feedSources.set(target, xw);
        }

        for (const [alightStop1, xferWalk] of feedSources) {
          const r1Codes = idx.routesAtStop.get(alightStop1);
          if (!r1Codes) continue;

          for (const r1Code of r1Codes) {
            if (r1Code === r2Code) continue; // no same-route "transfer"

            const combo = r1Code + '|' + r2Code;
            if (seenKeys.has(combo)) continue;

            const r1Path = idx.routePaths.get(r1Code);
            const r1Times = idx.travelTimesMin.get(r1Code);
            const alightIdx1 = idx.routeStopIndex.get(r1Code)?.get(alightStop1);
            if (!r1Path || !r1Times || alightIdx1 === undefined || alightIdx1 === 0) continue;

            // Find best origin stop on R1 upstream of alightIdx1
            let bestOrigIdx = -1;
            let bestOrigStop: string | null = null;
            let bestOrigWalk = INF;
            for (let oi = 0; oi < alightIdx1; oi++) {
              const oMatch = originStops.find((o) => o.code === r1Path[oi]);
              if (oMatch && oMatch.walkMin < bestOrigWalk) {
                bestOrigWalk = oMatch.walkMin;
                bestOrigStop = r1Path[oi];
                bestOrigIdx = oi;
              }
            }
            if (!bestOrigStop) continue;

            const ride1 = r1Times[alightIdx1] - r1Times[bestOrigIdx];
            const ride2 = r2Times[destIdx2] - r2Times[bi];
            const totalEst = Math.round(
              bestOrigWalk + UNKNOWN_WAIT_MIN + ride1 + xferWalk +
              UNKNOWN_WAIT_MIN + ride2 + dest.walkMin,
            );

            // Cutoff: skip if obviously too slow
            if (totalEst > pass3Cutoff) continue;

            seenKeys.add(combo);

            const legs: RawLeg[] = [
              { routeCode: r1Code, boardStop: bestOrigStop, boardIdx: bestOrigIdx,
                alightStop: alightStop1, alightIdx: alightIdx1, rideMin: ride1 },
              { routeCode: r2Code, boardStop: r2BoardStop, boardIdx: bi,
                alightStop: dest.code, alightIdx: destIdx2, rideMin: ride2 },
            ];
            const xferWalks = xferWalk > 0 ? [xferWalk] : [];

            const trip = buildTripOption(legs, xferWalks, dest, originStops, idx, linesMap);
            if (trip) trips.push(trip);
          }
        }
      }
    }
  }

  return trips;
}

/* ── Find Candidate Stops ────────────────────────────────────── */

export function findCandidateStops(
  lat: number,
  lng: number,
  allStops: OasaBulkStop[],
): StopCandidate[] {
  const pin: LatLng = { lat, lng };
  const candidates: StopCandidate[] = [];
  for (const s of allStops) {
    const sLat = parseFloat(s.stop_lat);
    const sLng = parseFloat(s.stop_lng);
    const dist = haversine(pin, { lat: sLat, lng: sLng });
    if (dist <= CANDIDATE_RADIUS_M) {
      candidates.push({
        code: s.stop_code,
        name: s.stop_descr_eng || s.stop_descr,
        lat: sLat,
        lng: sLng,
        distM: dist,
      });
    }
  }
  candidates.sort((a, b) => a.distM - b.distM);
  return candidates;
}

/* ── Ride Time Estimation (schedule-based, used for re-scoring) ─ */

export async function estimateRideTime(
  lineCode: string,
  routeCode: string,
  boardIdx: number,
  alightIdx: number,
  totalStops: number,
): Promise<number> {
  try {
    const data = await getCachedSchedule(lineCode);
    if (!data) return Math.max(1, (alightIdx - boardIdx) * FALLBACK_MIN_PER_STOP);

    let direction: 'go' | 'come' = 'go';
    const lineRoutes = await getCachedRoutes(lineCode);
    if (lineRoutes && lineRoutes.length > 0) {
      const idx = lineRoutes.findIndex((r) => r.RouteCode === routeCode);
      direction = idx <= 0 ? 'come' : 'go';
    }

    const isCircular = (data.come ?? []).length === 0;
    if (isCircular) direction = 'go';

    const entries = direction === 'go' ? (data.go ?? []) : (data.come ?? []);
    const startField = direction === 'go' ? 'sde_start1' : 'sde_start2';
    const endField = direction === 'go' ? 'sde_end1' : 'sde_end2';

    let fullTripMin: number | null = null;
    for (const e of entries) {
      const start = (e as any)[startField] as string | null;
      const end = (e as any)[endField] as string | null;
      if (!start || !end) continue;
      const startMin = parseTimeToMin(start);
      const endMin = parseTimeToMin(end);
      if (startMin !== null && endMin !== null && endMin > startMin) {
        fullTripMin = endMin - startMin;
        break;
      }
    }

    if (fullTripMin === null) {
      return Math.max(1, (alightIdx - boardIdx) * FALLBACK_MIN_PER_STOP);
    }

    const fraction = (alightIdx - boardIdx) / totalStops;
    const rideTime = Math.round(fullTripMin * fraction);
    return Math.max(rideTime, alightIdx - boardIdx);
  } catch {
    return Math.max(1, (alightIdx - boardIdx) * FALLBACK_MIN_PER_STOP);
  }
}

/** Parse "1900-01-01 HH:MM:SS" → minutes since midnight. */
function parseTimeToMin(timeStr: string): number | null {
  const m = timeStr.match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/* ── Hydrate Wait Times (post-scoring, top results only) ─────── */

/** Fetch with a timeout — resolves to null on timeout instead of hanging. */
function fetchWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Populate `waitTimeMin` on legs of already-scored top results.
 * Uses per-stop arrival caching so the same stop is only queried once.
 * Each API call has a 5 s timeout to avoid hanging.
 */
async function hydrateWaitTimes(trips: TripOption[]): Promise<void> {
  const arrivalCache = new Map<string, OasaArrival[]>();

  const fetchArrivals = async (stopCode: string): Promise<OasaArrival[]> => {
    if (arrivalCache.has(stopCode)) return arrivalCache.get(stopCode)!;
    try {
      const data = await fetchWithTimeout(getStopArrivals(stopCode), 5_000);
      const arr = data && Array.isArray(data) ? data : [];
      arrivalCache.set(stopCode, arr);
      return arr;
    } catch {
      arrivalCache.set(stopCode, []);
      return [];
    }
  };

  for (const trip of trips) {
    for (const leg of trip.legs) {
      if (leg.waitTimeMin !== null) continue;

      // Try live arrivals
      const arrivals = await fetchArrivals(leg.boardStop.code);
      if (arrivals.length > 0) {
        let minWait: number | null = null;
        for (const a of arrivals) {
          if (a.route_code === leg.routeCode) {
            const t = parseInt(a.btime2, 10);
            if (!isNaN(t) && (minWait === null || t < minWait)) minWait = t;
          }
        }
        if (minWait !== null) {
          leg.waitTimeMin = minWait;
          leg.waitSource = 'live';
          continue;
        }
      }

      // Fallback to cached schedule
      try {
        const data = await getCachedSchedule(leg.lineCode);
        if (data) {
          let direction: 'go' | 'come' = 'go';
          const lineRoutes = await getCachedRoutes(leg.lineCode);
          if (lineRoutes && lineRoutes.length > 0) {
            const ri = lineRoutes.findIndex((r) => r.RouteCode === leg.routeCode);
            direction = ri <= 0 ? 'come' : 'go';
          }
          const sched = parseSchedule(data, direction);
          if (sched.nextDeparture) {
            const [h, m] = sched.nextDeparture.split(':').map(Number);
            const now = new Date();
            const nowMin = now.getHours() * 60 + now.getMinutes();
            const schedMin = h * 60 + m;
            leg.waitTimeMin = schedMin >= nowMin
              ? schedMin - nowMin
              : (1440 - nowMin) + schedMin;
            leg.waitSource = 'scheduled';
            leg.scheduledTime = sched.nextDeparture;
            continue;
          }
        }
      } catch {
        // no schedule data
      }
    }
  }
}

/* ── Scoring & Deduplication ─────────────────────────────────── */

/** How many candidates to hydrate before final scoring. */
const PRE_HYDRATE_MAX = 25;

export function scoreTripOptions(trips: TripOption[]): TripOption[] {
  const deduped = new Map<string, TripOption>();
  for (const trip of trips) {
    const key = trip.legs.map((l) => l.routeCode).join('|');
    const existing = deduped.get(key);
    if (!existing || trip.totalTimeMin < existing.totalTimeMin) {
      deduped.set(key, trip);
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => a.totalTimeMin - b.totalTimeMin);
  if (sorted.length === 0) return [];

  const best = sorted[0].totalTimeMin;
  const cutoff = Math.max(best * 1.8, best + 30);
  const trimmed = sorted.filter((t) => t.totalTimeMin <= cutoff);

  return trimmed.slice(0, PRE_HYDRATE_MAX);
}

/**
 * Estimate average headway (minutes between departures) from schedule data.
 * Returns null if insufficient data.
 */
async function estimateHeadway(lineCode: string, routeCode: string): Promise<number | null> {
  try {
    const data = await getCachedSchedule(lineCode);
    if (!data) return null;

    let direction: 'go' | 'come' = 'go';
    const lineRoutes = await getCachedRoutes(lineCode);
    if (lineRoutes && lineRoutes.length > 0) {
      const ri = lineRoutes.findIndex((r) => r.RouteCode === routeCode);
      direction = ri <= 0 ? 'come' : 'go';
    }

    const sched = parseSchedule(data, direction);
    if (sched.times.length < 2) return null;

    // Compute average gap between departures
    const mins = sched.times.map((t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    });
    let totalGap = 0;
    let gaps = 0;
    for (let i = 1; i < mins.length; i++) {
      const gap = mins[i] - mins[i - 1];
      if (gap > 0 && gap < 120) { // ignore overnight gaps > 2h
        totalGap += gap;
        gaps++;
      }
    }
    return gaps > 0 ? Math.round(totalGap / gaps) : null;
  } catch {
    return null;
  }
}

/**
 * Compute composite score for a trip based on real wait data + multi-factor formula.
 *
 * Lower score = better trip.
 *
 * waitCost per leg:
 *   live ≤5min:          actual wait
 *   live >5min:          wait + 2 (slight uncertainty)
 *   scheduled <30min:    max(3, wait)
 *   scheduled ≥30min:    15 + (wait / 10)
 *   unknown, freq <10:   8
 *   unknown, freq 10-20: 12
 *   unknown, freq 20-40: 18
 *   unknown, no data:    22
 *
 * reliabilityAdj:
 *   all live:    −10
 *   some live:   −5
 *   all sched:    0
 *   some unknown: +5
 *   all unknown:  +20
 *
 * transferCost: numTransfers × 5 + max(0, transferWalk − 2) × 0.5
 */
async function computeCompositeScore(trip: TripOption): Promise<number> {
  let score = trip.walkToOriginMin + trip.walkFromDestMin;

  // Transfer cost
  const numTransfers = Math.max(0, trip.legs.length - 1);
  score += numTransfers * 5;
  score += Math.max(0, trip.transferWalkMin - 2) * 0.5;

  // Leg costs
  let liveCount = 0;
  let scheduledCount = 0;
  let unknownCount = 0;

  for (let i = 0; i < trip.legs.length; i++) {
    const leg = trip.legs[i];
    score += leg.rideTimeMin;

    if (leg.waitSource === 'live' && leg.waitTimeMin !== null) {
      score += leg.waitTimeMin <= 5 ? leg.waitTimeMin : leg.waitTimeMin + 2;
      liveCount++;
    } else if (leg.waitSource === 'scheduled' && leg.waitTimeMin !== null) {
      score += leg.waitTimeMin < 30
        ? Math.max(3, leg.waitTimeMin)
        : 15 + leg.waitTimeMin / 10;
      scheduledCount++;
    } else {
      // Unknown — use frequency-aware estimate
      const headway = await estimateHeadway(leg.lineCode, leg.routeCode);
      if (headway !== null && headway < 10) score += 8;
      else if (headway !== null && headway < 20) score += 12;
      else if (headway !== null && headway < 40) score += 18;
      else score += 22;
      unknownCount++;
    }
  }

  // Reliability adjustment
  const total = trip.legs.length;
  if (liveCount === total)                     score -= 10;
  else if (liveCount > 0)                      score -= 5;
  else if (scheduledCount === total)            score += 0;
  else if (unknownCount > 0 && unknownCount < total) score += 5;
  else if (unknownCount === total)              score += 20;

  return Math.round(score);
}

/* ── Main Entry Point ────────────────────────────────────────── */

/**
 * Plan trips between two map pins using RAPTOR algorithm.
 * Returns scored & ranked trip options. Throws if offline data is not available.
 */
export async function planTrips(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  linesMap: Map<string, OasaLine>,
): Promise<TripOption[] | 'too_close'> {
  const dist = haversine({ lat: originLat, lng: originLng }, { lat: destLat, lng: destLng });
  if (dist < TOO_CLOSE_M) return 'too_close';

  const allStops = await getAllCachedStops();
  if (!allStops) throw new Error('Offline data not available');

  // Find candidate stops near origin and destination
  const originCandidates = findCandidateStops(originLat, originLng, allStops);
  const destCandidates = findCandidateStops(destLat, destLng, allStops);

  if (originCandidates.length === 0 || destCandidates.length === 0) {
    return [];
  }

  // Build RAPTOR index scoped to candidate stops
  const candidateCodes = new Set<string>();
  for (const c of originCandidates) candidateCodes.add(c.code);
  for (const c of destCandidates) candidateCodes.add(c.code);

  const raptorIdx = await buildRaptorIndex(candidateCodes, allStops);

  // Prepare origin/dest stop lists with walk times
  const originStops = originCandidates
    .filter((c) => raptorIdx.routesAtStop.has(c.code))
    .slice(0, 20)
    .map((c) => ({ code: c.code, walkMin: Math.round(c.distM / WALK_SPEED_M_PER_MIN), distM: c.distM }));

  const destStops = destCandidates
    .filter((c) => raptorIdx.routesAtStop.has(c.code))
    .slice(0, 20)
    .map((c) => ({ code: c.code, walkMin: Math.round(c.distM / WALK_SPEED_M_PER_MIN), distM: c.distM }));

  if (originStops.length === 0 || destStops.length === 0) {
    return [];
  }

  // Run RAPTOR scan
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const raptorResult = raptorScan(originStops, nowMin, raptorIdx);

  // Extract trip options from RAPTOR results
  const rawTrips = extractTrips(raptorResult, destStops, originStops, raptorIdx, linesMap);

  if (rawTrips.length === 0) return [];

  // Score, rank, then hydrate wait times for top candidates
  const candidates = scoreTripOptions(rawTrips);
  await hydrateWaitTimes(candidates);

  // Recompute actual travel time using real wait data
  for (const trip of candidates) {
    let realTime = trip.walkToOriginMin + trip.walkFromDestMin + trip.transferWalkMin;
    for (const leg of trip.legs) {
      realTime += leg.rideTimeMin;
      realTime += leg.waitTimeMin ?? UNKNOWN_WAIT_MIN;
    }
    trip.totalTimeMin = Math.round(realTime);
  }

  // Compute composite scores (multi-factor: wait cost, reliability, transfers)
  const scored: { trip: TripOption; score: number }[] = await Promise.all(
    candidates.map(async (trip) => ({
      trip,
      score: await computeCompositeScore(trip),
    })),
  );

  // Sort by composite score (used only for ordering), keep totalTimeMin for display
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.trip);
}
