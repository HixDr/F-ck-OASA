/**
 * Three-tier ride-time model.
 *
 * The planner used to price every leg as haversine ÷ 16 km/h — identical for an
 * express and an all-stops local, blind to traffic, and printed to the minute.
 * It is replaced by three tiers, in descending order of trust:
 *
 *   1. live      — `getStopArrivals` publishes a *per-vehicle predicted arrival
 *                  profile* across the vehicle's whole remaining route, not
 *                  just "what's next". A vehicle that appears at both the board
 *                  and the alight stop gives the ride time directly:
 *                  btime2(alight) − btime2(board). Measured, traffic-aware,
 *                  ~40 min horizon. See rideTimeFromArrivals in services/api.
 *   2. empirical — median of tier-1 spans we already observed for this
 *                  (route, board→alight) pair in this hour of day. The table
 *                  self-populates from tier 1 and is persisted, so a route the
 *                  user actually travels gets good numbers with no extra calls.
 *   3. estimate  — haversine ÷ average speed × traffic multiplier. Cold start
 *                  only, and the UI renders it as a range because that is all
 *                  it deserves.
 *
 * Persistence lives here rather than in services/storage: this is planner-local
 * state with a namespaced key of its own.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPIRICAL_SPREAD,
  ESTIMATE_SPREAD,
  MAX_RIDE_TIME_KEYS,
  MAX_SAMPLES_PER_PAIR,
  getTrafficMultiplier,
} from './constants';
import type { RideSource } from './types';

const STORE_KEY = '@oasa/planner/rideTimes';
/** Debounce persistence — a search can record a dozen observations at once. */
const PERSIST_DELAY_MS = 3_000;

/** One observed ride: the hour of day it was measured in, and its span. */
interface Sample {
  h: number;
  m: number;
}
interface Entry {
  s: Sample[];
  /** Last-touched epoch ms, used to evict the coldest pairs. */
  t: number;
}
type Store = Record<string, Entry>;

let _store: Store | null = null;
let _loading: Promise<Store> | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function pairKey(routeCode: string, boardCode: string, alightCode: string): string {
  return `${routeCode}|${boardCode}>${alightCode}`;
}

function hourOf(minuteOfDay: number): number {
  return Math.floor((((minuteOfDay % 1440) + 1440) % 1440) / 60);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Load the persisted table into memory. Idempotent, and safe to call
 * concurrently — the planner awaits it once per search.
 */
export function loadRideTimes(): Promise<void> {
  if (_store) return Promise.resolve();
  if (_loading) return _loading.then(() => {});
  _loading = (async () => {
    let parsed: Store = {};
    try {
      const raw = await AsyncStorage.getItem(STORE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Store;
      }
    } catch {
      // Corrupt or absent — start empty rather than failing the search.
    }
    _store = parsed;
    _loading = null;
    return parsed;
  })();
  return _loading.then(() => {});
}

function persistSoon(): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    void flushRideTimes();
  }, PERSIST_DELAY_MS);
}

/** Write the table out now. Called on the debounce and on screen teardown. */
export async function flushRideTimes(): Promise<void> {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (!_store) return;
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(_store));
  } catch {
    // Best-effort: an unwritten observation only costs us the next lookup.
  }
}

/** Drop the coldest pairs once the table outgrows its budget. */
function prune(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_RIDE_TIME_KEYS) return;
  keys.sort((a, b) => store[a].t - store[b].t);
  for (let i = 0; i < keys.length - MAX_RIDE_TIME_KEYS; i++) delete store[keys[i]];
}

/**
 * Record a measured ride span. Only tier-1 (live) values should ever land here
 * — feeding estimates back in would launder a guess into "empirical".
 */
export function recordRideObservation(
  routeCode: string,
  boardCode: string,
  alightCode: string,
  atMin: number,
  rideMin: number,
): void {
  if (!_store) return;
  if (!Number.isFinite(rideMin) || rideMin <= 0 || rideMin > 240) return;

  const key = pairKey(routeCode, boardCode, alightCode);
  const entry = _store[key] ?? { s: [], t: 0 };
  entry.s.push({ h: hourOf(atMin), m: Math.round(rideMin) });
  if (entry.s.length > MAX_SAMPLES_PER_PAIR) entry.s.splice(0, entry.s.length - MAX_SAMPLES_PER_PAIR);
  entry.t = Date.now();
  _store[key] = entry;
  prune(_store);
  persistSoon();
}

/**
 * Median observed ride time for a pair, or null when we have never seen it.
 *
 * Prefers samples from the same hour of day. Falling back to all hours would
 * mix a 07:45 crawl with a 23:10 sprint, so out-of-hour samples are rescaled by
 * the ratio of traffic multipliers before being trusted.
 */
export function empiricalRideMin(
  routeCode: string,
  boardCode: string,
  alightCode: string,
  atMin: number,
): number | null {
  if (!_store) return null;
  const entry = _store[pairKey(routeCode, boardCode, alightCode)];
  if (!entry || entry.s.length === 0) return null;

  const hour = hourOf(atMin);
  const sameHour = entry.s.filter((x) => x.h === hour);
  if (sameHour.length > 0) return Math.max(1, Math.round(median(sameHour.map((x) => x.m))));

  const base = median(entry.s.map((x) => x.m));
  const sampleHour = median(entry.s.map((x) => x.h));
  const scale = getTrafficMultiplier(hour * 60) / getTrafficMultiplier(sampleHour * 60);
  return Math.max(1, Math.round(base * scale));
}

/* ── Tier resolution ─────────────────────────────────────────── */

export interface ResolvedRideTime {
  rideMin: number;
  source: RideSource;
  lowMin: number;
  highMin: number;
}

/**
 * Pick the best available ride time for a leg boarding at `atMin`.
 *
 * `rawRideMin` is the untouched haversine ÷ speed figure from the index; the
 * traffic multiplier is applied here so it matches the hour the user actually
 * boards rather than the hour the search ran.
 */
export function resolveRideTime(
  routeCode: string,
  boardCode: string,
  alightCode: string,
  rawRideMin: number,
  liveRideMin: number | null,
  atMin: number,
): ResolvedRideTime {
  if (liveRideMin !== null && liveRideMin > 0) {
    const m = Math.max(1, Math.round(liveRideMin));
    return { rideMin: m, source: 'live', lowMin: m, highMin: m };
  }

  const empirical = empiricalRideMin(routeCode, boardCode, alightCode, atMin);
  if (empirical !== null) {
    return {
      rideMin: empirical,
      source: 'empirical',
      lowMin: Math.max(1, Math.round(empirical * (1 - EMPIRICAL_SPREAD))),
      highMin: Math.round(empirical * (1 + EMPIRICAL_SPREAD)),
    };
  }

  const est = Math.max(1, Math.round(rawRideMin * getTrafficMultiplier(atMin)));
  return {
    rideMin: est,
    source: 'estimate',
    lowMin: Math.max(1, Math.round(est * (1 - ESTIMATE_SPREAD))),
    highMin: Math.round(est * (1 + ESTIMATE_SPREAD)),
  };
}
