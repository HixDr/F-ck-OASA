/**
 * Planner constants — shared across all RAPTOR planner modules.
 */

export const CANDIDATE_RADIUS_M = 1200;
export const WALK_SPEED_M_PER_MIN = 80;       // ~4.8 km/h
export const TRANSFER_WALK_RADIUS_M = 400;    // max walk between stops for a transfer
export const TRANSFER_FLAT_PENALTY_MIN = 3;   // minimum transfer time even at same stop
export const UNKNOWN_WAIT_MIN = 10;
export const TOO_CLOSE_M = 200;
export const AVG_BUS_SPEED_M_PER_MIN = 267;   // ~16 km/h in metres per minute
export const INF = 999999;

/**
 * Two bus legs, one transfer — and that is honest.
 *
 * The index only contains routes that touch an origin or destination candidate
 * (see raptorIndex). A genuine three-leg journey's middle route touches
 * neither, so it is not in the index and round 3 can never find it; it only
 * re-scans the same routes and burns CPU. Indexing the whole network to make
 * round 3 real would cost far more than the answers are worth on Hermes.
 */
export const MAX_ROUNDS = 2;

/** Candidate stops considered per pin. */
export const MAX_CANDIDATE_STOPS = 20;
/** Fan-out cap on the walking-transfer graph. Downtown stops have 30+
 *  neighbours within 400 m; the 8 nearest carry essentially all the value and
 *  keep the graph an order of magnitude smaller. */
export const MAX_TRANSFERS_PER_STOP = 8;

/** Trips surviving the pre-hydration cutoff. */
export const PRE_HYDRATE_MAX = 12;
/** Trips we spend network calls on (live waits + live ride times). */
export const HYDRATE_TOP = 8;
/** Hard cap on parallel getStopArrivals calls per search. */
export const MAX_ARRIVAL_FETCHES = 24;
/** Results shown. Everything shown is hydrated. */
export const MAX_RESULTS = 6;

/** Arrival-time bucket for ranking. Bucketing (rather than a tie *window*)
 *  keeps the comparator transitive — a 3-minute "close enough" window is not
 *  an equivalence relation and Array.sort is undefined with one. */
export const ARRIVAL_BUCKET_MIN = 3;

/** Waits at or above this get called out in the UI rather than hidden. */
export const LONG_WAIT_WARN_MIN = 25;

/** Display spread on non-measured ride times, as a fraction. */
export const ESTIMATE_SPREAD = 0.35;
export const EMPIRICAL_SPREAD = 0.15;

/** Persisted empirical ride-time table limits. */
export const MAX_SAMPLES_PER_PAIR = 8;
export const MAX_RIDE_TIME_KEYS = 600;

/**
 * Time-of-day traffic multiplier for bus ride times.
 * Baseline (1.0) = normal midday traffic (~16 km/h effective with dwell time).
 *
 *   00:00–05:59  night         0.55  (~29 km/h, minimal stops/traffic)
 *   06:00–07:29  early morning 0.80
 *   07:30–09:30  morning rush  1.30
 *   09:31–14:59  midday        1.00
 *   15:00–18:00  afternoon rush 1.25
 *   18:01–21:00  evening       1.00
 *   21:01–23:59  late evening  0.70
 */
export function getTrafficMultiplier(minuteOfDay: number): number {
  const h = (((minuteOfDay % 1440) + 1440) % 1440) / 60;
  if (h < 6)    return 0.55;
  if (h < 7.5)  return 0.80;
  if (h < 9.5)  return 1.30;
  if (h < 15)   return 1.00;
  if (h < 18)   return 1.25;
  if (h < 21)   return 1.00;
  return 0.70;
}
