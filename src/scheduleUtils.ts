/**
 * Shared schedule parsing utilities.
 * Extracted from FavoriteStopCard so the planner can reuse the same logic.
 */

import type { OasaDailySchedule } from './types';

/** Parsed schedule info per line */
export interface LineSchedule {
  times: string[];
  nextDeparture: string | null;
}

/**
 * Parse schedule data into sorted HH:MM times and find next departure.
 *  direction: 'go' | 'come' — picks only the matching route direction.
 *  GO: sde_start1 from go entries (departure from terminus A)
 *  COME: sde_start2 from come entries (departure from terminus B)
 */
export function parseSchedule(data: OasaDailySchedule, direction: 'go' | 'come'): LineSchedule {
  let entries = direction === 'go' ? (data.go ?? []) : (data.come ?? []);
  // Circular routes: come is empty, all entries live in go with sde_start1 only
  const isCircular = (data.come ?? []).length === 0;
  if (isCircular) { entries = data.go ?? []; direction = 'go'; }
  const times = new Set<string>();
  for (const e of entries) {
    // GO = departure from terminus A (sde_start1), COME = departure from terminus B (sde_start2)
    const field = direction === 'go' ? e.sde_start1 : e.sde_start2;
    if (!field) continue;
    const m = field.match(/(\d{2}):(\d{2})/);
    if (m) times.add(`${m[1]}:${m[2]}`);
  }
  const sorted = [...times].sort();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let next: string | null = null;
  for (const t of sorted) {
    const [h, m] = t.split(':').map(Number);
    if (h * 60 + m >= nowMin) { next = t; break; }
  }
  return { times: sorted, nextDeparture: next ?? sorted[0] ?? null };
}
