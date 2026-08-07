/**
 * React Query hooks for OASA data.
 */

import { useQuery } from '@tanstack/react-query';
import * as api from '../services/api';
import { getCachedLines, setCachedLines, getCachedSchedule, setCachedSchedule, getCachedStops, setCachedStops, getCachedRoutes, setCachedRoutes, getCachedRoutesForStop, setCachedRoutesForStop, getAllCachedStops, isOfflineDataDownloaded } from '../services/storage';
import { haversineM } from '../utils/geo';
import type { OasaLine, OasaMLInfo, OasaDailySchedule, OasaNearbyStop, OasaRoute } from '../types';

/** How often live arrival data is refreshed, everywhere in the app. */
export const ARRIVALS_POLL_MS = 15_000;
/** How often live bus positions are refreshed. */
export const BUS_POLL_MS = 10_000;

/** All bus lines — backed by AsyncStorage cache with 24h TTL. */
export function useLines() {
  return useQuery<OasaLine[]>({
    queryKey: ['lines'],
    queryFn: async () => {
      const cached = await getCachedLines();
      if (cached) return cached;
      const fresh = await api.getLines();
      await setCachedLines(fresh);
      return fresh;
    },
    staleTime: 24 * 60 * 60 * 1000,
  });
}

/** Routes (directions) for a line — cached to file system for offline use. */
export function useRoutes(lineCode: string | undefined) {
  return useQuery<OasaRoute[]>({
    queryKey: ['routes', lineCode],
    queryFn: async () => {
      try {
        const fresh = await api.getRoutes(lineCode!);
        if (fresh && fresh.length > 0) {
          setCachedRoutes(lineCode!, fresh);
        }
        return fresh;
      } catch (err) {
        // Offline fallback
        const cached = await getCachedRoutes(lineCode!);
        if (cached) return cached;
        throw err;
      }
    },
    enabled: !!lineCode,
    staleTime: 60 * 60 * 1000,
  });
}

/** Stops on a route — cached to AsyncStorage for offline use. */
export function useStops(routeCode: string | undefined) {
  return useQuery({
    queryKey: ['stops', routeCode],
    queryFn: async () => {
      try {
        const fresh = await api.getStops(routeCode!);
        if (fresh && fresh.length > 0) {
          setCachedStops(routeCode!, fresh);
        }
        return fresh;
      } catch (err) {
        // Offline fallback
        const cached = await getCachedStops(routeCode!);
        if (cached) return cached;
        throw err;
      }
    },
    enabled: !!routeCode,
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Real-time arrivals at a stop.
 *
 * THIS IS THE ONLY SANCTIONED WAY TO POLL ARRIVALS. Do not hand-roll a
 * `setInterval` — doing so is what produced ~5,800 requests/hour, kept polling
 * while the app was backgrounded, and made pull-to-refresh impossible to wire
 * up. React Query gives request dedup across cards showing the same stop,
 * automatic pause when the screen is unfocused or the app is backgrounded
 * (via services/appState.ts), and a single `refetchQueries` refresh entry point.
 *
 * `dataUpdatedAt` from the returned result is the freshness timestamp the UI
 * should surface, so a silently failing poll is visible rather than a frozen
 * number the user trusts.
 */
export function useArrivals(stopCode: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['arrivals', stopCode],
    queryFn: ({ signal }) => api.getStopArrivals(stopCode!, { signal }),
    enabled: !!stopCode && enabled,
    refetchInterval: ARRIVALS_POLL_MS,
    // Never poll a backgrounded app.
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: 1,
    // Keep showing the last known arrivals while a refetch is in flight
    // instead of flashing a spinner every 15 seconds — but ONLY for the same
    // stop. A bare `(prev) => prev` also survives a queryKey change, which
    // means selecting a new stop briefly renders the PREVIOUS stop's arrival
    // times under the new stop's name. Wrong numbers presented confidently is
    // the one failure this app cannot afford.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey?.[1] === stopCode ? prev : undefined,
  });
}

/** Live bus positions on a route — polls every 10s. */
export function useBusLocations(routeCode: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['busLocations', routeCode],
    queryFn: ({ signal }) => api.getBusLocations(routeCode!, { signal }),
    enabled: !!routeCode && enabled,
    refetchInterval: BUS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: 0,
    // Same-route only — see the note on useArrivals. Showing one route's
    // vehicles on another route's map is worse than showing none.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey?.[1] === routeCode ? prev : undefined,
  });
}

/** Closest stops to a coordinate.
 *  When offline data is available, computes distances locally from cached stops
 *  instead of hitting the API, so it works without a network connection. */
export function useClosestStops(lat: number | undefined, lng: number | undefined) {
  return useQuery<OasaNearbyStop[]>({
    queryKey: ['closestStops', lat, lng],
    queryFn: async () => {
      // Prefer local computation when bulk stops are cached (fast + works offline)
      const allStops = await getAllCachedStops();
      if (allStops && allStops.length > 0) {
        const withDist = allStops.map((s) => ({
          StopCode: s.stop_code,
          StopID: s.stop_id,
          StopDescr: s.stop_descr,
          StopDescrEng: s.stop_descr_eng,
          StopLat: s.stop_lat,
          StopLng: s.stop_lng,
          distance: String(Math.round(haversineM(lat!, lng!, +s.stop_lat, +s.stop_lng))),
        }));
        withDist.sort((a, b) => +a.distance - +b.distance);
        return withDist.slice(0, 20) as OasaNearbyStop[];
      }
      // No cached stops — hit API
      return api.getClosestStops(lat!, lng!);
    },
    enabled: lat != null && lng != null,
    staleTime: 30_000,
  });
}

/** Routes serving a specific stop — cached to file system for offline use. */
export function useRoutesForStop(stopCode: string | undefined) {
  return useQuery<OasaRoute[]>({
    queryKey: ['routesForStop', stopCode],
    queryFn: async () => {
      try {
        const fresh = await api.getRoutesForStop(stopCode!);
        if (fresh && fresh.length > 0) {
          setCachedRoutesForStop(stopCode!, fresh);
        }
        return fresh;
      } catch (err) {
        const cached = await getCachedRoutesForStop(stopCode!);
        if (cached) return cached;
        throw err;
      }
    },
    enabled: !!stopCode,
    staleTime: 60 * 60 * 1000,
  });
}

/** MasterLine info for all lines — cached 24h. */
export function useMLInfo() {
  return useQuery<OasaMLInfo[]>({
    queryKey: ['mlInfo'],
    queryFn: () => api.getMLInfo(),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

/** Today's schedule for a line — uses getDailySchedule (auto weekday/Saturday/Sunday).
 *  Cached to AsyncStorage for offline use.
 *  When offline data has been downloaded, always returns cached schedule
 *  (skipping TTL) and only refreshes from network if possible. */
export function useSchedule(lineCode: string | undefined) {
  return useQuery<OasaDailySchedule>({
    queryKey: ['schedule', lineCode],
    queryFn: async () => {
      // When offline data has been pre-downloaded, prefer cache unconditionally
      if (isOfflineDataDownloaded()) {
        const cached = await getCachedSchedule(lineCode!);
        if (api.isUsableSchedule(cached)) {
          // Fire-and-forget refresh for next time (non-blocking)
          api.getDailySchedule(lineCode!).then((fresh) => {
            if (api.isUsableSchedule(fresh)) setCachedSchedule(lineCode!, fresh);
          }).catch(() => {});
          return cached!;
        }
      }
      try {
        const fresh = await api.getDailySchedule(lineCode!);
        // Only persist a schedule that actually carries departures. Writing a
        // blank one poisons the cache: it is truthy, so it wins over the real
        // data forever and the line silently shows no timetable again.
        if (api.isUsableSchedule(fresh)) setCachedSchedule(lineCode!, fresh);
        return fresh;
      } catch (err) {
        // Offline fallback
        const cached = await getCachedSchedule(lineCode!);
        if (api.isUsableSchedule(cached)) return cached!;
        throw err;
      }
    },
    enabled: !!lineCode,
    staleTime: 24 * 60 * 60 * 1000,
  });
}

