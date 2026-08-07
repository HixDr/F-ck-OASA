/**
 * Live Map screen — real-time bus positions on a dark-themed Google Map.
 * Uses react-native-maps (Google Maps provider) for native performance.
 *
 * Polling is React Query's job (useBusLocations / useArrivals) and bus motion
 * is Animated's job (components/BusLayer). This component re-renders when its
 * own state changes and not otherwise — no requestAnimationFrame loop, no
 * setInterval, no per-frame `setOptions` on the native header.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { colors, font } from '../../theme';
import {
  useBusLocations, useStops, useRoutes, useSchedule, useArrivals, useRoutesForStop, BUS_POLL_MS,
} from '../../hooks';
import { useLinesMap } from '../../hooks/useLinesMap';
import { useInitialRegion } from '../../hooks/useInitialRegion';
import { useUserLocation } from '../../hooks/useUserLocation';
import { getRouteDetails } from '../../services/api';
import {
  isFavorite, addFavorite, removeFavorite, getStamps, addStamp, removeStamp,
  getToggle, setToggle, getCachedBusPositions, setCachedBusPositions,
  isFavoriteStop, addFavoriteStop, removeFavoriteStop,
} from '../../services/storage';
import { useNetworkStatus } from '../../services/network';
import { useSettings } from '../settings/SettingsProvider';
import { GOOGLE_DARK_STYLE, GOOGLE_MAP_ID } from '../../theme/googleMapStyle';
import { METRO_POLYLINES } from '../../data/metroPolylines';
import { mapStyles as ms } from '../../theme/mapStyles';
import {
  buildLineGroups, describeApiError, getArrivalColor, isInRegion, simplifyPath, type LineGroup,
} from './mapUtils';
import StampModal from '../../components/StampModal';
import ScheduleGrid from '../../components/ScheduleGrid';
import UserLocationMarker from '../../components/UserLocationMarker';
import Pressable from '../../ui/Pressable';
import MapControls, { type MapToggle } from '../../ui/MapControls';
import StopSheet, { useStopSheetInset, type StopSheetLine } from '../../ui/StopSheet';
import RefreshTimer from './components/RefreshTimer';
import MapStatus from './components/MapStatus';
import BusLayer, { type RawBus } from './components/BusLayer';
import StampLayer from './components/StampLayer';
import { RouteStopMarker } from './components/StopMarkers';
import { useMinuteTick, useScreenFocused, useVisibleRegion, useWalkingRoute } from './components/mapHooks';
import { BusMarkerRenderer } from '../../components/BusMarkerSvg';
import { bearingBetween } from '../../utils/geo';
import { s } from './LiveMapScreen.styles';
import type { MapStamp } from '../../types';

/** Douglas-Peucker tolerance for the route shape, metres. `getRouteDetails`
 *  hands back 300-1500 raw points; below ~8m nothing is visible at city zoom. */
const ROUTE_SIMPLIFY_M = 8;
/** Above this latitude span (~28 km) stop markers are hidden outright. That is
 *  wider than any Athens line, so the default fitted view still shows them;
 *  it only kicks in when the user has zoomed past the point of usefulness. */
const STOP_HIDE_DELTA = 0.25;
/** Retries for the off-screen SVG → PNG capture before we give up and use the
 *  vector fallback marker. */
const CAPTURE_MAX_ATTEMPTS = 8;

const EMPTY_BUSES: RawBus[] = [];
const EMPTY_TIMES: string[] = [];
const EMPTY_STOPS: StopWithBearing[] = [];
const FIT_PADDING = { top: 60, right: 60, bottom: 60, left: 60 };

interface ParsedStop { lat: number; lng: number; name: string; code: string }
interface StopWithBearing extends ParsedStop { bearing: number }

/* ── Live Map Component ──────────────────────────────────────── */

export default function LiveMapScreen() {
  const router = useRouter();
  const { lineCode, lineId, lineDescr } = useLocalSearchParams<{
    lineCode: string;
    lineId: string;
    lineDescr: string;
  }>();

  // expo-router's native stack keeps pushed-behind screens mounted. Everything
  // that polls or animates is gated on this.
  const focused = useScreenFocused();
  const minuteTick = useMinuteTick();

  const { data: allRoutes, error: routesError, refetch: refetchRoutes } = useRoutes(lineCode);
  const { linesMap } = useLinesMap();
  const [activeRouteCode, setActiveRouteCode] = useState<string | undefined>(undefined);
  const [fav, setFav] = useState(() => isFavorite(lineCode));
  const [showRouteMenu, setShowRouteMenu] = useState(false);
  const [showSchedule, setShowSchedule] = useState(() => getToggle('schedule', false));
  const [showMetro, setShowMetro] = useState(() => getToggle('metro', true));
  const [showStamps, setShowStamps] = useState(() => getToggle('stamps', true));
  const { primaryColor, iconStyle } = useSettings();

  // Stop all-lines expansion state
  const [showAllLines, setShowAllLines] = useState(false);

  // Stamp state
  const [stamps, setStamps] = useState<MapStamp[]>(() => getStamps());
  const [stampModal, setStampModal] = useState<{ lat: number; lng: number } | null>(null);
  const [stampName, setStampName] = useState('');
  const [stampEmoji, setStampEmoji] = useState('📍');

  // Schedule
  const { data: scheduleData, isLoading: loadingSchedule } = useSchedule(lineCode);
  // Pick schedule entries matching the active route direction (go vs come)
  // GO: sde_start1 from go entries (departure from terminus A)
  // COME: sde_start2 from come entries (departure from terminus B)
  const scheduleTimes = useMemo(() => {
    if (!scheduleData) return EMPTY_TIMES;
    // Circular routes: come is empty, all entries live in go with sde_start1
    const isCircular = (scheduleData.come ?? []).length === 0;
    const routeIdx = allRoutes?.findIndex((r) => r.RouteCode === activeRouteCode) ?? -1;
    // findIndex returns -1, which is not null — `?? 0` never caught it, so an
    // unrecognised route silently displayed the opposite direction's timetable.
    if (routeIdx < 0 && !isCircular) return EMPTY_TIMES;
    // OASA convention: route[0] = come (B→A), route[1] = go (A→B)
    const isGo = isCircular || routeIdx > 0;
    const entries = isGo ? (scheduleData.go ?? []) : (scheduleData.come ?? []);
    const times = new Set<string>();
    for (const e of entries) {
      const field = isGo ? e.sde_start1 : e.sde_start2;
      const m = field?.match(/(\d{2}):(\d{2})/);
      if (m) times.add(`${m[1]}:${m[2]}`);
    }
    return [...times].sort();
  }, [scheduleData, activeRouteCode, allRoutes]);

  const nextDeparture = useMemo(() => {
    if (scheduleTimes.length === 0) return null;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const t of scheduleTimes) {
      const [h, m] = t.split(':').map(Number);
      if (h * 60 + m >= nowMin) return t;
    }
    return scheduleTimes[0];
    // minuteTick: without it "Next: 14:05" stays on screen long after 14:05.
  }, [scheduleTimes, minuteTick]);

  // Auto-select first route
  useEffect(() => {
    if (allRoutes && allRoutes.length > 0 && !activeRouteCode) {
      setActiveRouteCode(allRoutes[0].RouteCode);
    }
  }, [allRoutes, activeRouteCode]);

  /* ── Route shape ───────────────────────────────────────────── */

  const [routePath, setRoutePath] = useState<Array<{ lat: number; lng: number }>>([]);
  const [shapeError, setShapeError] = useState<unknown>(null);
  const [shapeLoading, setShapeLoading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!activeRouteCode) { setRoutePath([]); setShapeError(null); setShapeLoading(false); return; }
    // Toggling direction A→B→A could land B's polyline last, and every A bus
    // then snapped onto B's geometry. The abort signal is the stale guard.
    const ac = new AbortController();
    setRoutePath([]);
    setShapeError(null);
    setShapeLoading(true);
    getRouteDetails(activeRouteCode, { signal: ac.signal })
      .then((pts) => {
        if (ac.signal.aborted) return;
        setRoutePath(pts);
        setShapeLoading(false);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        // getRouteDetails throws now, so [] genuinely means "no shape on file"
        // and this branch genuinely means "the request failed".
        setRoutePath([]);
        setShapeError(err);
        setShapeLoading(false);
      });
    return () => ac.abort();
  }, [activeRouteCode, retryNonce]);

  const {
    data: buses, dataUpdatedAt: busUpdatedAt, isFetching: busFetching,
    error: busError, refetch: refetchBuses,
  } = useBusLocations(activeRouteCode, focused);
  const { data: stops, error: stopsError, refetch: refetchStops } = useStops(activeRouteCode);
  const isOnline = useNetworkStatus();
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);

  // 1 Hz GPS only while this screen is actually on top of the stack.
  const { userLocationRef, userLoc, userHeading } = useUserLocation({ highAccuracy: focused });

  /* ── Bus marker bitmap ─────────────────────────────────────── */

  const busSvgRef = useRef<any>(null);
  const [busMarkerUri, setBusMarkerUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const capture = () => {
      if (cancelled) return;
      const svg = busSvgRef.current;
      if (svg && typeof svg.toDataURL === 'function') {
        svg.toDataURL((base64: string) => {
          if (!cancelled && base64) setBusMarkerUri('data:image/png;base64,' + base64);
        });
        return;
      }
      // The ref can still be null well past 100ms on a cold start or a low-end
      // device. There used to be no retry, and every bus marker was gated on
      // this URI — so a slow first frame meant no buses for the whole session.
      // BusLayer falls back to a vector pin if we never succeed.
      if (++attempts <= CAPTURE_MAX_ATTEMPTS) timer = setTimeout(capture, 100 * attempts);
    };
    timer = setTimeout(capture, 60);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [primaryColor]);

  /* ── Buses ─────────────────────────────────────────────────── */

  const [staleBusTs, setStaleBusTs] = useState<number | null>(null);
  const [staleBuses, setStaleBuses] = useState<RawBus[]>(EMPTY_BUSES);
  const staleLoadedFor = useRef<string | null>(null);

  const parsedBuses = useMemo<RawBus[]>(() => {
    if (!buses || buses.length === 0) return EMPTY_BUSES;
    // OASA occasionally reports the same VEH_NO twice on one route. Duplicate
    // React keys silently drop a marker, so collapse on the vehicle number.
    const byId = new Map<string, RawBus>();
    for (const b of buses) {
      if (b.ROUTE_CODE !== activeRouteCode) continue;
      const lat = parseFloat(b.CS_LAT);
      const lng = parseFloat(b.CS_LNG);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      byId.set(b.VEH_NO, { id: b.VEH_NO, lat, lng });
    }
    return byId.size > 0 ? [...byId.values()] : EMPTY_BUSES;
  }, [buses, activeRouteCode]);

  useEffect(() => {
    if (parsedBuses.length > 0 && activeRouteCode) {
      setCachedBusPositions(activeRouteCode, parsedBuses);
      setStaleBusTs(null);
      setStaleBuses(EMPTY_BUSES);
    }
  }, [parsedBuses, activeRouteCode]);

  useEffect(() => {
    // The cached lookup is per route, so the "already tried" latch has to be
    // too — otherwise switching direction while offline never loads again.
    if (!activeRouteCode || staleLoadedFor.current === activeRouteCode) return;
    if (isOnline || (buses && buses.length > 0)) return;
    staleLoadedFor.current = activeRouteCode;
    let cancelled = false;
    getCachedBusPositions(activeRouteCode).then((cached) => {
      if (cancelled || !cached || cached.buses.length === 0) return;
      // Discard stale positions older than 1 hour
      if ((Date.now() - cached.ts) / 60000 > 60) return;
      setStaleBuses(cached.buses);
      setStaleBusTs(cached.ts);
    });
    return () => { cancelled = true; };
  }, [activeRouteCode, isOnline, buses]);

  const staleLabel = useMemo(() => {
    if (!staleBusTs) return null;
    const diffMin = Math.round((Date.now() - staleBusTs) / 60000);
    if (diffMin < 1) return 'last seen <1 min ago';
    if (diffMin < 60) return `last seen ${diffMin} min ago`;
    const h = Math.floor(diffMin / 60);
    return `last seen ${h}h ago`;
    // minuteTick: this used to be pinned at "<1 min ago" for as long as the
    // pill was on screen, because Date.now() was not a dependency of anything.
  }, [staleBusTs, minuteTick]);

  const busMarkers = parsedBuses.length > 0 ? parsedBuses : staleBuses;
  const busStale = staleBuses.length > 0 && parsedBuses.length === 0;

  /* ── Stops & geometry ──────────────────────────────────────── */

  const parsedStops = useMemo<ParsedStop[]>(() => {
    if (!stops) return [];
    return stops.map((st) => ({
      lat: parseFloat(st.StopLat), lng: parseFloat(st.StopLng),
      name: st.StopDescrEng || st.StopDescr, code: st.StopCode,
    }));
  }, [stops]);

  // Bearings for directional stop markers
  const stopsWithBearings = useMemo<StopWithBearing[]>(() => {
    if (parsedStops.length < 2) return parsedStops.map((st) => ({ ...st, bearing: 0 }));
    return parsedStops.map((st, i) => {
      const next = parsedStops[Math.min(i + 1, parsedStops.length - 1)];
      const prev = parsedStops[Math.max(i - 1, 0)];
      const target = i < parsedStops.length - 1 ? next : prev;
      return { ...st, bearing: bearingBetween(st.lat, st.lng, target.lat, target.lng) };
    });
  }, [parsedStops]);

  const routeShape = useMemo(() => simplifyPath(routePath, ROUTE_SIMPLIFY_M), [routePath]);

  // One source of truth for the drawn line AND the interpolator. They used to
  // disagree: the polyline fell back to stops while the interpolator got an
  // empty route and bailed, so buses teleported every poll with bearing 0.
  const routeGeometry = useMemo(() => (
    routeShape.length > 1
      ? routeShape
      : parsedStops.map((p) => ({ lat: p.lat, lng: p.lng }))
  ), [routeShape, parsedStops]);

  const routePolyline = useMemo(
    () => routeGeometry.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [routeGeometry],
  );

  /* ── Viewport culling ──────────────────────────────────────── */

  const initialRegion = useInitialRegion(0.05);
  const { region, onRegionChangeStart, onRegionChangeComplete } = useVisibleRegion();

  const stopsHidden = region != null && region.latitudeDelta > STOP_HIDE_DELTA;
  const visibleStops = useMemo(() => {
    // Before the map has reported a region we cannot cull safely — a missed
    // first event would otherwise leave the route drawn with no stops on it.
    if (!region) return stopsWithBearings;
    if (region.latitudeDelta > STOP_HIDE_DELTA) return EMPTY_STOPS;
    return stopsWithBearings.filter((st) => isInRegion(st.lat, st.lng, region));
  }, [stopsWithBearings, region]);

  // Fit map to route bounds — after the map is ready, and again per direction.
  const fittedRoute = useRef<string | null>(null);
  useEffect(() => {
    if (!mapReady || !activeRouteCode || parsedStops.length < 2) return;
    if (fittedRoute.current === activeRouteCode) return;
    const map = mapRef.current;
    // On Android fitToCoordinates is a no-op before the map is ready, and the
    // old code latched `hasFitted` *before* calling it — so a fast cached load
    // left the camera at initialRegion with the route off-screen, forever.
    if (!map) return;
    map.fitToCoordinates(
      parsedStops.map((p) => ({ latitude: p.lat, longitude: p.lng })),
      { edgePadding: FIT_PADDING, animated: true },
    );
    fittedRoute.current = activeRouteCode;
  }, [mapReady, activeRouteCode, parsedStops]);

  // Metro polyline data (pre-computed constant)
  const metroLines = useMemo(() => METRO_POLYLINES.map((line, i) => (
    <Polyline key={`mp-${i}`} coordinates={line.coords}
      strokeColor={line.color + '99'} strokeWidth={2.5} lineCap="round" />
  )), []);

  const lineRouteCodes = useMemo(
    () => new Set((allRoutes ?? []).map((r) => r.RouteCode)),
    [allRoutes],
  );

  /* ── Selected stop ─────────────────────────────────────────── */

  const [selectedStop, setSelectedStop] = useState<ParsedStop | null>(null);
  const selectedStopCode = selectedStop?.code ?? null;

  // React Query owns arrivals polling: keyed by stop code, so a slow response
  // for stop A can no longer land in stop B's card, and it pauses when the
  // screen is unfocused or the app is backgrounded.
  const arrivalsQuery = useArrivals(selectedStopCode ?? undefined, focused);
  // `useArrivals` keeps the previous result as placeholder data so a 15s
  // refetch does not flash a spinner — but across a *key* change that
  // placeholder is the previous stop's arrivals. `isPlaceholderData` is true
  // only in that case, which is exactly when it must not be shown.
  const rawArrivals = arrivalsQuery.isPlaceholderData ? undefined : arrivalsQuery.data;
  const arrivalsLoading = arrivalsQuery.isLoading || arrivalsQuery.isPlaceholderData;

  const arrivals = useMemo(() => {
    if (!rawArrivals) return null;
    return rawArrivals
      .filter((a) => lineRouteCodes.has(a.route_code))
      .sort((a, b) => Number(a.btime2) - Number(b.btime2))
      .slice(0, 5)
      .map((a) => {
        const min = Number(a.btime2);
        return { min, color: getArrivalColor(min) };
      });
  }, [rawArrivals, lineRouteCodes]);

  const walkTarget = useMemo(
    () => (selectedStop ? { lat: selectedStop.lat, lng: selectedStop.lng, key: selectedStop.code } : null),
    [selectedStop],
  );
  const walk = useWalkingRoute(walkTarget, userLoc);

  // Read through a ref so `onStopPress` stays stable — a new callback identity
  // would re-render every memoized marker whenever the stop list changed.
  const stopsByCode = useMemo(
    () => new Map(parsedStops.map((st) => [st.code, st])),
    [parsedStops],
  );
  const stopsByCodeRef = useRef(stopsByCode);
  stopsByCodeRef.current = stopsByCode;

  const onStopPress = useCallback((code: string) => {
    const st = stopsByCodeRef.current.get(code);
    if (!st) return;
    setSelectedStop(st);
    setShowAllLines(false);
  }, []);

  const closeStop = useCallback(() => {
    setSelectedStop(null);
    setShowAllLines(false);
  }, []);

  // Saved-stop state, mirrored so the bookmark icon can re-render on toggle.
  const [stopSaved, setStopSaved] = useState(false);
  useEffect(() => {
    setStopSaved(selectedStop ? isFavoriteStop(selectedStop.code) : false);
  }, [selectedStop]);

  const toggleStopSaved = useCallback(() => {
    if (!selectedStop) return;
    if (isFavoriteStop(selectedStop.code)) {
      Alert.alert('Remove Stop', `Remove "${selectedStop.name}" from saved stops?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => {
          removeFavoriteStop(selectedStop.code);
          setStopSaved(false);
        } },
      ]);
    } else {
      addFavoriteStop({ stopCode: selectedStop.code, stopName: selectedStop.name, lat: selectedStop.lat, lng: selectedStop.lng });
      setStopSaved(true);
    }
  }, [selectedStop]);

  // An alert armed here watches every direction of the line being tracked.
  const alertTarget = useMemo(
    () => ({ lineId: lineId ?? '', routeCodes: [...lineRouteCodes] }),
    [lineId, lineRouteCodes],
  );

  // All lines at this stop — cached + offline-tolerant via the shared hook.
  const { data: stopRoutes, isLoading: loadingStopLines } = useRoutesForStop(
    showAllLines && selectedStopCode ? selectedStopCode : undefined,
  );
  const stopLines = useMemo<LineGroup[] | null>(() => {
    if (!showAllLines || !stopRoutes) return null;
    return buildLineGroups(stopRoutes, rawArrivals ?? [], linesMap).lines;
  }, [showAllLines, stopRoutes, rawArrivals, linesMap]);

  /* ── Map interactions ──────────────────────────────────────── */

  const onMapLongPress = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    setStampName(''); setStampEmoji('📍');
    setStampModal({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
  }, []);

  const onMapReady = useCallback(() => setMapReady(true), []);
  const onRemoveStamp = useCallback((id: string) => setStamps(removeStamp(id)), []);

  const recenter = useCallback(() => {
    const loc = userLocationRef.current;
    if (loc && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: loc.lat, longitude: loc.lng,
        latitudeDelta: 0.01, longitudeDelta: 0.01,
      }, 500);
    }
  }, [userLocationRef]);

  const selectRoute = useCallback((routeCode: string) => {
    setActiveRouteCode(routeCode);
    setShowRouteMenu(false);
    closeStop();
  }, [closeStop]);

  const toggleAllLines = useCallback(() => setShowAllLines((v) => !v), []);

  const openLine = useCallback((line: StopSheetLine) => {
    const info = linesMap.get(line.lineCode);
    router.push({ pathname: '/map/[lineCode]', params: {
      lineCode: line.lineCode, lineId: line.lineId,
      lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
    }});
  }, [linesMap, router]);

  const toggles = useMemo<MapToggle[]>(() => [
    {
      key: 'schedule',
      icon: 'time-outline',
      label: 'Timetable',
      active: showSchedule,
      onPress: () => { const n = !showSchedule; setShowSchedule(n); setToggle('schedule', n); },
    },
    {
      key: 'metro',
      icon: 'train-outline',
      label: 'Metro lines',
      active: showMetro,
      onPress: () => { const n = !showMetro; setShowMetro(n); setToggle('metro', n); },
    },
    {
      key: 'stamps',
      icon: 'pin-outline',
      label: 'Map stamps',
      active: showStamps,
      onPress: () => { const n = !showStamps; setShowStamps(n); setToggle('stamps', n); },
    },
  ], [showSchedule, showMetro, showStamps]);

  const sheetInset = useStopSheetInset(selectedStop != null);

  /* ── Header ────────────────────────────────────────────────── */

  const activeRouteLabel = useMemo(() => {
    const r = allRoutes?.find((x) => x.RouteCode === activeRouteCode);
    return r ? (r.RouteDescrEng || r.RouteDescr) : '';
  }, [allRoutes, activeRouteCode]);
  const hasMultipleRoutes = (allRoutes?.length ?? 0) > 1;

  const toggleRouteMenu = useCallback(() => setShowRouteMenu((v) => !v), []);
  const toggleFav = useCallback(() => {
    setFav((prev) => {
      if (prev) { removeFavorite(lineCode); return false; }
      addFavorite({ lineCode, lineId: lineId ?? '', lineDescr: lineDescr ?? '', lineDescrEng: lineDescr ?? '' });
      return true;
    });
  }, [lineCode, lineId, lineDescr]);

  // A fresh options object makes expo-router call setOptions and re-render the
  // native header. Rebuilt per frame (which is what the inline object did) that
  // is a full native header pass 60 times a second.
  const headerOptions = useMemo(() => ({
    headerStyle: { backgroundColor: colors.bg },
    headerTitle: () => (
      // `disabled` is deliberately not used: our Pressable dims a disabled
      // target, and a single-direction line's header is not "unavailable".
      <Pressable
        style={s.headerTitleWrap}
        onPress={hasMultipleRoutes ? toggleRouteMenu : undefined}
        pressScale={hasMultipleRoutes ? 0.97 : 1}
        haptic={hasMultipleRoutes}
        accessibilityRole={hasMultipleRoutes ? 'button' : 'header'}
        accessibilityState={hasMultipleRoutes ? { expanded: showRouteMenu } : undefined}
        accessibilityLabel={hasMultipleRoutes
          ? `Line ${lineId ?? ''}, ${activeRouteLabel}. Change direction`
          : `Line ${lineId ?? ''}, ${activeRouteLabel}`}
      >
        <View style={s.headerTitleRow}>
          <Text style={s.headerLineId}>{lineId ?? ''}</Text>
          {hasMultipleRoutes && (
            <Ionicons name={showRouteMenu ? 'chevron-up' : 'chevron-down'}
              size={16} color={colors.textMuted} style={s.headerChevron} />
          )}
        </View>
        {activeRouteLabel ? <Text style={s.headerRouteDescr} numberOfLines={1}>{activeRouteLabel}</Text> : null}
      </Pressable>
    ),
    headerRight: () => (
      <Pressable
        onPress={toggleFav}
        style={s.headerFavBtn}
        accessibilityRole="button"
        accessibilityLabel={fav ? 'Remove this line from favourites' : 'Add this line to favourites'}
        accessibilityState={{ selected: fav }}
      >
        <Ionicons name={fav ? 'heart' : 'heart-outline'} size={24} color={fav ? '#B91C1C' : colors.textMuted} />
      </Pressable>
    ),
  }), [hasMultipleRoutes, showRouteMenu, activeRouteLabel, lineId, fav, toggleRouteMenu, toggleFav]);

  /* ── Status ────────────────────────────────────────────────── */

  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const errorMessage = useMemo(() => {
    if (routesError) return describeApiError(routesError, 'Loading directions');
    if (stopsError) return describeApiError(stopsError, 'Loading stops');
    if (shapeError) return describeApiError(shapeError, 'Loading the route shape');
    if (busError) return describeApiError(busError, 'Live bus positions');
    return null;
  }, [routesError, stopsError, shapeError, busError]);
  const visibleError = errorMessage && errorMessage !== dismissedError ? errorMessage : null;

  const retryAll = useCallback(() => {
    setDismissedError(null);
    setRetryNonce((n) => n + 1);
    refetchRoutes();
    refetchStops();
    refetchBuses();
  }, [refetchRoutes, refetchStops, refetchBuses]);

  const dismissError = useCallback(() => setDismissedError(errorMessage), [errorMessage]);

  // Stops, polyline and buses all arrive well after the route list, and the
  // old spinner disappeared as soon as the list did — leaving an empty dark
  // map with no feedback through the slowest part of the load.
  const loadingLabel = useMemo(() => {
    if (!allRoutes) return 'Loading directions…';
    if (!stops) return 'Loading stops…';
    if (shapeLoading) return 'Drawing the route…';
    if (!buses && focused && isOnline) return 'Locating buses…';
    return null;
  }, [allRoutes, stops, shapeLoading, buses, focused, isOnline]);

  return (
    <View style={ms.container}>
      <Stack.Screen options={headerOptions} />

      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={ms.map}
        initialRegion={initialRegion}
        customMapStyle={GOOGLE_DARK_STYLE}
        googleMapId={GOOGLE_MAP_ID}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        onMapReady={onMapReady}
        onLongPress={onMapLongPress}
        onRegionChangeStart={onRegionChangeStart}
        onRegionChangeComplete={onRegionChangeComplete}
        moveOnMarkerPress={false}
      >
        {/* Route polyline */}
        {routePolyline.length > 1 && (
          <Polyline coordinates={routePolyline} strokeColor={primaryColor + 'AA'}
            strokeWidth={3.5} lineCap="round" lineJoin="round" zIndex={0} />
        )}

        {/* Walking route */}
        {walk.coords.length > 1 && (
          <Polyline coordinates={walk.coords} strokeColor="#4285F4"
            strokeWidth={4} lineDashPattern={[8, 6]} lineCap="round" lineJoin="round" />
        )}

        {/* Metro polylines */}
        {showMetro && metroLines}

        {/* Stop markers — bus icon with directional arrow */}
        {visibleStops.map((stop) => (
          <RouteStopMarker
            key={`st-${stop.code}`}
            code={stop.code}
            lat={stop.lat}
            lng={stop.lng}
            bearing={stop.bearing}
            selected={selectedStopCode === stop.code}
            color={primaryColor}
            onPress={onStopPress}
          />
        ))}

        {/* Buses — animated natively, no React state per frame */}
        <BusLayer
          buses={busMarkers}
          route={routeGeometry}
          imageUri={busMarkerUri}
          color={primaryColor}
          durationMs={BUS_POLL_MS}
          stale={busStale}
          active={focused}
        />

        {/* Stamps */}
        {showStamps && <StampLayer stamps={stamps} onRemove={onRemoveStamp} />}

        {/* User location */}
        {userLoc && (
          <UserLocationMarker
            lat={userLoc.lat} lng={userLoc.lng}
            heading={userHeading} iconStyle={iconStyle}
          />
        )}
      </MapView>

      {/* Route direction dropdown */}
      {showRouteMenu && allRoutes && allRoutes.length > 1 && (
        <View style={s.routeMenu}>
          {allRoutes.map((r) => (
            <Pressable key={r.RouteCode}
              style={[s.routeMenuItem, activeRouteCode === r.RouteCode && s.routeMenuItemActive]}
              onPress={() => selectRoute(r.RouteCode)}
              accessibilityRole="radio"
              accessibilityState={{ selected: activeRouteCode === r.RouteCode }}
              accessibilityLabel={r.RouteDescrEng || r.RouteDescr}>
              <Text style={[s.routeMenuText, activeRouteCode === r.RouteCode && s.routeMenuTextActive]} numberOfLines={2}>
                {r.RouteDescrEng || r.RouteDescr}
              </Text>
              {activeRouteCode === r.RouteCode && <Ionicons name="checkmark" size={16} color={colors.primaryLight} />}
            </Pressable>
          ))}
        </View>
      )}

      <MapControls
        toggles={toggles}
        accentColor={primaryColor}
        onRecenter={recenter}
        bottomOffset={sheetInset}
      >
        <RefreshTimer
          dataUpdatedAt={busUpdatedAt}
          intervalMs={BUS_POLL_MS}
          fetching={busFetching}
          staleLabel={staleLabel}
        />
      </MapControls>

      {selectedStop && (
        <StopSheet
          stop={selectedStop}
          accentColor={primaryColor}
          onClose={closeStop}
          walkMin={walk.walkMin}
          saved={stopSaved}
          onToggleSaved={toggleStopSaved}
          arrivals={arrivals}
          arrivalsLoading={arrivalsLoading}
          nextDeparture={nextDeparture}
          lines={stopLines}
          linesLoading={loadingStopLines}
          onPressLine={openLine}
          linesExpanded={showAllLines}
          onToggleLines={toggleAllLines}
          alert={alertTarget}
        />
      )}

      {/* Schedule overlay */}
      {showSchedule && (
        <View style={s.scheduleCard}>
          <View style={ms.arrivalHeader}>
            <Text style={[ms.arrivalName, { fontSize: font.size.micro }]} accessibilityRole="header">Schedule</Text>
            <Pressable
              onPress={() => setShowSchedule(false)}
              accessibilityRole="button"
              accessibilityLabel="Close the timetable">
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </Pressable>
          </View>
          {loadingSchedule ? (
            <ActivityIndicator size="small" color={colors.primaryLight} style={{ marginTop: 4 }} />
          ) : scheduleTimes.length > 0 ? (
            <ScheduleGrid times={scheduleTimes} nextDeparture={nextDeparture} accentColor={primaryColor} />
          ) : (
            <Text style={ms.arrivalEmpty}>No schedule available</Text>
          )}
        </View>
      )}

      <MapStatus
        blocking={!allRoutes && !routesError}
        loadingLabel={loadingLabel}
        hint={stopsHidden && stopsWithBearings.length > 0 ? 'Zoom in to see stops' : null}
        error={visibleError}
        onRetry={retryAll}
        onDismissError={dismissError}
      />

      <StampModal
        visible={!!stampModal}
        name={stampName} emoji={stampEmoji}
        accentColor={primaryColor}
        onChangeName={setStampName} onChangeEmoji={setStampEmoji}
        onCancel={() => setStampModal(null)}
        onSave={() => {
          if (!stampModal || !stampName.trim()) return;
          setStamps(addStamp({ name: stampName.trim(), emoji: stampEmoji, lat: stampModal.lat, lng: stampModal.lng }));
          setStampModal(null);
        }}
      />

      {/* Hidden SVG renderer for bus marker image capture */}
      <BusMarkerRenderer color={primaryColor} svgRef={busSvgRef} />
    </View>
  );
}
