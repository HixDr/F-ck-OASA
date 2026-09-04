/**
 * Shared map utility functions used by all map screens.
 */

import { arrival, colors } from '../../theme';
import type { OasaLine, OasaRoute } from '../../types';
import {
  ApiEmptyError, ApiParseError, ApiShapeError, ApiTimeoutError, ApiError, getStops,
} from '../../services/api';
import { getCachedStops } from '../../services/storage';
import { lngScaleAt } from '../../utils/geo';

/**
 * Turn a thrown API error into something worth showing on a map.
 *
 * `api()` throws typed errors now, so a persistent failure can finally be told
 * apart from "no buses running" — which is what the map used to render for both.
 */
export function describeApiError(err: unknown, what: string): string {
  if (err instanceof ApiTimeoutError) return `${what} timed out — check your connection`;
  if (err instanceof ApiParseError) return `${what} got an unreadable reply from OASA`;
  if (err instanceof ApiShapeError) return `${what} got an unexpected reply from OASA`;
  if (err instanceof ApiEmptyError) return `OASA returned nothing for ${what.toLowerCase()}`;
  if (err instanceof ApiError) return `${what} failed${err.status ? ` (${err.status})` : ''}`;
  return `${what} failed`;
}

/** Arrival time color — red (<= 2 min), amber (<= 5 min), green (> 5 min). */
export function getArrivalColor(minutes: number): string {
  if (minutes <= 2) return arrival.imminent;
  if (minutes <= 5) return arrival.soon;
  return arrival.later;
}

/* ── Geometry helpers for the map layer ──────────────────────── */

/** Metres per degree of latitude — near enough constant over one city. */
const M_PER_DEG_LAT = 111_320;

export interface PointLL { lat: number; lng: number }

/**
 * Ramer–Douglas–Peucker simplification with the tolerance expressed in metres.
 *
 * `getRouteDetails` hands back 300–1500 raw shape points per direction, all of
 * which end up as `<Polyline>` vertices and as candidate segments for every
 * bus snap. A 5–10 m tolerance drops a 1200-point Athens line to 200–300 with
 * no change anyone can see at city zoom levels.
 *
 * Iterative (explicit stack) rather than recursive — a pathological input
 * would otherwise blow the JS stack on a low-end device.
 */
export function simplifyPath<T extends PointLL>(points: T[], toleranceM = 8): T[] {
  const n = points.length;
  if (n < 3) return points;

  const lngScale = lngScaleAt(points[n >> 1].lat);
  const tolSq = toleranceM * toleranceM;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;

    const a = points[first];
    const b = points[last];
    const ax = a.lat * M_PER_DEG_LAT;
    const ay = a.lng * M_PER_DEG_LAT * lngScale;
    const dx = b.lat * M_PER_DEG_LAT - ax;
    const dy = b.lng * M_PER_DEG_LAT * lngScale - ay;
    const lenSq = dx * dx + dy * dy;

    let maxSq = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i].lat * M_PER_DEG_LAT - ax;
      const py = points[i].lng * M_PER_DEG_LAT * lngScale - ay;
      let t = lenSq > 0 ? (px * dx + py * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const dSq = ex * ex + ey * ey;
      if (dSq > maxSq) { maxSq = dSq; maxIdx = i; }
    }

    if (maxSq > tolSq && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  const out: T[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export interface RegionLike {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/**
 * True when a point falls inside the visible region, grown by `marginRatio`
 * of the region size so markers do not pop in exactly at the screen edge.
 */
export function isInRegion(
  lat: number,
  lng: number,
  region: RegionLike,
  marginRatio = 0.35,
): boolean {
  const latPad = (region.latitudeDelta / 2) * (1 + marginRatio);
  const lngPad = (region.longitudeDelta / 2) * (1 + marginRatio);
  return (
    Math.abs(lat - region.latitude) <= latPad &&
    Math.abs(lng - region.longitude) <= lngPad
  );
}

/**
 * Snap a coordinate to a grid of roughly `cellM` metres.
 *
 * Used as a react-query key for "stops near me". At 3 decimal places (~111 m)
 * every block walked minted a new key and re-ran a 9,382-stop distance sort on
 * the JS thread mid-pan. Nearby stops do not change meaningfully inside 500 m.
 */
export function coarseGrid(lat: number, lng: number, cellM = 500): { lat: number; lng: number } {
  const latStep = cellM / M_PER_DEG_LAT;
  const gLat = Math.round(lat / latStep) * latStep;
  // Derive the longitude step from the *quantized* latitude. Using the raw one
  // makes the step vary with every input, so the lattice shifts underfoot and
  // two points in the same cell can still produce different keys.
  const lngStep = latStep / Math.max(lngScaleAt(gLat), 0.1);
  return { lat: gLat, lng: Math.round(lng / lngStep) * lngStep };
}

export interface LineGroup {
  lineCode: string;
  /** The number on the front of the bus, or null when the catalogue does not
   *  name this LineCode. Never the LineCode itself — see `lineLabels.ts`. */
  lineId: string | null;
  lineDescrEng: string;
  nextMin: number | null;
  color: string;
  routeCode: string;
}

/**
 * Group routes by line, attach next arrival time and color.
 *
 * Returns the sorted line groups, a routeCode → lineCode map, and the
 * LineCodes the catalogue could not name. `unresolved` is reported rather than
 * acted on: this is a pure function, and the one thing it must never do is
 * invent a name by falling back to the code. `useCatalogueHeal` is what reacts
 * to it.
 */
export function buildLineGroups(
  routes: OasaRoute[],
  arrivals: Array<{ route_code: string; btime2: string }>,
  linesMap: Map<string, OasaLine>,
): { lines: LineGroup[]; routeToLine: Map<string, string>; unresolved: string[] } {
  const routeToLine = new Map<string, string>();
  routes.forEach((r) => routeToLine.set(r.RouteCode, r.LineCode));

  const lineMinMap = new Map<string, number>();
  (arrivals ?? []).forEach((a) => {
    const lineCode = routeToLine.get(a.route_code);
    if (lineCode) {
      const min = Number(a.btime2);
      const prev = lineMinMap.get(lineCode);
      if (prev === undefined || min < prev) lineMinMap.set(lineCode, min);
    }
  });

  const seenLines = new Set<string>();
  const lines: LineGroup[] = [];
  const unresolved: string[] = [];

  routes.forEach((r) => {
    if (seenLines.has(r.LineCode)) return;
    seenLines.add(r.LineCode);
    const lineInfo = linesMap.get(r.LineCode);
    const nextMin = lineMinMap.get(r.LineCode) ?? null;
    const color = nextMin != null ? getArrivalColor(nextMin) : colors.textMuted;
    // Prefer route description (direction-specific) over line description (generic)
    const rawDescr = r.RouteDescrEng || r.RouteDescr || lineInfo?.LineDescrEng || lineInfo?.LineDescr || '';
    const descr = rawDescr.replace(/ - /g, ' ► ');
    if (!lineInfo) unresolved.push(r.LineCode);
    lines.push({
      lineCode: r.LineCode,
      lineId: lineInfo?.LineID ?? null,
      lineDescrEng: descr,
      nextMin,
      color,
      routeCode: r.RouteCode,
    });
  });

  lines.sort((a, b) => {
    if (a.nextMin != null && b.nextMin != null) return a.nextMin - b.nextMin;
    if (a.nextMin != null) return -1;
    if (b.nextMin != null) return 1;
    return 0;
  });

  return { lines, routeToLine, unresolved };
}

/**
 * Enrich line groups with directional descriptions.
 * Replaces route description with "towards [destination]".
 * For circular routes, uses position to determine direction.
 * For non-circular, the destination is the route endpoint.
 */
export async function enrichWithDirectionHints(
  lines: LineGroup[],
  currentStopCode: string,
): Promise<LineGroup[]> {
  const enriched = await Promise.all(
    lines.map(async (line) => {
      try {
        // Try cache first (works offline), fall back to API
        const stops = await getCachedStops(line.routeCode) ?? await getStops(line.routeCode).catch(() => null);
        if (!stops || stops.length < 2) return line;

        // Get direction names from actual stop list (more reliable than parsing description)
        const isCircular = stops.length >= 4 && stops[0].StopCode === stops[stops.length - 1].StopCode;
        const startName = stops[0].StopDescrEng || stops[0].StopDescr || '';

        if (isCircular) {
          // For circular routes: extract midpoint name from description or use mid-route stop
          const rawDescr = line.lineDescrEng.replace(/ ► /g, ' - ');
          const parts = rawDescr.split(' - ').map((p) => p.trim());
          const midName = parts.length > 1 ? parts[parts.length - 1] : (stops[Math.floor(stops.length / 2)]?.StopDescrEng || '');

          const idx = stops.findIndex((s) => s.StopCode === currentStopCode);
          if (idx < 0) return line;
          const midpoint = Math.floor(stops.length / 2);
          const towards = idx < midpoint ? midName : startName;
          return { ...line, lineDescrEng: `to ${towards}` };
        } else {
          // Non-circular: heading toward the last stop
          const lastStop = stops[stops.length - 1];
          const endName = lastStop.StopDescrEng || lastStop.StopDescr || '';
          return { ...line, lineDescrEng: `to ${endName}` };
        }
      } catch {}
      return line;
    }),
  );
  return enriched;
}
