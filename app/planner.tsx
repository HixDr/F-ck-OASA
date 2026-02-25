/**
 * Trip Planner Screen — "Get Me There"
 *
 * Full-screen with Google Map (top ~60%) + results panel (bottom ~40%).
 * User drops origin (green, draggable) + destination (red, long-press) pins.
 * Finds direct and 1-transfer bus routes, ranked by estimated total time.
 * Requires offline data to be downloaded.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Dimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../src/theme';
import { GOOGLE_DARK_STYLE } from '../src/googleMapStyle';
import { mapStyles as ms } from '../src/mapStyles';
import { useSettings } from '../src/settings';
import { useLines } from '../src/hooks';
import { isOfflineDataDownloaded, getCachedStops, getStamps } from '../src/storage';
import { getLocation, subscribe as subscribeLocation } from '../src/location';
import { getArrivalColor } from '../src/mapUtils';
import { getWalkingRoute } from '../src/api';
import { haversine } from '../src/busInterpolation';
import { METRO_LINES } from '../src/metro';
import { planTrips, type TripOption } from '../src/planner';
import type { OasaLine, MapStamp } from '../src/types';

const { height: SCREEN_H } = Dimensions.get('window');
const MAP_HEIGHT = SCREEN_H * 0.55;
const WALK_SPEED_M_PER_MIN = 80;

/* ── Planner Screen ──────────────────────────────────────────── */

export default function PlannerScreen() {
  const router = useRouter();
  const { primaryColor } = useSettings();
  const { data: allLines } = useLines();

  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);

  // Offline gate
  const offlineReady = isOfflineDataDownloaded();

  // Metro + stamps
  const metroData = useMemo(() =>
    Object.values(METRO_LINES).map((line) => ({
      color: line.color,
      coords: line.stations.map((st) => ({ latitude: st.c[0], longitude: st.c[1] })),
    })), []);
  const stamps = useMemo<MapStamp[]>(() => getStamps(), []);

  // Pin state
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(() => {
    const loc = getLocation();
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  });
  const [destination, setDestination] = useState<{ lat: number; lng: number } | null>(null);

  // Results
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<TripOption[] | null>(null);
  const [tooClose, setTooClose] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected result for route highlight
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [highlightPolylines, setHighlightPolylines] = useState<
    Array<{ coords: { latitude: number; longitude: number }[]; color: string; dashed: boolean }>
  >([]);
  const [highlightMarkers, setHighlightMarkers] = useState<
    Array<{ lat: number; lng: number; label: string; color: string; type: 'board' | 'alight' | 'stop' }>
  >([]);

  // One-shot bitmap capture for highlight markers (prevents flicker)
  const [markerTracking, setMarkerTracking] = useState(false);
  useEffect(() => {
    if (highlightMarkers.length === 0) return;
    setMarkerTracking(true);
    const t = setTimeout(() => setMarkerTracking(false), 500);
    return () => clearTimeout(t);
  }, [highlightMarkers]);

  // Debounce
  const computeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);

  const mapRef = useRef<MapView>(null);

  // Set origin to GPS on first fix
  useEffect(() => {
    if (origin) return;
    const unsub = subscribeLocation((loc) => {
      setOrigin((prev) => prev ?? { lat: loc.lat, lng: loc.lng });
    });
    return unsub;
  }, [origin]);

  const initialRegion = useMemo(() => {
    const loc = getLocation();
    return {
      latitude: loc ? loc.lat : 37.9838,
      longitude: loc ? loc.lng : 23.7275,
      latitudeDelta: 0.015,
      longitudeDelta: 0.015,
    };
  }, []);

  // Compute trips when both pins are placed (debounced)
  const computeTrips = useCallback(() => {
    if (!origin || !destination || !offlineReady) return;
    if (computeTimer.current) clearTimeout(computeTimer.current);

    computeTimer.current = setTimeout(async () => {
      const gen = ++genRef.current;
      setLoading(true);
      setResults(null);
      setTooClose(false);
      setError(null);
      setSelectedIdx(null);
      setHighlightPolylines([]);
      setHighlightMarkers([]);

      try {
        const result = await planTrips(
          origin.lat, origin.lng,
          destination.lat, destination.lng,
          linesMap,
        );
        if (gen !== genRef.current) return; // stale
        if (result === 'too_close') {
          setTooClose(true);
          const walkDist = haversine(
            { lat: origin.lat, lng: origin.lng },
            { lat: destination.lat, lng: destination.lng },
          );
          setResults(null);
        } else {
          setResults(result);
        }
      } catch (err: any) {
        if (gen !== genRef.current) return;
        setError(err?.message || 'Failed to plan trips');
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    }, 500);
  }, [origin, destination, linesMap, offlineReady]);

  useEffect(() => {
    computeTrips();
    return () => { if (computeTimer.current) clearTimeout(computeTimer.current); };
  }, [computeTrips]);

  // Handle destination long-press
  const onMapLongPress = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    setDestination({ lat: latitude, lng: longitude });
  }, []);

  // Handle origin drag
  const onOriginDragEnd = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    setOrigin({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
  }, []);

  // Handle destination drag
  const onDestDragEnd = useCallback((e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    setDestination({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
  }, []);

  // Load route highlight on result tap
  const onResultTap = useCallback(async (idx: number) => {
    if (!results || !results[idx]) return;
    if (selectedIdx === idx) {
      // Deselect
      setSelectedIdx(null);
      setHighlightPolylines([]);
      setHighlightMarkers([]);
      return;
    }

    setSelectedIdx(idx);
    const trip = results[idx];
    const polys: typeof highlightPolylines = [];
    const markers: typeof highlightMarkers = [];

    // Walking route: origin pin → first board stop
    if (origin) {
      const boardStop = trip.legs[0].boardStop;
      const walkDist = haversine(
        { lat: origin.lat, lng: origin.lng },
        { lat: boardStop.lat, lng: boardStop.lng },
      );
      if (walkDist > 50) {
        try {
          const walk = await getWalkingRoute(origin.lat, origin.lng, boardStop.lat, boardStop.lng);
          if (walk && walk.coords.length > 1) {
            polys.push({
              coords: walk.coords.map((c) => ({ latitude: c[1], longitude: c[0] })),
              color: '#4285F4',
              dashed: true,
            });
          }
        } catch {}
      }
    }

    // Bus route polylines + stop markers for each leg
    const LEG_COLORS = [primaryColor, '#FF9800', '#9C27B0', '#009688'];
    for (let i = 0; i < trip.legs.length; i++) {
      const leg = trip.legs[i];
      const legColor = LEG_COLORS[i % LEG_COLORS.length];

      // Load stops between board and alight → draw polyline through them
      try {
        const routeStops = await getCachedStops(leg.routeCode);
        if (routeStops) {
          const boardIdx = leg.boardStop.orderInRoute;
          const alightIdx = leg.alightStop.orderInRoute;
          const stopCoords: { latitude: number; longitude: number }[] = [];

          for (let si = boardIdx; si <= alightIdx; si++) {
            const st = routeStops[si];
            if (!st) continue;
            const lat = parseFloat(st.StopLat);
            const lng = parseFloat(st.StopLng);
            stopCoords.push({ latitude: lat, longitude: lng });

            const isBoard = si === boardIdx;
            const isAlight = si === alightIdx;
            markers.push({
              lat, lng,
              label: isBoard ? 'Board' : isAlight ? 'Get off' : (st.StopDescrEng || st.StopDescr),
              color: isBoard ? '#22C55E' : isAlight ? '#F44336' : legColor,
              type: isBoard ? 'board' : isAlight ? 'alight' : 'stop',
            });
          }

          if (stopCoords.length > 1) {
            polys.push({ coords: stopCoords, color: legColor, dashed: false });
          }
        }
      } catch {}
    }

    // Walking route: last alight stop → destination pin
    if (destination) {
      const lastLeg = trip.legs[trip.legs.length - 1];
      const walkDist = haversine(
        { lat: lastLeg.alightStop.lat, lng: lastLeg.alightStop.lng },
        { lat: destination.lat, lng: destination.lng },
      );
      if (walkDist > 50) {
        try {
          const walk = await getWalkingRoute(
            lastLeg.alightStop.lat, lastLeg.alightStop.lng,
            destination.lat, destination.lng,
          );
          if (walk && walk.coords.length > 1) {
            polys.push({
              coords: walk.coords.map((c) => ({ latitude: c[1], longitude: c[0] })),
              color: '#4285F4',
              dashed: true,
            });
          }
        } catch {}
      }
    }

    // Transfer walk routes between consecutive legs
    for (let ti = 0; ti < trip.legs.length - 1; ti++) {
      const alight = trip.legs[ti].alightStop;
      const nextBoard = trip.legs[ti + 1].boardStop;
      const tDist = haversine(
        { lat: alight.lat, lng: alight.lng },
        { lat: nextBoard.lat, lng: nextBoard.lng },
      );
      if (tDist > 50) {
        try {
          const walk = await getWalkingRoute(alight.lat, alight.lng, nextBoard.lat, nextBoard.lng);
          if (walk && walk.coords.length > 1) {
            polys.push({
              coords: walk.coords.map((c) => ({ latitude: c[1], longitude: c[0] })),
              color: '#4285F4',
              dashed: true,
            });
          }
        } catch {}
      }
    }

    setHighlightPolylines(polys);
    setHighlightMarkers(markers);
  }, [results, selectedIdx, origin, destination, primaryColor]);

  // Navigate to line map on arrow press
  const onResultNavigate = useCallback((trip: TripOption) => {
    const leg = trip.legs[0];
    const info = linesMap.get(leg.lineCode);
    router.push({
      pathname: '/map/[lineCode]',
      params: {
        lineCode: leg.lineCode,
        lineId: leg.lineId,
        lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? leg.lineDescr,
      },
    });
  }, [linesMap, router]);

  /* ── Offline data gate ──────────────────────────────────────── */

  if (!offlineReady) {
    return (
      <View style={[ms.container, { justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xl }]}>
        <Stack.Screen
          options={{
            headerStyle: { backgroundColor: colors.bg },
            headerTitle: 'Get Me There',
            headerTitleStyle: { color: colors.text, fontWeight: '700' },
          }}
        />
        <Ionicons name="cloud-download-outline" size={56} color={colors.border} />
        <Text style={s.offlineTitle}>Download offline data to use the trip planner</Text>
        <Text style={s.offlineSubtitle}>
          Go to Settings and download offline data first. The planner needs stop and schedule data to work.
        </Text>
        <TouchableOpacity
          style={[s.offlineBtn, { borderColor: primaryColor }]}
          activeOpacity={0.7}
          onPress={() => router.back()}
        >
          <Text style={[s.offlineBtnText, { color: primaryColor }]}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  /* ── Main Render ────────────────────────────────────────────── */

  const walkDistM = origin && destination
    ? haversine({ lat: origin.lat, lng: origin.lng }, { lat: destination.lat, lng: destination.lng })
    : 0;

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: 'Get Me There',
          headerTitleStyle: { color: colors.text, fontWeight: '700' },
        }}
      />

      {/* Map */}
      <View style={{ height: MAP_HEIGHT }}>
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
          {/* Metro polylines */}
          {metroData.map((line, i) => (
            <Polyline key={`mp-${i}`} coordinates={line.coords}
              strokeColor={line.color + '99'} strokeWidth={2.5} lineCap="round" />
          ))}

          {/* Stamps */}
          {stamps.map((st) => (
            <Marker key={`stamp-${st.id}`}
              coordinate={{ latitude: st.lat, longitude: st.lng }}
              anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}
            >
              <View style={ms.stampMarker}>
                <Text style={ms.stampEmoji}>{st.emoji}</Text>
                <Text style={ms.stampLabel}>{st.name}</Text>
              </View>
            </Marker>
          ))}

          {/* Origin pin — green, draggable */}
          {origin && (
            <Marker
              coordinate={{ latitude: origin.lat, longitude: origin.lng }}
              draggable
              onDragEnd={onOriginDragEnd}
              anchor={{ x: 0.5, y: 1 }}
              pinColor="#22C55E"
            />
          )}

          {/* Destination pin — red, draggable */}
          {destination && (
            <Marker
              coordinate={{ latitude: destination.lat, longitude: destination.lng }}
              draggable
              onDragEnd={onDestDragEnd}
              anchor={{ x: 0.5, y: 1 }}
              pinColor="#F44336"
            />
          )}

          {/* Highlight polylines */}
          {highlightPolylines.map((poly, i) => (
            <Polyline
              key={`poly-${i}`}
              coordinates={poly.coords}
              strokeColor={poly.color}
              strokeWidth={poly.dashed ? 4 : 3}
              lineDashPattern={poly.dashed ? [8, 6] : undefined}
              lineCap="round"
              lineJoin="round"
            />
          ))}

          {/* Highlight stop markers */}
          {highlightMarkers.map((m, i) => (
            <Marker
              key={`hm-${i}-${m.lat}-${m.lng}`}
              coordinate={{ latitude: m.lat, longitude: m.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={markerTracking}
            >
              {m.type === 'board' || m.type === 'alight' ? (
                <View style={[s.stopPinLarge, { backgroundColor: m.color }]}>
                  <Text style={s.stopPinLargeText}>{m.type === 'board' ? 'B' : 'X'}</Text>
                </View>
              ) : (
                <View style={[s.stopPin, { backgroundColor: m.color }]}>
                  <View style={s.stopPinInner} />
                </View>
              )}
            </Marker>
          ))}
        </MapView>

        {/* Location button */}
        <View style={[ms.bottomControls, { bottom: spacing.md, right: spacing.md }]}>
          <TouchableOpacity
            style={ms.locationBtn}
            onPress={() => {
              const loc = getLocation();
              if (loc && mapRef.current) {
                mapRef.current.animateToRegion({
                  latitude: loc.lat, longitude: loc.lng,
                  latitudeDelta: 0.015, longitudeDelta: 0.015,
                }, 500);
              }
            }}
          >
            <View style={ms.locationIcon}><View style={ms.locationDot} /></View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Results Panel */}
      <View style={s.panel}>
        <View style={s.panelHandle} />

        {/* Instruction or results */}
        {!destination ? (
          <View style={s.instructionWrap}>
            <Ionicons name="hand-left-outline" size={24} color={colors.textMuted} />
            <Text style={s.instructionText}>Long press on the map to drop your destination pin</Text>
          </View>
        ) : loading ? (
          <View style={s.loadingWrap}>
            <ActivityIndicator size="small" color={primaryColor} />
            <Text style={s.loadingText}>Finding routes…</Text>
          </View>
        ) : tooClose ? (
          <View style={s.instructionWrap}>
            <Ionicons name="walk-outline" size={24} color="#4285F4" />
            <Text style={s.instructionText}>
              Walk there directly — {Math.round(walkDistM / WALK_SPEED_M_PER_MIN)} min walk ({Math.round(walkDistM)}m)
            </Text>
          </View>
        ) : error ? (
          <View style={s.instructionWrap}>
            <Ionicons name="alert-circle-outline" size={24} color={colors.danger} />
            <Text style={[s.instructionText, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : results && results.length === 0 ? (
          <View style={s.instructionWrap}>
            <Ionicons name="bus-outline" size={24} color={colors.textMuted} />
            <Text style={s.instructionText}>
              No bus routes found between these points. Try moving the pins closer to a bus route.
            </Text>
          </View>
        ) : results ? (
          <ScrollView style={s.resultScroll} showsVerticalScrollIndicator={false}>
            {results.map((trip, idx) => (
              <TouchableOpacity
                key={idx}
                style={[
                  s.resultCard,
                  selectedIdx === idx && { borderColor: primaryColor },
                ]}
                activeOpacity={0.7}
                onPress={() => onResultTap(idx)}
              >
                {/* Walk to origin */}
                {trip.walkToOriginMin > 0 && (
                  <View style={s.legRow}>
                    <Ionicons name="walk-outline" size={14} color="#4285F4" />
                    <Text style={s.legWalkText}>{trip.walkToOriginMin} min walk</Text>
                  </View>
                )}

                {/* Legs */}
                {trip.legs.map((leg, li) => (
                  <View key={li}>
                    {li > 0 && (
                      <View style={s.legRow}>
                        <Ionicons name="swap-horizontal-outline" size={14} color={colors.textMuted} />
                        <Text style={s.legTransferText}>Transfer ({trip.transferWalkMin} min)</Text>
                      </View>
                    )}
                    {/* Line badge + wait time */}
                    <View style={s.legRow}>
                      <Ionicons name="bus" size={14} color={primaryColor} />
                      <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
                        <Text style={s.lineBadgeText}>{leg.lineId}</Text>
                      </View>
                      {leg.waitSource === 'live' && leg.waitTimeMin !== null ? (
                        <View style={[s.waitBadge, { backgroundColor: getArrivalColor(leg.waitTimeMin) }]}>
                          <Text style={s.waitBadgeText}>● {leg.waitTimeMin} min</Text>
                        </View>
                      ) : leg.waitSource === 'scheduled' && leg.scheduledTime ? (
                        <View style={[s.waitBadge, { backgroundColor: colors.border }]}>
                          <Text style={[s.waitBadgeText, { color: colors.textMuted }]}>○ {leg.scheduledTime}</Text>
                        </View>
                      ) : (
                        <Text style={s.waitUnknownText}>?</Text>
                      )}
                    </View>
                    {/* Board */}
                    <View style={s.legDetailRow}>
                      <Text style={s.legDetailText}>Board: {leg.boardStop.name}</Text>
                    </View>
                    {/* Get off */}
                    <View style={s.legDetailRow}>
                      <Text style={s.legDetailText}>Get off: {leg.alightStop.name}</Text>
                    </View>
                    {/* Stops + ride time */}
                    <View style={s.legDetailRow}>
                      <Text style={s.legDetailMuted}>{leg.stopCount} stops · ~{leg.rideTimeMin} min</Text>
                    </View>
                  </View>
                ))}

                {/* Walk from dest */}
                {trip.walkFromDestMin > 0 && (
                  <View style={s.legRow}>
                    <Ionicons name="walk-outline" size={14} color="#4285F4" />
                    <Text style={s.legWalkText}>{trip.walkFromDestMin} min walk</Text>
                  </View>
                )}

                {/* Total + ETA */}
                <View style={s.totalRow}>
                  <View>
                    <Text style={s.totalText}>Total: ~{trip.totalTimeMin} min</Text>
                    <Text style={s.etaText}>
                      Arrive ~{(() => {
                        const d = new Date();
                        d.setMinutes(d.getMinutes() + trip.totalTimeMin);
                        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      })()}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={s.navBtn}
                    hitSlop={8}
                    onPress={() => onResultNavigate(trip)}
                  >
                    <Ionicons name="arrow-forward-circle" size={24} color={primaryColor} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

/* ── Styles ──────────────────────────────────────────────────── */

const s = StyleSheet.create({
  panel: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  panelHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  instructionWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  instructionText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
  },
  resultScroll: {
    flex: 1,
    paddingBottom: spacing.xl,
  },
  resultCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  legWalkText: {
    color: '#4285F4',
    fontSize: font.size.xs,
    fontWeight: '600',
    flex: 1,
  },
  legTransferText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
    flex: 1,
  },
  legBoardText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '600',
    flex: 1,
  },
  legDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
    paddingLeft: spacing.lg,
  },
  legDetailText: {
    color: colors.text,
    fontSize: font.size.xs,
    flex: 1,
  },
  legDetailMuted: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    flex: 1,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    minWidth: 36,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  waitBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.sm,
  },
  waitBadgeText: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  waitUnknownText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  totalText: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '700',
  },
  etaText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginTop: 2,
  },
  navBtn: {
    padding: spacing.xs,
  },
  stopPin: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopPinInner: {
    width: 4,
    height: 6,
    borderRadius: 1,
    backgroundColor: '#FFF',
  },
  stopPinLarge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopPinLargeText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '800',
  },
  offlineTitle: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: spacing.md,
  },
  offlineSubtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginTop: spacing.xs,
    lineHeight: 20,
  },
  offlineBtn: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  offlineBtnText: {
    fontSize: font.size.md,
    fontWeight: '700',
  },
});
