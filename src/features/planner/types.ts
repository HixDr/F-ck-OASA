/**
 * Planner type declarations — shared across all RAPTOR planner modules.
 */

import type { OasaRoute } from '../../types';

/* ── Confidence ──────────────────────────────────────────────── */

/**
 * Where a leg's ride time came from.
 *   live      — measured from a vehicle present at both stops right now.
 *   empirical — median of live spans we recorded earlier for this pair/hour.
 *   estimate  — straight-line distance ÷ average speed. Cold start only.
 *
 * The UI must render this. Printing a straight-line estimate to the minute
 * with total confidence is this screen's worst failure mode.
 */
export type RideSource = 'live' | 'empirical' | 'estimate';

/** Where a leg's wait came from. `null` means we genuinely do not know. */
export type WaitSource = 'live' | 'scheduled' | null;

/** Trip-level confidence, derived from its legs. */
export type TripConfidence = 'measured' | 'mixed' | 'estimated';

/* ── Trip Types ──────────────────────────────────────────────── */

export interface StopRef {
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Position in the route path (RouteStopOrder-sorted). */
  orderInRoute: number;
}

/** A single leg of a trip (one bus ride). */
export interface TripLeg {
  lineCode: string;
  lineId: string;
  lineDescr: string;
  routeCode: string;
  boardStop: StopRef;
  alightStop: StopRef;
  stopCount: number;

  /** Straight-line ÷ average bus speed, no traffic multiplier applied.
   *  The `estimate` tier is derived from this at clock time so the multiplier
   *  matches the hour the user actually boards. */
  rawRideMin: number;
  /** Span measured from a live vehicle profile, if one covered both stops. */
  liveRideMin: number | null;
  /** The ride time actually used, after tier resolution. */
  rideTimeMin: number;
  rideSource: RideSource;
  /** Honest bounds on rideTimeMin. Equal to it when measured. */
  rideLowMin: number;
  rideHighMin: number;

  waitTimeMin: number | null;
  waitSource: WaitSource;
  scheduledTime: string | null;
  /** The line has a schedule for today and it holds no usable departures. */
  noServiceToday: boolean;

  /** Walk from the previous leg's alight stop to this leg's board stop.
   *  Always 0 on the first leg — that walk is the trip's walkToOriginMin. */
  transferWalkMin: number;

  /** Minutes from the route's first stop to this board stop. Schedules publish
   *  terminus departures, so a bus leaving at T passes us at T + this. */
  terminusOffsetMin: number;

  /** Absolute minutes since Athens midnight, from the single trip clock. */
  boardMin: number | null;
  alightMin: number | null;
  boardTimeStr: string | null;
  alightTimeStr: string | null;
}

/**
 * A complete trip from origin pin to destination pin.
 *
 * ONE CLOCK. Everything below is derived from a single forward pass that
 * starts at `departMin` and adds walk, wait and ride in order:
 *   arriveMin    = end of that pass
 *   totalTimeMin = arriveMin − departMin  (door to door, waits included)
 * `Total` and `Arrive` can therefore never disagree.
 */
export interface TripOption {
  legs: TripLeg[];
  /** Pin → first board stop. */
  walkToOriginMin: number;
  /** Last alight stop → destination pin. Rendered even on single-leg trips. */
  walkFromDestMin: number;
  /** Sum of the per-leg transferWalkMin values. Display uses the per-leg one. */
  transferWalkMin: number;

  /** Minutes since Athens midnight when the user sets off. */
  departMin: number;
  /** Minutes since Athens midnight at the destination pin. */
  arriveMin: number;
  /** Optimistic / pessimistic bounds on arriveMin from the ride-time spreads. */
  arriveLowMin: number;
  arriveHighMin: number;
  /** arriveMin − departMin. Door to door, waits included. */
  totalTimeMin: number;
  totalLowMin: number;
  totalHighMin: number;

  arrivalTimeStr: string | null;
  confidence: TripConfidence;
  /** A leg has a schedule for today with nothing left on it. */
  noService: boolean;
  /** Longest single wait on the trip — surfaced rather than used to delete. */
  maxWaitMin: number;

  originStop: { code: string; name: string; lat: number; lng: number };
  destStop: { code: string; name: string; lat: number; lng: number };
  /** Stable identity for React keys and selection across re-ranks. */
  id: string;
  /** UI tag: 'Soonest' | 'Easiest' — set by the planner after sorting. */
  _tag?: 'Soonest' | 'Easiest';
}

/** Stop candidate with distance from pin. */
export interface StopCandidate {
  code: string;
  name: string;
  lat: number;
  lng: number;
  distM: number;
}

/** A candidate stop resolved against the index, with its walk time. */
export interface WalkStop {
  code: string;
  walkMin: number;
  distM: number;
}

/* ── RAPTOR Index Types ──────────────────────────────────────── */

/** Pre-computed data for the RAPTOR scan, built from offline cached data. */
export interface RaptorIndex {
  /** routeCode → ordered array of stop codes (RouteStopOrder-sorted) */
  routePaths: Map<string, string[]>;
  /** routeCode → stopCode → FIRST position index in route.
   *  First, not last: circular routes repeat a StopCode and the scan must
   *  start from the earliest occurrence. Callers needing every occurrence
   *  (e.g. a route passing the destination twice) walk routePaths instead. */
  routeStopIndex: Map<string, Map<string, number>>;
  /** stopCode → array of routeCodes serving this stop */
  routesAtStop: Map<string, string[]>;
  /** routeCode → cumulative straight-line travel time from the first stop */
  travelTimesMin: Map<string, number[]>;
  /** routeCode → OasaRoute (for lineCode, descr, etc.) */
  routeMeta: Map<string, OasaRoute>;
  /** stopCode → { name, lat, lng }, scoped to indexed stops only */
  stopInfo: Map<string, { name: string; lat: number; lng: number }>;
  /** stopCode → array of { target, walkMin } for walking transfers */
  transfers: Map<string, Array<{ target: string; walkMin: number }>>;
}

/* ── RAPTOR Scan Types ───────────────────────────────────────── */

/** Connection record: how we reached a stop in a given round. */
export type RideConnection = {
  type: 'ride';
  routeCode: string;
  boardStop: string;
  boardIdx: number;
  alightIdx: number;
};

export type TransferConnection = {
  type: 'transfer';
  fromStop: string;
  walkMin: number;
};

export type Connection = RideConnection | TransferConnection;

export interface RaptorResult {
  /** bestArrivals[stopCode] = earliest known arrival time (minutes) */
  bestArrivals: Map<string, number>;
  /** kArrivals[round][stopCode] = earliest arrival at stop in this round */
  kArrivals: Array<Map<string, number>>;
  /** kConnections[round][stopCode] = how we reached this stop in this round */
  kConnections: Array<Map<string, Connection>>;
}

/* ── Trip Extraction Types ───────────────────────────────────── */

/** Raw leg data before conversion to TripLeg. */
export interface RawLeg {
  routeCode: string;
  boardStop: string;
  boardIdx: number;
  alightStop: string;
  alightIdx: number;
  rideMin: number;
}
