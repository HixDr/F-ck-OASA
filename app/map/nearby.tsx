/**
 * Nearby Stops Map — shows bus stops near the user's location on a dark-themed Google Map.
 * Tapping a stop reveals all bus lines serving it, each pressable
 * to open that line's full route map with live tracking.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { getLocation, subscribe as subscribeLocation } from '../../src/location';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../src/theme';
import { useClosestStops, useLines } from '../../src/hooks';
import { getStopArrivals, getRoutesForStop, getWalkingRoute } from '../../src/api';
import { getStamps, addStamp, removeStamp, getToggle, setToggle } from '../../src/storage';
import { GOOGLE_DARK_STYLE } from '../../src/googleMapStyle';
import { METRO_LINES } from '../../src/metro';
import { mapStyles as ms } from '../../src/mapStyles';
import { buildLineGroups, getArrivalColor } from '../../src/mapUtils';
import { useSettings } from '../../src/settings';
import { USER_MARKER_BASE64 } from '../../src/userMarker';
import StampModal from '../../src/components/StampModal';
import type { OasaLine, MapStamp } from '../../src/types';

/* ── Helpers ─────────────────────────────────────────────────── */

const REFRESH_INTERVAL = 15;

/* ── Nearby Map Component ────────────────────────────────────── */

export default function NearbyMapScreen() {
  const router = useRouter();
  const { data: allLines } = useLines();
  const { primaryColor, iconStyle } = useSettings();

  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);

  // Stamp state
  const [stamps, setStamps] = useState<MapStamp[]>(() => getStamps());
  const [stampModal, setStampModal] = useState<{ lat: number; lng: number } | null>(null);
  const [stampName, setStampName] = useState('');
  const [stampEmoji, setStampEmoji] = useState('📍');

  // Toggle state
  const [showMetro, setShowMetro] = useState(() => getToggle('metro', true));
  const [showStamps, setShowStamps] = useState(() => getToggle('stamps', true));

  // User location
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(getLocation());
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(getLocation());
  const [queryLoc, setQueryLoc] = useState<{ lat: number; lng: number } | null>(() => {
    const loc = getLocation();
    if (!loc) return null;
    return { lat: Math.round(loc.lat * 1000) / 1000, lng: Math.round(loc.lng * 1000) / 1000 };
  });

  const { data: nearbyStops, isLoading: loadingStops } = useClosestStops(queryLoc?.lat, queryLoc?.lng);

  const mapRef = useRef<MapView>(null);
  const hasCentered = useRef(false);

  // Walking route
  const [walkCoords, setWalkCoords] = useState<Array<{ latitude: number; longitude: number }>>([]);

  const initialRegion = useMemo(() => {
    const loc = getLocation();
    return {
      latitude: loc ? loc.lat : 37.9838,
      longitude: loc ? loc.lng : 23.7275,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    };
  }, []);

  // Fly to user location on first update
  useEffect(() => {
    if (userLoc && !hasCentered.current && mapRef.current) {
      hasCentered.current = true;
      mapRef.current.animateToRegion({
        latitude: userLoc.lat, longitude: userLoc.lng,
        latitudeDelta: 0.01, longitudeDelta: 0.01,
      }, 500);
    }
  }, [userLoc]);

  // Subscribe to location updates
  useEffect(() => {
    return subscribeLocation(async (loc) => {
      userLocationRef.current = loc;
      setUserLoc(loc);

      const rounded = {
        lat: Math.round(loc.lat * 1000) / 1000,
        lng: Math.round(loc.lng * 1000) / 1000,
      };
      setQueryLoc((prev) => {
        if (prev && prev.lat === rounded.lat && prev.lng === rounded.lng) return prev;
        return rounded;
      });

      const target = selectedStopRef.current;
      if (target) {
        const walk = await getWalkingRoute(loc.lat, loc.lng, target.lat, target.lng);
        if (walk && walk.coords.length > 1 && selectedStopRef.current) {
          const walkMin = Math.round(walk.durationSec / 60);
          setWalkCoords(walk.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] })));
          setSelectedStop((prev) => (prev ? { ...prev, walkMin } : prev));
        }
      }
    });
  }, []);

  const parsedStops = useMemo(() => {
    if (!nearbyStops) return [];
    return nearbyStops.map((st) => ({
      lat: parseFloat(st.StopLat), lng: parseFloat(st.StopLng),
      name: st.StopDescrEng || st.StopDescr, code: st.StopCode,
    }));
  }, [nearbyStops]);

  // Metro polyline data
  const metroData = useMemo(() =>
    Object.values(METRO_LINES).map((line) => ({
      color: line.color,
      coords: line.stations.map((st) => ({ latitude: st.c[0], longitude: st.c[1] })),
    })), []);

  // One-shot bitmap capture: track for 300ms then stop for perf
  const [stopTracking, setStopTracking] = useState(true);
  useEffect(() => {
    setStopTracking(true);
    const t = setTimeout(() => setStopTracking(false), 500);
    return () => clearTimeout(t);
  }, [parsedStops, primaryColor]);

  // Selected stop state
  const [selectedStop, setSelectedStop] = useState<{
    name: string; stopCode: string; lat: number; lng: number;
    walkMin: number | null; loading: boolean;
    lines: Array<{ lineCode: string; lineId: string; lineDescrEng: string; nextMin: number | null; color: string; }> | null;
  } | null>(null);
  const selectedStopRef = useRef<{ lat: number; lng: number; stopCode: string } | null>(null);
  const selectedStopRoutesRef = useRef<Map<string, string>>(new Map());

  const onStopPress = useCallback(async (stop: { lat: number; lng: number; name: string; code: string }) => {
    setWalkCoords([]);
    selectedStopRef.current = { lat: stop.lat, lng: stop.lng, stopCode: stop.code };
    setSelectedStop({
      name: stop.name, stopCode: stop.code, lat: stop.lat, lng: stop.lng,
      walkMin: null, loading: true, lines: null,
    });

    const ul = userLocationRef.current;
    const [routes, arrivals, walkRoute] = await Promise.all([
      getRoutesForStop(stop.code),
      getStopArrivals(stop.code),
      ul ? getWalkingRoute(ul.lat, ul.lng, stop.lat, stop.lng) : Promise.resolve(null),
    ]);

    let walkMin: number | null = null;
    if (walkRoute && walkRoute.coords.length > 1) {
      walkMin = Math.round(walkRoute.durationSec / 60);
      setWalkCoords(walkRoute.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] })));
    }

    const { lines, routeToLine } = buildLineGroups(routes ?? [], arrivals ?? [], linesMap);
    selectedStopRoutesRef.current = routeToLine;

    setSelectedStop({
      name: stop.name, stopCode: stop.code, lat: stop.lat, lng: stop.lng,
      walkMin, loading: false, lines,
    });
  }, [linesMap]);

  // Auto-refresh arrivals
  useEffect(() => {
    if (!selectedStop || !selectedStop.stopCode || selectedStop.loading) return;
    const stopCode = selectedStop.stopCode;
    const routeToLine = selectedStopRoutesRef.current;

    const id = setInterval(async () => {
      try {
        const arrivals = await getStopArrivals(stopCode);
        const lineMinMap = new Map<string, number>();
        (arrivals ?? []).forEach((a) => {
          const lineCode = routeToLine.get(a.route_code);
          if (lineCode) {
            const min = Number(a.btime2);
            const prev = lineMinMap.get(lineCode);
            if (prev === undefined || min < prev) lineMinMap.set(lineCode, min);
          }
        });
        setSelectedStop((prev) => {
          if (!prev || prev.stopCode !== stopCode) return prev;
          const updatedLines = prev.lines?.map((l) => {
            const nextMin = lineMinMap.get(l.lineCode) ?? null;
            const color = nextMin != null ? getArrivalColor(nextMin) : colors.textMuted;
            return { ...l, nextMin, color };
          }) ?? null;
          return { ...prev, lines: updatedLines };
        });
      } catch {}
    }, REFRESH_INTERVAL * 1000);
    return () => clearInterval(id);
  }, [selectedStop?.stopCode, selectedStop?.loading]);

  const onMapLongPress = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    setStampName(''); setStampEmoji('📍');
    setStampModal({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
  }, []);

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: 'Nearby Stops',
          headerTitleStyle: { color: colors.text, fontWeight: '700' },
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
        onLongPress={onMapLongPress}
        moveOnMarkerPress={false}
      >
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

        {/* Nearby stop markers */}
        {parsedStops.map((stop, i) => (
          <Marker key={`stop-${stop.code}-${i}-${primaryColor}`}
            coordinate={{ latitude: stop.lat, longitude: stop.lng }}
            anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={stopTracking}
            onPress={() => onStopPress(stop)}>
            <View style={[s.stopPin, { backgroundColor: primaryColor }]}>
              <View style={s.stopPinInner} />
            </View>
          </Marker>
        ))}

        {/* Stamps */}
        {showStamps && stamps.map((st) => (
          <Marker key={`stamp-${st.id}`}
            coordinate={{ latitude: st.lat, longitude: st.lng }}
            anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={true}
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
          <Marker coordinate={{ latitude: userLoc.lat, longitude: userLoc.lng }}
            anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={true}>
            {iconStyle === 'cat' ? (
              <Image source={{ uri: USER_MARKER_BASE64 }} style={ms.catIcon} />
            ) : (
              <View style={ms.userDot}>
                <View style={ms.userDotInner} />
              </View>
            )}
          </Marker>
        )}
      </MapView>

      {/* Stop card */}
      {selectedStop && (
        <View style={s.arrivalCard}>
          <View style={ms.arrivalHeader}>
            <Text style={ms.arrivalName} numberOfLines={1}>{selectedStop.name}</Text>
            <TouchableOpacity
              onPress={() => {
                setSelectedStop(null); selectedStopRef.current = null;
                selectedStopRoutesRef.current = new Map(); setWalkCoords([]);
              }} hitSlop={10}>
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          {selectedStop.walkMin !== null && (
            <View style={ms.walkRow}>
              <Ionicons name="walk" size={14} color="#4285F4" />
              <Text style={ms.walkText}>{selectedStop.walkMin} min walk</Text>
            </View>
          )}
          {selectedStop.loading ? (
            <ActivityIndicator size="small" color={colors.primaryLight} style={{ marginTop: 6 }} />
          ) : selectedStop.lines && selectedStop.lines.length > 0 ? (
            <ScrollView style={s.lineScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              {selectedStop.lines.map((line) => (
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
                  <Text style={s.lineDescr} numberOfLines={1}>{line.lineDescrEng}</Text>
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
      </View>

      {loadingStops && (
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
    </View>
  );
}

/* ── Styles ───────────────────────────────────────────────────── */

const s = StyleSheet.create({
  arrivalCard: {
    position: 'absolute', bottom: spacing.xl * 2, left: spacing.sm, right: spacing.sm,
    backgroundColor: colors.overlay, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, maxHeight: 320,
  },
  lineScroll: { maxHeight: 220 },
  lineRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  lineBadge: {
    backgroundColor: colors.primary, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    marginRight: spacing.sm, minWidth: 40, alignItems: 'center',
  },
  lineBadgeText: { color: '#FFFFFF', fontSize: font.size.xs, fontWeight: '700' },
  lineDescr: { flex: 1, color: colors.textMuted, fontSize: font.size.xs, marginRight: spacing.sm },
  lineArrivalBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  lineArrivalMin: { color: '#000', fontSize: font.size.xs, fontWeight: '700' },
  lineNoArrivals: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
  /* ── Native map marker styles ── */
  stopPin: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  stopPinInner: { width: 4, height: 6, borderRadius: 1, backgroundColor: '#FFF' },
});
