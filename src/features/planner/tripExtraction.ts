/**
 * Trip Extraction — traces RAPTOR connections backward to build TripOption[].
 *
 * Pass 1: Standard RAPTOR extraction — the single best connection per dest stop.
 * Pass 2: Route enumeration — tries every route serving each dest stop as the
 *         final leg, catching near-optimal alternatives RAPTOR pruned.
 *
 * There used to be a Pass 3 ("direct 2-leg feeder enumeration"). It was
 * 80-95% of the planner's runtime: a five-deep loop nest over 0.5-2M tuples,
 * with its memoisation placed *after* the cutoff `continue` so every tuple that
 * failed the cutoff re-ran the whole evaluation — including a linear
 * `originStops.find()` up to 25 times per tuple. It also duplicated Pass 2,
 * whose dedup was broken (Pass 1 poisoned the shared key set). Pass 2 is fixed
 * below and Pass 3 is gone; its coverage is subsumed.
 */

import { haversineM } from '../../utils/geo';
import type { OasaLine } from '../../types';
import type {
  RaptorIndex,
  RaptorResult,
  RawLeg,
  TripLeg,
  TripOption,
  WalkStop,
} from './types';
import {
  WALK_SPEED_M_PER_MIN,
  TRANSFER_FLAT_PENALTY_MIN,
  INF,
} from './constants';

export interface Pin {
  lat: number;
  lng: number;
}

/**
 * Trace backward from a stop through kConnections to recover prior legs.
 *
 * Transfer hops are dropped here rather than accumulated: every walk in the
 * finished trip is re-derived from the actual stop coordinates in
 * `buildTripOption`, so the card's segments always add up to its own total.
 */
function traceLegsBack(
  startStop: string,
  startRound: number,
  result: RaptorResult,
  idx: RaptorIndex,
): RawLeg[] | null {
  const legs: RawLeg[] = [];
  let curStop = startStop;
  let curRound = startRound;
  let guard = 0;

  while (curRound >= 1 && guard++ < 16) {
    const conn = result.kConnections[curRound].get(curStop);
    if (!conn) break;

    if (conn.type === 'transfer') {
      // Stay in the same round — the ride that reached fromStop is also here.
      curStop = conn.fromStop;
      continue;
    }

    const path = idx.routePaths.get(conn.routeCode);
    const times = idx.travelTimesMin.get(conn.routeCode);
    if (!path || !times) return null;

    legs.unshift({
      routeCode: conn.routeCode,
      boardStop: conn.boardStop,
      boardIdx: conn.boardIdx,
      alightStop: path[conn.alightIdx],
      alightIdx: conn.alightIdx,
      rideMin: times[conn.alightIdx] - times[conn.boardIdx],
    });

    curStop = conn.boardStop;
    curRound -= 1;
  }

  return legs.length > 0 ? legs : null;
}

function walkMinBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return Math.round(haversineM(aLat, aLng, bLat, bLng) / WALK_SPEED_M_PER_MIN);
}

/**
 * Build a TripOption from raw legs.
 *
 * Every walk is measured from the thing the user actually stands at — the pins
 * and the real stop coordinates. The old code measured the first walk from the
 * nearest *origin stop* to the board stop, dropping the pin→origin-stop leg
 * entirely (routinely ~13 minutes) and then ranked the trip as if it were free.
 *
 * Times are left unset here: the single forward clock in scoring.ts owns them.
 */
function buildTripOption(
  rawLegs: RawLeg[],
  originPin: Pin,
  destPin: Pin,
  idx: RaptorIndex,
  linesMap: Map<string, OasaLine>,
): TripOption | null {
  if (rawLegs.length === 0) return null;

  const tripLegs: TripLeg[] = [];
  let prevAlight: { lat: number; lng: number } | null = null;
  let transferTotal = 0;

  for (const leg of rawLegs) {
    const meta = idx.routeMeta.get(leg.routeCode);
    const lineCode = meta?.LineCode ?? '';
    const lineInfo = linesMap.get(lineCode);
    const boardInfo = idx.stopInfo.get(leg.boardStop);
    const alightInfo = idx.stopInfo.get(leg.alightStop);
    if (!boardInfo || !alightInfo) return null;
    const times = idx.travelTimesMin.get(leg.routeCode);

    const transferWalkMin = prevAlight
      ? Math.max(
          TRANSFER_FLAT_PENALTY_MIN,
          walkMinBetween(prevAlight.lat, prevAlight.lng, boardInfo.lat, boardInfo.lng),
        )
      : 0;
    transferTotal += transferWalkMin;

    tripLegs.push({
      lineCode,
      lineId: lineInfo?.LineID ?? lineCode,
      lineDescr: lineInfo?.LineDescrEng ?? lineInfo?.LineDescr ?? meta?.RouteDescrEng ?? '',
      routeCode: leg.routeCode,
      boardStop: {
        code: leg.boardStop,
        name: boardInfo.name,
        lat: boardInfo.lat,
        lng: boardInfo.lng,
        orderInRoute: leg.boardIdx,
      },
      alightStop: {
        code: leg.alightStop,
        name: alightInfo.name,
        lat: alightInfo.lat,
        lng: alightInfo.lng,
        orderInRoute: leg.alightIdx,
      },
      stopCount: leg.alightIdx - leg.boardIdx,
      rawRideMin: Math.max(1, leg.rideMin),
      liveRideMin: null,
      rideTimeMin: Math.max(1, Math.round(leg.rideMin)),
      rideSource: 'estimate',
      rideLowMin: Math.max(1, Math.round(leg.rideMin)),
      rideHighMin: Math.max(1, Math.round(leg.rideMin)),
      waitTimeMin: null,
      waitSource: null,
      scheduledTime: null,
      noServiceToday: false,
      transferWalkMin,
      terminusOffsetMin: times ? Math.round(times[leg.boardIdx] - times[0]) : 0,
      boardMin: null,
      alightMin: null,
      boardTimeStr: null,
      alightTimeStr: null,
    });

    prevAlight = { lat: alightInfo.lat, lng: alightInfo.lng };
  }

  const first = tripLegs[0];
  const last = tripLegs[tripLegs.length - 1];

  return {
    legs: tripLegs,
    walkToOriginMin: walkMinBetween(
      originPin.lat, originPin.lng, first.boardStop.lat, first.boardStop.lng,
    ),
    walkFromDestMin: walkMinBetween(
      last.alightStop.lat, last.alightStop.lng, destPin.lat, destPin.lng,
    ),
    transferWalkMin: transferTotal,
    departMin: 0,
    arriveMin: 0,
    arriveLowMin: 0,
    arriveHighMin: 0,
    totalTimeMin: 0,
    totalLowMin: 0,
    totalHighMin: 0,
    arrivalTimeStr: null,
    confidence: 'estimated',
    noService: false,
    maxWaitMin: 0,
    originStop: {
      code: first.boardStop.code, name: first.boardStop.name,
      lat: first.boardStop.lat, lng: first.boardStop.lng,
    },
    destStop: {
      code: last.alightStop.code, name: last.alightStop.name,
      lat: last.alightStop.lat, lng: last.alightStop.lng,
    },
    id: tripKey(tripLegs),
  };
}

/**
 * Identity of an itinerary. Route codes alone collapsed two materially
 * different trips — different board stops, or a route that passes the
 * destination area twice — into one, and then kept whichever the stale
 * pre-multiplier total happened to favour.
 */
function tripKey(legs: TripLeg[]): string {
  let k = '';
  for (const l of legs) k += `${l.routeCode}@${l.boardStop.code}>${l.alightStop.code}|`;
  return k;
}

/**
 * Trace back from destination stops through kConnections to build TripOption[].
 */
export function extractTrips(
  result: RaptorResult,
  destStops: WalkStop[],
  originPin: Pin,
  destPin: Pin,
  idx: RaptorIndex,
  linesMap: Map<string, OasaLine>,
): TripOption[] {
  const trips: TripOption[] = [];
  const seen = new Set<string>();

  const emit = (legs: RawLeg[]): void => {
    const trip = buildTripOption(legs, originPin, destPin, idx, linesMap);
    if (!trip) return;
    if (seen.has(trip.id)) return;
    seen.add(trip.id);
    trips.push(trip);
  };

  // === Pass 1: Standard RAPTOR extraction ===
  for (const dest of destStops) {
    for (let k = 1; k < result.kArrivals.length; k++) {
      if (result.kArrivals[k].get(dest.code) === undefined) continue;
      const legs = traceLegsBack(dest.code, k, result, idx);
      if (legs) emit(legs);
    }
  }

  // === Pass 2: Route enumeration at dest stops ===
  //
  // The dedup key now includes board and alight stops, so Pass 1 no longer
  // blanket-disables Pass 2 by claiming every route code it emitted — which was
  // exactly where the alternatives lived.
  const ENUM_RELAX_MIN = 20;

  for (const dest of destStops) {
    const routesHere = idx.routesAtStop.get(dest.code);
    if (!routesHere) continue;
    const bestAtDest = result.bestArrivals.get(dest.code) ?? INF;

    for (const routeCode of routesHere) {
      const path = idx.routePaths.get(routeCode);
      const times = idx.travelTimesMin.get(routeCode);
      if (!path || !times) continue;

      // Every position at which this route reaches the destination stop, not
      // only the first — a route that loops past the destination twice offers
      // two genuinely different itineraries.
      for (let destIdx = 1; destIdx < path.length; destIdx++) {
        if (path[destIdx] !== dest.code) continue;

        for (let k = 1; k < result.kArrivals.length; k++) {
          const prevRound = result.kArrivals[k - 1];
          if (!prevRound || prevRound.size === 0) continue;

          // Same boarding rule as the scan: minimise prevArrival − times[si].
          let boardStop: string | null = null;
          let boardIdx = -1;
          let bestOffset = INF;
          for (let si = 0; si < destIdx; si++) {
            const prevArr = prevRound.get(path[si]);
            if (prevArr === undefined || prevArr >= INF) continue;
            const offset = prevArr - times[si];
            if (boardStop === null || offset < bestOffset) {
              bestOffset = offset;
              boardStop = path[si];
              boardIdx = si;
            }
          }
          if (boardStop === null) continue;

          if (bestOffset + times[destIdx] > bestAtDest + ENUM_RELAX_MIN) continue;

          const lastLeg: RawLeg = {
            routeCode,
            boardStop,
            boardIdx,
            alightStop: dest.code,
            alightIdx: destIdx,
            rideMin: times[destIdx] - times[boardIdx],
          };

          if (k === 1) {
            emit([lastLeg]);
          } else {
            const prior = traceLegsBack(boardStop, k - 1, result, idx);
            if (prior) emit([...prior, lastLeg]);
          }
        }
      }
    }
  }

  return trips;
}
