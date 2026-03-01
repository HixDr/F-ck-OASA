/**
 * Trip Planner — RAPTOR-based algorithm for finding bus routes between two map pins.
 *
 * Supports direct routes and up to 2 transfers (3 buses).
 * This file is the orchestrator entry-point; the algorithm is split across:
 *   - types.ts          — shared type declarations
 *   - constants.ts      — tuning constants
 *   - raptorIndex.ts    — spatial/route index builder
 *   - raptorScan.ts     — core RAPTOR scan
 *   - tripExtraction.ts — connection trace-back & trip construction
 *   - scoring.ts        — scoring, deduplication, wait-time hydration
 */

import { haversine, type LatLng } from '../map/busInterpolation';
import { getAllCachedStops } from '../../services/storage';
import type { OasaBulkStop, OasaLine } from '../../types';
import type { TripOption, StopCandidate } from './types';
import {
  CANDIDATE_RADIUS_M,
  WALK_SPEED_M_PER_MIN,
  TOO_CLOSE_M,
  UNKNOWN_WAIT_MIN,
  MAX_RESULTS,
  getTrafficMultiplier,
} from './constants';
import { buildRaptorIndex } from './raptorIndex';
import { raptorScan } from './raptorScan';
import { extractTrips } from './tripExtraction';
import { scoreTripOptions, hydrateWaitTimes, computeCompositeScore, validateMultiLegTiming, populateSingleLegTimes, minToHHMM } from './scoring';

/* ── Re-exports ──────────────────────────────────────────────── */

export type { TripOption, TripLeg, StopCandidate } from './types';
export { estimateRideTime } from './scoring';

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

  // Apply time-of-day traffic multiplier to ride times.
  // Estimates each leg's departure time to pick the right traffic band.
  for (const trip of rawTrips) {
    let estTimeMin = nowMin + trip.walkToOriginMin + UNKNOWN_WAIT_MIN;
    for (const leg of trip.legs) {
      const mult = getTrafficMultiplier(estTimeMin);
      leg.rideTimeMin = Math.max(1, Math.round(leg.rideTimeMin * mult));
      estTimeMin += leg.rideTimeMin + UNKNOWN_WAIT_MIN;
    }
  }

  // Score, rank, then hydrate wait times for top candidates
  const candidates = scoreTripOptions(rawTrips);
  const caches = await hydrateWaitTimes(candidates);

  // Validate temporal feasibility of multi-leg trips (correct wait times
  // on subsequent legs based on when the user actually arrives at each
  // transfer stop, and discard trips where a connection is missed)
  const validated = validateMultiLegTiming(candidates, caches, nowMin);
  if (validated.length === 0) return [];

  // Populate board/alight times on single-leg trips
  populateSingleLegTimes(validated, nowMin);

  // Recompute times: arrivalMin (for sorting) and totalTimeMin (for display).
  // totalTimeMin = active travel only (walk + ride), excludes wait times.
  // arrivalMin   = full time from now including waits (used for ranking).
  const arrivalMap = new Map<TripOption, number>();
  for (const trip of validated) {
    let activeTime = trip.walkToOriginMin + trip.walkFromDestMin + trip.transferWalkMin;
    let fullTime = activeTime;
    for (const leg of trip.legs) {
      activeTime += leg.rideTimeMin;
      fullTime += leg.rideTimeMin + (leg.waitTimeMin ?? UNKNOWN_WAIT_MIN);
    }
    trip.totalTimeMin = Math.round(activeTime);
    arrivalMap.set(trip, Math.round(fullTime));
    // Arrival at destination = last alight time + walk from dest
    const lastLeg = trip.legs[trip.legs.length - 1];
    if (lastLeg.alightTimeStr) {
      const [h, m] = lastLeg.alightTimeStr.split(':').map(Number);
      trip.arrivalTimeStr = minToHHMM(h * 60 + m + trip.walkFromDestMin);
    } else {
      trip.arrivalTimeStr = minToHHMM(nowMin + Math.round(fullTime));
    }
  }

  // Compute composite scores (multi-factor: wait cost, reliability, transfers)
  const scored: { trip: TripOption; score: number; arrivalMin: number }[] = await Promise.all(
    validated.map(async (trip) => ({
      trip,
      score: await computeCompositeScore(trip),
      arrivalMin: arrivalMap.get(trip) ?? trip.totalTimeMin,
    })),
  );

  // Sort primarily by arrival time (soonest first); composite score breaks ties
  // within a 3-minute window so near-simultaneous arrivals still prefer the
  // more reliable / fewer-transfer option.
  const ARRIVAL_TIE_WINDOW = 3;
  scored.sort((a, b) => {
    const timeDiff = a.arrivalMin - b.arrivalMin;
    if (Math.abs(timeDiff) > ARRIVAL_TIE_WINDOW) return timeDiff;
    return a.score - b.score;
  });

  const sorted = scored.slice(0, MAX_RESULTS).map((s) => s.trip);

  // Tag the soonest arrival ("Soonest") and shortest active travel ("Shortest").
  // If they differ, promote the shortest route to position 2 so both featured
  // results are visible without scrolling.
  if (sorted.length > 0) {
    sorted[0]._tag = 'Soonest';
    let shortestIdx = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].totalTimeMin < sorted[shortestIdx].totalTimeMin) shortestIdx = i;
    }
    if (shortestIdx !== 0) {
      sorted[shortestIdx]._tag = 'Shortest';
      if (shortestIdx > 1) {
        const [item] = sorted.splice(shortestIdx, 1);
        sorted.splice(1, 0, item);
      }
    }
  }

  return sorted;
}
