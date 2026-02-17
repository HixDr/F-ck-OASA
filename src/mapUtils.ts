/**
 * Shared map utility functions used by all map screens.
 */

import { colors } from './theme';
import type { OasaLine, OasaRoute } from './types';

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
    lines.push({
      lineCode: r.LineCode,
      lineId: lineInfo?.LineID ?? r.LineCode,
      lineDescrEng: lineInfo?.LineDescrEng ?? lineInfo?.LineDescr ?? '',
      nextMin,
      color,
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
