/**
 * Shared schedule parsing utilities.
 * Extracted from FavoriteStopCard so the planner can reuse the same logic.
 */

import type { OasaDailySchedule } from '../types';

/** Parsed schedule info per line */
export interface LineSchedule {
  times: string[];
  nextDeparture: string | null;
  /** True when `nextDeparture` is tomorrow's first departure because today's
   *  service has finished. Callers must not present it as "coming up". */
  nextIsTomorrow: boolean;
}

/**
 * Minutes since midnight in Athens.
 *
 * OASA schedules are Europe/Athens; the device may not be. Using local time
 * silently produced wrong "next departure" values for anyone travelling, and
 * fed a wrong `nowMin` into the whole planner pipeline.
 */
export function athensNowMin(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Athens',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m;
  } catch {
    // Hermes without full ICU — fall through to device local time.
  }
  return now.getHours() * 60 + now.getMinutes();
}

/** Parse "HH:MM" into minutes since midnight, or null. */
export function hhmmToMin(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

/**
 * Parse schedule data into sorted HH:MM times and find next departure.
 *  direction: 'go' | 'come' — picks only the matching route direction.
 *  GO: sde_start1 from go entries (departure from terminus A)
 *  COME: sde_start2 from come entries (departure from terminus B)
 */
export function parseSchedule(
  data: OasaDailySchedule,
  direction: 'go' | 'come',
  nowMin: number = athensNowMin(),
): LineSchedule {
  let entries = direction === 'go' ? (data?.go ?? []) : (data?.come ?? []);
  // Circular routes: come is empty, all entries live in go with sde_start1 only
  const isCircular = (data?.come ?? []).length === 0;
  if (isCircular) {
    entries = data?.go ?? [];
    direction = 'go';
  }
  const times = new Set<string>();
  for (const e of entries) {
    // GO = departure from terminus A (sde_start1), COME = departure from terminus B (sde_start2)
    const field = direction === 'go' ? e.sde_start1 : e.sde_start2;
    if (!field) continue;
    const m = field.match(/(\d{2}):(\d{2})/);
    if (m) times.add(`${m[1]}:${m[2]}`);
  }
  // Sort numerically, not lexicographically, so after-midnight service times
  // ("24:30", "25:10") land after 23:xx instead of before 03:00.
  const sorted = [...times].sort((a, b) => (hhmmToMin(a) ?? 0) - (hhmmToMin(b) ?? 0));

  let next: string | null = null;
  for (const t of sorted) {
    const tMin = hhmmToMin(t);
    if (tMin != null && tMin >= nowMin) {
      next = t;
      break;
    }
  }

  const nextIsTomorrow = next === null && sorted.length > 0;
  return {
    times: sorted,
    nextDeparture: next ?? sorted[0] ?? null,
    nextIsTomorrow,
  };
}
