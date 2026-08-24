/**
 * OASA Telematics API service layer.
 *
 * Base URL: http://telematics.oasa.gr/api/
 * Protocol: JSON over HTTP POST/GET.
 * Auth: None — but User-Agent header is mandatory (403 without it).
 * CORS: Open (Access-Control-Allow-Origin: *).
 */

import type {
  OasaLine,
  OasaRoute,
  OasaRouteDetail,
  OasaStop,
  OasaArrival,
  OasaBusLocation,
  OasaNearbyStop,
  OasaMLInfo,
  OasaSchedLines,
  OasaDailySchedule,
  OasaBulkStop,
} from '../types';

/**
 * The only host this app talks to.
 *
 * There is deliberately no plaintext alternative. As of 2026-08
 * `http://telematics.oasa.gr` does not complete a connection at all — it hangs
 * until the timeout — while HTTPS serves every endpoint normally. A fallback to
 * it could therefore never succeed, and the one that used to live here did real
 * damage: see `getApiBase` below.
 */
const API_BASE = 'https://telematics.oasa.gr/api/';

/** Shared User-Agent. The API returns 403 without one. */
export const USER_AGENT = 'OASALive/1.0 (personal telematics client)';

/** Default per-request timeout. RN's OkHttp client has an infinite read
 *  timeout by default, so without this a half-open socket hangs forever. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/** Per-request options accepted by every endpoint wrapper. */
export interface RequestOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Return the API base URL.
 *
 * A constant, and it must stay one. This used to be a module-level `let` that a
 * failed request could rewrite: one transport error moved it from HTTPS to the
 * plaintext host and nothing could move it back, so a single bad moment — a
 * tunnel, a lift, a cell handover — pointed every later request at a host that
 * does not answer, for the rest of the process's life. It presented as every
 * saved stop losing its bus times at once while names and lines kept rendering
 * from the offline cache, and it cleared only on a force-quit.
 *
 * Where the next request goes must not be something a previous request can
 * write. `tests/api-transport.test.mjs` holds that line.
 */
export function getApiBase(): string {
  return API_BASE;
}

/* ── Errors ──────────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(message: string, readonly action: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}
/** Request exceeded its timeout or was aborted by the caller. */
export class ApiTimeoutError extends ApiError {
  constructor(action: string) {
    super(`OASA API ${action} timed out`, action);
    this.name = 'ApiTimeoutError';
  }
}
/** Body was not valid JSON — a captive portal or an upstream error page. */
export class ApiParseError extends ApiError {
  constructor(action: string, readonly body: string) {
    super(`OASA API ${action} returned non-JSON`, action);
    this.name = 'ApiParseError';
  }
}
/** Body parsed but is not the shape this endpoint promises. */
export class ApiShapeError extends ApiError {
  constructor(action: string) {
    super(`OASA API ${action} returned an unexpected shape`, action);
    this.name = 'ApiShapeError';
  }
}
/** Server explicitly returned nothing where an object was expected. */
export class ApiEmptyError extends ApiError {
  constructor(action: string) {
    super(`OASA API ${action} returned an empty body`, action);
    this.name = 'ApiEmptyError';
  }
}

/**
 * `fetch` with a hard timeout, and support for an external abort signal so
 * callers can cancel in-flight work (screen unmount, superseded request).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * Core request helper.
 *
 * `expect` matters: it decides what an *empty* response means. Array
 * endpoints legitimately return nothing (no arrivals right now), so `[]` is a
 * real answer. Object endpoints returning nothing is a failure — and it must
 * throw, because callers persist successful results to the offline cache.
 * Returning `[]` here (as this used to) wrote `[]` over good schedule data,
 * and since `[]` is truthy it was then preferred forever.
 */
async function api<T>(
  action: string,
  params: Record<string, string> = {},
  expect: 'array' | 'object' = 'array',
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const qs = new URLSearchParams({ act: action, ...params }).toString();

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${API_BASE}?${qs}`,
      { method: 'GET', headers: { 'User-Agent': USER_AGENT } },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.signal,
    );
  } catch {
    /* Timeout, caller abort and outright transport failure all land here, and
       all three produced this same error before — nothing downstream tells them
       apart, because the response to each is identical: serve the stop's last
       known arrivals off disk rather than blanking the card. */
    throw new ApiTimeoutError(action);
  }

  if (!res.ok) {
    throw new ApiError(`OASA API ${action} → ${res.status}`, action, res.status);
  }

  const text = (await res.text()).trim();
  if (!text || text === '""' || text === 'null') {
    if (expect === 'array') return [] as unknown as T;
    throw new ApiEmptyError(action);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiParseError(action, text.slice(0, 200));
  }

  if (parsed === null || parsed === undefined) {
    if (expect === 'array') return [] as unknown as T;
    throw new ApiEmptyError(action);
  }
  // The API signals some failures as {"error": "..."} with HTTP 200.
  if (typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in (parsed as object)) {
    throw new ApiError(`OASA API ${action}: ${(parsed as { error: string }).error}`, action);
  }
  if (expect === 'array' && !Array.isArray(parsed)) throw new ApiShapeError(action);
  if (expect === 'object' && typeof parsed !== 'object') throw new ApiShapeError(action);

  return parsed as T;
}

/* ── Static / Reference Endpoints ────────────────────────────── */

/** All 464 bus/trolley lines (~150 KB). */
export const getLines = (opts: RequestOpts = {}) =>
  api<OasaLine[]>('webGetLines', {}, 'array', opts);

/** Routes (directions) for a specific line. */
export const getRoutes = (lineCode: string, opts: RequestOpts = {}) =>
  api<OasaRoute[]>('webGetRoutes', { p1: lineCode }, 'array', opts);

/** Ordered stops for a specific route. */
export const getStops = (routeCode: string, opts: RequestOpts = {}) =>
  api<OasaStop[]>('webGetStops', { p1: routeCode }, 'array', opts);

/** Detailed route path (road-following polyline points) + stops.
 *  Throws on failure — callers need to tell "this route has no shape" apart
 *  from "the request failed", because the map falls back to a stop-to-stop
 *  line and the bus interpolator must be fed the same source. */
export async function getRouteDetails(
  routeCode: string,
  opts: RequestOpts = {},
): Promise<{ lat: number; lng: number }[]> {
  const data = await api<{ details: OasaRouteDetail[] }>(
    'webGetRoutesDetailsAndStops',
    { p1: routeCode },
    'object',
    opts,
  );
  if (!data?.details?.length) return [];
  return data.details
    .slice()
    .sort((a, b) => Number(a.routed_order) - Number(b.routed_order))
    .map((d) => ({ lat: parseFloat(d.routed_y), lng: parseFloat(d.routed_x) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/** Ordered stops for a route, sorted by RouteStopOrder rather than trusting
 *  the array order the API happens to return. Every downstream assumption
 *  (board index < alight index, cumulative travel times) depends on this. */
export async function getRouteStopsOrdered(
  routeCode: string,
  opts: RequestOpts = {},
): Promise<OasaStop[]> {
  const data = await api<{ stops: OasaStop[] }>(
    'webGetRoutesDetailsAndStops',
    { p1: routeCode },
    'object',
    opts,
  );
  if (!data?.stops?.length) return [];
  return data.stops
    .slice()
    .sort((a, b) => Number(a.RouteStopOrder) - Number(b.RouteStopOrder));
}

/** Routes serving a specific stop. */
export const getRoutesForStop = (stopCode: string, opts: RequestOpts = {}) =>
  api<OasaRoute[]>('webRoutesForStop', { p1: stopCode }, 'array', opts);

/* ── Real-Time Endpoints ─────────────────────────────────────── */

/** Upcoming arrivals at a stop (route_code, veh_code, btime2 in minutes).
 *
 *  Note: this is a per-vehicle *predicted arrival profile*, not just "what's
 *  next". The same veh_code appears at every stop further along its route with
 *  a monotonically increasing btime2, out to a horizon of ~40 minutes. That
 *  makes live, traffic-aware ride times derivable — see rideTimeFromArrivals. */
export const getStopArrivals = (stopCode: string, opts: RequestOpts = {}) =>
  api<OasaArrival[]>('getStopArrivals', { p1: stopCode }, 'array', opts);

/**
 * Live ride time between two stops on the same route, in minutes.
 *
 * Finds a vehicle present in both stops' arrival profiles and subtracts its
 * predicted arrival times. This is measured and traffic-aware — vastly better
 * than estimating from straight-line distance. Returns null when no vehicle
 * currently spans both stops (outside the ~40 min prediction horizon, or no
 * service running), in which case the caller should fall back to an estimate.
 *
 * Picks the soonest-boarding common vehicle, and rejects non-positive spans
 * (which occur on circular routes where the first and last position share a
 * StopCode and therefore report identical btime2).
 */
export function rideTimeFromArrivals(
  boardArrivals: OasaArrival[],
  alightArrivals: OasaArrival[],
  routeCode: string,
): { rideMin: number; waitMin: number; vehCode: string } | null {
  const board = new Map<string, number>();
  for (const a of boardArrivals) {
    if (a.route_code !== routeCode) continue;
    const m = Number(a.btime2);
    if (!Number.isFinite(m)) continue;
    const prev = board.get(a.veh_code);
    if (prev === undefined || m < prev) board.set(a.veh_code, m);
  }
  if (board.size === 0) return null;

  let best: { rideMin: number; waitMin: number; vehCode: string } | null = null;
  for (const a of alightArrivals) {
    if (a.route_code !== routeCode) continue;
    const alightMin = Number(a.btime2);
    if (!Number.isFinite(alightMin)) continue;
    const boardMin = board.get(a.veh_code);
    if (boardMin === undefined) continue;
    const rideMin = alightMin - boardMin;
    if (rideMin <= 0) continue;
    if (best === null || boardMin < best.waitMin) {
      best = { rideMin, waitMin: boardMin, vehCode: a.veh_code };
    }
  }
  return best;
}

/** Live vehicle positions on a route. */
export const getBusLocations = (routeCode: string, opts: RequestOpts = {}) =>
  api<OasaBusLocation[]>('getBusLocation', { p1: routeCode }, 'array', opts);

/* ── Geo Endpoints ───────────────────────────────────────────── */

/** Closest stops to a lat/lng coordinate. */
export const getClosestStops = (lat: number, lng: number, opts: RequestOpts = {}) =>
  api<OasaNearbyStop[]>('getClosestStops', { p1: String(lat), p2: String(lng) }, 'array', opts);

/* ── Bulk / Offline Endpoints (undocumented) ─────────────────── */

/** All 9,000+ stops in the network — single call, ~2 MB JSON.
 *  Uses the undocumented `getAllStops` action (no params).
 *  Gets a longer timeout: the payload alone takes ~1s on a good connection. */
export const getAllStopsBulk = (opts: RequestOpts = {}) =>
  api<OasaBulkStop[]>('getAllStops', {}, 'array', { ...opts, timeoutMs: 45_000 });

/* ── Schedule Endpoints ──────────────────────────────────────── */

/** All lines with MasterLine info (ml_code, sdc_code mapping). */
export const getMLInfo = (opts: RequestOpts = {}) =>
  api<OasaMLInfo[]>('webGetLinesWithMLInfo', {}, 'array', opts);

/** Schedule departure times for a line (needs mlCode + sdcCode). */
export const getSchedLines = (mlCode: string, sdcCode: string, lineCode: string) =>
  api<OasaSchedLines>('getSchedLines', { p1: mlCode, p2: sdcCode, p3: lineCode }, 'object');

/** Today's schedule for a line — auto-selects weekday/Saturday/Sunday.
 *  Throws (rather than yielding []) on an empty or malformed body, so callers
 *  never persist a blank schedule over a good cached one. */
export const getDailySchedule = (lineCode: string, opts: RequestOpts = {}) =>
  api<OasaDailySchedule>('getDailySchedule', { line_code: lineCode }, 'object', opts);

/** True when a daily schedule actually carries departures. Guard every cache
 *  write with this — an object with two empty arrays is not worth persisting. */
export function isUsableSchedule(s: OasaDailySchedule | null | undefined): boolean {
  if (!s || typeof s !== 'object') return false;
  return (s.go?.length ?? 0) > 0 || (s.come?.length ?? 0) > 0;
}

/* ── Walking Route (Valhalla) ────────────────────────────────── */

export interface WalkingRoute {
  /** Walking duration in seconds. */
  durationSec: number;
  /** Walking distance in metres. */
  distanceM: number;
  /** GeoJSON LineString coordinates [[lng, lat], …]. */
  coords: [number, number][];
}

/**
 * Fetch optimal walking route between two points via the public Valhalla API.
 * Uses the pedestrian costing model — ignores one-way car restrictions, uses
 * sidewalks, crossings, and footpaths.
 * Returns null if the request fails or no route is found.
 */
export async function getWalkingRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  opts: RequestOpts = {},
): Promise<WalkingRoute | null> {
  try {
    const body = JSON.stringify({
      locations: [
        { lat: fromLat, lon: fromLng },
        { lat: toLat, lon: toLng },
      ],
      costing: 'pedestrian',
      units: 'km',
      shape_match: 'map_snap',
    });
    // This is a shared public OSM demo instance with no SLA — callers MUST
    // debounce and gate by distance, and pass a signal so superseded requests
    // are actually cancelled rather than racing to overwrite each other.
    const res = await fetchWithTimeout(
      'https://valhalla1.openstreetmap.de/route',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      8_000,
      opts.signal,
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.trip || !data.trip.legs || data.trip.legs.length === 0) return null;

    const leg = data.trip.legs[0];
    const durationSec = data.trip.summary.time;
    const distanceM = data.trip.summary.length * 1000; // length is in km

    // Decode Valhalla's encoded polyline (precision 6)
    const coords = decodePolyline(leg.shape, 6);

    return { durationSec, distanceM, coords };
  } catch {
    return null;
  }
}

/** Decode Google-style encoded polyline. precision=6 for Valhalla, 5 for OSRM/Google. */
function decodePolyline(encoded: string, precision: number): [number, number][] {
  const factor = Math.pow(10, precision);
  const result: [number, number][] = [];
  let lat = 0;
  let lng = 0;
  let index = 0;

  while (index < encoded.length) {
    let shift = 0;
    let b: number;
    let dlat = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      dlat |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += dlat & 1 ? ~(dlat >> 1) : dlat >> 1;

    shift = 0;
    let dlng = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      dlng |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += dlng & 1 ? ~(dlng >> 1) : dlng >> 1;

    // Return as [lng, lat] to match GeoJSON convention (swapped to [lat, lng] in caller)
    result.push([lng / factor, lat / factor]);
  }

  return result;
}
