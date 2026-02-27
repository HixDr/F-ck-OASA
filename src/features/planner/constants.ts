/**
 * Planner constants — shared across all RAPTOR planner modules.
 */

export const CANDIDATE_RADIUS_M = 1200;
export const WALK_SPEED_M_PER_MIN = 80;       // ~4.8 km/h
export const TRANSFER_WALK_RADIUS_M = 400;    // max walk between stops for a transfer
export const TRANSFER_FLAT_PENALTY_MIN = 3;   // minimum transfer time even at same stop
export const UNKNOWN_WAIT_MIN = 10;
export const FALLBACK_MIN_PER_STOP = 2;
export const TOO_CLOSE_M = 200;
export const MAX_RESULTS = 10;
export const MAX_ROUNDS = 3;                  // up to 3 bus legs (2 transfers)
export const AVG_BUS_SPEED_M_PER_MIN = 267;   // ~16 km/h in metres per minute
export const INF = 999999;
export const PRE_HYDRATE_MAX = 25;

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
  const h = minuteOfDay / 60;
  if (h < 6)    return 0.55;
  if (h < 7.5)  return 0.80;
  if (h < 9.5)  return 1.30;
  if (h < 15)   return 1.00;
  if (h < 18)   return 1.25;
  if (h < 21)   return 1.00;
  return 0.70;
}
