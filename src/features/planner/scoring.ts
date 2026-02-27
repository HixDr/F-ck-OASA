/**
 * Scoring, wait-time hydration, and ride-time estimation for trip results.
 */

import { parseSchedule } from '../../utils/scheduleUtils';
import {
  getCachedSchedule,
  getCachedRoutes,
} from '../../services/storage';
import { getStopArrivals } from '../../services/api';
import type { OasaArrival, OasaDailySchedule, OasaRoute } from '../../types';
import type { TripOption } from './types';
import { haversine } from '../map/busInterpolation';
import {
  FALLBACK_MIN_PER_STOP,
  PRE_HYDRATE_MAX,
  WALK_SPEED_M_PER_MIN,
  TRANSFER_FLAT_PENALTY_MIN,
  UNKNOWN_WAIT_MIN,
} from './constants';

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

/** Caches returned by hydrateWaitTimes, reused by validateMultiLegTiming. */
export interface HydrationCaches {
  arrivalCache: Map<string, OasaArrival[]>;
  schedCache: Map<string, OasaDailySchedule | null>;
  routesLookup: Map<string, OasaRoute[] | null>;
}

/**
 * Populate `waitTimeMin` on legs of already-scored top results.
 * Uses per-stop arrival caching so the same stop is only queried once.
 * All unique stops are fetched in parallel (each with a 5 s timeout).
 * Returns caches for downstream multi-leg validation.
 */
export async function hydrateWaitTimes(trips: TripOption[]): Promise<HydrationCaches> {
  // 1. Collect all unique boarding-stop codes across all trips
  const uniqueStops = new Set<string>();
  for (const trip of trips) {
    for (const leg of trip.legs) {
      if (leg.waitTimeMin === null) uniqueStops.add(leg.boardStop.code);
    }
  }

  // 2. Fetch arrivals for all unique stops in parallel
  const arrivalCache = new Map<string, OasaArrival[]>();
  const fetchEntries = [...uniqueStops].map(async (stopCode) => {
    try {
      const data = await fetchWithTimeout(getStopArrivals(stopCode), 5_000);
      arrivalCache.set(stopCode, data && Array.isArray(data) ? data : []);
    } catch {
      arrivalCache.set(stopCode, []);
    }
  });
  await Promise.all(fetchEntries);

  // 3. Pre-load all unique schedules + routes in parallel for fallback
  const uniqueLines = new Set<string>();
  for (const trip of trips) {
    for (const leg of trip.legs) {
      uniqueLines.add(leg.lineCode);
    }
  }
  const schedCache = new Map<string, OasaDailySchedule | null>();
  const routesLookup = new Map<string, OasaRoute[] | null>();
  await Promise.all([...uniqueLines].map(async (lc) => {
    const [sched, routes] = await Promise.all([getCachedSchedule(lc), getCachedRoutes(lc)]);
    schedCache.set(lc, sched);
    routesLookup.set(lc, routes);
  }));

  // 4. Assign wait times from cached data (no more async in the hot loop)
  for (const trip of trips) {
    for (const leg of trip.legs) {
      if (leg.waitTimeMin !== null) continue;

      // Try live arrivals
      const arrivals = arrivalCache.get(leg.boardStop.code) ?? [];
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
      const data = schedCache.get(leg.lineCode);
      if (data) {
        let direction: 'go' | 'come' = 'go';
        const lineRoutes = routesLookup.get(leg.lineCode);
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
    }
  }

  return { arrivalCache, schedCache, routesLookup };
}

/* ── Scoring & Deduplication ─────────────────────────────────── */

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
export async function computeCompositeScore(trip: TripOption): Promise<number> {
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

/* ── Multi-Leg Temporal Validation ───────────────────────────── */

/** Maximum minutes to wait at a transfer stop before the trip is infeasible. */
const MAX_TRANSFER_WAIT_MIN = 30;

/** Format minutes since midnight to HH:MM string. Wraps past midnight. */
export function minToHHMM(min: number): string {
  const wrapped = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.round(wrapped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Find the next scheduled departure from a sorted HH:MM list at or after
 * `afterMin` (minutes since midnight).
 * Returns the wait in minutes and the HH:MM string, or null if no service.
 */
function findNextDepartureFromSchedule(
  sortedTimes: string[],
  afterMin: number,
): { time: string; waitMin: number } | null {
  if (sortedTimes.length === 0) return null;
  for (const t of sortedTimes) {
    const [h, m] = t.split(':').map(Number);
    const tMin = h * 60 + m;
    if (tMin >= afterMin) {
      return { time: t, waitMin: tMin - afterMin };
    }
  }
  // Wrap to next day's first departure
  const [h, m] = sortedTimes[0].split(':').map(Number);
  const tMin = h * 60 + m;
  return { time: sortedTimes[0], waitMin: (1440 - afterMin) + tMin };
}

/**
 * Find the next live bus for a specific route at a stop, arriving at or after
 * `afterMin` (absolute minutes since midnight).
 * Returns wait in minutes from `afterMin`, or null if no matching arrival.
 */
function findNextLiveArrival(
  arrivals: OasaArrival[],
  routeCode: string,
  nowMin: number,
  afterMin: number,
): number | null {
  let bestWait: number | null = null;
  for (const a of arrivals) {
    if (a.route_code !== routeCode) continue;
    const btime = parseInt(a.btime2, 10);
    if (isNaN(btime)) continue;
    const arrivalAbsMin = nowMin + btime; // absolute time this bus arrives at the stop
    if (arrivalAbsMin >= afterMin) {
      const wait = arrivalAbsMin - afterMin;
      if (bestWait === null || wait < bestWait) bestWait = wait;
    }
  }
  return bestWait;
}

/**
 * Compute the walk time between two stops for a transfer, using their coords.
 * Applies a minimum of TRANSFER_FLAT_PENALTY_MIN even for same-stop transfers.
 */
function computeTransferWalkMin(
  alightLat: number, alightLng: number,
  boardLat: number, boardLng: number,
): number {
  const d = haversine(
    { lat: alightLat, lng: alightLng },
    { lat: boardLat, lng: boardLng },
  );
  const walkMin = Math.round(d / WALK_SPEED_M_PER_MIN);
  return Math.max(walkMin, TRANSFER_FLAT_PENALTY_MIN);
}

/**
 * Resolve the direction ('go' | 'come') for a route given cached route data.
 */
function resolveDirection(
  lineCode: string,
  routeCode: string,
  routesLookup: Map<string, OasaRoute[] | null>,
): 'go' | 'come' {
  const lineRoutes = routesLookup.get(lineCode);
  if (lineRoutes && lineRoutes.length > 0) {
    const ri = lineRoutes.findIndex((r) => r.RouteCode === routeCode);
    return ri <= 0 ? 'come' : 'go';
  }
  return 'go';
}

/**
 * Validate temporal feasibility of multi-leg trips and correct wait times
 * for legs beyond the first.
 *
 * For each multi-leg trip, chains timing forward:
 *   1. Leg 1 departs at: now + walkToOrigin + leg1.waitTimeMin
 *   2. Leg 1 arrives at alight stop: departure + rideTimeMin
 *   3. Walk to leg 2 board stop (computed from coords)
 *   4. Check if leg 2's bus is reachable from that arrival time
 *      — live data first, then scheduled, then headway estimate
 *   5. Cascade to leg 3 if present
 *
 * Trips where any transfer wait exceeds MAX_TRANSFER_WAIT_MIN are removed.
 * Surviving trips get corrected waitTimeMin values on subsequent legs.
 */
export function validateMultiLegTiming(
  trips: TripOption[],
  caches: HydrationCaches,
  nowMin: number,
): TripOption[] {
  const { arrivalCache, schedCache, routesLookup } = caches;
  const valid: TripOption[] = [];

  for (const trip of trips) {
    // Single-leg trips pass through — no transfer to validate
    if (trip.legs.length < 2) {
      valid.push(trip);
      continue;
    }

    let currentTimeMin = nowMin + trip.walkToOriginMin;
    let feasible = true;

    for (let i = 0; i < trip.legs.length; i++) {
      const leg = trip.legs[i];

      if (i === 0) {
        // First leg: wait was hydrated from "now", just advance the clock
        currentTimeMin += leg.waitTimeMin ?? UNKNOWN_WAIT_MIN;
        // Board time = when we finish walking + waiting
        leg.boardTimeStr = minToHHMM(currentTimeMin);
        // After riding leg 1
        currentTimeMin += leg.rideTimeMin;
        leg.alightTimeStr = minToHHMM(currentTimeMin);
      } else {
        // Compute transfer walk from previous leg's alight to this leg's board
        const prevLeg = trip.legs[i - 1];
        const xferWalk = computeTransferWalkMin(
          prevLeg.alightStop.lat, prevLeg.alightStop.lng,
          leg.boardStop.lat, leg.boardStop.lng,
        );
        currentTimeMin += xferWalk;

        // Now currentTimeMin = when we arrive at this leg's board stop.
        // Find the next bus for this route.

        let resolved = false;

        // 1) Try live arrivals
        const arrivals = arrivalCache.get(leg.boardStop.code) ?? [];
        if (arrivals.length > 0) {
          const liveWait = findNextLiveArrival(arrivals, leg.routeCode, nowMin, currentTimeMin);
          if (liveWait !== null) {
            leg.waitTimeMin = liveWait;
            leg.waitSource = 'live';
            leg.scheduledTime = null;
            resolved = true;
          }
        }

        // 2) Fallback to cached schedule
        if (!resolved) {
          const data = schedCache.get(leg.lineCode);
          if (data) {
            const dir = resolveDirection(leg.lineCode, leg.routeCode, routesLookup);
            const sched = parseSchedule(data, dir);
            const next = findNextDepartureFromSchedule(sched.times, currentTimeMin);
            if (next) {
              leg.waitTimeMin = next.waitMin;
              leg.waitSource = 'scheduled';
              leg.scheduledTime = next.time;
              resolved = true;
            }
          }
        }

        // 3) Fallback: keep existing waitTimeMin or use UNKNOWN_WAIT_MIN
        if (!resolved && leg.waitTimeMin === null) {
          leg.waitTimeMin = UNKNOWN_WAIT_MIN;
        }

        const actualWait = leg.waitTimeMin ?? UNKNOWN_WAIT_MIN;

        // Feasibility: if the wait at this transfer is too long, discard the trip
        if (actualWait > MAX_TRANSFER_WAIT_MIN) {
          feasible = false;
          break;
        }

        currentTimeMin += actualWait;
        // Board time = arrival at transfer stop + wait
        leg.boardTimeStr = minToHHMM(currentTimeMin);
        // After riding this leg
        currentTimeMin += leg.rideTimeMin;
        leg.alightTimeStr = minToHHMM(currentTimeMin);
      }
    }

    if (feasible) valid.push(trip);
  }

  return valid;
}

/**
 * Populate boardTimeStr / alightTimeStr on single-leg trips.
 * For multi-leg trips, validateMultiLegTiming already does this.
 *
 * - Scheduled: boardTimeStr = the scheduled departure (leg.scheduledTime).
 * - Live:      boardTimeStr = nowMin + waitTimeMin (bus arrival time at stop).
 * - Unknown:   boardTimeStr = nowMin + walkToOrigin + UNKNOWN_WAIT_MIN.
 */
export function populateSingleLegTimes(
  trips: TripOption[],
  nowMin: number,
): void {
  for (const trip of trips) {
    if (trip.legs.length !== 1) continue;
    const leg = trip.legs[0];
    if (leg.boardTimeStr !== null) continue; // already populated

    let boardMin: number;

    if (leg.waitSource === 'scheduled' && leg.scheduledTime) {
      // Board at the scheduled departure time
      const [h, m] = leg.scheduledTime.split(':').map(Number);
      boardMin = h * 60 + m;
      leg.boardTimeStr = leg.scheduledTime;
    } else if (leg.waitSource === 'live' && leg.waitTimeMin !== null) {
      // Board when the live bus arrives at the stop
      boardMin = nowMin + leg.waitTimeMin;
      leg.boardTimeStr = minToHHMM(boardMin);
    } else {
      // Unknown: estimate from walk + default wait
      boardMin = nowMin + trip.walkToOriginMin + (leg.waitTimeMin ?? UNKNOWN_WAIT_MIN);
      leg.boardTimeStr = minToHHMM(boardMin);
    }

    leg.alightTimeStr = minToHHMM(boardMin + leg.rideTimeMin);
  }
}
