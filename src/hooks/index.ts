/**
 * React Query hooks for OASA data.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  focusManager,
  onlineManager,
  useIsFetching,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
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

/* ── The shared arrivals clock ───────────────────────────────── */

/**
 * One clock for every arrivals query in the app.
 *
 * A per-query `refetchInterval` starts when its card mounts, so N saved stops
 * meant N independent 15-second clocks at N different phases — which makes any
 * single "next refresh in 4s" on screen a lie, and adds another phase every
 * time a scroll mounts one more card.
 *
 * Pausing is not reinvented here. `focusManager` (driven from AppState by
 * services/appState.ts) and `onlineManager` (driven from NetInfo by
 * services/network.ts) are the same two gates `refetchIntervalInBackground:
 * false` and `networkMode: 'online'` consulted, so the clock reads them
 * directly rather than opening a second AppState listener. It parks while
 * either says no; coming back is React Query's job, since `refetchOnWindowFocus`
 * and `refetchOnReconnect` already refetch on those transitions.
 */
let _clockTimer: ReturnType<typeof setTimeout> | null = null;
/** Wall-clock ms of the next tick. 0 while parked — the countdown reads this. */
let _clockDueAt = 0;
/** Live `useArrivals` consumers. No consumers, no clock. */
let _clockWatchers = 0;
let _clockClient: QueryClient | null = null;
let _clockBridged = false;
const _clockSubs = new Set<() => void>();

function clockSet(dueAt: number): void {
  if (_clockDueAt === dueAt) return;
  _clockDueAt = dueAt;
  for (const fn of _clockSubs) fn();
}

/** Bring the timer in line with the gates. Idempotent, and the only place the
 *  timer is armed or cleared. */
function clockSync(): void {
  const run = _clockWatchers > 0 && focusManager.isFocused() && onlineManager.isOnline();
  if (!run) {
    if (_clockTimer) {
      clearTimeout(_clockTimer);
      _clockTimer = null;
    }
    clockSet(0);
    return;
  }
  if (_clockTimer) return;
  _clockTimer = setTimeout(clockTick, ARRIVALS_POLL_MS);
  clockSet(Date.now() + ARRIVALS_POLL_MS);
}

function clockTick(): void {
  _clockTimer = null;
  /* Gates re-read rather than trusted: a timer armed a moment before the app
     was backgrounded still fires. */
  if (_clockWatchers > 0 && focusManager.isFocused() && onlineManager.isOnline()) {
    /* `type: 'active'` reproduces the old scope exactly — a `refetchInterval`
       only ran for a query something was observing with `enabled` true, so a
       stop the map screen left behind in the cache is not polled for nobody.
       `cancelRefetch: false` matters on a bad connection: the default would
       cancel and restart a request still in flight, so a fetch slower than the
       interval could never finish. */
    _clockClient
      ?.refetchQueries({ queryKey: ['arrivals'], type: 'active' }, { cancelRefetch: false })
      .catch(() => {
        // Per-stop failure is surfaced on the card; the clock keeps its cadence.
      });
  }
  clockSync();
}

/** Join the clock for as long as this consumer actually wants live data. */
function useArrivalsClock(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    _clockClient = client;
    if (!_clockBridged) {
      _clockBridged = true;
      focusManager.subscribe(clockSync);
      onlineManager.subscribe(clockSync);
    }
    _clockWatchers += 1;
    clockSync();
    return () => {
      _clockWatchers -= 1;
      if (_clockWatchers === 0) clockSync();
    };
  }, [client, enabled]);
}

function subscribeClock(fn: () => void): () => void {
  _clockSubs.add(fn);
  return () => {
    _clockSubs.delete(fn);
  };
}

function readClock(): number {
  return _clockDueAt;
}

/** Wall-clock ms of the next shared arrivals refresh, or 0 while the clock is
 *  parked (backgrounded, offline, or nothing on screen wants arrivals). */
export function useArrivalsPollAt(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}

/**
 * Real-time arrivals at a stop.
 *
 * THIS IS THE ONLY SANCTIONED WAY TO POLL ARRIVALS. Do not hand-roll a
 * `setInterval` — doing so is what produced ~5,800 requests/hour, kept polling
 * while the app was backgrounded, and made pull-to-refresh impossible to wire
 * up. React Query gives request dedup across cards showing the same stop, and a
 * single `refetchQueries` refresh entry point; the shared clock above gives one
 * cadence for the whole app, paused while the app is backgrounded or offline.
 *
 * `dataUpdatedAt` from the returned result is the freshness timestamp the UI
 * should surface, so a silently failing poll is visible rather than a frozen
 * number the user trusts.
 */
export function useArrivals(stopCode: string | undefined, enabled = true) {
  const on = !!stopCode && enabled;
  useArrivalsClock(on);
  return useQuery({
    queryKey: ['arrivals', stopCode],
    queryFn: ({ signal }) => api.getStopArrivals(stopCode!, { signal }),
    enabled: on,
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

export interface ArrivalsStatus {
  /** Oldest successful response across the given stops; 0 before any lands. */
  updatedAt: number;
  /** Stops whose most recent arrivals request failed. */
  failing: number;
  /** A request is in flight somewhere. */
  fetching: boolean;
}

function readStatus(client: QueryClient, codes: string[]): { updatedAt: number; failing: number } {
  let updatedAt = 0;
  let failing = 0;
  for (const code of codes) {
    const st = client.getQueryState(['arrivals', code]);
    if (!st) continue;
    if (st.status === 'error') failing += 1;
    /* The *oldest* stop, not the newest: "everything you can see is at least
       this fresh". A maximum would let one stalled stop hide behind the
       neighbour that refreshed a second ago. */
    else if (st.dataUpdatedAt > 0 && (updatedAt === 0 || st.dataUpdatedAt < updatedAt)) {
      updatedAt = st.dataUpdatedAt;
    }
  }
  return { updatedAt, failing };
}

/**
 * Freshness of the arrivals the user is currently looking at, summarised over
 * `stopCodes` — the one indicator on Home is built from this.
 *
 * Scoped to the given codes on purpose: the map screens also populate
 * `['arrivals', …]` for stops nobody has saved, and a stop seen once in a sheet
 * must not decide what Home says about the saved list.
 *
 * `getQueryCache()` is a plain read, so the cache subscription is what makes
 * this reactive; `useIsFetching` already is.
 */
export function useArrivalsStatus(stopCodes: string[]): ArrivalsStatus {
  const client = useQueryClient();
  const fetching = useIsFetching({ queryKey: ['arrivals'] }) > 0;
  // A primitive dep, so a freshly mapped array of the same codes is not a change.
  const key = stopCodes.join('|');
  const [snap, setSnap] = useState(() => readStatus(client, stopCodes));

  useEffect(() => {
    const codes = key ? key.split('|') : [];
    const read = () =>
      setSnap((prev) => {
        const next = readStatus(client, codes);
        return prev.updatedAt === next.updatedAt && prev.failing === next.failing ? prev : next;
      });
    read();
    return client.getQueryCache().subscribe(read);
  }, [client, key]);

  return { updatedAt: snap.updatedAt, failing: snap.failing, fetching };
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

