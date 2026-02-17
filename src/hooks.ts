/**
 * React Query hooks for OASA data.
 */

import { useQuery } from '@tanstack/react-query';
import * as api from './api';
import { getCachedLines, setCachedLines, getCachedSchedule, setCachedSchedule, getCachedStops, setCachedStops } from './storage';
import type { OasaLine, OasaMLInfo } from './types';

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

/** Routes (directions) for a line. */
export function useRoutes(lineCode: string | undefined) {
  return useQuery({
    queryKey: ['routes', lineCode],
    queryFn: () => api.getRoutes(lineCode!),
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
  });
}

/** Closest stops to a coordinate — refetches when position changes. */
export function useClosestStops(lat: number | undefined, lng: number | undefined) {
  return useQuery({
    queryKey: ['closestStops', lat, lng],
    queryFn: () => api.getClosestStops(lat!, lng!),
    enabled: lat != null && lng != null,
    staleTime: 30_000,
  });
}

/** Routes serving a specific stop. */
export function useRoutesForStop(stopCode: string | undefined) {
  return useQuery({
    queryKey: ['routesForStop', stopCode],
    queryFn: () => api.getRoutesForStop(stopCode!),
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

/** Schedule for a specific line — cached to AsyncStorage for offline use. */
export function useSchedule(
  mlCode: string | undefined,
  sdcCode: string | undefined,
  lineCode: string | undefined,
) {
  return useQuery({
    queryKey: ['schedule', mlCode, sdcCode, lineCode],
    queryFn: async () => {
      try {
        const fresh = await api.getSchedLines(mlCode!, sdcCode!, lineCode!);
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
    enabled: !!mlCode && !!sdcCode && !!lineCode,
    staleTime: 24 * 60 * 60 * 1000,
  });
}

