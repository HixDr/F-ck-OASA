/**
 * Trip timing, scoring and live hydration.
 *
 * The one rule in this file: there is a SINGLE CLOCK. `applyTripClock` walks a
 * trip forward from "now" adding walk, wait and ride in the order the user
 * experiences them, and every displayed number — board time, alight time,
 * arrival, total — is read off that one pass. The old code had three competing
 * definitions of "total" (one excluding waits, one including them, one a flat
 * 10 min/leg placeholder) and printed two of them side by side, which is how
 * "Total: ~25 min" ended up next to "Arrive ~14:50" at 14:15.
 */

import { parseSchedule, hhmmToMin, type LineSchedule } from '../../utils/scheduleUtils';
import { getCachedSchedule, getCachedRoutes } from '../../services/storage';
import { getStopArrivals, rideTimeFromArrivals } from '../../services/api';
import type { OasaArrival, OasaDailySchedule, OasaRoute } from '../../types';
import type { TripLeg, TripOption, WaitSource } from './types';
import { resolveRideTime, recordRideObservation } from './rideTimes';
import {
  UNKNOWN_WAIT_MIN,
  ARRIVAL_BUCKET_MIN,
  MAX_ARRIVAL_FETCHES,
  PRE_HYDRATE_MAX,
  getTrafficMultiplier,
} from './constants';

/** A wait past this is not a wait, it is "come back tomorrow". */
const NO_SERVICE_WAIT_MIN = 240;
/** Per-request budget for a live arrivals lookup. */
const ARRIVALS_TIMEOUT_MS = 6_000;

/* ── Plan context ────────────────────────────────────────────── */

/**
 * Everything the timing pass needs, resolved once per search.
 *
 * Schedules used to be re-parsed per leg per scoring call — a Set build, a
 * sort and a `new Date()` for the same line dozens of times inside an
 * `await` in a `for` loop, so the legs were serial as well as redundant.
 */
export interface PlanContext {
  nowMin: number;
  /** stopCode → live arrivals. Empty until hydrateLive runs. */
  arrivals: Map<string, OasaArrival[]>;
  schedules: Map<string, OasaDailySchedule | null>;
  routes: Map<string, OasaRoute[] | null>;
  /** `${lineCode}|${direction}` → parsed schedule. */
  parsed: Map<string, LineSchedule>;
  /** routeCode → average headway in minutes, or null. */
  headways: Map<string, number | null>;
}

/**
 * Resolve the schedule direction for a route.
 *
 * The base convention is verified against the live API and is NOT inverted
 * here: for a two-route line, index 0 is `come` and index ≥1 is `go`
 * (line 1153 ΠΕΙΡΑΙΑΣ - ΑΕΡ/ΝΑΣ: go = idx 1, come = idx 0). Two narrower
 * defects are fixed:
 *   (a) `findIndex` returning −1 used to fall into `'come'` as well, so an
 *       unknown route silently read the wrong half of the schedule;
 *   (b) circular lines have a single route, so idx 0 said `'come'` — but their
 *       schedule carries everything in `go` with `come: []`. parseSchedule
 *       already compensates internally, so this is belt-and-braces, but being
 *       explicit means the direction we log matches the direction we read.
 */
export function resolveDirection(
  lineCode: string,
  routeCode: string,
  routes: Map<string, OasaRoute[] | null>,
): 'go' | 'come' {
  const lineRoutes = routes.get(lineCode);
  if (!lineRoutes || lineRoutes.length === 0) return 'go';
  if (lineRoutes.length === 1) return 'go';   // circular — all times live in `go`
  const ri = lineRoutes.findIndex((r) => r.RouteCode === routeCode);
  if (ri < 0) return 'go';                    // unknown route — don't guess `come`
  return ri === 0 ? 'come' : 'go';
}

/** Average gap between departures, ignoring overnight breaks. */
function headwayFrom(sched: LineSchedule): number | null {
  if (sched.times.length < 2) return null;
  let total = 0;
  let gaps = 0;
  let prev = hhmmToMin(sched.times[0]);
  for (let i = 1; i < sched.times.length; i++) {
    const cur = hhmmToMin(sched.times[i]);
    if (prev != null && cur != null) {
      const g = cur - prev;
      if (g > 0 && g < 120) {
        total += g;
        gaps++;
      }
    }
    prev = cur;
  }
  return gaps > 0 ? Math.round(total / gaps) : null;
}

/** Parsed schedule for a leg, memoised per line+direction. */
function schedFor(ctx: PlanContext, lineCode: string, routeCode: string): LineSchedule | null {
  const data = ctx.schedules.get(lineCode);
  if (!data) return null;
  const dir = resolveDirection(lineCode, routeCode, ctx.routes);
  const key = `${lineCode}|${dir}`;
  const hit = ctx.parsed.get(key);
  if (hit) return hit;
  const parsedSched = parseSchedule(data, dir, ctx.nowMin);
  ctx.parsed.set(key, parsedSched);
  return parsedSched;
}

/**
 * Load schedules, routes and headways for every line in `trips`, in parallel.
 */
export async function buildPlanContext(
  trips: TripOption[],
  nowMin: number,
): Promise<PlanContext> {
  const lines = new Set<string>();
  for (const trip of trips) for (const leg of trip.legs) if (leg.lineCode) lines.add(leg.lineCode);

  const schedules = new Map<string, OasaDailySchedule | null>();
  const routes = new Map<string, OasaRoute[] | null>();
  await Promise.all(
    [...lines].map(async (lc) => {
      const [sched, rts] = await Promise.all([getCachedSchedule(lc), getCachedRoutes(lc)]);
      schedules.set(lc, sched);
      routes.set(lc, rts);
    }),
  );

  const ctx: PlanContext = {
    nowMin,
    arrivals: new Map(),
    schedules,
    routes,
    parsed: new Map(),
    headways: new Map(),
  };

  for (const trip of trips) {
    for (const leg of trip.legs) {
      if (ctx.headways.has(leg.routeCode)) continue;
      const sched = schedFor(ctx, leg.lineCode, leg.routeCode);
      ctx.headways.set(leg.routeCode, sched ? headwayFrom(sched) : null);
    }
  }
  return ctx;
}

/* ── Time helpers ────────────────────────────────────────────── */

/** Format minutes since midnight to HH:MM. Wraps past midnight. */
export function minToHHMM(min: number): string {
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Next time a bus on this schedule passes our board stop at or after `atMin`.
 *
 * Two corrections over the old version:
 *   - `atMin` is absolute and routinely exceeds 1440 on a second leg late at
 *     night (23:50 + walk + ride ≈ 1470). The old wrap branch returned
 *     `(1440 − afterMin) + tMin`, i.e. −20 minutes for a 00:10 departure — a
 *     negative wait that passed the feasibility check and then ran the clock
 *     backwards. Departures are rolled forward by whole days instead, so the
 *     wait can never be negative.
 *   - schedules publish departures from the *terminus*, not from our stop, so
 *     the bus reaches us `offsetMin` later. Assuming zero meant every board
 *     stop down the line was told to expect a bus that had already gone.
 */
function nextPassing(
  times: string[],
  offsetMin: number,
  atMin: number,
): { passMin: number; waitMin: number } | null {
  let best = Infinity;
  for (const t of times) {
    const tm = hhmmToMin(t);
    if (tm == null) continue;
    let pass = tm + offsetMin;
    if (pass < atMin) pass += 1440 * Math.ceil((atMin - pass) / 1440);
    if (pass < best) best = pass;
  }
  if (!Number.isFinite(best)) return null;
  return { passMin: best, waitMin: Math.max(0, best - atMin) };
}

interface WaitResult {
  waitMin: number;
  source: WaitSource;
  scheduledTime: string | null;
  noService: boolean;
}

/**
 * How long the user waits at `leg.boardStop` having arrived there at `atMin`.
 *
 * Live first, then the schedule, then a headway-shaped guess. A long wait is
 * reported, never used to delete the trip: Athens off-peak headways are
 * routinely 20-40 minutes, and the old hard 30-minute cutoff turned every
 * evening and every Sunday into "No bus routes found" when the true answer was
 * "one transfer, 35 minutes".
 */
function resolveWait(leg: TripLeg, atMin: number, ctx: PlanContext): WaitResult {
  const arrivals = ctx.arrivals.get(leg.boardStop.code);
  if (arrivals && arrivals.length > 0) {
    let best: number | null = null;
    for (const a of arrivals) {
      if (a.route_code !== leg.routeCode) continue;
      const btime = parseInt(a.btime2, 10);
      if (isNaN(btime)) continue;
      const absMin = ctx.nowMin + btime;
      if (absMin < atMin) continue;   // that bus leaves before we get there
      const wait = absMin - atMin;
      if (best === null || wait < best) best = wait;
    }
    if (best !== null) {
      // scheduledTime stays null: this bus came from live tracking, not from
      // the timetable, and the card must not imply otherwise.
      return { waitMin: best, source: 'live', scheduledTime: null, noService: false };
    }
  }

  const sched = schedFor(ctx, leg.lineCode, leg.routeCode);
  if (sched) {
    if (sched.times.length === 0) {
      // A schedule record exists for today and holds no departures at all.
      return { waitMin: UNKNOWN_WAIT_MIN, source: null, scheduledTime: null, noService: true };
    }
    const offset = Math.round(leg.terminusOffsetMin * getTrafficMultiplier(atMin));
    const next = nextPassing(sched.times, offset, atMin);
    if (next) {
      return {
        waitMin: next.waitMin,
        source: 'scheduled',
        scheduledTime: minToHHMM(next.passMin),
        noService: next.waitMin >= NO_SERVICE_WAIT_MIN,
      };
    }
  }

  // No live data and no schedule — shape the guess with the line's headway.
  const headway = ctx.headways.get(leg.routeCode) ?? null;
  const guess = headway === null
    ? UNKNOWN_WAIT_MIN
    : Math.min(30, Math.max(3, Math.round(headway / 2)));
  return { waitMin: guess, source: null, scheduledTime: null, noService: false };
}

/* ── The single clock ────────────────────────────────────────── */

/**
 * Walk a trip forward from now and write every derived time onto it.
 * Idempotent — call it again after live hydration to re-derive everything.
 */
export function applyTripClock(trip: TripOption, ctx: PlanContext): void {
  const now = ctx.nowMin;
  trip.departMin = now;

  let t = now + trip.walkToOriginMin;
  let low = t;
  let high = t;
  let maxWait = 0;
  let noService = false;
  let liveRides = 0;
  let estimateRides = 0;

  for (let i = 0; i < trip.legs.length; i++) {
    const leg = trip.legs[i];

    if (i > 0) {
      t += leg.transferWalkMin;
      low += leg.transferWalkMin;
      high += leg.transferWalkMin;
    }

    const wait = resolveWait(leg, t, ctx);
    leg.waitTimeMin = wait.waitMin;
    leg.waitSource = wait.source;
    leg.scheduledTime = wait.scheduledTime;
    leg.noServiceToday = wait.noService;
    if (wait.noService) noService = true;
    if (wait.waitMin > maxWait) maxWait = wait.waitMin;

    t += wait.waitMin;
    low += wait.waitMin;
    high += wait.waitMin;
    leg.boardMin = t;
    leg.boardTimeStr = minToHHMM(t);

    const ride = resolveRideTime(
      leg.routeCode, leg.boardStop.code, leg.alightStop.code,
      leg.rawRideMin, leg.liveRideMin, t,
    );
    leg.rideTimeMin = ride.rideMin;
    leg.rideSource = ride.source;
    leg.rideLowMin = ride.lowMin;
    leg.rideHighMin = ride.highMin;
    if (ride.source === 'live') liveRides++;
    else if (ride.source === 'estimate') estimateRides++;

    t += ride.rideMin;
    low += ride.lowMin;
    high += ride.highMin;
    leg.alightMin = t;
    leg.alightTimeStr = minToHHMM(t);
  }

  t += trip.walkFromDestMin;
  low += trip.walkFromDestMin;
  high += trip.walkFromDestMin;

  trip.arriveMin = Math.round(t);
  trip.arriveLowMin = Math.round(low);
  trip.arriveHighMin = Math.round(high);
  trip.totalTimeMin = trip.arriveMin - now;
  trip.totalLowMin = trip.arriveLowMin - now;
  trip.totalHighMin = trip.arriveHighMin - now;
  trip.arrivalTimeStr = minToHHMM(trip.arriveMin);
  trip.maxWaitMin = maxWait;
  trip.noService = noService;
  trip.confidence = liveRides === trip.legs.length
    ? 'measured'
    : estimateRides === trip.legs.length
      ? 'estimated'
      : 'mixed';
}

/* ── Scoring ─────────────────────────────────────────────────── */

/**
 * Composite score for a trip. Lower is better.
 *
 * This is a tiebreak within an arrival bucket, not the primary ranking — the
 * primary ranking is when you actually get there. It prices the things arrival
 * time alone cannot see: transfers, walking, and how much of the answer is a
 * guess.
 */
export function computeCompositeScore(trip: TripOption, ctx: PlanContext): number {
  let score = trip.walkToOriginMin + trip.walkFromDestMin;

  const numTransfers = Math.max(0, trip.legs.length - 1);
  score += numTransfers * 5;
  score += Math.max(0, trip.transferWalkMin - 2) * 0.5;

  let liveCount = 0;
  let scheduledCount = 0;
  let unknownCount = 0;

  for (const leg of trip.legs) {
    score += leg.rideTimeMin;
    // An answer we had to guess is worth less than one we measured.
    score += (leg.rideHighMin - leg.rideLowMin) * 0.5;

    const wait = leg.waitTimeMin ?? UNKNOWN_WAIT_MIN;
    if (leg.waitSource === 'live') {
      score += wait <= 5 ? wait : wait + 2;
      liveCount++;
    } else if (leg.waitSource === 'scheduled') {
      score += wait < 30 ? Math.max(3, wait) : 15 + wait / 10;
      scheduledCount++;
    } else {
      const headway = ctx.headways.get(leg.routeCode) ?? null;
      if (headway !== null && headway < 10) score += 8;
      else if (headway !== null && headway < 20) score += 12;
      else if (headway !== null && headway < 40) score += 18;
      else score += 22;
      unknownCount++;
    }
  }

  const total = trip.legs.length;
  if (liveCount === total) score -= 10;
  else if (liveCount > 0) score -= 5;
  else if (scheduledCount === total) score += 0;
  else if (unknownCount > 0 && unknownCount < total) score += 5;
  else if (unknownCount === total) score += 20;

  return Math.round(score);
}

/**
 * Rank trips: soonest arrival first, composite score breaking ties.
 *
 * Arrival is *bucketed* rather than compared against a tie window. A window is
 * not an equivalence relation, so the old comparator was intransitive —
 * A={arr:10,score:100}, B={arr:12,score:50}, C={arr:14,score:10} gives B<A,
 * C<B and A<C, a cycle, and those same three elements produced four different
 * orderings across the six input permutations. Array.sort with an inconsistent
 * comparator is implementation-defined.
 */
export function rankTrips(trips: TripOption[], ctx: PlanContext): TripOption[] {
  const scored = trips.map((trip) => ({ trip, score: computeCompositeScore(trip, ctx) }));
  scored.sort((a, b) =>
    Math.floor(a.trip.arriveMin / ARRIVAL_BUCKET_MIN) - Math.floor(b.trip.arriveMin / ARRIVAL_BUCKET_MIN)
    || a.score - b.score
    || a.trip.arriveMin - b.trip.arriveMin
    || (a.trip.id < b.trip.id ? -1 : a.trip.id > b.trip.id ? 1 : 0),
  );
  return scored.map((s) => s.trip);
}

/**
 * Cheap pre-filter before any schedule work: drop trips that cannot compete on
 * raw walk + ride, so the context only loads schedules for plausible lines.
 */
export function roughTrim(trips: TripOption[], nowMin: number, limit: number): TripOption[] {
  if (trips.length <= limit) return trips;
  const mult = getTrafficMultiplier(nowMin);
  const keyed = trips.map((trip) => {
    let t = trip.walkToOriginMin + trip.walkFromDestMin + UNKNOWN_WAIT_MIN * trip.legs.length;
    for (const leg of trip.legs) t += leg.transferWalkMin + leg.rawRideMin * mult;
    return { trip, t };
  });
  keyed.sort((a, b) => a.t - b.t);
  return keyed.slice(0, limit).map((k) => k.trip);
}

/** Keep the plausible tail after the clock has run. Sorted before the slice —
 *  trimming an unsorted array to N keeps an arbitrary N. */
export function trimByArrival(trips: TripOption[]): TripOption[] {
  if (trips.length === 0) return trips;
  let best = Infinity;
  for (const t of trips) if (t.totalTimeMin < best) best = t.totalTimeMin;
  const cutoff = Math.max(best * 1.8, best + 30);
  return trips
    .filter((t) => t.totalTimeMin <= cutoff)
    .sort((a, b) => a.arriveMin - b.arriveMin)
    .slice(0, PRE_HYDRATE_MAX);
}

/* ── Live hydration ──────────────────────────────────────────── */

/** Resolve to null on timeout or failure instead of hanging the phase. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * Fetch live arrival profiles and upgrade the top trips to measured times.
 *
 * `getStopArrivals` returns a per-vehicle predicted arrival profile across the
 * vehicle's whole remaining route, so a vehicle present at both ends of a leg
 * gives its ride time directly. The board stop's profile is needed for the wait
 * anyway, which makes the measured ride time roughly one extra call per leg —
 * and only for the handful of trips we are about to show, never for every
 * candidate.
 */
export async function hydrateLive(
  trips: TripOption[],
  ctx: PlanContext,
  signal?: AbortSignal,
): Promise<void> {
  // Board stops first: they carry the waits, which matter even if the ride
  // time falls back a tier.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    ordered.push(code);
  };
  for (const trip of trips) for (const leg of trip.legs) push(leg.boardStop.code);
  for (const trip of trips) for (const leg of trip.legs) push(leg.alightStop.code);

  const stops = ordered.slice(0, MAX_ARRIVAL_FETCHES);
  await Promise.all(
    stops.map(async (code) => {
      const data = await withTimeout(getStopArrivals(code, { signal }), ARRIVALS_TIMEOUT_MS);
      ctx.arrivals.set(code, Array.isArray(data) ? data : []);
    }),
  );
  if (signal?.aborted) return;

  for (const trip of trips) {
    for (const leg of trip.legs) {
      const board = ctx.arrivals.get(leg.boardStop.code);
      const alight = ctx.arrivals.get(leg.alightStop.code);
      if (!board || !alight || board.length === 0 || alight.length === 0) continue;

      const measured = rideTimeFromArrivals(board, alight, leg.routeCode);
      if (!measured) continue;
      leg.liveRideMin = measured.rideMin;
      // Only tier-1 values feed the empirical table — recording an estimate
      // would launder a guess into "measured" on the next search.
      recordRideObservation(
        leg.routeCode, leg.boardStop.code, leg.alightStop.code,
        ctx.nowMin + measured.waitMin, measured.rideMin,
      );
    }
  }
}
