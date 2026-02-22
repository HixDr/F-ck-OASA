/**
 * Live Map screen — real-time bus positions on a dark-themed Google Map.
 * Uses react-native-maps (Google Maps provider) for native performance.
 * Polls getBusLocation every 10 seconds.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
  Keyboard,
  Platform,
  Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { getLocation, getHeading, subscribe as subscribeLocation, subscribeHeading } from '../../src/location';
import HeadingBeam from '../../src/components/HeadingBeam';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../src/theme';
import { useBusLocations, useStops, useRoutes, useSchedule, useLines } from '../../src/hooks';
import { getStopArrivals, getWalkingRoute, getRoutesForStop, getRouteDetails } from '../../src/api';
import { isFavorite, addFavorite, removeFavorite, getStamps, addStamp, removeStamp, getToggle, setToggle, getCachedBusPositions, setCachedBusPositions, isFavoriteStop, addFavoriteStop, removeFavoriteStop, getCachedRoutesForStop, setCachedRoutesForStop } from '../../src/storage';
import { useNetworkStatus } from '../../src/network';
import { startAlertWatch, stopAlertWatch, subscribeAlertConfig, type AlertConfig } from '../../src/notifications';
import { useSettings } from '../../src/settings';
import { USER_MARKER_BASE64 } from '../../src/userMarker';
import { GOOGLE_DARK_STYLE } from '../../src/googleMapStyle';
import { METRO_LINES } from '../../src/metro';
import { mapStyles as ms } from '../../src/mapStyles';
import { buildLineGroups, enrichWithDirectionHints, getArrivalColor, type LineGroup } from '../../src/mapUtils';
import StampModal from '../../src/components/StampModal';
import { BusMarkerRenderer, BUS_MARKER_ANCHOR_Y } from '../../src/components/BusMarkerSvg';
import { BusInterpolator } from '../../src/busInterpolation';
import type { MapStamp, OasaLine } from '../../src/types';

/* ── Refresh countdown timer ─────────────────────────────────── */

const POLL_INTERVAL = 10;

function RefreshTimer({ staleLabel }: { staleLabel: string | null }) {
  const [seconds, setSeconds] = useState(POLL_INTERVAL);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((prev) => (prev <= 1 ? POLL_INTERVAL : prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ alignItems: 'flex-end', gap: 4 }}>
      {staleLabel && (
        <View style={s.stalePill}>
          <Ionicons name="cloud-offline-outline" size={10} color={colors.warning} />
          <Text style={s.staleText}>{staleLabel}</Text>
        </View>
      )}
      <View style={s.timerPill}>
        <View style={[s.timerDot, staleLabel ? { backgroundColor: colors.warning } : null]} />
        <Text style={s.timerText}>{seconds}s</Text>
      </View>
    </View>
  );
}

/* ── Schedule grid with auto-scroll to next departure ────────── */

function ScheduleGrid({ times, nextDeparture, accentColor }: { times: string[]; nextDeparture: string | null; accentColor: string }) {
  const scrollRef = useRef<ScrollView>(null);
  const nextY = useRef(0);

  return (
    <ScrollView
      ref={scrollRef}
      style={s.scheduleScroll}
      showsVerticalScrollIndicator={false}
    >
      <View style={s.scheduleGrid}>
        {times.map((t, i) => {
          const now = new Date();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const [h, m] = t.split(':').map(Number);
          const isPast = h * 60 + m < nowMin;
          const isNext = t === nextDeparture;
          return (
            <View
              key={i}
              style={[s.scheduleTime, isNext && { backgroundColor: accentColor }]}
              onLayout={isNext ? (e) => {
                nextY.current = e.nativeEvent.layout.y;
                scrollRef.current?.scrollTo({ y: Math.max(0, nextY.current - 40), animated: false });
              } : undefined}
            >
              <Text style={[s.scheduleTimeText, isPast && s.scheduleTimePast, isNext && s.scheduleTimeNextText]}>{t}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

/* ── Bearing helper ──────────────────────────────────────────── */

function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/* ── Live Map Component ──────────────────────────────────────── */

export default function LiveMapScreen() {
  const router = useRouter();
  const { lineCode, lineId, lineDescr } = useLocalSearchParams<{
    lineCode: string;
    lineId: string;
    lineDescr: string;
  }>();

  const { data: allRoutes } = useRoutes(lineCode);
  const { data: allLines } = useLines();
  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);
  const [activeRouteCode, setActiveRouteCode] = useState<string | undefined>(undefined);
  const [fav, setFav] = useState(() => isFavorite(lineCode));
  const [showRouteMenu, setShowRouteMenu] = useState(false);
  const [showSchedule, setShowSchedule] = useState(() => getToggle('schedule', false));
  const [showMetro, setShowMetro] = useState(() => getToggle('metro', true));
  const [showStamps, setShowStamps] = useState(() => getToggle('stamps', true));
  const { primaryColor, iconStyle } = useSettings();

  // Stop all-lines expansion state
  const [stopLines, setStopLines] = useState<LineGroup[] | null>(null);
  const [loadingStopLines, setLoadingStopLines] = useState(false);

  // Stamp state
  const [stamps, setStamps] = useState<MapStamp[]>(() => getStamps());
  const [stampModal, setStampModal] = useState<{ lat: number; lng: number } | null>(null);
  const [stampName, setStampName] = useState('');
  const [stampEmoji, setStampEmoji] = useState('📍');

  // Arrival alert state — synced with global service
  const [arrivalAlert, setArrivalAlert] = useState<AlertConfig | null>(null);
  useEffect(() => subscribeAlertConfig(setArrivalAlert), []);
  const [showAlertPicker, setShowAlertPicker] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState('5');

  // Keyboard height tracking — push card above keyboard
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Schedule
  const { data: scheduleData, isLoading: loadingSchedule } = useSchedule(lineCode);
  // Pick schedule entries matching the active route direction (go vs come)
  // GO: sde_start1 from go entries (departure from terminus A)
  // COME: sde_start2 from come entries (departure from terminus B)
  const scheduleTimes = useMemo(() => {
    if (!scheduleData) return [];
    const routeIdx = allRoutes?.findIndex((r) => r.RouteCode === activeRouteCode) ?? 0;
    // OASA convention: route[0] = come (B→A), route[1] = go (A→B)
    // Circular routes: come is empty, all entries live in go with sde_start1
    const isCircular = (scheduleData.come ?? []).length === 0;
    let isGo = isCircular || routeIdx > 0;
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
  }, [scheduleTimes]);

  // Auto-select first route
  useEffect(() => {
    if (allRoutes && allRoutes.length > 0 && !activeRouteCode) {
      setActiveRouteCode(allRoutes[0].RouteCode);
    }
  }, [allRoutes, activeRouteCode]);

  // Road-following path
  const [routePath, setRoutePath] = useState<Array<{ lat: number; lng: number }>>([]);
  useEffect(() => {
    if (!activeRouteCode) { setRoutePath([]); return; }
    setRoutePath([]);
    getRouteDetails(activeRouteCode).then(setRoutePath).catch(() => setRoutePath([]));
  }, [activeRouteCode]);

  const { data: buses } = useBusLocations(activeRouteCode);
  const { data: stops } = useStops(activeRouteCode);
  const isOnline = useNetworkStatus();
  const mapRef = useRef<MapView>(null);
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(getLocation());

  // Bus marker image — rendered off-screen as SVG, captured as PNG
  const busSvgRef = useRef<any>(null);
  const [busMarkerUri, setBusMarkerUri] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      if (busSvgRef.current) {
        busSvgRef.current.toDataURL((base64: string) => {
          setBusMarkerUri('data:image/png;base64,' + base64);
        });
      }
    }, 100);
    return () => clearTimeout(id);
  }, [primaryColor]);

  // Stale bus positions
  const [staleBusTs, setStaleBusTs] = useState<number | null>(null);
  const staleLoadedRef = useRef(false);
  const [staleBuses, setStaleBuses] = useState<Array<{ lat: number; lng: number; id: string }>>([]);

  // User location for marker
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(getLocation());
  const [userHeading, setUserHeading] = useState<number | null>(getHeading());

  // Walking route
  const [walkCoords, setWalkCoords] = useState<Array<{ latitude: number; longitude: number }>>([]);

  // Subscribe to location updates
  useEffect(() => {
    const unLoc = subscribeLocation(async (loc) => {
      userLocationRef.current = loc;
      setUserLoc(loc);
      const target = selectedStopRef.current;
      if (target) {
        const walk = await getWalkingRoute(loc.lat, loc.lng, target.lat, target.lng);
        if (walk && walk.coords.length > 1 && selectedStopRef.current) {
          const walkMin = Math.round(walk.durationSec / 60);
          setWalkCoords(walk.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] })));
          setSelectedStop((prev) => prev ? { ...prev, walkMin } : prev);
        }
      }
    });
    const unHead = subscribeHeading((h) => setUserHeading(h));
    return () => { unLoc(); unHead(); };
  }, []);

  const parsedBuses = useMemo(() => {
    if (!buses || buses.length === 0) return [];
    return buses.map((b) => ({ lat: parseFloat(b.CS_LAT), lng: parseFloat(b.CS_LNG), id: b.VEH_NO }));
  }, [buses]);

  useEffect(() => {
    if (parsedBuses.length > 0 && activeRouteCode) {
      setCachedBusPositions(activeRouteCode, parsedBuses);
      setStaleBusTs(null);
      setStaleBuses([]);
    }
  }, [parsedBuses, activeRouteCode]);

  useEffect(() => {
    if (!activeRouteCode || staleLoadedRef.current) return;
    if (!isOnline && (!buses || buses.length === 0)) {
      staleLoadedRef.current = true;
      getCachedBusPositions(activeRouteCode).then((cached) => {
        if (cached && cached.buses.length > 0) {
          // Discard stale positions older than 1 hour
          const ageMin = (Date.now() - cached.ts) / 60000;
          if (ageMin > 60) return;
          setStaleBuses(cached.buses);
          setStaleBusTs(cached.ts);
        }
      });
    }
  }, [activeRouteCode, isOnline, buses]);

  const staleLabel = useMemo(() => {
    if (!staleBusTs) return null;
    const diffMin = Math.round((Date.now() - staleBusTs) / 60000);
    if (diffMin < 1) return 'last seen <1 min ago';
    if (diffMin < 60) return `last seen ${diffMin} min ago`;
    const h = Math.floor(diffMin / 60);
    return `last seen ${h}h ago`;
  }, [staleBusTs]);

  const parsedStops = useMemo(() => {
    if (!stops) return [];
    return stops.map((st) => ({
      lat: parseFloat(st.StopLat), lng: parseFloat(st.StopLng),
      name: st.StopDescrEng || st.StopDescr, code: st.StopCode,
    }));
  }, [stops]);

  // Bearings for directional stop markers
  const stopsWithBearings = useMemo(() => {
    if (parsedStops.length < 2) return parsedStops.map((st) => ({ ...st, bearing: 0 }));
    return parsedStops.map((st, i) => {
      const next = parsedStops[Math.min(i + 1, parsedStops.length - 1)];
      const prev = parsedStops[Math.max(i - 1, 0)];
      const target = i < parsedStops.length - 1 ? next : prev;
      return { ...st, bearing: bearingBetween(st.lat, st.lng, target.lat, target.lng) };
    });
  }, [parsedStops]);

  // Route polyline coordinates
  const routePolyline = useMemo(() => {
    const source = routePath.length > 1 ? routePath : parsedStops;
    return source.map((p) => ({ latitude: p.lat, longitude: p.lng }));
  }, [routePath, parsedStops]);

  // Fit map to route bounds on stops load
  const hasFitted = useRef(false);
  useEffect(() => {
    if (parsedStops.length < 2 || !mapRef.current || hasFitted.current) return;
    hasFitted.current = true;
    mapRef.current.fitToCoordinates(
      parsedStops.map((p) => ({ latitude: p.lat, longitude: p.lng })),
      { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true },
    );
  }, [parsedStops]);

  // Metro polyline data
  const metroData = useMemo(() =>
    Object.values(METRO_LINES).map((line) => ({
      color: line.color,
      coords: line.stations.map((st) => ({ latitude: st.c[0], longitude: st.c[1] })),
    })), []);

  // Bus markers — live or stale
  const rawBusMarkers = parsedBuses.length > 0 ? parsedBuses : staleBuses;
  const busStale = staleBuses.length > 0 && parsedBuses.length === 0;

  // Route-snapped interpolation for smooth bus movement
  const interpolatorRef = useRef(new BusInterpolator());
  const [interpolatedBuses, setInterpolatedBuses] = useState<Array<{ id: string; lat: number; lng: number; bearing: number }>>([]);
  const rafRef = useRef<number | null>(null);

  // Feed route to interpolator when it changes
  useEffect(() => {
    interpolatorRef.current.setRoute(routePath);
  }, [routePath]);

  // Feed bus positions to interpolator when API data arrives
  useEffect(() => {
    if (rawBusMarkers.length > 0 && routePath.length >= 2 && !busStale) {
      interpolatorRef.current.update(rawBusMarkers);
    }
  }, [rawBusMarkers, routePath, busStale]);

  // Animation loop — runs at ~60fps, updates interpolated positions
  useEffect(() => {
    if (routePath.length < 2 || rawBusMarkers.length === 0) {
      setInterpolatedBuses([]);
      return;
    }

    let active = true;
    const tick = () => {
      if (!active) return;
      const positions = interpolatorRef.current.getPositions();
      setInterpolatedBuses(positions);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [routePath, rawBusMarkers]);

  // Fall back to raw positions when route not available
  const busMarkers = useMemo(() => {
    if (interpolatedBuses.length > 0) return interpolatedBuses;
    return rawBusMarkers.map((b) => ({ ...b, bearing: 0 }));
  }, [interpolatedBuses, rawBusMarkers]);

  const lineRouteCodes = useMemo(
    () => new Set((allRoutes ?? []).map((r) => r.RouteCode)),
    [allRoutes],
  );

  // Selected stop
  const [selectedStop, setSelectedStop] = useState<{
    name: string; stopCode: string;
    arrivals: Array<{ min: number; color: string }> | null;
    loading: boolean; walkMin: number | null; lat: number; lng: number;
  } | null>(null);
  const selectedStopRef = useRef<{ lat: number; lng: number; stopCode: string } | null>(null);

  const onStopPress = useCallback(async (stop: { lat: number; lng: number; name: string; code: string }) => {
    setWalkCoords([]);
    selectedStopRef.current = { lat: stop.lat, lng: stop.lng, stopCode: stop.code };
    setStopLines(null);
    setSelectedStop({ name: stop.name, stopCode: stop.code, arrivals: null, loading: true, walkMin: null, lat: stop.lat, lng: stop.lng });

    const ul = userLocationRef.current;
    const [arrivalsResult, walkResult] = await Promise.allSettled([
      getStopArrivals(stop.code),
      ul ? getWalkingRoute(ul.lat, ul.lng, stop.lat, stop.lng) : Promise.resolve(null),
    ]);
    const arrivals = arrivalsResult.status === 'fulfilled' ? arrivalsResult.value ?? [] : [];
    const walkRoute = walkResult.status === 'fulfilled' ? walkResult.value : null;

    let walkMin: number | null = null;
    if (walkRoute && walkRoute.coords.length > 1) {
      walkMin = Math.round(walkRoute.durationSec / 60);
      setWalkCoords(walkRoute.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] })));
    }

    const filtered = (arrivals ?? []).filter((a) => lineRouteCodes.has(a.route_code));
    if (filtered.length === 0) {
      setSelectedStop({ name: stop.name, stopCode: stop.code, arrivals: [], loading: false, walkMin, lat: stop.lat, lng: stop.lng });
    } else {
      const sorted = [...filtered].sort((a, b) => Number(a.btime2) - Number(b.btime2));
      const items = sorted.slice(0, 5).map((a) => {
        const min = Number(a.btime2);
        return { min, color: getArrivalColor(min) };
      });
      setSelectedStop({ name: stop.name, stopCode: stop.code, arrivals: items, loading: false, walkMin, lat: stop.lat, lng: stop.lng });
    }
  }, [lineRouteCodes]);

  // Auto-refresh arrivals
  useEffect(() => {
    if (!selectedStop || !selectedStop.stopCode) return;
    const code = selectedStop.stopCode;
    const id = setInterval(async () => {
      try {
        const arrivals = await getStopArrivals(code);
        const filtered = (arrivals ?? []).filter((a) => lineRouteCodes.has(a.route_code));
        const items = filtered.length === 0 ? [] :
          [...filtered].sort((a, b) => Number(a.btime2) - Number(b.btime2)).slice(0, 5).map((a) => {
            const min = Number(a.btime2);
            return { min, color: getArrivalColor(min) };
          });
        setSelectedStop((prev) => prev && prev.stopCode === code ? { ...prev, arrivals: items, loading: false } : prev);
      } catch {}
    }, POLL_INTERVAL * 1000);
    return () => clearInterval(id);
  }, [selectedStop?.stopCode, lineRouteCodes]);

  // Long press
  const onMapLongPress = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    setStampName(''); setStampEmoji('📍');
    setStampModal({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
  }, []);

  // One-shot bitmap capture: track for 500ms after stops/color change, then stop for perf
  const selectedStopCode = selectedStop?.stopCode ?? null;
  const [stopTracking, setStopTracking] = useState(true);
  useEffect(() => {
    setStopTracking(true);
    const t = setTimeout(() => setStopTracking(false), 500);
    return () => clearTimeout(t);
  }, [stopsWithBearings, primaryColor]);

  // One-shot bitmap capture for selected stop changes
  const [selectedTracking, setSelectedTracking] = useState(false);
  useEffect(() => {
    setSelectedTracking(true);
    const t = setTimeout(() => setSelectedTracking(false), 500);
    return () => clearTimeout(t);
  }, [selectedStopCode]);

  // One-shot bitmap capture for stamp markers
  const stampIds = useMemo(() => stamps.map((s) => s.id).join(','), [stamps]);
  const [stampTracking, setStampTracking] = useState(true);
  useEffect(() => {
    setStampTracking(true);
    const t = setTimeout(() => setStampTracking(false), 500);
    return () => clearTimeout(t);
  }, [stampIds]);

  const initialRegion = useMemo(() => {
    const loc = getLocation();
    return {
      latitude: loc ? loc.lat : 37.9838,
      longitude: loc ? loc.lng : 23.7275,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };
  }, []);

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: () => {
            const hasMultiple = allRoutes && allRoutes.length > 1;
            const activeRoute = allRoutes?.find((r) => r.RouteCode === activeRouteCode);
            const routeLabel = activeRoute ? (activeRoute.RouteDescrEng || activeRoute.RouteDescr) : '';
            return (
              <TouchableOpacity style={s.headerTitleWrap} disabled={!hasMultiple}
                onPress={() => setShowRouteMenu((v) => !v)} activeOpacity={0.7}>
                <View style={s.headerTitleRow}>
                  <Text style={s.headerLineId}>{lineId ?? ''}</Text>
                  {hasMultiple && (
                    <Ionicons name={showRouteMenu ? 'chevron-up' : 'chevron-down'}
                      size={16} color={colors.textMuted} style={{ marginLeft: 4 }} />
                  )}
                </View>
                {routeLabel ? <Text style={s.headerRouteDescr} numberOfLines={1}>{routeLabel}</Text> : null}
              </TouchableOpacity>
            );
          },
          headerRight: () => (
            <TouchableOpacity
              onPress={() => {
                if (fav) { removeFavorite(lineCode); setFav(false); }
                else { addFavorite({ lineCode, lineId: lineId ?? '', lineDescr: lineDescr ?? '', lineDescrEng: lineDescr ?? '' }); setFav(true); }
              }}
              hitSlop={12} style={{ marginRight: spacing.sm }}>
              <Ionicons name={fav ? 'heart' : 'heart-outline'} size={24} color={fav ? '#B91C1C' : colors.textMuted} />
            </TouchableOpacity>
          ),
        }}
      />

      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={ms.map}
        initialRegion={initialRegion}
        customMapStyle={GOOGLE_DARK_STYLE}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        onLongPress={onMapLongPress}
        moveOnMarkerPress={false}
      >
        {/* Route polyline */}
        {routePolyline.length > 1 && (
          <Polyline coordinates={routePolyline} strokeColor={primaryColor + 'AA'}
            strokeWidth={3.5} lineCap="round" lineJoin="round" zIndex={0} />
        )}

        {/* Walking route */}
        {walkCoords.length > 1 && (
          <Polyline coordinates={walkCoords} strokeColor="#4285F4"
            strokeWidth={4} lineDashPattern={[8, 6]} lineCap="round" lineJoin="round" />
        )}

        {/* Metro polylines */}
        {showMetro && metroData.map((line, i) => (
          <Polyline key={`mp-${i}`} coordinates={line.coords}
            strokeColor={line.color + '99'} strokeWidth={2.5} lineCap="round" />
        ))}

        {/* Stop markers — bus icon with directional arrow */}
        {stopsWithBearings.map((stop, i) => {
          const isSelected = selectedStopCode === stop.code;
          return (
          <Marker key={`st-${stop.code}-${i}-${primaryColor}`}
            coordinate={{ latitude: stop.lat, longitude: stop.lng }}
            anchor={{ x: 0.5, y: 0.65 }} tracksViewChanges={stopTracking || selectedTracking}
            rotation={stop.bearing}
            flat={true}
            zIndex={isSelected ? 1050 : 999}
            onPress={() => onStopPress(stop)}>
            <View style={s.stopMarkerOuter} collapsable={false}>
              <View style={[s.stopArrow, isSelected && { borderBottomColor: 'transparent' }]} />
              <View style={s.stopDotWrap}>
                {isSelected && <View style={[s.stopRing, { borderColor: primaryColor }]} />}
                <View style={[
                  s.stopDot,
                  isSelected
                    ? { backgroundColor: '#FFFFFF', borderColor: primaryColor, borderWidth: 3 }
                    : { backgroundColor: primaryColor },
                  { transform: [{ rotate: `${-stop.bearing}deg` }] },
                ]}>
                  <Ionicons name="bus" size={10} color={isSelected ? primaryColor : '#FFFFFF'} />
                </View>
              </View>
            </View>
          </Marker>
          );
        })}

        {/* Buses */}
        {busMarkerUri && busMarkers.map((bus) => (
          <Marker key={`bus-${bus.id}-${busStale}`}
            coordinate={{ latitude: bus.lat, longitude: bus.lng }}
            anchor={{ x: 0.5, y: BUS_MARKER_ANCHOR_Y }}
            zIndex={1100}
            opacity={busStale ? 0.35 : 1}
            image={{ uri: busMarkerUri }}
          />
        ))}

        {/* Stamps */}
        {showStamps && stamps.map((st) => (
          <Marker key={`stamp-${st.id}`}
            coordinate={{ latitude: st.lat, longitude: st.lng }}
            anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={stampTracking}
            onPress={() => {
              Alert.alert('Remove stamp?', `Delete "${st.name}"?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => setStamps(removeStamp(st.id)) },
              ]);
            }}>
            <View style={ms.stampMarker}>
              <Text style={ms.stampEmoji}>{st.emoji}</Text>
              <Text style={ms.stampLabel}>{st.name}</Text>
            </View>
          </Marker>
        ))}

        {/* User location */}
        {userLoc && (
          <Marker key={`user-${iconStyle}`}
            coordinate={{ latitude: userLoc.lat, longitude: userLoc.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={iconStyle !== 'cat' ? (userHeading ?? 0) : 0}
            tracksViewChanges={false} flat>
            {iconStyle === 'cat' ? (
              <Image source={{ uri: USER_MARKER_BASE64 }} style={ms.catIcon} />
            ) : (
              <View style={ms.userMarkerWrap}>
                {userHeading != null && (
                  <View style={ms.headingBeam}>
                    <HeadingBeam />
                  </View>
                )}
                <View style={ms.userDot}>
                  <View style={ms.userDotInner} />
                </View>
              </View>
            )}
          </Marker>
        )}
      </MapView>

      {/* Stop arrivals card + alert pill */}
      <View style={[s.leftStack, kbHeight > 0 && { bottom: kbHeight + spacing.sm }]}>
        {selectedStop && (
          <View style={[s.arrivalCard, stopLines && s.arrivalCardExpanded]}>
          <View style={ms.arrivalHeader}>
            <Text style={ms.arrivalName} numberOfLines={1}>{selectedStop.name}</Text>
            <View style={s.arrivalHeaderBtns}>
              <TouchableOpacity onPress={() => {
                if (isFavoriteStop(selectedStop.stopCode)) {
                  Alert.alert('Remove Stop', `Remove "${selectedStop.name}" from saved stops?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => {
                      removeFavoriteStop(selectedStop.stopCode);
                      setSelectedStop((prev) => prev ? { ...prev } : prev);
                    }},
                  ]);
                } else {
                  addFavoriteStop({ stopCode: selectedStop.stopCode, stopName: selectedStop.name, lat: selectedStop.lat, lng: selectedStop.lng });
                  setSelectedStop((prev) => prev ? { ...prev } : prev);
                }
              }} hitSlop={10}>
                <Ionicons
                  name={isFavoriteStop(selectedStop.stopCode) ? 'bookmark' : 'bookmark-outline'}
                  size={16}
                  color={isFavoriteStop(selectedStop.stopCode) ? primaryColor : colors.textMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => {
                if (arrivalAlert?.stopCode === selectedStop.stopCode) {
                  stopAlertWatch(); setShowAlertPicker(false);
                } else {
                  setShowAlertPicker((v) => !v);
                }
              }} hitSlop={10}>
                <Ionicons
                  name={arrivalAlert?.stopCode === selectedStop.stopCode ? 'notifications' : 'notifications-outline'}
                  size={16}
                  color={arrivalAlert?.stopCode === selectedStop.stopCode ? colors.warning : colors.textMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setSelectedStop(null); selectedStopRef.current = null; setStopLines(null); setWalkCoords([]); setShowAlertPicker(false); }} hitSlop={10}>
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          {showAlertPicker && (
            <Modal visible={true} transparent animationType="fade" onRequestClose={() => setShowAlertPicker(false)}>
              <TouchableOpacity style={s.alertOverlay} activeOpacity={1} onPress={() => setShowAlertPicker(false)}>
                <TouchableOpacity style={s.alertModal} activeOpacity={1} onPress={() => {}}>
                  <Text style={s.alertModalTitle}>Set Arrival Alert</Text>
                  <Text style={s.alertModalSubtitle}>{lineId} at {selectedStop.name}</Text>
                  <View style={s.alertPickerRow}>
                    <Text style={s.alertPickerLabel}>Alert when ≤</Text>
                    <TextInput
                      style={s.alertPickerInput}
                      value={alertThreshold}
                      onChangeText={setAlertThreshold}
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholderTextColor={colors.textMuted}
                      autoFocus
                    />
                    <Text style={s.alertPickerLabel}>min</Text>
                  </View>
                  <View style={s.alertModalBtns}>
                    <TouchableOpacity style={s.alertModalCancel} onPress={() => setShowAlertPicker(false)}>
                      <Text style={s.alertModalCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.alertModalConfirm, { backgroundColor: primaryColor }]}
                      onPress={() => {
                        const min = parseInt(alertThreshold, 10);
                        if (!isNaN(min) && min > 0) {
                          startAlertWatch({
                            stopCode: selectedStop.stopCode,
                            stopName: selectedStop.name,
                            thresholdMin: min,
                            lineId: lineId ?? '',
                            routeCodes: [...lineRouteCodes],
                            color: primaryColor,
                          });
                          setShowAlertPicker(false);
                        }
                      }}>
                      <Ionicons name="notifications" size={16} color="#FFF" />
                      <Text style={s.alertModalConfirmText}>Start</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              </TouchableOpacity>
            </Modal>
          )}
          {selectedStop.walkMin !== null && (
            <View style={ms.walkRow}>
              <Ionicons name="walk" size={14} color="#4285F4" />
              <Text style={ms.walkText}>{selectedStop.walkMin} min walk</Text>
            </View>
          )}
          {selectedStop.loading ? (
            <ActivityIndicator size="small" color={colors.primaryLight} style={{ marginTop: 6 }} />
          ) : selectedStop.arrivals && selectedStop.arrivals.length > 0 ? (
            selectedStop.arrivals.map((a, i) => (
              <View key={i} style={s.arrivalRow}>
                <View style={[s.arrivalBadge, { backgroundColor: a.color }]}>
                  <Text style={s.arrivalMin}>{a.min} min</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={ms.arrivalEmpty}>No arrivals right now</Text>
          )}
          {nextDeparture && (
            <View style={[s.nextDepRow, { marginTop: spacing.sm }]}>
              <Ionicons name="time-outline" size={12} color={colors.textMuted} />
              <Text style={s.nextDepLabel}> Next: {nextDeparture}</Text>
            </View>
          )}
          <TouchableOpacity style={s.allLinesBtn} activeOpacity={0.7}
            onPress={async () => {
              if (stopLines) { setStopLines(null); return; }
              setLoadingStopLines(true);
              try {
                let routes: Awaited<ReturnType<typeof getRoutesForStop>> | null = null;
                let arrivals: Awaited<ReturnType<typeof getStopArrivals>> = [];
                try {
                  [routes, arrivals] = await Promise.all([
                    getRoutesForStop(selectedStop.stopCode), getStopArrivals(selectedStop.stopCode),
                  ]);
                  if (routes && routes.length > 0) setCachedRoutesForStop(selectedStop.stopCode, routes);
                } catch {
                  routes = await getCachedRoutesForStop(selectedStop.stopCode);
                  arrivals = [];
                }
                const { lines } = buildLineGroups(routes ?? [], arrivals ?? [], linesMap);
                setStopLines(lines);
              } catch {} finally { setLoadingStopLines(false); }
            }}>
            {loadingStopLines ? (
              <ActivityIndicator size="small" color={primaryColor} />
            ) : (
              <>
                <Ionicons name={stopLines ? 'chevron-down' : 'bus-outline'} size={14} color={primaryColor} />
                <Text style={[s.allLinesBtnText, { color: primaryColor }]}>{stopLines ? 'Hide lines' : 'All lines'}</Text>
              </>
            )}
          </TouchableOpacity>
          {stopLines && stopLines.length > 0 && (
            <ScrollView style={s.stopLinesScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              {stopLines.map((line) => (
                <TouchableOpacity key={line.lineCode} style={s.stopLineRow} activeOpacity={0.7}
                  onPress={() => {
                    const info = linesMap.get(line.lineCode);
                    router.push({ pathname: '/map/[lineCode]', params: {
                      lineCode: line.lineCode, lineId: line.lineId,
                      lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
                    }});
                  }}>
                  <View style={[s.stopLineBadge, { backgroundColor: primaryColor }]}>
                    <Text style={s.stopLineBadgeText}>{line.lineId}</Text>
                  </View>
                  <Text style={s.stopLineDescr}>{line.lineDescrEng}</Text>
                  {line.nextMin != null ? (
                    <View style={[s.stopLineArrBadge, { backgroundColor: line.color }]}>
                      <Text style={s.stopLineArrMin}>{line.nextMin}'</Text>
                    </View>
                  ) : (
                    <Text style={s.stopLineNone}>—</Text>
                  )}
                  <Ionicons name="chevron-forward" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
        )}
      </View>

      {/* Route direction dropdown */}
      {showRouteMenu && allRoutes && allRoutes.length > 1 && (
        <View style={s.routeMenu}>
          {allRoutes.map((r) => (
            <TouchableOpacity key={r.RouteCode}
              style={[s.routeMenuItem, activeRouteCode === r.RouteCode && s.routeMenuItemActive]}
              onPress={() => {
                setActiveRouteCode(r.RouteCode); setShowRouteMenu(false);
                setSelectedStop(null); selectedStopRef.current = null;
                setStopLines(null); setWalkCoords([]);
              }}>
              <Text style={[s.routeMenuText, activeRouteCode === r.RouteCode && s.routeMenuTextActive]} numberOfLines={2}>
                {r.RouteDescrEng || r.RouteDescr}
              </Text>
              {activeRouteCode === r.RouteCode && <Ionicons name="checkmark" size={16} color={colors.primaryLight} />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Top right controls */}
      <View style={ms.topControls}>
        <TouchableOpacity
          style={[ms.toggleBtn, showSchedule && ms.toggleBtnActive, showSchedule && { borderColor: primaryColor }]}
          onPress={() => { const n = !showSchedule; setShowSchedule(n); setToggle('schedule', n); }}>
          <Ionicons name="time-outline" size={18} color={showSchedule ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[ms.toggleBtn, showMetro && ms.toggleBtnActive, showMetro && { borderColor: primaryColor }]}
          onPress={() => { const n = !showMetro; setShowMetro(n); setToggle('metro', n); }}>
          <Ionicons name="train-outline" size={18} color={showMetro ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[ms.toggleBtn, showStamps && ms.toggleBtnActive, showStamps && { borderColor: primaryColor }]}
          onPress={() => { const n = !showStamps; setShowStamps(n); setToggle('stamps', n); }}>
          <Ionicons name="pin-outline" size={18} color={showStamps ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Bottom right controls */}
      <View style={ms.bottomControls}>
        <TouchableOpacity style={ms.locationBtn}
          onPress={() => {
            const loc = userLocationRef.current;
            if (loc && mapRef.current) {
              mapRef.current.animateToRegion({
                latitude: loc.lat, longitude: loc.lng,
                latitudeDelta: 0.01, longitudeDelta: 0.01,
              }, 500);
            }
          }}>
          <View style={ms.locationIcon}><View style={ms.locationDot} /></View>
        </TouchableOpacity>
        <RefreshTimer staleLabel={staleLabel} />
      </View>

      {/* Schedule overlay */}
      {showSchedule && (
        <View style={s.scheduleCard}>
          <View style={ms.arrivalHeader}>
            <Text style={[ms.arrivalName, { fontSize: font.size.xs }]}>Schedule</Text>
            <TouchableOpacity onPress={() => setShowSchedule(false)} hitSlop={10}>
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
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

      {!allRoutes && (
        <View style={ms.loaderOverlay}>
          <ActivityIndicator size="large" color={colors.primaryLight} />
        </View>
      )}

      <StampModal
        visible={!!stampModal}
        name={stampName} emoji={stampEmoji}
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

/* ── Styles ───────────────────────────────────────────────────── */

const s = StyleSheet.create({
  timerPill: {
    backgroundColor: colors.overlay,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  timerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  timerText: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stalePill: {
    backgroundColor: colors.overlay, borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    borderWidth: 1, borderColor: colors.warning,
    flexDirection: 'row', alignItems: 'center', gap: 3,
  },
  staleText: { color: colors.warning, fontSize: 9, fontWeight: '700' },
  headerTitleWrap: { alignItems: 'flex-start' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerLineId: { color: colors.text, fontSize: font.size.lg, fontWeight: '700' },
  headerRouteDescr: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '500', marginTop: 1, maxWidth: 220 },
  routeMenu: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, zIndex: 10,
  },
  routeMenuItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.sm,
  },
  routeMenuItemActive: { backgroundColor: colors.card },
  routeMenuText: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '500', flex: 1, marginRight: spacing.sm },
  routeMenuTextActive: { color: colors.text, fontWeight: '700' },
  leftStack: {
    position: 'absolute', bottom: spacing.xl * 2, left: spacing.sm,
  },
  arrivalCard: {
    backgroundColor: colors.overlay, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, minWidth: 160, maxWidth: 220,
  },
  arrivalCardExpanded: {
    minWidth: 300,
    maxWidth: 340,
  },
  arrivalRow: { marginTop: 4 },
  arrivalBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, alignSelf: 'flex-start' },
  arrivalMin: { color: '#000', fontSize: font.size.sm, fontWeight: '700' },
  scheduleCard: {
    position: 'absolute', top: spacing.sm, right: 36 + spacing.sm + spacing.sm,
    backgroundColor: colors.overlay, borderRadius: radius.md, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border, minWidth: 140, maxWidth: 200, maxHeight: 240,
  },
  nextDepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  nextDepLabel: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600' },
  scheduleScroll: { maxHeight: 160 },
  scheduleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  scheduleTime: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: colors.card },
  scheduleTimeText: { color: colors.text, fontSize: font.size.xs, fontWeight: '600', fontVariant: ['tabular-nums'] },
  scheduleTimePast: { color: colors.textMuted, opacity: 0.5 },
  scheduleTimeNextText: { color: '#FFF', fontWeight: '700' },
  allLinesBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    marginTop: spacing.sm, paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  allLinesBtnText: { fontSize: font.size.xs, fontWeight: '600' },
  stopLinesScroll: { maxHeight: 180, marginTop: spacing.xs },
  stopLineRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  stopLineBadge: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, marginRight: spacing.sm, minWidth: 40, alignItems: 'center' },
  stopLineBadgeText: { color: '#FFFFFF', fontSize: font.size.xs, fontWeight: '700' },
  stopLineDescr: { flex: 1, color: colors.textMuted, fontSize: font.size.xs, marginRight: spacing.sm },
  stopLineArrBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  stopLineArrMin: { color: '#000', fontSize: font.size.xs, fontWeight: '700' },
  stopLineNone: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
  /* ── Native map marker styles — bus icon + arrow ── */
  stopMarkerOuter: {
    width: 40, height: 40,
    alignItems: 'center',
  },
  stopArrow: {
    width: 0, height: 0,
    borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 10,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#FFFFFF',
    marginBottom: -2,
  },
  stopDot: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.6, shadowRadius: 3, elevation: 4,
  },
  stopDotWrap: {
    alignItems: 'center', justifyContent: 'center',
  },
  stopRing: {
    position: 'absolute',
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 2.5, borderColor: 'transparent',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  /* ── Arrival alert styles ── */
  arrivalHeaderBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertPickerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: spacing.lg,
  },
  alertPickerLabel: { color: colors.textMuted, fontSize: font.size.md, fontWeight: '600' },
  alertPickerInput: {
    color: colors.text, fontSize: font.size.lg, fontWeight: '700',
    backgroundColor: colors.card, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    minWidth: 52, textAlign: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  alertOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center',
  },
  alertModal: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.lg, minWidth: 280, maxWidth: 340,
    borderWidth: 1, borderColor: colors.border,
  },
  alertModalTitle: { color: colors.text, fontSize: font.size.lg, fontWeight: '700', marginBottom: spacing.xs },
  alertModalSubtitle: { color: colors.textMuted, fontSize: font.size.sm, marginBottom: spacing.md },
  alertModalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  alertModalCancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm },
  alertModalCancelText: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
  alertModalConfirm: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm,
  },
  alertModalConfirmText: { color: '#FFF', fontSize: font.size.sm, fontWeight: '700' },
  alertPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4,
    backgroundColor: colors.overlay, borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    borderWidth: 1, borderColor: colors.warning, marginBottom: spacing.xs,
  },
  alertPillText: { color: colors.warning, fontSize: font.size.xs, fontWeight: '700' },
});
