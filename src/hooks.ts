/**
 * React Query hooks for OASA data.
 */

import { useQuery } from '@tanstack/react-query';
import * as api from './api';
import { getCachedLines, setCachedLines, getCachedSchedule, setCachedSchedule, getCachedStops, setCachedStops, getCachedRoutes, setCachedRoutes, getCachedRoutesForStop, setCachedRoutesForStop, getAllCachedStops, isOfflineDataDownloaded } from './storage';
import type { OasaLine, OasaMLInfo, OasaDailySchedule, OasaNearbyStop, OasaRoute } from './types';

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

/** Real-time arrivals at a stop — polls every 15s. */
export function useArrivals(stopCode: string | undefined) {
  return useQuery({
    queryKey: ['arrivals', stopCode],
    queryFn: () => api.getStopArrivals(stopCode!),
    enabled: !!stopCode,
    refetchInterval: 15_000,
  });
}

/** Live bus positions on a route — polls every 10s. */
export function useBusLocations(routeCode: string | undefined) {
  return useQuery({
    queryKey: ['busLocations', routeCode],
    queryFn: () => api.getBusLocations(routeCode!),
    enabled: !!routeCode,
    refetchInterval: 10_000,
    retry: 0,
  });
}

/** Haversine distance in metres between two lat/lng points. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
        if (cached) {
          // Fire-and-forget refresh for next time (non-blocking)
          api.getDailySchedule(lineCode!).then((fresh) => {
            if (fresh) setCachedSchedule(lineCode!, fresh);
          }).catch(() => {});
          return cached;
        }
      }
      try {
        const fresh = await api.getDailySchedule(lineCode!);
        if (fresh) {
          setCachedSchedule(lineCode!, fresh);
        }
        return fresh;
      } catch (err) {
        // Offline fallback
        const cached = await getCachedSchedule(lineCode!);
        if (cached) return cached;
        throw err;
      }
    },
    enabled: !!lineCode,
    staleTime: 24 * 60 * 60 * 1000,
  });
}

