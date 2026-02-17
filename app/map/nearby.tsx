/**
 * Nearby Stops Map — shows bus stops near the user's location on a dark-themed map.
 * Tapping a stop reveals all bus lines serving it, each pressable
 * to open that line's full route map with live tracking.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { getLocation, subscribe as subscribeLocation } from '../../src/location';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../src/theme';
import { useClosestStops, useLines } from '../../src/hooks';
import { getStopArrivals, getRoutesForStop, getWalkingRoute } from '../../src/api';
import { getStamps, addStamp, removeStamp, getToggle, setToggle } from '../../src/storage';
import { getUserMarkerSrc } from '../../src/userMarker';
import { buildStampsLayerJS } from '../../src/stamps';
import { buildBaseMapHTML } from '../../src/mapHtml';
import { mapStyles as ms } from '../../src/mapStyles';
import { useSettings } from '../../src/settings';
import StampModal from '../../src/components/StampModal';
import type { OasaLine, OasaRoute, MapStamp } from '../../src/types';

/* ── Nearby stop markers (no directional arrow) ──────────────── */

function buildNearbyStopsLayerJS(
  stops: Array<{ lat: number; lng: number; name: string; code: string }>,
  accentColor = '#7B2CBF',
) {
  const stopMarkersJS = stops
    .map((s) => {
      const safeName = s.name.replace(/'/g, "\\'");
      const svg = `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" fill="${accentColor}" stroke="#FFF" stroke-width="1.5"/><rect x="8" y="6" width="4" height="4" rx="0.8" fill="#FFF"/><rect x="8.8" y="10" width="2.4" height="4.5" rx="0.5" fill="#FFF"/></svg>`;
      const icon = `L.divIcon({html:'${svg.replace(/'/g, "\\'")}',className:'stop-pin',iconSize:[20,20],iconAnchor:[10,10]})`;
      return `(function(){var m=L.marker([${s.lat},${s.lng}],{icon:${icon}}).addTo(window._routeLayer);m.on('click',function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'stopTap',stopCode:'${s.code}',lat:${s.lat},lng:${s.lng},name:'${safeName}'}));});})();`;
    })
    .join('\n');

  return `
    window._routeLayer.clearLayers();
    ${stopMarkersJS}
    true;
  `;
}

/* ── Helpers ─────────────────────────────────────────────────── */

const REFRESH_INTERVAL = 15; // seconds for arrival refresh

/** Build line groups from routes + arrivals data */
function buildLineGroups(
  routes: OasaRoute[],
  arrivals: Array<{ route_code: string; btime2: string }>,
  linesMap: Map<string, OasaLine>,
) {
  // Map routeCode → lineCode
  const routeToLine = new Map<string, string>();
  routes.forEach((r) => routeToLine.set(r.RouteCode, r.LineCode));

  // Group arrivals by lineCode — keep the soonest arrival per line
  const lineMinMap = new Map<string, number>();
  (arrivals ?? []).forEach((a) => {
    const lineCode = routeToLine.get(a.route_code);
    if (lineCode) {
      const min = Number(a.btime2);
      const prev = lineMinMap.get(lineCode);
      if (prev === undefined || min < prev) lineMinMap.set(lineCode, min);
    }
  });

  // Collect unique lines serving this stop
  const seenLines = new Set<string>();
  const lines: Array<{
    lineCode: string;
    lineId: string;
    lineDescrEng: string;
    nextMin: number | null;
    color: string;
  }> = [];

  routes.forEach((r) => {
    if (seenLines.has(r.LineCode)) return;
    seenLines.add(r.LineCode);

    const lineInfo = linesMap.get(r.LineCode);
    const nextMin = lineMinMap.get(r.LineCode) ?? null;
    const color =
      nextMin != null
        ? nextMin <= 2
          ? '#F44336'
          : nextMin <= 5
            ? '#F59E0B'
            : '#22C55E'
        : colors.textMuted;

    lines.push({
      lineCode: r.LineCode,
      lineId: lineInfo?.LineID ?? r.LineCode,
      lineDescrEng: lineInfo?.LineDescrEng ?? lineInfo?.LineDescr ?? '',
      nextMin,
      color,
    });
  });

  // Sort: lines with arrivals first (by time), then the rest
  lines.sort((a, b) => {
    if (a.nextMin != null && b.nextMin != null) return a.nextMin - b.nextMin;
    if (a.nextMin != null) return -1;
    if (b.nextMin != null) return 1;
    return 0;
  });

  return { lines, routeToLine };
}

/* ── Nearby Map Component ────────────────────────────────────── */

export default function NearbyMapScreen() {
  const router = useRouter();
  const { data: allLines } = useLines();
  const { primaryColor, iconStyle } = useSettings();
  const userMarkerSrc = useMemo(() => getUserMarkerSrc(iconStyle, primaryColor), [iconStyle, primaryColor]);

  /** LineCode → OasaLine lookup */
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

  // User location tracking
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(getLocation());
  const [queryLoc, setQueryLoc] = useState<{ lat: number; lng: number } | null>(() => {
    const loc = getLocation();
    if (!loc) return null;
    return {
      lat: Math.round(loc.lat * 1000) / 1000,
      lng: Math.round(loc.lng * 1000) / 1000,
    };
  });

  // Fetch nearby stops (re-fetches when user moves ~100m)
  const { data: nearbyStops, isLoading: loadingStops } = useClosestStops(
    queryLoc?.lat,
    queryLoc?.lng,
  );

  const webViewRef = useRef<WebView>(null);
  const webViewReady = useRef(false);
  const pendingStopsUpdate = useRef<
    Array<{ lat: number; lng: number; name: string; code: string }> | null
  >(null);

  // Map center — user location or Athens center
  const center: [number, number] = useMemo(() => {
    const loc = getLocation();
    if (loc) return [loc.lat, loc.lng];
    return [37.9838, 23.7275];
  }, []);

  const html = useMemo(
    () => buildBaseMapHTML(center, 15, userMarkerSrc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userMarkerSrc],
  );

  // Subscribe to location updates — user dot + nearby refetch
  useEffect(() => {
    return subscribeLocation(async (loc) => {
      userLocationRef.current = loc;

      // Update user dot on map
      if (webViewReady.current && webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          if(!window._userDot){window._userDot=L.marker([${loc.lat},${loc.lng}],{icon:window._catIcon,zIndexOffset:1000}).addTo(map);}else{window._userDot.setLatLng([${loc.lat},${loc.lng}]);}
          true;
        `);
      }

      // Refetch nearby stops when user moves ~100m
      const rounded = {
        lat: Math.round(loc.lat * 1000) / 1000,
        lng: Math.round(loc.lng * 1000) / 1000,
      };
      setQueryLoc((prev) => {
        if (prev && prev.lat === rounded.lat && prev.lng === rounded.lng) return prev;
        return rounded;
      });

      // Live-update walking route if a stop is selected
      const target = selectedStopRef.current;
      if (target && webViewReady.current && webViewRef.current) {
        const walk = await getWalkingRoute(loc.lat, loc.lng, target.lat, target.lng);
        if (walk && walk.coords.length > 1 && selectedStopRef.current) {
          const walkMin = Math.round(walk.durationSec / 60);
          const latLngs = walk.coords.map((c: [number, number]) => `[${c[1]},${c[0]}]`).join(',');
          webViewRef.current?.injectJavaScript(`
            window._walkLayer.clearLayers();
            L.polyline([${latLngs}],{color:'#4285F4',weight:4,opacity:0.8,dashArray:'8 6',lineCap:'round',lineJoin:'round'}).addTo(window._walkLayer);
            true;
          `);
          setSelectedStop((prev) => (prev ? { ...prev, walkMin } : prev));
        }
      }
    });
  }, []);

  // Parse nearby stops for map injection
  const parsedStops = useMemo(() => {
    if (!nearbyStops) return [];
    return nearbyStops.map((s) => ({
      lat: parseFloat(s.StopLat),
      lng: parseFloat(s.StopLng),
      name: s.StopDescrEng || s.StopDescr,
      code: s.StopCode,
    }));
  }, [nearbyStops]);

  // Inject stop markers when data changes
  useEffect(() => {
    if (parsedStops.length === 0) return;
    if (!webViewReady.current) {
      pendingStopsUpdate.current = parsedStops;
      return;
    }
    webViewRef.current?.injectJavaScript(buildNearbyStopsLayerJS(parsedStops, primaryColor));
  }, [parsedStops, primaryColor]);

  // Selected stop state
  const [selectedStop, setSelectedStop] = useState<{
    name: string;
    stopCode: string;
    lat: number;
    lng: number;
    walkMin: number | null;
    loading: boolean;
    lines: Array<{
      lineCode: string;
      lineId: string;
      lineDescrEng: string;
      nextMin: number | null;
      color: string;
    }> | null;
  } | null>(null);

  const selectedStopRef = useRef<{ lat: number; lng: number; stopCode: string } | null>(null);
  /** Route→Line mapping for the currently selected stop (used by arrival refresh) */
  const selectedStopRoutesRef = useRef<Map<string, string>>(new Map());

  // Handle WebView messages
  const onWebViewMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        if (msg.type === 'ready') {
          webViewReady.current = true;
          // Inject user location dot if available
          if (userLocationRef.current && webViewRef.current) {
            const { lat, lng } = userLocationRef.current;
            webViewRef.current.injectJavaScript(`
              if(!window._userDot){window._userDot=L.marker([${lat},${lng}],{icon:window._catIcon,zIndexOffset:1000}).addTo(map);}
              true;
            `);
          }
          if (pendingStopsUpdate.current) {
            webViewRef.current?.injectJavaScript(
              buildNearbyStopsLayerJS(pendingStopsUpdate.current, primaryColor),
            );
            pendingStopsUpdate.current = null;
          }
          // Inject saved stamps
          webViewRef.current?.injectJavaScript(buildStampsLayerJS(getStamps()));
          // Apply saved toggle states
          if (!getToggle('metro', true)) {
            webViewRef.current?.injectJavaScript('map.removeLayer(window._metroLayer);toggleMetroLabels();true;');
          }
          if (!getToggle('stamps', true)) {
            webViewRef.current?.injectJavaScript('if(window._stampLayer)map.removeLayer(window._stampLayer);true;');
          }
        } else if (msg.type === 'mapMove') {
          // noop — no tracking needed
        } else if (msg.type === 'mapLongPress') {
          setStampName('');
          setStampEmoji('📍');
          setStampModal({ lat: msg.lat, lng: msg.lng });
        } else if (msg.type === 'stampTap') {
          Alert.alert('Remove stamp?', `Delete "${msg.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                const updated = removeStamp(msg.id);
                setStamps(updated);
                webViewRef.current?.injectJavaScript(buildStampsLayerJS(updated));
              },
            },
          ]);
        } else if (msg.type === 'stopTap' && msg.stopCode) {
          // Clear previous walking route
          webViewRef.current?.injectJavaScript('window._walkLayer.clearLayers();true;');
          selectedStopRef.current = { lat: msg.lat, lng: msg.lng, stopCode: msg.stopCode };
          setSelectedStop({
            name: msg.name,
            stopCode: msg.stopCode,
            lat: msg.lat,
            lng: msg.lng,
            walkMin: null,
            loading: true,
            lines: null,
          });

          // Fetch routes, arrivals and walking route in parallel
          const userLoc = userLocationRef.current;
          const [routes, arrivals, walkRoute] = await Promise.all([
            getRoutesForStop(msg.stopCode),
            getStopArrivals(msg.stopCode),
            userLoc
              ? getWalkingRoute(userLoc.lat, userLoc.lng, msg.lat, msg.lng)
              : Promise.resolve(null),
          ]);

          // Draw walking route
          let walkMin: number | null = null;
          if (walkRoute && walkRoute.coords.length > 1) {
            walkMin = Math.round(walkRoute.durationSec / 60);
            const latLngs = walkRoute.coords
              .map((c: [number, number]) => `[${c[1]},${c[0]}]`)
              .join(',');
            webViewRef.current?.injectJavaScript(`
              window._walkLayer.clearLayers();
              L.polyline([${latLngs}],{color:'#4285F4',weight:4,opacity:0.8,dashArray:'8 6',lineCap:'round',lineJoin:'round'}).addTo(window._walkLayer);
              true;
            `);
          }

          // Build line groups
          const { lines, routeToLine } = buildLineGroups(
            routes ?? [],
            arrivals ?? [],
            linesMap,
          );
          selectedStopRoutesRef.current = routeToLine;

          setSelectedStop({
            name: msg.name,
            stopCode: msg.stopCode,
            lat: msg.lat,
            lng: msg.lng,
            walkMin,
            loading: false,
            lines,
          });
        }
      } catch {}
    },
    [linesMap],
  );

  // Auto-refresh stop arrivals every 15s while the card is open
  useEffect(() => {
    if (!selectedStop || !selectedStop.stopCode || selectedStop.loading) return;
    const stopCode = selectedStop.stopCode;
    const routeToLine = selectedStopRoutesRef.current;

    const id = setInterval(async () => {
      try {
        const arrivals = await getStopArrivals(stopCode);
        // Recompute per-line minimum arrival time
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
          const updatedLines =
            prev.lines?.map((l) => {
              const nextMin = lineMinMap.get(l.lineCode) ?? null;
              const color =
                nextMin != null
                  ? nextMin <= 2
                    ? '#F44336'
                    : nextMin <= 5
                      ? '#F59E0B'
                      : '#22C55E'
                  : colors.textMuted;
              return { ...l, nextMin, color };
            }) ?? null;
          return { ...prev, lines: updatedLines };
        });
      } catch {}
    }, REFRESH_INTERVAL * 1000);
    return () => clearInterval(id);
  }, [selectedStop?.stopCode, selectedStop?.loading]);

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: 'Nearby Stops',
          headerTitleStyle: { color: colors.text, fontWeight: '700' },
        }}
      />

      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html }}
        style={ms.map}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        onMessage={onWebViewMessage}
        startInLoadingState
        renderLoading={() => (
          <View style={ms.loader}>
            <ActivityIndicator size="large" color={colors.primaryLight} />
          </View>
        )}
      />

      {/* Stop card — shows all lines serving the tapped stop */}
      {selectedStop && (
        <View style={s.arrivalCard}>
          <View style={ms.arrivalHeader}>
            <Text style={ms.arrivalName} numberOfLines={1}>
              {selectedStop.name}
            </Text>
            <TouchableOpacity
              onPress={() => {
                setSelectedStop(null);
                selectedStopRef.current = null;
                selectedStopRoutesRef.current = new Map();
                webViewRef.current?.injectJavaScript('window._walkLayer.clearLayers();true;');
              }}
              hitSlop={10}
            >
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
            <ActivityIndicator
              size="small"
              color={colors.primaryLight}
              style={{ marginTop: 6 }}
            />
          ) : selectedStop.lines && selectedStop.lines.length > 0 ? (
            <ScrollView
              style={s.lineScroll}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {selectedStop.lines.map((line) => (
                <TouchableOpacity
                  key={line.lineCode}
                  style={s.lineRow}
                  activeOpacity={0.7}
                  onPress={() => {
                    const info = linesMap.get(line.lineCode);
                    router.push({
                      pathname: '/map/[lineCode]',
                      params: {
                        lineCode: line.lineCode,
                        lineId: line.lineId,
                        lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
                      },
                    });
                  }}
                >
                  <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
                    <Text style={s.lineBadgeText}>{line.lineId}</Text>
                  </View>
                  <Text style={s.lineDescr} numberOfLines={1}>
                    {line.lineDescrEng}
                  </Text>
                  {line.nextMin != null ? (
                    <View style={[s.lineArrivalBadge, { backgroundColor: line.color }]}>
                      <Text style={s.lineArrivalMin}>{line.nextMin}'</Text>
                    </View>
                  ) : (
                    <Text style={s.lineNoArrivals}>—</Text>
                  )}
                  <Ionicons
                    name="chevron-forward"
                    size={14}
                    color={colors.textMuted}
                    style={{ marginLeft: 4 }}
                  />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <Text style={ms.arrivalEmpty}>No lines found</Text>
          )}
        </View>
      )}

      {/* Top right controls — metro, stamps toggles */}
      <View style={ms.topControls}>
        <TouchableOpacity
          style={[ms.toggleBtn, showMetro && ms.toggleBtnActive, showMetro && { borderColor: primaryColor }]}
          onPress={() => {
            const next = !showMetro;
            setShowMetro(next);
            setToggle('metro', next);
            webViewRef.current?.injectJavaScript(
              next
                ? 'map.addLayer(window._metroLayer);toggleMetroLabels();true;'
                : 'map.removeLayer(window._metroLayer);toggleMetroLabels();true;'
            );
          }}
        >
          <Ionicons name="train-outline" size={18} color={showMetro ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[ms.toggleBtn, showStamps && ms.toggleBtnActive, showStamps && { borderColor: primaryColor }]}
          onPress={() => {
            const next = !showStamps;
            setShowStamps(next);
            setToggle('stamps', next);
            webViewRef.current?.injectJavaScript(
              next
                ? 'if(window._stampLayer)map.addLayer(window._stampLayer);true;'
                : 'if(window._stampLayer)map.removeLayer(window._stampLayer);true;'
            );
          }}
        >
          <Ionicons name="pin-outline" size={18} color={showStamps ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Bottom right controls */}
      <View style={ms.bottomControls}>
        <TouchableOpacity
          style={ms.locationBtn}
          onPress={() => {
            const loc = userLocationRef.current;
            if (loc && webViewRef.current) {
              webViewRef.current.injectJavaScript(
                `map.setView([${loc.lat},${loc.lng}],15);true;`,
              );
            }
          }}
        >
          <View style={ms.locationIcon}>
            <View style={ms.locationDot} />
          </View>
        </TouchableOpacity>
      </View>

      {loadingStops && (
        <View style={ms.loaderOverlay}>
          <ActivityIndicator size="large" color={colors.primaryLight} />
        </View>
      )}

      {/* Stamp creation modal */}
      <StampModal
        visible={!!stampModal}
        name={stampName}
        emoji={stampEmoji}
        onChangeName={setStampName}
        onChangeEmoji={setStampEmoji}
        onCancel={() => setStampModal(null)}
        onSave={() => {
          if (!stampModal || !stampName.trim()) return;
          const updated = addStamp({ name: stampName.trim(), emoji: stampEmoji, lat: stampModal.lat, lng: stampModal.lng });
          setStamps(updated);
          webViewRef.current?.injectJavaScript(buildStampsLayerJS(updated));
          setStampModal(null);
        }}
      />
    </View>
  );
}

/* ── Styles (screen-specific only — shared styles come from mapStyles) ── */

const s = StyleSheet.create({
  arrivalCard: {
    position: 'absolute',
    bottom: spacing.xl * 2,
    left: spacing.sm,
    right: spacing.sm,
    backgroundColor: colors.overlay,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: 320,
  },
  lineScroll: {
    maxHeight: 220,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineBadge: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.sm,
    minWidth: 40,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  lineDescr: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginRight: spacing.sm,
  },
  lineArrivalBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  lineArrivalMin: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  lineNoArrivals: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
});
