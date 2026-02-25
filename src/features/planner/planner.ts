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
} from './constants';
import { buildRaptorIndex } from './raptorIndex';
import { raptorScan } from './raptorScan';
import { extractTrips } from './tripExtraction';
import { scoreTripOptions, hydrateWaitTimes, computeCompositeScore } from './scoring';

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
