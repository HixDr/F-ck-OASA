/**
 * Trip Extraction — traces RAPTOR connections backward to build TripOption[].
 *
 * Pass 1: Standard RAPTOR extraction — traces the single best connection per stop.
 * Pass 2: Route enumeration — tries ALL routes serving each dest stop as the
 *         final leg, catching near-optimal alternatives that RAPTOR pruned.
 * Pass 3: Direct 2-leg feeder enumeration — bypasses RAPTOR connections entirely.
 */

import { haversine } from '../map/busInterpolation';
import type { OasaLine } from '../../types';
import type {
  RaptorIndex,
  RaptorResult,
  RawLeg,
  TripOption,
  TripLeg,
} from './types';
import { WALK_SPEED_M_PER_MIN, INF, UNKNOWN_WAIT_MIN } from './constants';

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
 */
export function extractTrips(
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
  const ENUM_RELAX_MIN = 20;

  for (const dest of destStops) {
    const routesHere = idx.routesAtStop.get(dest.code);
    if (!routesHere) continue;

    for (const routeCode of routesHere) {
      const path = idx.routePaths.get(routeCode);
      const times = idx.travelTimesMin.get(routeCode);
      const destIdxInRoute = idx.routeStopIndex.get(routeCode)?.get(dest.code);
      if (!path || !times || destIdxInRoute === undefined || destIdxInRoute === 0) continue;

      for (let k = 1; k < result.kArrivals.length; k++) {
        const prevRoundArrivals = result.kArrivals[k - 1];
        if (!prevRoundArrivals) continue;

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

        const bestAtDest = result.bestArrivals.get(dest.code) ?? INF;
        if (arriveAtDest > bestAtDest + ENUM_RELAX_MIN) continue;

        const lastLeg: RawLeg = {
          routeCode,
          boardStop: bestBoardStop,
          boardIdx: bestBoardIdx,
          alightStop: dest.code,
          alightIdx: destIdxInRoute,
          rideMin,
        };

        let allLegs: RawLeg[];
        let transferWalks: number[] = [];

        if (k === 1) {
          allLegs = [lastLeg];
        } else {
          const traced = traceLegsBack(bestBoardStop, k - 1, result, idx);
          if (!traced) continue;
          allLegs = [...traced.legs, lastLeg];
          transferWalks = traced.transferWalks;
        }

        const key = allLegs.map((l) => l.routeCode).join('|');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const trip = buildTripOption(allLegs, transferWalks, dest, originStops, idx, linesMap);
        if (trip) trips.push(trip);
      }
    }
  }

  // === Pass 3: Direct 2-leg feeder enumeration ===
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

      for (let bi = 0; bi < destIdx2; bi++) {
        const r2BoardStop = r2Path[bi];

        const feedSources = new Map<string, number>();
        feedSources.set(r2BoardStop, 0);
        const xfers = idx.transfers.get(r2BoardStop);
        if (xfers) {
          for (const { target, walkMin: xw } of xfers) feedSources.set(target, xw);
        }

        for (const [alightStop1, xferWalk] of feedSources) {
          const r1Codes = idx.routesAtStop.get(alightStop1);
          if (!r1Codes) continue;

          for (const r1Code of r1Codes) {
            if (r1Code === r2Code) continue;

            const combo = r1Code + '|' + r2Code;
            if (seenKeys.has(combo)) continue;

            const r1Path = idx.routePaths.get(r1Code);
            const r1Times = idx.travelTimesMin.get(r1Code);
            const alightIdx1 = idx.routeStopIndex.get(r1Code)?.get(alightStop1);
            if (!r1Path || !r1Times || alightIdx1 === undefined || alightIdx1 === 0) continue;

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
