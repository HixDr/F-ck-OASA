/**
 * Offline data download orchestrator.
 *
 * Downloads all stops (via undocumented `getAllStops`) and all schedules
 * (via `getDailySchedule` for every line) and caches them indefinitely.
 */

import {
  getLines,
  getAllStopsBulk,
  getDailySchedule,
  getRoutes,
  getStops,
  getRoutesForStop,
  isUsableSchedule,
} from './api';
import type { OasaDailySchedule, OasaLine, OasaRoute, OasaStop } from '../types';
import {
  setCachedLines,
  setCachedSchedulesBulk,
  setCachedRoutesBulk,
  setCachedStopsBulk,
  setCachedRoutesForStopBulk,
  setAllCachedStops,
  setOfflineDataFlag,
  isOfflineDataDownloaded,
  clearOfflineData,
  getFavoriteStops,
} from './storage';

export interface OfflineProgress {
  phase: 'lines' | 'stops' | 'routes' | 'schedules' | 'done' | 'error';
  current: number;
  total: number;
  /** Human-readable status message. */
  message: string;
}

/* ── Tuning ──────────────────────────────────────────────────── */

/**
 * Lines processed at once. Each costs one `getRoutes` plus up to
 * `ROUTE_CONCURRENCY` `getStops` calls, so together these bound the download at
 * ~16 sockets. The inner `routes.map` used to be unbounded, which meant a batch
 * of 16 lines really opened 60-80 connections and OkHttp queued the rest.
 */
const LINE_BATCH = 8;
const ROUTE_CONCURRENCY = 2;
/** Schedules are one request per line, so a wider batch is still ~16 sockets. */
const SCHEDULE_BATCH = 16;
/** Breather between batches so the API doesn't start rate-limiting. */
const BATCH_DELAY = 200;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Distinguishes "the user closed the modal" from "the download broke". */
class DownloadCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'DownloadCancelled';
  }
}

/** Shared per-run state: cancellation plus a progress sink that goes quiet
 *  once aborted, so nothing calls back into an unmounted tree. */
interface Ctx {
  signal?: AbortSignal;
  report(p: OfflineProgress): void;
  stop(): void;
}

/** Run `worker` over `items` with at most `limit` promises in flight. */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runner = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

/* ── Phases ──────────────────────────────────────────────────── */

/** Phase 2. Returns the stop count and lets the ~2 MB array go out of scope —
 *  it is dead weight for the rest of the run. */
async function downloadAllStops(ctx: Ctx): Promise<number> {
  const stops = await getAllStopsBulk({ signal: ctx.signal });
  ctx.stop();
  if (stops.length === 0) throw new Error('The stop list came back empty');
  await setAllCachedStops(stops); // throws if the file write fails
  console.log(`[offline] Stops cached: ${stops.length}`);
  return stops.length;
}

/**
 * Phase 3: routes per line, then stops per route.
 *
 * Both consolidated files are written before returning so neither dict outlives
 * this call — holding routes, route-stops, the stop index and the schedules
 * dict simultaneously is what made peak RSS spike.
 * Returns the stop → routes index for the caller to persist.
 */
async function downloadRoutesAndStops(lines: OasaLine[], ctx: Ctx): Promise<Map<string, OasaRoute[]>> {
  const total = lines.length;
  const allRoutes: Record<string, OasaRoute[]> = {};
  const allStops: Record<string, OasaStop[]> = {};
  const stopRoutes = new Map<string, OasaRoute[]>();
  let done = 0;
  let lineFails = 0;
  let stopFails = 0;

  for (let i = 0; i < total; i += LINE_BATCH) {
    ctx.stop();
    await Promise.all(
      lines.slice(i, i + LINE_BATCH).map(async (line) => {
        try {
          const routes = await getRoutes(line.LineCode, { signal: ctx.signal });
          if (routes.length > 0) {
            allRoutes[line.LineCode] = routes;
            await mapLimit(routes, ROUTE_CONCURRENCY, async (route) => {
              try {
                const routeStops = await getStops(route.RouteCode, { signal: ctx.signal });
                if (routeStops.length === 0) return;
                allStops[route.RouteCode] = routeStops;
                for (const s of routeStops) {
                  const seen = stopRoutes.get(s.StopCode);
                  if (!seen) stopRoutes.set(s.StopCode, [route]);
                  else if (!seen.some((r) => r.RouteCode === route.RouteCode)) seen.push(route);
                }
              } catch {
                // Silently swallowed before, which is why the UI could report
                // "0 failed" over a download that fetched almost no stops.
                stopFails++;
              }
            });
          }
          done++;
        } catch {
          lineFails++;
        }
      }),
    );
    // `done` counts lines that actually came back — the old counter added the
    // batch length whether or not anything succeeded, so the bar reached 100%
    // on a download that had failed outright.
    let msg = `Routes: ${done}/${total}`;
    if (lineFails > 0) msg += ` (${lineFails} failed)`;
    if (stopFails > 0) msg += ` · ${stopFails} stop lists failed`;
    ctx.report({ phase: 'routes', current: done, total, message: msg });
    if (i + LINE_BATCH < total) await delay(BATCH_DELAY);
  }

  ctx.stop();
  ctx.report({ phase: 'routes', current: done, total, message: 'Saving routes & stops…' });
  console.log(`[offline] Writing ${Object.keys(allRoutes).length} routes, ${Object.keys(allStops).length} route-stops…`);
  if (!setCachedRoutesBulk(allRoutes)) throw new Error('Could not write the routes cache to disk');
  if (!setCachedStopsBulk(allStops)) throw new Error('Could not write the route-stops cache to disk');
  return stopRoutes;
}

/** Phase 4: invert the stop index and top it up with live lookups for the
 *  user's favourite stops (whose routes matter most and may be incomplete). */
async function writeRoutesForStopIndex(stopRoutes: Map<string, OasaRoute[]>, ctx: Ctx): Promise<void> {
  const dict: Record<string, OasaRoute[]> = {};
  for (const [code, routes] of stopRoutes) dict[code] = routes;

  const favStops = getFavoriteStops();
  if (favStops.length > 0) {
    console.log(`[offline] Pre-caching routes for ${favStops.length} favorite stops…`);
    await mapLimit(favStops, ROUTE_CONCURRENCY * 2, async (fav) => {
      try {
        const routes = await getRoutesForStop(fav.stopCode, { signal: ctx.signal });
        if (routes.length > 0) dict[fav.stopCode] = routes;
      } catch {}
    });
  }

  ctx.stop();
  console.log(`[offline] Writing routes-for-stop index for ${Object.keys(dict).length} stops…`);
  if (!setCachedRoutesForStopBulk(dict)) throw new Error('Could not write the routes-for-stop index to disk');
}

/** Phase 5: today's schedule for every line. */
async function downloadSchedules(lines: OasaLine[], ctx: Ctx): Promise<void> {
  const total = lines.length;
  const schedules: Record<string, OasaDailySchedule> = {};
  let done = 0;
  let failed = 0;
  let empty = 0;

  for (let i = 0; i < total; i += SCHEDULE_BATCH) {
    ctx.stop();
    await Promise.all(
      lines.slice(i, i + SCHEDULE_BATCH).map(async (line) => {
        try {
          const schedule = await getDailySchedule(line.LineCode, { signal: ctx.signal });
          // An object with two empty arrays is truthy, so caching it would
          // shadow a good copy forever. Not worth a slot.
          if (isUsableSchedule(schedule)) {
            schedules[line.LineCode] = schedule;
            done++;
          } else {
            empty++;
          }
        } catch {
          failed++;
        }
      }),
    );
    ctx.report({
      phase: 'schedules',
      current: done,
      total,
      message: `Schedules: ${done}/${total}${failed > 0 ? ` (${failed} failed)` : ''}`,
    });
    if (i + SCHEDULE_BATCH < total) await delay(BATCH_DELAY);
  }

  ctx.stop();
  console.log(`[offline] Writing ${done} schedules (${failed} failed, ${empty} empty)…`);
  if (!setCachedSchedulesBulk(schedules)) throw new Error('Could not write the schedules cache to disk');
}

/* ── Orchestrator ────────────────────────────────────────────── */

/**
 * Download all offline data with progress callbacks.
 * @param onProgress Called with each progress update. Stops firing once aborted.
 * @param opts.signal Abort to cancel; in-flight requests are torn down with it.
 * @returns true only when every phase reached disk.
 */
export async function downloadAllOfflineData(
  onProgress: (p: OfflineProgress) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const { signal } = opts;
  const ctx: Ctx = {
    signal,
    report: (p) => { if (!signal?.aborted) onProgress(p); },
    stop: () => { if (signal?.aborted) throw new DownloadCancelled(); },
  };

  // A re-download rewrites the consolidated files in place. Drop the flag up
  // front so a crash halfway through can't leave it claiming a complete bundle
  // over half-replaced files; it goes back on only once everything has landed.
  if (isOfflineDataDownloaded()) await setOfflineDataFlag(false).catch(() => {});

  try {
    ctx.stop();
    console.log('[offline] Starting download…');

    // Phase 1: Lines
    ctx.report({ phase: 'lines', current: 0, total: 1, message: 'Downloading lines…' });
    const lines = await getLines();
    ctx.stop();
    if (lines.length === 0) throw new Error('The line catalogue came back empty');
    await setCachedLines(lines);
    console.log(`[offline] Lines cached: ${lines.length}`);
    ctx.report({ phase: 'lines', current: 1, total: 1, message: `${lines.length} lines cached` });

    // Phase 2: All stops
    ctx.report({ phase: 'stops', current: 0, total: 1, message: 'Downloading all stops…' });
    const stopCount = await downloadAllStops(ctx);
    ctx.report({ phase: 'stops', current: 1, total: 1, message: `${stopCount} stops cached` });

    // Phases 3-4: routes, route-stops, and the stop → routes index. The index
    // is written (and freed) before schedules start so the two never overlap.
    const stopRoutes = await downloadRoutesAndStops(lines, ctx);
    await writeRoutesForStopIndex(stopRoutes, ctx);
    stopRoutes.clear();

    // Phase 5: schedules
    await downloadSchedules(lines, ctx);

    // Only now is the bundle genuinely complete on disk.
    await setOfflineDataFlag(true);
    console.log('[offline] Done!');
    ctx.report({ phase: 'done', current: lines.length, total: lines.length, message: 'All offline data saved!' });
    return true;
  } catch (err) {
    if (err instanceof DownloadCancelled || signal?.aborted) {
      console.log('[offline] Download cancelled');
      return false;
    }
    console.error('[offline] Download failed:', err);
    // Whatever landed stays as ordinary best-effort cache and the flag stays
    // clear, so the runtime writers keep filling gaps and a retry is possible.
    await setOfflineDataFlag(false).catch(() => {});
    ctx.report({
      phase: 'error',
      current: 0,
      total: 0,
      message: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
    return false;
  }
}

/** Clear all offline data and reset the flag. */
export async function removeAllOfflineData(): Promise<void> {
  await clearOfflineData();
}
