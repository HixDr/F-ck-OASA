/**
 * Scoring, wait-time hydration, and ride-time estimation for trip results.
 */

import { parseSchedule } from '../../utils/scheduleUtils';
import {
  getCachedSchedule,
  getCachedRoutes,
} from '../../services/storage';
import { getStopArrivals } from '../../services/api';
import type { OasaArrival } from '../../types';
import type { TripOption } from './types';
import {
  FALLBACK_MIN_PER_STOP,
  PRE_HYDRATE_MAX,
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

/**
 * Populate `waitTimeMin` on legs of already-scored top results.
 * Uses per-stop arrival caching so the same stop is only queried once.
 * All unique stops are fetched in parallel (each with a 5 s timeout).
 */
export async function hydrateWaitTimes(trips: TripOption[]): Promise<void> {
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
      if (leg.waitTimeMin === null) uniqueLines.add(leg.lineCode);
    }
  }
  const schedCache = new Map<string, Awaited<ReturnType<typeof getCachedSchedule>>>();
  const routesLookup = new Map<string, Awaited<ReturnType<typeof getCachedRoutes>>>();
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
