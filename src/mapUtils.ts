/**
 * Shared map utility functions used by all map screens.
 */

import { colors } from './theme';
import type { OasaLine, OasaRoute } from './types';
import { getStops } from './api';

/** Arrival time color — red (<= 2 min), amber (<= 5 min), green (> 5 min). */
export function getArrivalColor(minutes: number): string {
  if (minutes <= 2) return '#F44336';
  if (minutes <= 5) return '#F59E0B';
  return '#22C55E';
}

export interface LineGroup {
  lineCode: string;
  lineId: string;
  lineDescrEng: string;
  nextMin: number | null;
  color: string;
  routeCode: string;
}

/**
 * Group routes by line, attach next arrival time and color.
 * Returns sorted line groups and a routeCode → lineCode map.
 */
export function buildLineGroups(
  routes: OasaRoute[],
  arrivals: Array<{ route_code: string; btime2: string }>,
  linesMap: Map<string, OasaLine>,
): { lines: LineGroup[]; routeToLine: Map<string, string> } {
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

  routes.forEach((r) => {
    if (seenLines.has(r.LineCode)) return;
    seenLines.add(r.LineCode);
    const lineInfo = linesMap.get(r.LineCode);
    const nextMin = lineMinMap.get(r.LineCode) ?? null;
    const color = nextMin != null ? getArrivalColor(nextMin) : colors.textMuted;
    // Prefer route description (direction-specific) over line description (generic)
    const rawDescr = r.RouteDescrEng || r.RouteDescr || lineInfo?.LineDescrEng || lineInfo?.LineDescr || '';
    const descr = rawDescr.replace(/ - /g, ' ► ');
    lines.push({
      lineCode: r.LineCode,
      lineId: lineInfo?.LineID ?? r.LineCode,
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

  return { lines, routeToLine };
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
        const stops = await getStops(line.routeCode);
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
