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
