/**
 * Live Map screen — real-time bus positions on a dark-themed map.
 * Uses a WebView with Leaflet + CARTO Dark Matter tiles.
 * Polls getBusLocation every 10 seconds.
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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { getLocation, subscribe as subscribeLocation } from '../../src/location';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../src/theme';
import { useBusLocations, useStops, useRoutes, useMLInfo, useSchedule, useLines } from '../../src/hooks';
import { getStopArrivals, getWalkingRoute, getRoutesForStop } from '../../src/api';
import { isFavorite, addFavorite, removeFavorite, getStamps, addStamp, removeStamp, getToggle, setToggle, getCachedBusPositions, setCachedBusPositions } from '../../src/storage';
import { useNetworkStatus } from '../../src/network';
import { getUserMarkerSrc } from '../../src/userMarker';
import { buildStampsLayerJS } from '../../src/stamps';
import { buildBaseMapHTML } from '../../src/mapHtml';
import { mapStyles as ms } from '../../src/mapStyles';
import { useSettings } from '../../src/settings';
import StampModal from '../../src/components/StampModal';
import type { MapStamp, OasaLine, OasaRoute } from '../../src/types';

/* ── Bus icon SVG (location pin with bus) ────────────────────── */

const BUS_PIN_SVG = `
<svg width="36" height="50" viewBox="0 0 51.787 51.787" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M25.892,0c-7.646,0-13.845,6.198-13.845,13.845c0,1.494,0.244,2.929,0.68,4.274c0.981,3.461,12.292,33.668,12.292,33.668s12.014-27.703,13.83-33.096c0.565-1.511,0.891-3.14,0.891-4.848C39.738,6.199,33.539,0,25.892,0z M25.892,24.761c-6,0-10.865-4.867-10.865-10.865c0-6.003,4.865-10.868,10.865-10.868c6.003,0,10.866,4.865,10.866,10.868C36.758,19.894,31.895,24.761,25.892,24.761z" fill="#FFFFFF"/>
  <circle cx="25.892" cy="13.845" r="10.865" fill="#FFFFFF"/>
  <path d="M30.511,6.326h-9.237c-0.948,0-1.72,0.835-1.72,1.866v10.039c0,0.685,0.341,1.28,0.848,1.604v1.073c0,0.353,0.567,0.636,1.271,0.636c0.701,0,1.271-0.283,1.271-0.636v-0.812H24.5v-0.001h3.217v0.001h1.195v0.812c0,0.353,0.568,0.636,1.271,0.636s1.271-0.283,1.271-0.636v-1.116c0.471-0.334,0.78-0.907,0.78-1.562V8.191C32.232,7.162,31.461,6.326,30.511,6.326z M23.22,7.121h5.344V7.64H23.22V7.121z M24.291,17.061h-3.373v-1.248h3.373V17.061z M27.715,19.941h-3.217v-0.99h3.217V19.941z M31.037,17.061h-3.374v-1.248h3.374V17.061z M31.185,12.773c0,0.127-0.224,0.23-0.5,0.23H21.1c-0.275,0-0.499-0.104-0.499-0.23V8.339c0-0.128,0.224-0.232,0.499-0.232h9.585c0.276,0,0.5,0.104,0.5,0.232V12.773z" fill="#0F0814"/>
</svg>`;

/* ── Helpers ─────────────────────────────────────────────────── */

/** Build JS to inject bus markers into _busLayer */
function buildBusLayerJS(buses: Array<{ lat: number; lng: number; id: string }>, stale = false) {
  const opacity = stale ? '0.35' : '1';
  return `
    window._busLayer.clearLayers();
    var _bIcon = L.divIcon({html:'<div style="opacity:${opacity}">${BUS_PIN_SVG.replace(/'/g, "\\'").replace(/\n/g, '')}</div>',className:'bus-pin',iconSize:[36,50],iconAnchor:[18,50],popupAnchor:[0,-50]});
    ${buses.map((b) => `L.marker([${b.lat},${b.lng}],{icon:_bIcon}).addTo(window._busLayer);`).join('\n')}
    true;
  `;
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Generate JS to inject route stops + polyline into _routeLayer.
 *  Stop markers are created lazily — only at zoom >= 14 — to avoid
 *  DOM overhead when the whole route is in view.
 */
function buildRouteLayerJS(
  stops: Array<{ lat: number; lng: number; name: string; code: string }>,
  accentColor = '#7B2CBF',
) {
  const polylineCoords = stops.map((s) => `[${s.lat},${s.lng}]`).join(',');

  // Pre-compute bearing angles on the RN side so the WebView doesn't have to
  const stopDataEntries = stops.map((s, i) => {
    const safeName = s.name.replace(/'/g, "\\'");
    let angle = 0;
    if (i < stops.length - 1) {
      angle = bearingDeg(s.lat, s.lng, stops[i + 1].lat, stops[i + 1].lng);
    } else if (i > 0) {
      angle = bearingDeg(stops[i - 1].lat, stops[i - 1].lng, s.lat, s.lng);
    }
    return `{lat:${s.lat},lng:${s.lng},code:'${s.code}',name:'${safeName}',angle:${angle.toFixed(1)}}`;
  });

  // Fit map to route bounds so the whole line is visible and centered
  const fitBoundsJS = stops.length > 1
    ? `map.fitBounds([${polylineCoords}],{padding:[40,40],maxZoom:14});`
    : '';

  return `
    window._routeLayer.clearLayers();
    window._routeStopMarkers=[];
    window._routeStops=[${stopDataEntries.join(',')}];
    ${stops.length > 1 ? `L.polyline([${polylineCoords}],{color:'${accentColor}',weight:3.5,opacity:0.7,lineCap:'round',lineJoin:'round'}).addTo(window._routeLayer);` : ''}
    window._updateRouteStops=function(){
      var z=map.getZoom();
      var show=z>=14;
      if(show&&window._routeStopMarkers.length===0){
        window._routeStops.forEach(function(s){
          var svg='<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><g transform="rotate('+s.angle+',9,9)"><polygon points="9,0 6,6.5 12,6.5" fill="${accentColor}" stroke="#FFF" stroke-width="0.7" stroke-linejoin="round"/></g><circle cx="9" cy="9" r="5" fill="${accentColor}" stroke="#FFF" stroke-width="1.2"/><rect x="7.8" y="6" width="2.4" height="2.6" rx="0.6" fill="#FFF"/><rect x="8.3" y="8.5" width="1.4" height="3" rx="0.3" fill="#FFF"/></svg>';
          var icon=L.divIcon({html:svg,className:'stop-pin',iconSize:[18,18],iconAnchor:[9,9]});
          var m=L.marker([s.lat,s.lng],{icon:icon}).addTo(window._routeLayer);
          m.on('click',function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'stopTap',stopCode:s.code,lat:s.lat,lng:s.lng,name:s.name}));});
          window._routeStopMarkers.push(m);
        });
      }else if(!show&&window._routeStopMarkers.length>0){
        window._routeStopMarkers.forEach(function(m){window._routeLayer.removeLayer(m);});
        window._routeStopMarkers=[];
      }
    };
    map.off('zoomend',window._updateRouteStops);
    map.on('zoomend',window._updateRouteStops);
    window._updateRouteStops();
    ${fitBoundsJS}
    true;
  `;
}

/* ── Build line groups from routes + arrivals ────────────────── */

function buildLineGroups(
  routes: OasaRoute[],
  arrivals: Array<{ route_code: string; btime2: string }>,
  linesMap: Map<string, OasaLine>,
) {
  const routeToLine = new Map<string, string>();
  routes.forEach((r) => routeToLine.set(r.RouteCode, r.LineCode));

  const lineMinMap = new Map<string, number>();
  (arrivals ?? []).forEach((a) => {
    const lineCode = routeToLine.get(a.route_code);
    if (lineCode) {
      const min = Number(a.btime2);
      const prev = lineMinMap.get(lineCode);
      if (prev === undefined || min < prev) lineMinMap.set(lineCode, min);
    }
  });

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
        ? nextMin <= 2 ? '#F44336' : nextMin <= 5 ? '#F59E0B' : '#22C55E'
        : colors.textMuted;
    lines.push({
      lineCode: r.LineCode,
      lineId: lineInfo?.LineID ?? r.LineCode,
      lineDescrEng: lineInfo?.LineDescrEng ?? lineInfo?.LineDescr ?? '',
      nextMin,
      color,
    });
  });

  lines.sort((a, b) => {
    if (a.nextMin != null && b.nextMin != null) return a.nextMin - b.nextMin;
    if (a.nextMin != null) return -1;
    if (b.nextMin != null) return 1;
    return 0;
  });

  return lines;
}

/* ── Refresh countdown timer ─────────────────────────────────── */

const POLL_INTERVAL = 10; // seconds — matches useBusLocations refetchInterval

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
      onLayout={() => {
        if (nextY.current > 0) {
          scrollRef.current?.scrollTo({ y: Math.max(0, nextY.current - 40), animated: false });
        }
      }}
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
              onLayout={isNext ? (e) => { nextY.current = e.nativeEvent.layout.y; } : undefined}
            >
              <Text style={[s.scheduleTimeText, isPast && s.scheduleTimePast, isNext && s.scheduleTimeNextText]}>{t}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

/* ── Live Map Component ──────────────────────────────────────── */

export default function LiveMapScreen() {
  const router = useRouter();
  const { lineCode, lineId, lineDescr } = useLocalSearchParams<{
    lineCode: string;
    lineId: string;
    lineDescr: string;
  }>();

  // Fetch all routes for this line, auto-select first
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
  const userMarkerSrc = useMemo(() => getUserMarkerSrc(iconStyle, primaryColor), [iconStyle, primaryColor]);

  // Stop all-lines expansion state
  const [stopLines, setStopLines] = useState<Array<{
    lineCode: string; lineId: string; lineDescrEng: string; nextMin: number | null; color: string;
  }> | null>(null);
  const [loadingStopLines, setLoadingStopLines] = useState(false);

  // Stamp state
  const [stamps, setStamps] = useState<MapStamp[]>(() => getStamps());
  const [stampModal, setStampModal] = useState<{ lat: number; lng: number } | null>(null);
  const [stampName, setStampName] = useState('');
  const [stampEmoji, setStampEmoji] = useState('📍');

  // ML info for schedule lookup
  const { data: mlInfoData } = useMLInfo();
  const mlInfo = useMemo(() => {
    if (!mlInfoData || !lineCode) return null;
    return mlInfoData.find((m) => m.line_code === lineCode) ?? null;
  }, [mlInfoData, lineCode]);

  const { data: scheduleData, isLoading: loadingSchedule } = useSchedule(
    mlInfo?.ml_code,
    mlInfo?.sdc_code,
    lineCode,
  );

  // Parse schedule times and find next departure
  const scheduleTimes = useMemo(() => {
    if (!scheduleData) return [];
    const entries = [...(scheduleData.go ?? []), ...(scheduleData.come ?? [])];
    const times = entries
      .map((e) => {
        const match = e.sde_start1?.match(/(\d{2}):(\d{2})/);
        if (!match) return null;
        return `${match[1]}:${match[2]}`;
      })
      .filter((t): t is string => t !== null);
    // Deduplicate and sort
    return [...new Set(times)].sort();
  }, [scheduleData]);

  const nextDeparture = useMemo(() => {
    if (scheduleTimes.length === 0) return null;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const t of scheduleTimes) {
      const [h, m] = t.split(':').map(Number);
      if (h * 60 + m >= nowMin) return t;
    }
    return scheduleTimes[0]; // wrap to first departure tomorrow
  }, [scheduleTimes]);

  // Auto-select first route when routes load
  useEffect(() => {
    if (allRoutes && allRoutes.length > 0 && !activeRouteCode) {
      setActiveRouteCode(allRoutes[0].RouteCode);
    }
  }, [allRoutes, activeRouteCode]);

  const { data: buses, isLoading: loadingBuses } = useBusLocations(activeRouteCode);
  const { data: stops } = useStops(activeRouteCode);
  const isOnline = useNetworkStatus();
  const webViewRef = useRef<WebView>(null);
  const mapViewRef = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(getLocation());

  // Stale bus positions tracking
  const [staleBusTs, setStaleBusTs] = useState<number | null>(null);
  const staleLoadedRef = useRef(false);

  // Subscribe to global location updates
  useEffect(() => {
    return subscribeLocation(async (loc) => {
      userLocationRef.current = loc;
      if (webViewReady.current && webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          if(!window._userDot){window._userDot=L.marker([${loc.lat},${loc.lng}],{icon:window._catIcon,zIndexOffset:1000}).addTo(map);}else{window._userDot.setLatLng([${loc.lat},${loc.lng}]);}
          true;
        `);
      }

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
          setSelectedStop((prev) => prev ? { ...prev, walkMin } : prev);
        }
      }
    });
  }, []);

  const parsedBuses = useMemo(() => {
    if (!buses || buses.length === 0) return [];
    return buses.map((b) => ({
      lat: parseFloat(b.CS_LAT),
      lng: parseFloat(b.CS_LNG),
      id: b.VEH_NO,
    }));
  }, [buses]);

  // Persist bus positions whenever we get fresh data
  useEffect(() => {
    if (parsedBuses.length > 0 && activeRouteCode) {
      setCachedBusPositions(activeRouteCode, parsedBuses);
      setStaleBusTs(null); // clear stale flag — we have live data
    }
  }, [parsedBuses, activeRouteCode]);

  // Load cached bus positions when offline and no live data
  useEffect(() => {
    if (!activeRouteCode || staleLoadedRef.current) return;
    if (!isOnline && (!buses || buses.length === 0)) {
      staleLoadedRef.current = true;
      getCachedBusPositions(activeRouteCode).then((cached) => {
        if (cached && cached.buses.length > 0 && webViewReady.current) {
          webViewRef.current?.injectJavaScript(buildBusLayerJS(cached.buses, true));
          setStaleBusTs(cached.ts);
        }
      });
    }
  }, [activeRouteCode, isOnline, buses]);

  // Compute human-readable stale label
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
    return stops.map((s) => ({
      lat: parseFloat(s.StopLat),
      lng: parseFloat(s.StopLng),
      name: s.StopDescrEng || s.StopDescr,
      code: s.StopCode,
    }));
  }, [stops]);

  // Center on stops only (never recenter when buses refresh)
  const center: [number, number] = useMemo(() => {
    if (parsedStops.length > 0) return [parsedStops[0].lat, parsedStops[0].lng];
    return [37.9838, 23.7275]; // Athens center
  }, [parsedStops]);

  // Track WebView readiness
  const webViewReady = useRef(false);
  const pendingRouteUpdate = useRef<typeof parsedStops | null>(null);
  const pendingBusUpdate = useRef<typeof parsedBuses | null>(null);

  // Base map HTML — rebuilt when settings change
  const html = useMemo(
    () => buildBaseMapHTML(center, 13, userMarkerSrc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userMarkerSrc],
  );

  // Inject route layer (stops + polyline) when stops change
  useEffect(() => {
    if (parsedStops.length === 0) return;
    if (!webViewReady.current) {
      pendingRouteUpdate.current = parsedStops;
      return;
    }
    webViewRef.current?.injectJavaScript(buildRouteLayerJS(parsedStops, primaryColor));
  }, [parsedStops, primaryColor]);

  // Inject updated bus positions into the WebView on each poll cycle
  useEffect(() => {
    if (parsedBuses.length === 0) return;
    if (!webViewReady.current) {
      pendingBusUpdate.current = parsedBuses;
      return;
    }
    webViewRef.current?.injectJavaScript(buildBusLayerJS(parsedBuses));
  }, [parsedBuses]);

  // Handle messages from WebView (stop taps — fetch arrivals filtered to current line)
  const lineRouteCodes = useMemo(
    () => new Set((allRoutes ?? []).map((r) => r.RouteCode)),
    [allRoutes],
  );

  // Selected stop arrivals overlay state
  const [selectedStop, setSelectedStop] = useState<{
    name: string;
    stopCode: string;
    arrivals: Array<{ min: number; color: string }> | null;
    loading: boolean;
    walkMin: number | null;
    lat: number;
    lng: number;
  } | null>(null);

  // Ref mirror of selected stop for use inside location callback and polling
  const selectedStopRef = useRef<{ lat: number; lng: number; stopCode: string } | null>(null);

  const onWebViewMessage = useCallback(async (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        webViewReady.current = true;
        // Inject user location if it arrived before WebView was ready
        if (userLocationRef.current && webViewRef.current) {
          const { lat, lng } = userLocationRef.current;
          webViewRef.current.injectJavaScript(`
            if(!window._userDot){window._userDot=L.marker([${lat},${lng}],{icon:window._catIcon,zIndexOffset:1000}).addTo(map);}
            true;
          `);
        }
        if (pendingRouteUpdate.current) {
          webViewRef.current?.injectJavaScript(buildRouteLayerJS(pendingRouteUpdate.current, primaryColor));
          pendingRouteUpdate.current = null;
        }
        if (pendingBusUpdate.current) {
          webViewRef.current?.injectJavaScript(buildBusLayerJS(pendingBusUpdate.current));
          pendingBusUpdate.current = null;
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
        mapViewRef.current = { lat: msg.lat, lng: msg.lng, zoom: msg.zoom };
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
        setStopLines(null);
        setSelectedStop({ name: msg.name, stopCode: msg.stopCode, arrivals: null, loading: true, walkMin: null, lat: msg.lat, lng: msg.lng });

        // Fetch arrivals and walking route in parallel
        const userLoc = userLocationRef.current;
        const [arrivals, walkRoute] = await Promise.all([
          getStopArrivals(msg.stopCode),
          userLoc
            ? getWalkingRoute(userLoc.lat, userLoc.lng, msg.lat, msg.lng)
            : Promise.resolve(null),
        ]);

        // Draw walking route polyline on map
        let walkMin: number | null = null;
        if (walkRoute && walkRoute.coords.length > 1) {
          walkMin = Math.round(walkRoute.durationSec / 60);
          // OSRM returns [lng, lat] — swap to [lat, lng] for Leaflet
          const latLngs = walkRoute.coords.map((c: [number, number]) => `[${c[1]},${c[0]}]`).join(',');
          webViewRef.current?.injectJavaScript(`
            window._walkLayer.clearLayers();
            L.polyline([${latLngs}],{color:'#4285F4',weight:4,opacity:0.8,dashArray:'8 6',lineCap:'round',lineJoin:'round'}).addTo(window._walkLayer);
            true;
          `);
        }

        const filtered = (arrivals ?? []).filter((a) => lineRouteCodes.has(a.route_code));
        if (filtered.length === 0) {
          setSelectedStop({ name: msg.name, stopCode: msg.stopCode, arrivals: [], loading: false, walkMin, lat: msg.lat, lng: msg.lng });
        } else {
          const sorted = [...filtered].sort((a, b) => Number(a.btime2) - Number(b.btime2));
          const items = sorted.slice(0, 5).map((a) => {
            const min = Number(a.btime2);
            const color = min <= 2 ? '#F44336' : min <= 5 ? '#F59E0B' : '#22C55E';
            return { min, color };
          });
          setSelectedStop({ name: msg.name, stopCode: msg.stopCode, arrivals: items, loading: false, walkMin, lat: msg.lat, lng: msg.lng });
        }
      }
    } catch {}
  }, [lineRouteCodes]);

  // Auto-refresh stop arrivals every 10s while the card is open
  useEffect(() => {
    if (!selectedStop || !selectedStop.stopCode) return;
    const code = selectedStop.stopCode;
    const id = setInterval(async () => {
      try {
        const arrivals = await getStopArrivals(code);
        const filtered = (arrivals ?? []).filter((a) => lineRouteCodes.has(a.route_code));
        if (filtered.length === 0) {
          setSelectedStop((prev) => prev && prev.stopCode === code ? { ...prev, arrivals: [], loading: false } : prev);
        } else {
          const sorted = [...filtered].sort((a, b) => Number(a.btime2) - Number(b.btime2));
          const items = sorted.slice(0, 5).map((a) => {
            const min = Number(a.btime2);
            const color = min <= 2 ? '#F44336' : min <= 5 ? '#F59E0B' : '#22C55E';
            return { min, color };
          });
          setSelectedStop((prev) => prev && prev.stopCode === code ? { ...prev, arrivals: items, loading: false } : prev);
        }
      } catch {}
    }, POLL_INTERVAL * 1000);
    return () => clearInterval(id);
  }, [selectedStop?.stopCode, lineRouteCodes]);

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: () => {
            const hasMultiple = allRoutes && allRoutes.length > 1;
            const activeRoute = allRoutes?.find((r) => r.RouteCode === activeRouteCode);
            const routeLabel = activeRoute
              ? (activeRoute.RouteDescrEng || activeRoute.RouteDescr)
              : '';
            return (
              <TouchableOpacity
                style={s.headerTitleWrap}
                disabled={!hasMultiple}
                onPress={() => setShowRouteMenu((v) => !v)}
                activeOpacity={0.7}
              >
                <View style={s.headerTitleRow}>
                  <Text style={s.headerLineId}>{lineId ?? ''}</Text>
                  {hasMultiple && (
                    <Ionicons
                      name={showRouteMenu ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={colors.textMuted}
                      style={{ marginLeft: 4 }}
                    />
                  )}
                </View>
                {routeLabel ? (
                  <Text style={s.headerRouteDescr} numberOfLines={1}>{routeLabel}</Text>
                ) : null}
              </TouchableOpacity>
            );
          },
          headerRight: () => (
            <TouchableOpacity
              onPress={() => {
                if (fav) {
                  removeFavorite(lineCode);
                  setFav(false);
                } else {
                  addFavorite({
                    lineCode,
                    lineId: lineId ?? '',
                    lineDescr: lineDescr ?? '',
                    lineDescrEng: lineDescr ?? '',
                  });
                  setFav(true);
                }
              }}
              hitSlop={12}
              style={{ marginRight: spacing.sm }}
            >
              <Ionicons
                name={fav ? 'heart' : 'heart-outline'}
                size={24}
                color={fav ? '#B91C1C' : colors.textMuted}
              />
            </TouchableOpacity>
          ),
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

      {/* Stop arrivals card — bottom left */}
      {selectedStop && (
        <View style={s.arrivalCard}>
          <View style={ms.arrivalHeader}>
            <Text style={ms.arrivalName} numberOfLines={1}>{selectedStop.name}</Text>
            <TouchableOpacity onPress={() => { setSelectedStop(null); selectedStopRef.current = null; setStopLines(null); webViewRef.current?.injectJavaScript('window._walkLayer.clearLayers();true;'); }} hitSlop={10}>
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
          {/* All lines toggle */}
          <TouchableOpacity
            style={s.allLinesBtn}
            activeOpacity={0.7}
            onPress={async () => {
              if (stopLines) { setStopLines(null); return; }
              setLoadingStopLines(true);
              try {
                const [routes, arrivals] = await Promise.all([
                  getRoutesForStop(selectedStop.stopCode),
                  getStopArrivals(selectedStop.stopCode),
                ]);
                setStopLines(buildLineGroups(routes ?? [], arrivals ?? [], linesMap));
              } catch {} finally { setLoadingStopLines(false); }
            }}
          >
            {loadingStopLines ? (
              <ActivityIndicator size="small" color={primaryColor} />
            ) : (
              <>
                <Ionicons name={stopLines ? 'chevron-down' : 'bus-outline'} size={14} color={primaryColor} />
                <Text style={[s.allLinesBtnText, { color: primaryColor }]}>{stopLines ? 'Hide lines' : 'All lines'}</Text>
              </>
            )}
          </TouchableOpacity>
          {/* Expanded lines list */}
          {stopLines && stopLines.length > 0 && (
            <ScrollView style={s.stopLinesScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              {stopLines.map((line) => (
                <TouchableOpacity
                  key={line.lineCode}
                  style={s.stopLineRow}
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
                  <View style={[s.stopLineBadge, { backgroundColor: primaryColor }]}>
                    <Text style={s.stopLineBadgeText}>{line.lineId}</Text>
                  </View>
                  <Text style={s.stopLineDescr} numberOfLines={1}>{line.lineDescrEng}</Text>
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

      {/* Route direction dropdown menu */}
      {showRouteMenu && allRoutes && allRoutes.length > 1 && (
        <View style={s.routeMenu}>
          {allRoutes.map((r) => (
            <TouchableOpacity
              key={r.RouteCode}
              style={[s.routeMenuItem, activeRouteCode === r.RouteCode && s.routeMenuItemActive]}
              onPress={() => {
                setActiveRouteCode(r.RouteCode);
                setShowRouteMenu(false);
                // Clear stale stop data from previous direction
                setSelectedStop(null);
                selectedStopRef.current = null;
                setStopLines(null);
                webViewRef.current?.injectJavaScript('window._walkLayer.clearLayers();true;');
              }}
            >
              <Text
                style={[s.routeMenuText, activeRouteCode === r.RouteCode && s.routeMenuTextActive]}
                numberOfLines={2}
              >
                {r.RouteDescrEng || r.RouteDescr}
              </Text>
              {activeRouteCode === r.RouteCode && (
                <Ionicons name="checkmark" size={16} color={colors.primaryLight} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Top right controls — schedule, metro, stamps toggles */}
      <View style={ms.topControls}>
        <TouchableOpacity
          style={[ms.toggleBtn, showSchedule && ms.toggleBtnActive, showSchedule && { borderColor: primaryColor }]}
          onPress={() => { const next = !showSchedule; setShowSchedule(next); setToggle('schedule', next); }}
        >
          <Ionicons name="time-outline" size={18} color={showSchedule ? primaryColor : colors.textMuted} />
        </TouchableOpacity>
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
                `map.setView([${loc.lat},${loc.lng}],15);true;`
              );
            }
          }}
        >
          <View style={ms.locationIcon}>
            <View style={ms.locationDot} />
          </View>
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

      {loadingBuses && (
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
  timerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  timerText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stalePill: {
    backgroundColor: colors.overlay,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.warning,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  staleText: {
    color: colors.warning,
    fontSize: 9,
    fontWeight: '700',
  },
  headerTitleWrap: {
    alignItems: 'flex-start',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerLineId: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
  },
  headerRouteDescr: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '500',
    marginTop: 1,
    maxWidth: 220,
  },
  routeMenu: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    zIndex: 10,
  },
  routeMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  routeMenuItemActive: {
    backgroundColor: colors.card,
  },
  routeMenuText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '500',
    flex: 1,
    marginRight: spacing.sm,
  },
  routeMenuTextActive: {
    color: colors.text,
    fontWeight: '700',
  },
  arrivalCard: {
    position: 'absolute',
    bottom: spacing.xl * 2,
    left: spacing.sm,
    backgroundColor: colors.overlay,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 160,
    maxWidth: 220,
  },
  arrivalRow: {
    marginTop: 4,
  },
  arrivalBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  arrivalMin: {
    color: '#000',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
  scheduleCard: {
    position: 'absolute',
    top: spacing.sm,
    right: 36 + spacing.sm + spacing.sm,
    backgroundColor: colors.overlay,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 140,
    maxWidth: 200,
    maxHeight: 240,
  },
  nextDepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  nextDepLabel: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  scheduleScroll: {
    maxHeight: 160,
  },
  scheduleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
  },
  scheduleTime: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  scheduleTimeNext: {
    backgroundColor: colors.primary,
  },
  scheduleTimeText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  scheduleTimePast: {
    color: colors.textMuted,
    opacity: 0.5,
  },
  scheduleTimeNextText: {
    color: '#FFF',
    fontWeight: '700',
  },
  allLinesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: spacing.sm,
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  allLinesBtnText: {
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  stopLinesScroll: {
    maxHeight: 180,
    marginTop: spacing.xs,
  },
  stopLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  stopLineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.sm,
    minWidth: 40,
    alignItems: 'center',
  },
  stopLineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  stopLineDescr: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginRight: spacing.sm,
  },
  stopLineArrBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  stopLineArrMin: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  stopLineNone: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
});
