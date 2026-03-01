/**
 * Planner type declarations — shared across all RAPTOR planner modules.
 */

import type { OasaRoute } from '../../types';

/* ── Trip Types ──────────────────────────────────────────────── */

/** A single leg of a trip (one bus ride). */
export interface TripLeg {
  lineCode: string;
  lineId: string;
  lineDescr: string;
  routeCode: string;
  boardStop: {
    code: string;
    name: string;
    lat: number;
    lng: number;
    orderInRoute: number;
  };
  alightStop: {
    code: string;
    name: string;
    lat: number;
    lng: number;
    orderInRoute: number;
  };
  stopCount: number;
  rideTimeMin: number;
  waitTimeMin: number | null;
  waitSource: 'live' | 'scheduled' | null;
  scheduledTime: string | null;
  /** HH:MM when the user boards this bus (null if timing unknown). */
  boardTimeStr: string | null;
  /** HH:MM when the user alights this bus (null if timing unknown). */
  alightTimeStr: string | null;
  /** Estimated minutes from route terminus to this board stop. */
  boardOffsetMin: number;
}

/** A complete trip from origin to destination. */
export interface TripOption {
  legs: TripLeg[];
  walkToOriginMin: number;
  walkFromDestMin: number;
  transferWalkMin: number;             // sum of all transfer walks
  totalTimeMin: number;
  /** HH:MM estimated arrival at destination (including waits + walk). */
  arrivalTimeStr: string | null;
  originStop: { code: string; name: string; lat: number; lng: number };
  destStop: { code: string; name: string; lat: number; lng: number };
  /** UI tag: 'Soonest' | 'Shortest' — set by planner after sorting. */
  _tag?: 'Soonest' | 'Shortest';
}

/** Stop candidate with distance from pin. */
export interface StopCandidate {
  code: string;
  name: string;
  lat: number;
  lng: number;
  distM: number;
}

/* ── RAPTOR Index Types ──────────────────────────────────────── */

/** Pre-computed data for the RAPTOR scan, built from offline cached data. */
export interface RaptorIndex {
  /** routeCode → ordered array of stop codes */
  routePaths: Map<string, string[]>;
  /** routeCode → map of stopCode → position index in route */
  routeStopIndex: Map<string, Map<string, number>>;
  /** stopCode → array of routeCodes serving this stop */
  routesAtStop: Map<string, string[]>;
  /** routeCode → cumulative travel time in minutes from first stop to each stop */
  travelTimesMin: Map<string, number[]>;
  /** routeCode → OasaRoute (for lineCode, descr, etc.) */
  routeMeta: Map<string, OasaRoute>;
  /** stopCode → { name, lat, lng } */
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
