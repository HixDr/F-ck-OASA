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
import { getCachedLines, setCachedLines, getCachedSchedule, setCachedSchedule, getCachedStops, setCachedStops, getCachedRoutes, setCachedRoutes, getCachedRoutesForStop, setCachedRoutesForStop, getCachedArrivals, setCachedArrivals, getAllCachedStops, isOfflineDataDownloaded } from '../services/storage';
import { isOnlineConfirmed } from '../services/network';
import { haversineM } from '../utils/geo';
import type { OasaArrival, OasaLine, OasaMLInfo, OasaDailySchedule, OasaNearbyStop, OasaRoute } from '../types';

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
    /* offlineFirst, not the global 'online': this serves from the file cache
       inside queryFn, and 'online' pauses the query so that cache is never
       reached. Going offline used to strand the line map on "Loading
       directions…" with a full offline bundle sitting on disk. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
  });
}

/**
 * Retry policy for the `offlineFirst` queries below.
 *
 * `offlineFirst` runs queryFn once and then *pauses* retries. On a cache hit
 * that is exactly right. On a cache miss while offline the request fails and
 * the retry parks, which leaves the query `status: 'pending'` with `error:
 * null` and `data: undefined` — indistinguishable from still loading. The line
 * map read that as "Loading directions…" and sat there forever.
 *
 * Failing fast while offline turns that into a real error the screen can
 * report, with the Retry the user actually needs.
 */
function retryUnlessOffline(failureCount: number): boolean {
  /* `isOnlineConfirmed`, not `onlineManager.isOnline()`. The latter is
     optimistic until NetInfo answers, so on a cold start with the radio
     already off the first failure still looks online, a retry is scheduled,
     and *that* retry parks once the truth arrives — the query then sits
     `pending` with no error and no data, which the map reads as still
     loading. Unknown connectivity counts as offline for retry purposes. */
  return isOnlineConfirmed() && failureCount < 2;
}

const ROUTES_STALE_MS = 60 * 60 * 1000;
/** Route topology changes about never, and the file cache is the offline story.
 *  The global 5-minute gcTime would otherwise evict these between screen opens
 *  and defeat their staleTime entirely. */
const STATIC_GC_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch a line's routes: cache first, then revalidate.
 *
 * This used to be network-first, consulting the file cache only inside `catch`
 * — so a user carrying the entire offline bundle still waited on a live request
 * before the map could do anything, and this request gates the whole screen:
 * nothing else can start until a route code exists.
 *
 * The revalidation is deliberately fire-and-forget. Its result reaches the UI
 * through `setQueryData`, and a failure is not worth surfacing when correct data
 * is already on screen.
 *
 * Shared by the hook and by `usePrefetchLine`, so both paths cache alike.
 */
function routesQueryFn(lineCode: string, queryClient: QueryClient) {
  return async (): Promise<OasaRoute[]> => {
    const cached = await getCachedRoutes(lineCode);
    if (cached && cached.length > 0) {
      api.getRoutes(lineCode)
        .then((fresh) => {
          if (!fresh || fresh.length === 0) return;
          setCachedRoutes(lineCode, fresh);
          queryClient.setQueryData(['routes', lineCode], fresh);
        })
        .catch(() => { /* Cached routes are already showing. */ });
      return cached;
    }
    const fresh = await api.getRoutes(lineCode);
    if (fresh && fresh.length > 0) setCachedRoutes(lineCode, fresh);
    return fresh;
  };
}

export function useRoutes(lineCode: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery<OasaRoute[]>({
    queryKey: ['routes', lineCode],
    queryFn: routesQueryFn(lineCode!, queryClient),
    enabled: !!lineCode,
    staleTime: ROUTES_STALE_MS,
    gcTime: STATIC_GC_MS,
    /* offlineFirst, not the global 'online': this serves from the file cache
       inside queryFn, and 'online' pauses the query so that cache is never
       reached. Going offline used to strand the line map on "Loading
       directions…" with a full offline bundle sitting on disk. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
  });
}

/**
 * Warm a line's routes before its map mounts.
 *
 * Opening a line is a two-stage waterfall: nothing — stops, buses, the drawn
 * shape — can start until the route list names a route code. Firing that first
 * request from the tap instead of from the screen overlaps it with the push
 * transition, which is most of the gap.
 *
 * `prefetchQuery` respects `staleTime`, so a line opened twice costs one
 * request, and it resolves quietly: a failure here just means the screen fetches
 * normally.
 */
export function usePrefetchLine(): (lineCode: string) => void {
  const queryClient = useQueryClient();
  return (lineCode: string) => {
    if (!lineCode) return;
    queryClient.prefetchQuery({
      queryKey: ['routes', lineCode],
      queryFn: routesQueryFn(lineCode, queryClient),
      staleTime: ROUTES_STALE_MS,
      gcTime: STATIC_GC_MS,
    }).catch(() => { /* The map will fetch it itself. */ });
  };
}

/** Stops on a route. Cache-first then revalidate, for the reasons in `useRoutes`. */
export function useStops(routeCode: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['stops', routeCode],
    queryFn: async () => {
      const cached = await getCachedStops(routeCode!);
      if (cached && cached.length > 0) {
        api.getStops(routeCode!)
          .then((fresh) => {
            if (!fresh || fresh.length === 0) return;
            setCachedStops(routeCode!, fresh);
            queryClient.setQueryData(['stops', routeCode], fresh);
          })
          .catch(() => { /* Cached stops are already on the map. */ });
        return cached;
      }
      const fresh = await api.getStops(routeCode!);
      if (fresh && fresh.length > 0) setCachedStops(routeCode!, fresh);
      return fresh;
    },
    enabled: !!routeCode,
    staleTime: ROUTES_STALE_MS,
    gcTime: STATIC_GC_MS,
    /* offlineFirst, not the global 'online': this serves from the file cache
       inside queryFn, and 'online' pauses the query so that cache is never
       reached. Going offline used to strand the line map on "Loading
       directions…" with a full offline bundle sitting on disk. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
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

/* ── Where a stop's arrivals came from ───────────────────────── */

/**
 * stopCode → the wall-clock ms at which the arrivals now held for it were seen
 * on the network. An entry exists *only* while the last serve came off disk.
 *
 * React Query stamps `dataUpdatedAt` when the `queryFn` resolves, which for a
 * disk serve is now. A UI that decays arrival estimates from `dataUpdatedAt` —
 * as the saved-stop cards do — would therefore render a twenty-minute-old
 * "5 min" as a fresh "5 min": a confident lie about a bus that already left.
 * The disk entry carries the original observation time, and this is how it
 * reaches the components that do the decay maths.
 *
 * Absence rather than a duplicate timestamp marks the network case, so
 * "did this come off disk?" is an exact question with no epsilon in it.
 */
const _observedAt = new Map<string, number>();

export interface ArrivalsOrigin {
  /** When these numbers were actually observed. 0 before any have landed. */
  observedAt: number;
  /** They were read back from disk because the network could not be reached. */
  fromCache: boolean;
}

const NO_ARRIVALS_ORIGIN: ArrivalsOrigin = { observedAt: 0, fromCache: false };

/**
 * Provenance of the arrivals currently held for `stopCode`.
 *
 * Pass the query's own `dataUpdatedAt`: that is the reactive value, so reading
 * the registry beside it during render is safe and always describes the result
 * being rendered — the registry is written before the `queryFn` promise
 * resolves, and the only thing that resolution can do is re-render.
 *
 * Use `observedAt` wherever `dataUpdatedAt` would have been used to talk about
 * freshness. It is the same number on the network path.
 */
export function arrivalsOrigin(stopCode: string | undefined, dataUpdatedAt: number): ArrivalsOrigin {
  if (!stopCode || !dataUpdatedAt) return NO_ARRIVALS_ORIGIN;
  const observed = _observedAt.get(stopCode);
  return observed == null
    ? { observedAt: dataUpdatedAt, fromCache: false }
    : { observedAt: observed, fromCache: true };
}

/**
 * Serve a stop's last-known arrivals from disk, or null if there is nothing
 * worth serving.
 *
 * Vehicles whose estimate has already run out are dropped rather than left to
 * be clamped at zero by the UI. `buildLineGroups` shows the *soonest* vehicle
 * per line, so a bus that was due eight minutes ago would pin the whole line at
 * "now" for as long as we held it — and hide the one that is genuinely still
 * coming. The surviving estimates are returned untouched: they are decayed once,
 * in the UI, against `observedAt`.
 */
async function servedFromCache(stopCode: string): Promise<OasaArrival[] | null> {
  const cached = await getCachedArrivals(stopCode);
  if (!cached || cached.arrivals.length === 0) return null;
  const elapsedMin = Math.floor((Date.now() - cached.ts) / 60_000);
  const due = cached.arrivals.filter((a) => {
    const min = Number(a.btime2);
    return Number.isFinite(min) && min - elapsedMin >= 0;
  });
  if (due.length === 0) return null;
  _observedAt.set(stopCode, cached.ts);
  return due;
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
 * Every success is written to disk, and a failed request falls back to it, so
 * losing signal keeps the last numbers on screen instead of blanking the saved
 * stops. Ask `arrivalsOrigin` — not `dataUpdatedAt` — for the freshness
 * timestamp to surface: a disk serve resolves *now*, and the difference between
 * the two is the difference between a countdown and a fabrication.
 */
export function useArrivals(stopCode: string | undefined, enabled = true) {
  const on = !!stopCode && enabled;
  useArrivalsClock(on);
  return useQuery({
    queryKey: ['arrivals', stopCode],
    queryFn: async ({ signal }) => {
      try {
        const fresh = await api.getStopArrivals(stopCode!, { signal });
        // Absence is what marks this as live — see `_observedAt`.
        _observedAt.delete(stopCode!);
        setCachedArrivals(stopCode!, fresh);
        return fresh;
      } catch (err) {
        // A cancelled request is not a failed one: the caller superseded it,
        // and answering it with disk contents would install a result React
        // Query was told to throw away.
        if (signal.aborted) throw err;
        const cached = await servedFromCache(stopCode!);
        if (!cached) throw err;
        return cached;
      }
    },
    enabled: on,
    staleTime: 5_000,
    /* offlineFirst, not the global 'online': the disk fallback lives inside
       queryFn, and 'online' pauses the query before it runs, so going offline
       emptied every saved-stop card of the numbers that were on screen a
       moment earlier. The shared clock still parks while offline — this only
       decides what happens when something does ask. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
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
  /** Oldest successful response across the given stops; 0 before any lands.
   *  When it was *observed* — a stop being served from disk keeps ageing here
   *  rather than looking brand new on every read. */
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
    else {
      /* `observedAt`, never `dataUpdatedAt`: a stop served from disk resolved
         a millisecond ago, and taking that at face value is what would let the
         header say "Live" over half-hour-old numbers. */
      const { observedAt } = arrivalsOrigin(code, st.dataUpdatedAt);
      /* The *oldest* stop, not the newest: "everything you can see is at least
         this fresh". A maximum would let one stalled stop hide behind the
         neighbour that refreshed a second ago. */
      if (observedAt > 0 && (updatedAt === 0 || observedAt < updatedAt)) updatedAt = observedAt;
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
    /* offlineFirst, not the global 'online': this serves from the file cache
       inside queryFn, and 'online' pauses the query so that cache is never
       reached. Going offline used to strand the line map on "Loading
       directions…" with a full offline bundle sitting on disk. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
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
/**
 * A line's timetable.
 *
 * `enabled` exists because the Live map used to fetch this on every open
 * although its timetable overlay defaults to off, and nothing else needs a
 * departure time until a stop is tapped.
 */
export function useSchedule(lineCode: string | undefined, enabled = true) {
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
    enabled: !!lineCode && enabled,
    staleTime: 24 * 60 * 60 * 1000,
    /* offlineFirst, not the global 'online': this serves from the file cache
       inside queryFn, and 'online' pauses the query so that cache is never
       reached. Going offline used to strand the line map on "Loading
       directions…" with a full offline bundle sitting on disk. */
    networkMode: 'offlineFirst',
    retry: retryUnlessOffline,
    // A timetable is valid for the day; the global 5-minute gcTime would
    // throw it away between screens and re-fetch it for nothing.
    gcTime: 24 * 60 * 60 * 1000,
  });
}

