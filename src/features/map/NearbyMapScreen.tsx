/**
 * Nearby Stops Map — shows bus stops near the user's location on a dark-themed Google Map.
 * Tapping a stop reveals all bus lines serving it, each pressable
 * to open that line's full route map with live tracking.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import MapView, { Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme';
import { useArrivals, useClosestStops, useRoutesForStop } from '../../hooks';
import { useLinesMap } from '../../hooks/useLinesMap';
import { useInitialRegion } from '../../hooks/useInitialRegion';
import { useUserLocation } from '../../hooks/useUserLocation';
import { getLocation } from '../../services/location';
import {
  getStamps, addStamp, removeStamp, getToggle, setToggle,
  isFavoriteStop, addFavoriteStop, removeFavoriteStop,
} from '../../services/storage';
import { GOOGLE_DARK_STYLE } from '../../theme/googleMapStyle';
import { METRO_POLYLINES } from '../../data/metroPolylines';
import { mapStyles as ms } from '../../theme/mapStyles';
import { buildLineGroups, coarseGrid, describeApiError } from './mapUtils';
import { haversineM } from '../../utils/geo';
import { useSettings } from '../settings/SettingsProvider';
import StampModal from '../../components/StampModal';
import UserLocationMarker from '../../components/UserLocationMarker';
import MapStatus from './components/MapStatus';
import StampLayer from './components/StampLayer';
import { NearbyStopMarker } from './components/StopMarkers';
import { useScreenFocused, useWalkingRoute } from './components/mapHooks';
import { s } from './NearbyMapScreen.styles';
import type { MapStamp } from '../../types';

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Grid size for the "stops near me" query key.
 *
 * At 3 decimal places (~111 m) every block walked minted a new key, and each
 * miss re-parsed ~2 MB of cached stops and sorted 9,382 of them on the JS
 * thread — a 100-300 ms freeze, mid-pan. Nothing useful changes inside 500 m.
 */
const NEARBY_GRID_M = 500;
/**
 * How far the user must walk from the anchoring fix before the cell is even
 * recomputed. Pure grid rounding flaps between two cells when you stand on a
 * boundary and GPS jitters, so the hysteresis, not the grid, is what actually
 * stops the refetching.
 */
const NEARBY_REFRESH_M = 400;

interface ParsedStop { lat: number; lng: number; name: string; code: string }

/* ── Nearby Map Component ────────────────────────────────────── */

export default function NearbyMapScreen() {
  const router = useRouter();
  const { linesMap } = useLinesMap();
  const { primaryColor, iconStyle } = useSettings();
  const focused = useScreenFocused();

  // Stamp state
  const [stamps, setStamps] = useState<MapStamp[]>(() => getStamps());
  const [stampModal, setStampModal] = useState<{ lat: number; lng: number } | null>(null);
  const [stampName, setStampName] = useState('');
  const [stampEmoji, setStampEmoji] = useState('📍');

  // Toggle state
  const [showMetro, setShowMetro] = useState(() => getToggle('metro', true));
  const [showStamps, setShowStamps] = useState(() => getToggle('stamps', true));

  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  /** True during a pan/zoom gesture; a refetch mid-gesture stutters the map. */
  const panningRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Grid cell we could not apply because the user was panning. */
  const pendingLoc = useRef<{ lat: number; lng: number } | null>(null);

  // User location via shared hook
  const [queryLoc, setQueryLoc] = useState<{ lat: number; lng: number } | null>(() => {
    const loc = getLocation();
    return loc ? coarseGrid(loc.lat, loc.lng, NEARBY_GRID_M) : null;
  });
  /** Fix the current query cell was derived from. */
  const anchor = useRef<{ lat: number; lng: number } | null>(getLocation());

  const applyGrid = useCallback((g: { lat: number; lng: number }) => {
    setQueryLoc((prev) => (prev && prev.lat === g.lat && prev.lng === g.lng ? prev : g));
  }, []);

  const onLocationUpdate = useCallback((loc: { lat: number; lng: number }) => {
    const from = anchor.current;
    if (from && haversineM(from.lat, from.lng, loc.lat, loc.lng) < NEARBY_REFRESH_M) return;
    anchor.current = loc;
    const grid = coarseGrid(loc.lat, loc.lng, NEARBY_GRID_M);
    // Re-keying the query mid-gesture re-runs the nearest-stops pass on the JS
    // thread while the map is animating. It can wait for the map to settle.
    if (panningRef.current) { pendingLoc.current = grid; return; }
    applyGrid(grid);
  }, [applyGrid]);

  const { userLocationRef, userLoc, userHeading } = useUserLocation({
    onLocationUpdate,
    highAccuracy: focused,
  });

  const {
    data: nearbyStops, isLoading: loadingStops, isFetching: fetchingStops,
    error: stopsError, refetch: refetchStops,
  } = useClosestStops(queryLoc?.lat, queryLoc?.lng);

  const initialRegion = useInitialRegion(0.01);

  // Fly to user location on first update — but only once the native map can
  // actually act on it. Before onMapReady this is a no-op on Android.
  const hasCentered = useRef(false);
  useEffect(() => {
    if (!mapReady || !userLoc || hasCentered.current) return;
    const map = mapRef.current;
    if (!map) return;
    map.animateToRegion({
      latitude: userLoc.lat, longitude: userLoc.lng,
      latitudeDelta: 0.01, longitudeDelta: 0.01,
    }, 500);
    hasCentered.current = true;
  }, [mapReady, userLoc]);

  const onRegionChangeStart = useCallback(() => {
    panningRef.current = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const onRegionChangeComplete = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      panningRef.current = false;
      const pending = pendingLoc.current;
      pendingLoc.current = null;
      if (pending) applyGrid(pending);
    }, 400);
  }, [applyGrid]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const parsedStops = useMemo<ParsedStop[]>(() => {
    if (!nearbyStops) return [];
    return nearbyStops.map((st) => ({
      lat: parseFloat(st.StopLat), lng: parseFloat(st.StopLng),
      name: st.StopDescrEng || st.StopDescr, code: st.StopCode,
    }));
  }, [nearbyStops]);

  // Read through a ref so `onStopPress` stays stable — a new callback identity
  // would re-render every memoized marker whenever the stop list changed.
  const stopsByCode = useMemo(
    () => new Map(parsedStops.map((st) => [st.code, st])),
    [parsedStops],
  );
  const stopsByCodeRef = useRef(stopsByCode);
  stopsByCodeRef.current = stopsByCode;

  // Metro polyline data (pre-computed constant)
  const metroLines = useMemo(() => METRO_POLYLINES.map((line, i) => (
    <Polyline key={`mp-${i}`} coordinates={line.coords}
      strokeColor={line.color + '99'} strokeWidth={2.5} lineCap="round" />
  )), []);

  /* ── Selected stop ─────────────────────────────────────────── */

  const [selectedStop, setSelectedStop] = useState<ParsedStop | null>(null);
  const selectedStopCode = selectedStop?.code ?? null;

  // React Query owns both fetches, keyed by stop code — a slow response for
  // stop A can no longer land in stop B's card, and the 15s hand-rolled
  // interval that kept running while backgrounded is gone.
  const { data: stopRoutes, isLoading: loadingRoutes } = useRoutesForStop(selectedStopCode ?? undefined);
  const arrivalsQuery = useArrivals(selectedStopCode ?? undefined, focused);
  // Placeholder data across a key change is the *previous* stop's arrivals;
  // merging it here would put stop A's times on stop B's line list.
  const arrivals = arrivalsQuery.isPlaceholderData ? undefined : arrivalsQuery.data;

  const lines = useMemo(() => {
    if (!stopRoutes) return null;
    return buildLineGroups(stopRoutes, arrivals ?? [], linesMap).lines;
  }, [stopRoutes, arrivals, linesMap]);

  const walkTarget = useMemo(
    () => (selectedStop ? { lat: selectedStop.lat, lng: selectedStop.lng, key: selectedStop.code } : null),
    [selectedStop],
  );
  const walk = useWalkingRoute(walkTarget, userLoc);

  const onStopPress = useCallback((code: string) => {
    const st = stopsByCodeRef.current.get(code);
    if (st) setSelectedStop(st);
  }, []);

  const closeStop = useCallback(() => setSelectedStop(null), []);

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

  const headerOptions = useMemo(() => ({
    headerStyle: { backgroundColor: colors.bg },
    headerTitle: 'Nearby Stops',
    headerTitleStyle: { color: colors.text, fontWeight: '700' as const },
  }), []);

  // Only the very first load may take the screen. Dimming the whole map on
  // every background refetch made it strobe while walking.
  const firstLoad = loadingStops && parsedStops.length === 0;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const errorMessage = stopsError ? describeApiError(stopsError, 'Loading nearby stops') : null;
  const visibleError = errorMessage && errorMessage !== dismissedError ? errorMessage : null;

  return (
    <View style={ms.container}>
      <Stack.Screen options={headerOptions} />

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
        onMapReady={onMapReady}
        onLongPress={onMapLongPress}
        onRegionChangeStart={onRegionChangeStart}
        onRegionChangeComplete={onRegionChangeComplete}
        moveOnMarkerPress={false}
      >
        {/* Walking route */}
        {walk.coords.length > 1 && (
          <Polyline coordinates={walk.coords} strokeColor="#4285F4"
            strokeWidth={4} lineDashPattern={[8, 6]} lineCap="round" lineJoin="round" />
        )}

        {/* Metro polylines */}
        {showMetro && metroLines}

        {/* Nearby stop markers */}
        {parsedStops.map((stop) => (
          <NearbyStopMarker
            key={`stop-${stop.code}`}
            code={stop.code}
            lat={stop.lat}
            lng={stop.lng}
            color={primaryColor}
            onPress={onStopPress}
          />
        ))}

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

      {/* Stop card */}
      {selectedStop && (
        <View style={s.arrivalCard}>
          <View style={ms.arrivalHeader}>
            <Text style={ms.arrivalName} numberOfLines={1}>{selectedStop.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity onPress={toggleStopSaved} hitSlop={10}>
                <Ionicons
                  name={stopSaved ? 'bookmark' : 'bookmark-outline'}
                  size={16}
                  color={stopSaved ? primaryColor : colors.textMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={closeStop} hitSlop={10}>
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          {walk.walkMin !== null && (
            <View style={ms.walkRow}>
              <Ionicons name="walk" size={14} color="#4285F4" />
              <Text style={ms.walkText}>{walk.walkMin} min walk</Text>
            </View>
          )}
          {loadingRoutes ? (
            <ActivityIndicator size="small" color={colors.primaryLight} style={{ marginTop: 6 }} />
          ) : lines && lines.length > 0 ? (
            <ScrollView style={s.lineScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              {lines.map((line) => (
                <TouchableOpacity key={line.lineCode} style={s.lineRow} activeOpacity={0.7}
                  onPress={() => {
                    const info = linesMap.get(line.lineCode);
                    router.push({ pathname: '/map/[lineCode]', params: {
                      lineCode: line.lineCode, lineId: line.lineId,
                      lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
                    }});
                  }}>
                  <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
                    <Text style={s.lineBadgeText}>{line.lineId}</Text>
                  </View>
                  <Text style={s.lineDescr}>{line.lineDescrEng}</Text>
                  {line.nextMin != null ? (
                    <View style={[s.lineArrivalBadge, { backgroundColor: line.color }]}>
                      <Text style={s.lineArrivalMin}>{line.nextMin}'</Text>
                    </View>
                  ) : (
                    <Text style={s.lineNoArrivals}>—</Text>
                  )}
                  <Ionicons name="chevron-forward" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <Text style={ms.arrivalEmpty}>No lines found</Text>
          )}
        </View>
      )}

      {/* Top right controls */}
      <View style={ms.topControls}>
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
        <TouchableOpacity style={ms.locationBtn} onPress={recenter}>
          <View style={ms.locationIcon}><View style={ms.locationDot} /></View>
        </TouchableOpacity>
      </View>

      <MapStatus
        blocking={firstLoad}
        loadingLabel={firstLoad ? 'Finding stops near you…' : fetchingStops ? 'Updating…' : null}
        error={visibleError}
        onRetry={() => { setDismissedError(null); refetchStops(); }}
        onDismissError={() => setDismissedError(errorMessage)}
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
    </View>
  );
}
