/**
 * Offline data download orchestrator.
 *
 * Downloads all stops (via undocumented `getAllStops`) and all schedules
 * (via `getDailySchedule` for every line) and caches them indefinitely.
 */

import { getLines, getAllStopsBulk, getDailySchedule, getRoutes, getStops, getRoutesForStop } from './api';
import type { OasaDailySchedule, OasaRoute, OasaStop } from '../types';
import {
  setCachedLines,
  setCachedSchedulesBulk,
  setCachedRoutesBulk,
  setCachedStopsBulk,
  setCachedRoutesForStopBulk,
  setAllCachedStops,
  setOfflineDataFlag,
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

/** Wraps a promise with a timeout. Rejects if the promise doesn't settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Small delay to avoid rate-limiting from the API. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Download all offline data with progress callbacks.
 * @param onProgress Called with each progress update.
 * @returns true if successful, false on error.
 */
export async function downloadAllOfflineData(
  onProgress: (p: OfflineProgress) => void,
): Promise<boolean> {
  try {
    // Phase 1: Lines
    console.log('[offline] Starting download…');
    onProgress({ phase: 'lines', current: 0, total: 1, message: 'Downloading lines…' });
    const lines = await getLines();
    if (!lines || lines.length === 0) throw new Error('Failed to fetch lines');
    await setCachedLines(lines);
    console.log(`[offline] Lines cached: ${lines.length}`);
    onProgress({ phase: 'lines', current: 1, total: 1, message: `${lines.length} lines cached` });

    // Phase 2: All Stops
    onProgress({ phase: 'stops', current: 0, total: 1, message: 'Downloading all stops…' });
    const stops = await getAllStopsBulk();
    if (!stops || stops.length === 0) throw new Error('Failed to fetch stops');
    await setAllCachedStops(stops);
    console.log(`[offline] Stops cached: ${stops.length}`);
    onProgress({ phase: 'stops', current: 1, total: 1, message: `${stops.length} stops cached` });

    // Phase 3: Routes + Stops for every line (10s timeout, 200ms delay between batches)
    const total = lines.length;
    const BATCH_SIZE = 16;
    const REQUEST_TIMEOUT = 10_000;
    const BATCH_DELAY = 200;
    let completed = 0;
    let failed = 0;
    const allRoutesDict: Record<string, OasaRoute[]> = {};
    const allStopsDict: Record<string, OasaStop[]> = {};
    const stopRoutesMap = new Map<string, OasaRoute[]>();

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (line) => {
          try {
            const routes = await withTimeout(getRoutes(line.LineCode), REQUEST_TIMEOUT);
            if (routes && routes.length > 0) {
              allRoutesDict[line.LineCode] = routes;
              // Fetch stops for each route + build stop-to-routes index
              await Promise.allSettled(
                routes.map(async (route) => {
                  try {
                    const routeStops = await withTimeout(getStops(route.RouteCode), REQUEST_TIMEOUT);
                    if (routeStops && routeStops.length > 0) {
                      allStopsDict[route.RouteCode] = routeStops;
                      for (const stop of routeStops) {
                        const existing = stopRoutesMap.get(stop.StopCode) || [];
                        if (!existing.some((r) => r.RouteCode === route.RouteCode)) {
                          existing.push(route);
                          stopRoutesMap.set(stop.StopCode, existing);
                        }
                      }
                    }
                  } catch {}
                }),
              );
            }
          } catch {
            failed++;
          }
        }),
      );
      completed += results.length;
      onProgress({
        phase: 'routes',
        current: completed,
        total,
        message: `Routes: ${completed}/${total}${failed > 0 ? ` (${failed} failed)` : ''}`,
      });
      if (i + BATCH_SIZE < total) await delay(BATCH_DELAY);
    }

    // Bulk-write routes + stops as consolidated files (single file per data type)
    console.log(`[offline] Writing ${Object.keys(allRoutesDict).length} routes, ${Object.keys(allStopsDict).length} route-stops…`);
    onProgress({ phase: 'routes', current: completed, total, message: 'Saving routes & stops…' });
    setCachedRoutesBulk(allRoutesDict);
    setCachedStopsBulk(allStopsDict);

    // Phase 4: Schedules for every line
    completed = 0;
    failed = 0;
    const allSchedulesDict: Record<string, OasaDailySchedule> = {};

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (line) => {
          try {
            const schedule = await withTimeout(getDailySchedule(line.LineCode), REQUEST_TIMEOUT);
            if (schedule) {
              allSchedulesDict[line.LineCode] = schedule;
            }
          } catch {
            failed++;
          }
        }),
      );
      completed += results.length;
      onProgress({
        phase: 'schedules',
        current: completed,
        total,
        message: `Schedules: ${completed}/${total}${failed > 0 ? ` (${failed} failed)` : ''}`,
      });
      if (i + BATCH_SIZE < total) await delay(BATCH_DELAY);
    }

    // Bulk-write schedules
    console.log(`[offline] Writing ${Object.keys(allSchedulesDict).length} schedules…`);
    setCachedSchedulesBulk(allSchedulesDict);

    // Phase 5: Build routes-for-stop index + pre-fetch for favorite stops
    const routesForStopDict: Record<string, OasaRoute[]> = {};
    for (const [k, v] of stopRoutesMap) routesForStopDict[k] = v;

    const favStops = getFavoriteStops();
    if (favStops.length > 0) {
      console.log(`[offline] Pre-caching routes for ${favStops.length} favorite stops…`);
      await Promise.allSettled(
        favStops.map(async (fav) => {
          try {
            const routes = await withTimeout(getRoutesForStop(fav.stopCode), REQUEST_TIMEOUT);
            if (routes && routes.length > 0) {
              routesForStopDict[fav.stopCode] = routes;
            }
          } catch {}
        }),
      );
    }

    // Bulk-write routes-for-stop index
    console.log(`[offline] Writing routes-for-stop index for ${Object.keys(routesForStopDict).length} stops…`);
    setCachedRoutesForStopBulk(routesForStopDict);

    // Mark as downloaded
    await setOfflineDataFlag(true);
    console.log(`[offline] Done! ${completed} schedules (${failed} failed)`);
    onProgress({ phase: 'done', current: total, total, message: 'All offline data saved!' });
    return true;
  } catch (err) {
    console.error('[offline] Download failed:', err);
    onProgress({
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
