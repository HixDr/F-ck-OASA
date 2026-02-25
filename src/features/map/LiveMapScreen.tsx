/**
 * Live Map screen — real-time bus positions on a dark-themed Google Map.
 * Uses react-native-maps (Google Maps provider) for native performance.
 * Polls getBusLocation every 10 seconds.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
  Keyboard,
  Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font } from '../../theme';
import { useBusLocations, useStops, useRoutes, useSchedule } from '../../hooks';
import { useLinesMap } from '../../hooks/useLinesMap';
import { useInitialRegion } from '../../hooks/useInitialRegion';
import { useUserLocation } from '../../hooks/useUserLocation';
import { useMarkerTracking } from '../../hooks/useMarkerTracking';
import { getStopArrivals, getWalkingRoute, getRoutesForStop, getRouteDetails } from '../../services/api';
import { isFavorite, addFavorite, removeFavorite, getStamps, addStamp, removeStamp, getToggle, setToggle, getCachedBusPositions, setCachedBusPositions, isFavoriteStop, addFavoriteStop, removeFavoriteStop, getCachedRoutesForStop, setCachedRoutesForStop } from '../../services/storage';
import { useNetworkStatus } from '../../services/network';
import { startAlertWatch, stopAlertWatch, subscribeAlertConfig, type AlertConfig } from '../../services/notifications';
import { useSettings } from '../settings/SettingsProvider';
import { GOOGLE_DARK_STYLE } from '../../theme/googleMapStyle';
import { METRO_POLYLINES } from '../../data/metroPolylines';
import { mapStyles as ms } from '../../theme/mapStyles';
import { buildLineGroups, getArrivalColor, type LineGroup } from './mapUtils';
import StampModal from '../../components/StampModal';
import ScheduleGrid from '../../components/ScheduleGrid';
import AlertPickerModal from '../../components/AlertPickerModal';
import UserLocationMarker from '../../components/UserLocationMarker';
import RefreshTimer from './components/RefreshTimer';
import { BusMarkerRenderer, BUS_MARKER_ANCHOR_Y } from '../../components/BusMarkerSvg';
import { BusInterpolator } from './busInterpolation';
import { bearingBetween } from '../../utils/geo';
import { s } from './LiveMapScreen.styles';
import type { MapStamp } from '../../types';

const POLL_INTERVAL = 10;

/* ── Live Map Component ──────────────────────────────────────── */

export default function LiveMapScreen() {
  const router = useRouter();
  const { lineCode, lineId, lineDescr } = useLocalSearchParams<{
    lineCode: string;
    lineId: string;
    lineDescr: string;
  }>();

  const { data: allRoutes } = useRoutes(lineCode);
  const { linesMap } = useLinesMap();
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

  // User location + heading via shared hook
  const onLocationUpdate = useCallback(async (loc: { lat: number; lng: number }) => {
    const target = selectedStopRef.current;
    if (target) {
      const walk = await getWalkingRoute(loc.lat, loc.lng, target.lat, target.lng);
      if (walk && walk.coords.length > 1 && selectedStopRef.current) {
        const walkMin = Math.round(walk.durationSec / 60);
        setWalkCoords(walk.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] })));
        setSelectedStop((prev) => prev ? { ...prev, walkMin } : prev);
      }
    }
  }, []);
  const { userLocationRef, userLoc, userHeading } = useUserLocation(onLocationUpdate);

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

  // Walking route
  const [walkCoords, setWalkCoords] = useState<Array<{ latitude: number; longitude: number }>>([]);

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

  // Metro polyline data (pre-computed constant)
  const metroData = METRO_POLYLINES;

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

  // Marker bitmap tracking (burst-enable then disable for perf)
  const selectedStopCode = selectedStop?.stopCode ?? null;
  const stopTracking = useMarkerTracking([stopsWithBearings, primaryColor]);
  const selectedTracking = useMarkerTracking([selectedStopCode]);
  const userTracking = useMarkerTracking([userHeading], 400);
  const stampTracking = useMarkerTracking([stamps.map((s) => s.id).join(',')]);

  const initialRegion = useInitialRegion(0.05);

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
          <UserLocationMarker
            lat={userLoc.lat} lng={userLoc.lng}
            heading={userHeading} iconStyle={iconStyle}
            tracksViewChanges={userTracking}
          />
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
          <AlertPickerModal
              visible={showAlertPicker}
              subtitle={`${lineId} at ${selectedStop.name}`}
              threshold={alertThreshold}
              onChangeThreshold={setAlertThreshold}
              accentColor={primaryColor}
              onCancel={() => setShowAlertPicker(false)}
              onConfirm={() => {
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
              }}
            />
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
