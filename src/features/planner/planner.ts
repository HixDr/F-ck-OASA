/**
 * Trip Planner — RAPTOR-based algorithm for finding bus routes between two map pins.
 *
 * Direct routes and one transfer (see MAX_ROUNDS for why not two).
 * This file is the orchestrator entry-point; the algorithm is split across:
 *   - types.ts          — shared type declarations
 *   - constants.ts      — tuning constants
 *   - stopTable.ts      — parsed stop coordinates + candidate search
 *   - raptorIndex.ts    — spatial/route index builder (cached)
 *   - raptorScan.ts     — core RAPTOR scan
 *   - tripExtraction.ts — connection trace-back & trip construction
 *   - rideTimes.ts      — three-tier ride-time model (live / empirical / estimate)
 *   - scoring.ts        — the single trip clock, ranking, live hydration
 *
 * The search is cancellable and yields to the event loop between phases, so
 * dragging a pin cancels the run in flight instead of queueing another one
 * behind it.
 */

import { getAllCachedStops, getOfflineTimestamp } from '../../services/storage';
import { athensNowMin } from '../../utils/scheduleUtils';
import { haversineM } from '../../utils/geo';
import type { OasaLine } from '../../types';
import type { TripOption, WalkStop } from './types';
import {
  WALK_SPEED_M_PER_MIN,
  TOO_CLOSE_M,
  MAX_RESULTS,
  MAX_CANDIDATE_STOPS,
  HYDRATE_TOP,
} from './constants';
import { buildStopTable, findCandidateStops } from './stopTable';
import { buildRaptorIndex } from './raptorIndex';
import { raptorScan } from './raptorScan';
import { extractTrips } from './tripExtraction';
import { loadRideTimes } from './rideTimes';
import {
  applyTripClock,
  buildPlanContext,
  hydrateLive,
  rankTrips,
  roughTrim,
  trimByArrival,
} from './scoring';

/* ── Re-exports ──────────────────────────────────────────────── */

export type {
  TripOption, TripLeg, StopCandidate, RideSource, WaitSource, TripConfidence,
} from './types';
export { minToHHMM } from './scoring';
export { findCandidateStops } from './stopTable';
export { flushRideTimes } from './rideTimes';
export { clearRaptorIndexCache } from './raptorIndex';

/* ── Public result shape ─────────────────────────────────────── */

export type PlannerPhase =
  | 'preparing'   // reading offline data, finding candidate stops
  | 'indexing'    // building (or reusing) the route index
  | 'searching'   // RAPTOR scan + extraction
  | 'timing'      // schedules, clock, ranking
  | 'live'        // fetching live arrivals for the shortlist
  | 'done';

/** Why a search produced nothing. The screen must not say "no bus routes
 *  found, move the pins" when the truth is "no service at this hour". */
export type NoneReason =
  | 'no_offline_data'
  | 'no_stops_near_origin'
  | 'no_stops_near_dest'
  | 'no_served_stops'
  | 'no_connection'
  | 'no_service_now';

export type PlanOutcome =
  | { kind: 'trips'; trips: TripOption[] }
  | { kind: 'too_close'; distM: number; walkMin: number }
  | { kind: 'none'; reason: NoneReason };

export interface PlanOptions {
  signal?: AbortSignal;
  onPhase?: (phase: PlannerPhase) => void;
  /** Estimate-tier results, emitted before the network phase so the panel can
   *  fill in immediately and upgrade in place. */
  onPartial?: (trips: TripOption[]) => void;
}

/** Thrown when a search is superseded or the screen goes away. */
export class PlanCancelled extends Error {
  constructor() {
    super('Trip planning cancelled');
    this.name = 'PlanCancelled';
  }
}

/** Hand the JS thread back so the map and the spinner keep moving. */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlanCancelled();
}

/* ── Main Entry Point ────────────────────────────────────────── */

/**
 * Plan trips between two map pins.
 * Never throws for "no result" — that comes back as a typed `none` outcome.
 */
export async function planTrips(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  linesMap: Map<string, OasaLine>,
  opts: PlanOptions = {},
): Promise<PlanOutcome> {
  const { signal, onPhase, onPartial } = opts;

  const distM = haversineM(originLat, originLng, destLat, destLng);
  if (distM < TOO_CLOSE_M) {
    return { kind: 'too_close', distM, walkMin: Math.round(distM / WALK_SPEED_M_PER_MIN) };
  }

  onPhase?.('preparing');
  const [allStops, offlineTs] = await Promise.all([
    getAllCachedStops(),
    getOfflineTimestamp(),
    loadRideTimes(),
  ]);
  checkAborted(signal);
  if (!allStops || allStops.length === 0) return { kind: 'none', reason: 'no_offline_data' };

  const table = buildStopTable(allStops);
  const originCandidates = findCandidateStops(originLat, originLng, table);
  if (originCandidates.length === 0) return { kind: 'none', reason: 'no_stops_near_origin' };
  const destCandidates = findCandidateStops(destLat, destLng, table);
  if (destCandidates.length === 0) return { kind: 'none', reason: 'no_stops_near_dest' };

  await yieldToUI();
  checkAborted(signal);
  onPhase?.('indexing');

  const candidateCodes = new Set<string>();
  for (const c of originCandidates) candidateCodes.add(c.code);
  for (const c of destCandidates) candidateCodes.add(c.code);

  const idx = await buildRaptorIndex(candidateCodes, table, offlineTs);
  checkAborted(signal);

  const toWalkStops = (list: typeof originCandidates): WalkStop[] =>
    list
      .filter((c) => idx.routesAtStop.has(c.code))
      .slice(0, MAX_CANDIDATE_STOPS)
      .map((c) => ({
        code: c.code,
        walkMin: Math.round(c.distM / WALK_SPEED_M_PER_MIN),
        distM: c.distM,
      }));

  const originStops = toWalkStops(originCandidates);
  const destStops = toWalkStops(destCandidates);
  if (originStops.length === 0 || destStops.length === 0) {
    return { kind: 'none', reason: 'no_served_stops' };
  }

  await yieldToUI();
  checkAborted(signal);
  onPhase?.('searching');

  const nowMin = athensNowMin();
  const scan = raptorScan(originStops, nowMin, idx);
  const rawTrips = extractTrips(
    scan,
    destStops,
    { lat: originLat, lng: originLng },
    { lat: destLat, lng: destLng },
    idx,
    linesMap,
  );
  if (rawTrips.length === 0) return { kind: 'none', reason: 'no_connection' };

  await yieldToUI();
  checkAborted(signal);
  onPhase?.('timing');

  // Cheap pre-filter, then the real clock on what is left.
  const plausible = roughTrim(rawTrips, nowMin, 40);
  const ctx = await buildPlanContext(plausible, nowMin);
  checkAborted(signal);

  for (const trip of plausible) applyTripClock(trip, ctx);

  const running = plausible.filter((t) => !t.noService);
  if (running.length === 0) return { kind: 'none', reason: 'no_service_now' };

  const shortlist = rankTrips(trimByArrival(running), ctx);
  const partial = tagTrips(shortlist.slice(0, MAX_RESULTS));
  onPartial?.(partial);

  await yieldToUI();
  checkAborted(signal);
  onPhase?.('live');

  // Only the shortlist gets network calls. Hydrating every candidate is how
  // the old planner turned a search into a request storm.
  const hydrateSet = shortlist.slice(0, HYDRATE_TOP);
  try {
    await hydrateLive(hydrateSet, ctx, signal);
  } catch {
    // Live data is an upgrade, not a requirement — keep the estimate tier.
  }
  checkAborted(signal);

  for (const trip of hydrateSet) applyTripClock(trip, ctx);
  const finalRunning = hydrateSet.filter((t) => !t.noService);
  if (finalRunning.length === 0) return { kind: 'none', reason: 'no_service_now' };

  onPhase?.('done');
  return { kind: 'trips', trips: tagTrips(rankTrips(finalRunning, ctx).slice(0, MAX_RESULTS)) };
}

/**
 * Tag the headline results.
 *
 * 'Soonest' is the earliest arrival. The old second tag, 'Shortest', ranked by
 * a total that excluded waiting, so a trip you would stand around 28 minutes
 * for could be badged as the short one — and now that the clock is one number,
 * shortest total and soonest arrival are the same trip by construction.
 * 'Easiest' is the genuinely different axis: fewest transfers, then least
 * walking. It is only tagged when it is not already the soonest.
 */
function tagTrips(trips: TripOption[]): TripOption[] {
  for (const t of trips) t._tag = undefined;
  if (trips.length === 0) return trips;

  trips[0]._tag = 'Soonest';

  const effort = (t: TripOption) =>
    t.legs.length * 1000 + t.walkToOriginMin + t.walkFromDestMin + t.transferWalkMin;
  let easiestIdx = 0;
  for (let i = 1; i < trips.length; i++) {
    if (effort(trips[i]) < effort(trips[easiestIdx])) easiestIdx = i;
  }
  if (easiestIdx !== 0) {
    trips[easiestIdx]._tag = 'Easiest';
    // Promote it so both featured results are visible without scrolling.
    if (easiestIdx > 1) {
      const [item] = trips.splice(easiestIdx, 1);
      trips.splice(1, 0, item);
    }
  }
  return trips;
}
