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

const BASES = [
  'https://telematics.oasa.gr/api/',
  'http://telematics.oasa.gr/api/',
] as const;
let _resolvedBase: string = BASES[0]; // default to HTTPS
const UA = 'OASALive/1.0 (personal telematics client)';

/**
 * Probe both HTTP and HTTPS endpoints at startup and lock onto whichever
 * responds successfully first. Prefers HTTPS. Call once at app boot.
 */
export async function probeApiBase(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const results = await Promise.allSettled(
      BASES.map(async (base) => {
        const res = await fetch(`${base}?act=webGetLines`, {
          method: 'GET',
          headers: { 'User-Agent': UA },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return base;
      }),
    );

    // Pick HTTPS if it succeeded, else HTTP, else keep default
    for (const r of results) {
      if (r.status === 'fulfilled') {
        _resolvedBase = r.value;
        break;
      }
    }
  } catch {
    // Both failed or aborted — keep HTTPS default
  } finally {
    clearTimeout(timeout);
  }
  console.log(`[api] Using base: ${_resolvedBase}`);
}

/** Return the currently resolved API base URL. */
export function getApiBase(): string {
  return _resolvedBase;
}

async function api<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ act: action, ...params }).toString();
  const url = `${_resolvedBase}?${qs}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
    },
  });

  if (!res.ok) {
    throw new Error(`OASA API ${action} → ${res.status}`);
  }

  const text = await res.text();
  if (!text || text === '""' || text === 'null') {
    return [] as unknown as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return [] as unknown as T;
  }
}

/* ── Static / Reference Endpoints ────────────────────────────── */

/** All 464 bus/trolley lines (~150 KB). */
export const getLines = () => api<OasaLine[]>('webGetLines');

/** Routes (directions) for a specific line. */
export const getRoutes = (lineCode: string) =>
  api<OasaRoute[]>('webGetRoutes', { p1: lineCode });

/** Ordered stops for a specific route. */
export const getStops = (routeCode: string) =>
  api<OasaStop[]>('webGetStops', { p1: routeCode });

/** Detailed route path (road-following polyline points) + stops. */
export async function getRouteDetails(routeCode: string): Promise<{ lat: number; lng: number }[]> {
  try {
    const data = await api<{ details: OasaRouteDetail[] }>('webGetRoutesDetailsAndStops', { p1: routeCode });
    if (!data || !data.details || data.details.length === 0) return [];
    return data.details
      .sort((a, b) => Number(a.routed_order) - Number(b.routed_order))
      .map((d) => ({ lat: parseFloat(d.routed_y), lng: parseFloat(d.routed_x) }));
  } catch {
    return [];
  }
}

/** Routes serving a specific stop. */
export const getRoutesForStop = (stopCode: string) =>
  api<OasaRoute[]>('webRoutesForStop', { p1: stopCode });

/* ── Real-Time Endpoints ─────────────────────────────────────── */

/** Upcoming arrivals at a stop (route_code, veh_code, btime2 in minutes). */
export const getStopArrivals = (stopCode: string) =>
  api<OasaArrival[]>('getStopArrivals', { p1: stopCode });

/** Live vehicle positions on a route. */
export const getBusLocations = (routeCode: string) =>
  api<OasaBusLocation[]>('getBusLocation', { p1: routeCode });

/* ── Geo Endpoints ───────────────────────────────────────────── */

/** Closest stops to a lat/lng coordinate. */
export const getClosestStops = (lat: number, lng: number) =>
  api<OasaNearbyStop[]>('getClosestStops', { p1: String(lat), p2: String(lng) });

/* ── Bulk / Offline Endpoints (undocumented) ─────────────────── */

/** All 9,000+ stops in the network — single call, ~2 MB JSON.
 *  Uses the undocumented `getAllStops` action (no params). */
export const getAllStopsBulk = () => api<OasaBulkStop[]>('getAllStops');

/* ── Schedule Endpoints ──────────────────────────────────────── */

/** All lines with MasterLine info (ml_code, sdc_code mapping). */
export const getMLInfo = () => api<OasaMLInfo[]>('webGetLinesWithMLInfo');

/** Schedule departure times for a line (needs mlCode + sdcCode). */
export const getSchedLines = (mlCode: string, sdcCode: string, lineCode: string) =>
  api<OasaSchedLines>('getSchedLines', { p1: mlCode, p2: sdcCode, p3: lineCode });

/** Today's schedule for a line — auto-selects weekday/Saturday/Sunday. */
export const getDailySchedule = (lineCode: string) =>
  api<OasaDailySchedule>('getDailySchedule', { line_code: lineCode });

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
    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
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
