/**
 * Trip Planner Screen — "Get Me There"
 *
 * A full-bleed Google Map with a draggable results sheet floating over it.
 * User drops origin (green, draggable) + destination (red) pins, either with
 * the "Drop pin" control or with a long press on the map.
 * Finds direct and 1-transfer bus routes, ranked by when you actually arrive.
 * Requires offline data to be downloaded.
 *
 * The panel is honest about confidence: legs whose ride time was measured from
 * a live vehicle show exact clock times, legs derived from straight-line
 * distance show ranges. Precise-and-wrong is worse than vague-and-right.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { colors, onAccent, spacing } from '../../theme';
import { GOOGLE_DARK_STYLE } from '../../theme/googleMapStyle';
import { mapStyles as ms } from '../../theme/mapStyles';
import Pressable from '../../ui/Pressable';
import BottomSheet, { type BottomSheetHandle } from '../../ui/BottomSheet';
import { SkeletonTripCard } from '../../ui/Skeleton';
import { useSettings } from '../settings/SettingsProvider';
import { useLinesMap } from '../../hooks/useLinesMap';
import { useInitialRegion } from '../../hooks/useInitialRegion';
import { isOfflineDataDownloaded, getCachedStops, getStamps } from '../../services/storage';
import { getLocation, subscribe as subscribeLocation } from '../../services/location';
import { getArrivalColor } from '../map/mapUtils';
import { getWalkingRoute } from '../../services/api';
import { haversineM } from '../../utils/geo';
import { METRO_POLYLINES } from '../../data/metroPolylines';
import {
  planTrips,
  PlanCancelled,
  flushRideTimes,
  type TripOption,
  type TripLeg,
  type PlannerPhase,
  type NoneReason,
} from './planner';
import { LONG_WAIT_WARN_MIN } from './constants';
import TripCardShell from './components/TripCardShell';
import { num, s } from './PlannerScreen.styles';
import type { MapStamp, OasaStop } from '../../types';

/**
 * Sheet heights as fractions of the space below the status bar.
 *
 * Peek shows one card and the phase row; results is the resting size the old
 * fixed panel had; full is for reading a long list without the map stealing
 * two thirds of the screen.
 */
const SNAP_POINTS = [0.28, 0.55, 0.85];
/** Index into SNAP_POINTS. */
const PEEK_SNAP = 0;
const RESULTS_SNAP = 1;

/** How many placeholders stand in for the answer while the search runs. Three
 *  is what a typical plan returns, so the panel barely moves when they land. */
const SKELETON_COUNT = 3;

/** Native marker views are expensive on Android — each one is a snapshotted
 *  bitmap. A 3-leg trip with 40-stop legs used to emit ~120 of them and freeze
 *  the map for seconds. Board/alight pins are always drawn; the dots between
 *  them are sampled down to this many. */
const MAX_INTERMEDIATE_MARKERS = 12;

/** Colours for legs 2+; leg 1 uses the user's accent colour. */
const LEG_COLORS = ['#FF9800', '#9C27B0', '#009688'];
const WALK_COLOR = '#4285F4';

const PHASE_LABEL: Record<PlannerPhase, string> = {
  preparing: 'Reading offline data…',
  indexing: 'Building the route index…',
  searching: 'Searching for routes…',
  timing: 'Working out the timings…',
  live: 'Checking live bus times…',
  done: 'Almost there…',
};

const NONE_MESSAGE: Record<NoneReason, { title: string; detail: string }> = {
  no_offline_data: {
    title: 'Offline data is missing',
    detail: 'Download offline data in Settings — the planner needs stop and schedule data to work.',
  },
  no_stops_near_origin: {
    title: 'No stops near the start pin',
    detail: 'There is no bus stop within 1.2 km of the green pin. Move it closer to a road with buses.',
  },
  no_stops_near_dest: {
    title: 'No stops near the destination',
    detail: 'There is no bus stop within 1.2 km of the red pin. Move it closer to a road with buses.',
  },
  no_served_stops: {
    title: 'Those stops have no route data',
    detail: 'Stops are nearby, but none of them are on a route in the offline data. Re-downloading it in Settings may help.',
  },
  no_connection: {
    title: 'No route connects these points',
    detail: 'Nothing links these two areas with at most one transfer. Try moving a pin to a bigger road.',
  },
  no_service_now: {
    title: 'Nothing running right now',
    detail: 'Routes exist between these points, but none of them have service left today at this hour.',
  },
};

/* ── Types local to the screen ───────────────────────────────── */

interface HighlightPoly {
  coords: { latitude: number; longitude: number }[];
  color: string;
  dashed: boolean;
}
interface HighlightPin {
  lat: number;
  lng: number;
  color: string;
  type: 'board' | 'alight' | 'stop';
}
/** Which pin the next map tap will place, or null when tapping does nothing. */
type Placing = 'origin' | 'destination' | null;

/* ── Marker with layout-driven bitmap capture ────────────────── */

/**
 * `tracksViewChanges` must stay on until the native side has rasterised the
 * custom view, then go off or every map frame re-snapshots it. The old code
 * gave it a flat 500 ms from mount, which on a cold Android layout expires
 * before the view exists and leaves a blank pin. Layout is the actual signal.
 */
const HighlightMarkerView = React.memo(function HighlightMarkerView(
  { pin }: { pin: HighlightPin },
) {
  const [tracking, setTracking] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onLayout = useCallback(() => {
    if (timer.current) return;
    // One frame of slack after layout so the snapshot catches the painted view.
    timer.current = setTimeout(() => setTracking(false), 80);
  }, []);

  const big = pin.type !== 'stop';
  return (
    <Marker
      coordinate={{ latitude: pin.lat, longitude: pin.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracking}
    >
      {big ? (
        <View style={[s.stopPinLarge, { backgroundColor: pin.color }]} onLayout={onLayout}>
          <Text style={s.stopPinLargeText}>{pin.type === 'board' ? 'B' : 'X'}</Text>
        </View>
      ) : (
        <View style={[s.stopPin, { backgroundColor: pin.color }]} onLayout={onLayout}>
          <View style={s.stopPinInner} />
        </View>
      )}
    </Marker>
  );
});

/* ── Formatting helpers ──────────────────────────────────────── */

/** A trip whose ride times were all measured can be stated to the minute.
 *  Anything else gets a range, because that is what we actually know. */
function totalLabel(trip: TripOption): string {
  if (trip.confidence === 'measured' || trip.totalHighMin - trip.totalLowMin <= 2) {
    return `${trip.totalTimeMin} min`;
  }
  return `~${trip.totalLowMin}–${trip.totalHighMin} min`;
}

function arriveLabel(trip: TripOption): string {
  if (trip.confidence === 'measured' || trip.arriveHighMin - trip.arriveLowMin <= 2) {
    return `Arrive ${trip.arrivalTimeStr}`;
  }
  return `Arrive ${trip.arrivalTimeStr} (±${Math.round((trip.arriveHighMin - trip.arriveLowMin) / 2)} min)`;
}

function rideLabel(leg: TripLeg): string {
  const stops = `${leg.stopCount} stop${leg.stopCount === 1 ? '' : 's'}`;
  if (leg.rideSource === 'live') return `${stops} · ${leg.rideTimeMin} min on the bus · live`;
  if (leg.rideSource === 'empirical') {
    return `${stops} · ~${leg.rideLowMin}–${leg.rideHighMin} min · from past trips`;
  }
  return `${stops} · ~${leg.rideLowMin}–${leg.rideHighMin} min · estimated`;
}

/** Board/alight clock times are only worth printing when the ride time they
 *  rest on was measured; otherwise say "about". */
function stopTimeLabel(leg: TripLeg, which: 'board' | 'alight'): string {
  const t = which === 'board' ? leg.boardTimeStr : leg.alightTimeStr;
  if (!t) return '';
  const exact = which === 'board'
    ? leg.waitSource === 'live' || leg.waitSource === 'scheduled'
    : leg.rideSource === 'live';
  return exact ? ` · ${t}` : ` · ~${t}`;
}

const CONF_STYLE: Record<TripOption['confidence'], { label: string; color: string }> = {
  measured: { label: 'Live times', color: '#22C55E' },
  mixed: { label: 'Part live', color: '#F59E0B' },
  estimated: { label: 'Estimated', color: colors.textMuted },
};

/* ── Planner Screen ──────────────────────────────────────────── */

export default function PlannerScreen() {
  const router = useRouter();
  const { primaryColor } = useSettings();
  const { linesMap } = useLinesMap();

  const offlineReady = isOfflineDataDownloaded();

  const metroData = METRO_POLYLINES;
  const stamps = useMemo<MapStamp[]>(() => getStamps(), []);

  /* Read through the hook, not `Dimensions.get` at module scope: a module-level
     read is captured once on first import and is then wrong for the rest of the
     process after a rotation, a fold, or entering split screen. */
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Pin state
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(() => {
    const loc = getLocation();
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  });
  const [destination, setDestination] = useState<{ lat: number; lng: number } | null>(null);
  const [placing, setPlacing] = useState<Placing>(null);

  // Results
  const [phase, setPhase] = useState<PlannerPhase | null>(null);
  const [results, setResults] = useState<TripOption[] | null>(null);
  const [noneReason, setNoneReason] = useState<NoneReason | null>(null);
  const [tooClose, setTooClose] = useState<{ walkMin: number; distM: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  /** Bumped by the retry button to re-run the search effect. */
  const [retryTick, setRetryTick] = useState(0);

  // Route highlight
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightPolylines, setHighlightPolylines] = useState<HighlightPoly[]>([]);
  const [highlightMarkers, setHighlightMarkers] = useState<HighlightPin[]>([]);
  const [highlightLoading, setHighlightLoading] = useState(false);
  const [highlightError, setHighlightError] = useState<string | null>(null);

  const computeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planAbort = useRef<AbortController | null>(null);
  const highlightAbort = useRef<AbortController | null>(null);
  const mapRef = useRef<MapView>(null);
  const sheetRef = useRef<BottomSheetHandle>(null);

  const loading = phase !== null;

  /* The strip of map the sheet never covers. Mirrors BottomSheet's own height
     maths so `animateToRegion` centres on somewhere the user can actually see
     rather than under the panel. Recomputed on every window change, which is
     the point of the hook above. */
  const mapPadding = useMemo(
    () => ({
      top: 0,
      left: 0,
      right: 0,
      bottom: Math.round(SNAP_POINTS[PEEK_SNAP] * Math.max(1, winH - insets.top)),
    }),
    [winH, insets.top],
  );

  // Set origin to GPS on first fix
  useEffect(() => {
    if (origin) return;
    const unsub = subscribeLocation((loc) => {
      setOrigin((prev) => prev ?? { lat: loc.lat, lng: loc.lng });
    });
    return unsub;
  }, [origin]);

  const initialRegion = useInitialRegion(0.015);

  // Persist whatever ride times we learned when the screen goes away.
  useEffect(() => () => { void flushRideTimes(); }, []);

  const clearHighlight = useCallback(() => {
    highlightAbort.current?.abort();
    highlightAbort.current = null;
    setSelectedId(null);
    setHighlightPolylines([]);
    setHighlightMarkers([]);
    setHighlightLoading(false);
    setHighlightError(null);
  }, []);

  const cancelPlan = useCallback(() => {
    planAbort.current?.abort();
    planAbort.current = null;
    if (computeTimer.current) {
      clearTimeout(computeTimer.current);
      computeTimer.current = null;
    }
    setPhase(null);
    setCancelled(true);
  }, []);

  /* ── Compute trips (debounced, cancellable) ─────────────────── */

  useEffect(() => {
    if (!origin || !destination || !offlineReady) return;

    if (computeTimer.current) clearTimeout(computeTimer.current);
    // Abort the run already in flight. Discarding only its *result* — which is
    // what the old generation counter did — left three overlapping multi-second
    // computations fighting for the JS thread after three pin drags.
    planAbort.current?.abort();

    // Show the skeletons (and a way out) during the debounce, not only once the
    // work starts.
    setPhase('preparing');
    setCancelled(false);

    computeTimer.current = setTimeout(() => {
      const controller = new AbortController();
      planAbort.current = controller;
      const isCurrent = () => planAbort.current === controller;

      setPhase('preparing');
      setResults(null);
      setNoneReason(null);
      setTooClose(null);
      setError(null);
      clearHighlight();

      planTrips(origin.lat, origin.lng, destination.lat, destination.lng, linesMap, {
        signal: controller.signal,
        onPhase: (p) => { if (isCurrent()) setPhase(p); },
        // Show the estimate-tier answer straight away; live data upgrades it
        // in place a moment later rather than holding the whole panel blank.
        onPartial: (trips) => { if (isCurrent()) setResults(trips); },
      })
        .then((outcome) => {
          if (!isCurrent()) return;
          if (outcome.kind === 'too_close') {
            setTooClose({ walkMin: outcome.walkMin, distM: outcome.distM });
            setResults(null);
          } else if (outcome.kind === 'none') {
            setNoneReason(outcome.reason);
            setResults(null);
          } else {
            setResults(outcome.trips);
          }
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (err instanceof PlanCancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to plan trips');
        })
        .finally(() => {
          if (isCurrent()) {
            setPhase(null);
            planAbort.current = null;
          }
        });
    }, 500);

    return () => {
      if (computeTimer.current) clearTimeout(computeTimer.current);
    };
  }, [origin, destination, linesMap, offlineReady, clearHighlight, retryTick]);

  // Abort any in-flight work on unmount.
  useEffect(() => () => {
    planAbort.current?.abort();
    highlightAbort.current?.abort();
  }, []);

  /* ── Pin handlers ───────────────────────────────────────────── */

  /** Every path that sets the destination ends here, so the answer is never
   *  left behind a sheet the user pushed out of the way. */
  const revealResults = useCallback(() => {
    sheetRef.current?.snapTo(RESULTS_SNAP);
  }, []);

  const onMapLongPress = useCallback(
    (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
      const { latitude, longitude } = e.nativeEvent.coordinate;
      // Without a GPS fix there is no start pin to drag, so the first long
      // press places it rather than leaving the user staring at a dead panel.
      setOrigin((prev) => {
        if (prev) setDestination({ lat: latitude, lng: longitude });
        return prev ?? { lat: latitude, lng: longitude };
      });
      // A long press satisfies an in-progress button placement too — the user
      // used the gesture they already knew.
      setPlacing(null);
      revealResults();
    },
    [revealResults],
  );

  /**
   * Placement mode: the discoverable half of the same job the long press does.
   *
   * The long press is kept because people who know it will keep using it, but
   * an invisible gesture cannot be the only way to state where you are going —
   * the screen used to need a line of instruction text to admit as much.
   */
  const startPlacing = useCallback(() => {
    // No origin yet means the pin the user actually needs first is the start
    // one, matching the order the long-press path uses.
    setPlacing(origin ? 'destination' : 'origin');
    // Nothing can be tapped through the panel, so get it out of the way.
    sheetRef.current?.snapTo(PEEK_SNAP);
  }, [origin]);

  const cancelPlacing = useCallback(() => {
    setPlacing(null);
    revealResults();
  }, [revealResults]);

  const onMapPress = useCallback(
    (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
      if (!placing) return;
      const { latitude, longitude } = e.nativeEvent.coordinate;
      if (placing === 'origin') {
        setOrigin({ lat: latitude, lng: longitude });
        // Chain into the destination when there isn't one: the user asked to
        // place pins, and stopping after the start pin strands them on a map
        // with nothing to plan.
        if (destination) {
          setPlacing(null);
          revealResults();
        } else {
          setPlacing('destination');
        }
        return;
      }
      setDestination({ lat: latitude, lng: longitude });
      setPlacing(null);
      revealResults();
    },
    [placing, destination, revealResults],
  );

  const onOriginDragEnd = useCallback(
    (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
      setOrigin({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
    },
    [],
  );

  const onDestDragEnd = useCallback(
    (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
      setDestination({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude });
    },
    [],
  );

  const recenter = useCallback(() => {
    const loc = getLocation();
    if (loc && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: loc.lat, longitude: loc.lng,
        latitudeDelta: 0.015, longitudeDelta: 0.015,
      }, 500);
    }
  }, []);

  /* ── Route highlight on card tap ────────────────────────────── */

  const onResultTap = useCallback(async (trip: TripOption) => {
    if (selectedId === trip.id) {
      clearHighlight();
      return;
    }

    highlightAbort.current?.abort();
    const controller = new AbortController();
    highlightAbort.current = controller;
    const isCurrent = () => highlightAbort.current === controller;

    setSelectedId(trip.id);
    setHighlightPolylines([]);
    setHighlightMarkers([]);
    setHighlightError(null);
    setHighlightLoading(true);

    // Everything the highlight needs, in parallel. Serially this was up to
    // five Valhalla POSTs plus a cache read per leg — 5-10 s of nothing.
    const walkJobs: Array<Promise<HighlightPoly | null>> = [];
    const walk = (
      fromLat: number, fromLng: number, toLat: number, toLng: number,
    ): Promise<HighlightPoly | null> => {
      if (haversineM(fromLat, fromLng, toLat, toLng) <= 50) return Promise.resolve(null);
      return getWalkingRoute(fromLat, fromLng, toLat, toLng, { signal: controller.signal })
        .then((route) =>
          route && route.coords.length > 1
            ? {
                coords: route.coords.map((c) => ({ latitude: c[1], longitude: c[0] })),
                color: WALK_COLOR,
                dashed: true,
              }
            : null,
        )
        .catch(() => null);
    };

    if (origin) {
      const b = trip.legs[0].boardStop;
      walkJobs.push(walk(origin.lat, origin.lng, b.lat, b.lng));
    }
    for (let i = 0; i < trip.legs.length - 1; i++) {
      const a = trip.legs[i].alightStop;
      const b = trip.legs[i + 1].boardStop;
      walkJobs.push(walk(a.lat, a.lng, b.lat, b.lng));
    }
    if (destination) {
      const a = trip.legs[trip.legs.length - 1].alightStop;
      walkJobs.push(walk(a.lat, a.lng, destination.lat, destination.lng));
    }

    const stopJobs = trip.legs.map((leg) =>
      getCachedStops(leg.routeCode).catch(() => null),
    );

    let walkPolys: Array<HighlightPoly | null>;
    let legStops: Array<OasaStop[] | null>;
    try {
      [walkPolys, legStops] = await Promise.all([
        Promise.all(walkJobs),
        Promise.all(stopJobs),
      ]);
    } catch {
      if (isCurrent()) {
        setHighlightLoading(false);
        setHighlightError('Could not load the route shape.');
      }
      return;
    }
    if (!isCurrent()) return;

    const polys: HighlightPoly[] = [];
    const pins: HighlightPin[] = [];
    const intermediates: HighlightPin[] = [];

    const legColors = [primaryColor, ...LEG_COLORS];
    for (let i = 0; i < trip.legs.length; i++) {
      const leg = trip.legs[i];
      const legColor = legColors[i % legColors.length];
      const raw = legStops[i];
      if (!raw) continue;
      // Array position is not route position — sort by RouteStopOrder before
      // slicing between the board and alight indices.
      const routeStops = raw.slice().sort(
        (a, b) => Number(a.RouteStopOrder ?? 0) - Number(b.RouteStopOrder ?? 0),
      );

      const boardIdx = leg.boardStop.orderInRoute;
      const alightIdx = leg.alightStop.orderInRoute;
      const coords: { latitude: number; longitude: number }[] = [];

      for (let si = boardIdx; si <= alightIdx; si++) {
        const st = routeStops[si];
        if (!st) continue;
        const lat = parseFloat(st.StopLat);
        const lng = parseFloat(st.StopLng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        coords.push({ latitude: lat, longitude: lng });
        if (si === boardIdx) pins.push({ lat, lng, color: '#22C55E', type: 'board' });
        else if (si === alightIdx) pins.push({ lat, lng, color: '#F44336', type: 'alight' });
        else intermediates.push({ lat, lng, color: legColor, type: 'stop' });
      }

      if (coords.length > 1) polys.push({ coords, color: legColor, dashed: false });
    }

    // Evenly sample the intermediate dots down to the cap.
    if (intermediates.length > MAX_INTERMEDIATE_MARKERS) {
      const step = intermediates.length / MAX_INTERMEDIATE_MARKERS;
      const sampled: HighlightPin[] = [];
      for (let i = 0; i < MAX_INTERMEDIATE_MARKERS; i++) {
        sampled.push(intermediates[Math.floor(i * step)]);
      }
      pins.push(...sampled);
    } else {
      pins.push(...intermediates);
    }

    for (const p of walkPolys) if (p) polys.push(p);

    setHighlightPolylines(polys);
    setHighlightMarkers(pins);
    setHighlightLoading(false);
    if (polys.length === 0) setHighlightError('No route shape available for this trip.');
  }, [selectedId, origin, destination, clearHighlight, primaryColor]);

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
        <Pressable
          style={[s.offlineBtn, { borderColor: primaryColor }]}
          onPress={() => router.back()}
        >
          <Text style={[s.offlineBtnText, { color: primaryColor }]}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  /* ── Panel body ─────────────────────────────────────────────── */

  /** The panel's own "drop a pin" button, for the moment the user is looking
   *  at the instruction rather than at the map. */
  function renderDropPinButton(label: string) {
    const fg = onAccent(primaryColor);
    return (
      <Pressable
        style={[s.primaryBtn, { backgroundColor: primaryColor }]}
        onPress={startPlacing}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Ionicons name="location" size={16} color={fg} />
        <Text style={[s.primaryBtnText, { color: fg }]}>{label}</Text>
      </Pressable>
    );
  }

  function renderPanel() {
    if (!origin) {
      // Previously this fell through every branch and rendered nothing at all.
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="locate-outline" size={24} color={colors.textMuted} />
          <Text style={s.emptyTitle}>Waiting for your location</Text>
          {renderDropPinButton('Drop start pin')}
          <Text style={s.instructionText}>
            No GPS fix yet. Long press anywhere on the map to set your starting point manually.
          </Text>
        </View>
      );
    }

    if (!destination) {
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="flag-outline" size={24} color={colors.textMuted} />
          <Text style={s.emptyTitle}>Where are you going?</Text>
          {renderDropPinButton('Drop destination pin')}
          {/* The gesture still works; it is just no longer the only way in. */}
          <Text style={s.instructionText}>
            Or long press on the map to drop your destination pin
          </Text>
        </View>
      );
    }

    // Loading with no results yet. Skeletons shaped like the answer, so the
    // panel settles instead of jumping when the real cards land — but the
    // phase label stays, because "which stage" is what separates "working"
    // from "stuck".
    if (loading && !results) {
      return (
        <ScrollView
          style={s.resultScroll}
          contentContainerStyle={s.resultScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {renderPhaseRow('preparing')}
          {Array.from({ length: SKELETON_COUNT }, (_, i) => <SkeletonTripCard key={i} />)}
        </ScrollView>
      );
    }

    if (tooClose) {
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="walk-outline" size={24} color={WALK_COLOR} />
          <Text style={[s.instructionText, num]}>
            Walk there directly — {tooClose.walkMin} min walk ({Math.round(tooClose.distM)}m)
          </Text>
        </View>
      );
    }

    if (error) {
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="alert-circle-outline" size={24} color={colors.danger} />
          <Text style={[s.instructionText, { color: colors.danger }]}>{error}</Text>
        </View>
      );
    }

    if (noneReason) {
      const msg = NONE_MESSAGE[noneReason];
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="bus-outline" size={24} color={colors.textMuted} />
          <Text style={s.emptyTitle}>{msg.title}</Text>
          <Text style={s.instructionText}>{msg.detail}</Text>
        </View>
      );
    }

    if (cancelled && !results) {
      return (
        <View style={s.instructionWrap}>
          <Ionicons name="close-circle-outline" size={24} color={colors.textMuted} />
          <Text style={s.instructionText}>Search cancelled.</Text>
          <Pressable
            style={[s.offlineBtn, { borderColor: primaryColor, marginTop: spacing.sm }]}
            onPress={() => setRetryTick((n) => n + 1)}
          >
            <Text style={[s.offlineBtnText, { color: primaryColor }]}>Try again</Text>
          </Pressable>
        </View>
      );
    }

    if (!results) return null;

    return (
      <ScrollView
        style={s.resultScroll}
        contentContainerStyle={s.resultScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Partial results are on screen and the live tier is still landing. */}
        {loading && renderPhaseRow('live')}
        {results.map((trip, i) => renderCard(trip, i))}
      </ScrollView>
    );
  }

  /** Which stage the search is in, plus the way out of it. */
  function renderPhaseRow(fallback: PlannerPhase) {
    return (
      <View style={s.phaseRow}>
        <ActivityIndicator size="small" color={primaryColor} />
        {/* Takes the slack so Cancel stays pinned right however long the
            phase label runs. */}
        <Text style={[s.loadingText, s.grow]} numberOfLines={1}>
          {PHASE_LABEL[phase ?? fallback]}
        </Text>
        <Pressable style={s.cancelInline} onPress={cancelPlan}>
          <Text style={s.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  function renderCard(trip: TripOption, index: number) {
    const selected = selectedId === trip.id;
    const conf = CONF_STYLE[trip.confidence];
    const tagColor = trip._tag === 'Soonest' ? '#22C55E' : '#3B82F6';

    return (
      <TripCardShell
        key={trip.id}
        index={index}
        style={[s.resultCard, selected && { borderColor: primaryColor }]}
        onPress={() => onResultTap(trip)}
      >
        <View style={s.cardHeader}>
          {trip._tag ? (
            <View style={[s.tagBadge, { backgroundColor: tagColor, marginBottom: 0 }]}>
              <Text style={[s.tagBadgeText, { color: onAccent(tagColor) }]}>{trip._tag}</Text>
            </View>
          ) : <View />}
          <View style={[s.confChip, { borderColor: conf.color }]}>
            <Text style={[s.confChipText, { color: conf.color }]}>{conf.label}</Text>
          </View>
        </View>

        {trip.walkToOriginMin > 0 && (
          <View style={s.legRow}>
            <Ionicons name="walk-outline" size={14} color={WALK_COLOR} />
            <Text style={[s.legWalkText, num]}>{trip.walkToOriginMin} min walk to the stop</Text>
          </View>
        )}

        {trip.legs.map((leg, li) => (
          <View key={`${leg.routeCode}-${leg.boardStop.code}-${li}`}>
            {li > 0 && (
              <View style={s.legRow}>
                <Ionicons name="swap-horizontal-outline" size={14} color={colors.textMuted} />
                {/* Per-leg walk. This row used to print the SUM of every
                    transfer on the trip, on every transfer row. */}
                <Text style={[s.legTransferText, num]}>
                  Transfer — {leg.transferWalkMin} min walk
                </Text>
              </View>
            )}

            <View style={s.legRow}>
              <Ionicons name="bus" size={14} color={primaryColor} />
              <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
                {/* The accent is user-picked across the whole hue circle, so
                    white is not a safe assumption on top of it. */}
                <Text style={[s.lineBadgeText, num, { color: onAccent(primaryColor) }]}>
                  {leg.lineId}
                </Text>
              </View>
              {renderWait(leg)}
            </View>

            <View style={s.legDetailRow}>
              <Text style={[s.legDetailText, num]}>
                Board: {leg.boardStop.name}{stopTimeLabel(leg, 'board')}
              </Text>
            </View>
            <View style={s.legDetailRow}>
              <Text style={[s.legDetailText, num]}>
                Get off: {leg.alightStop.name}{stopTimeLabel(leg, 'alight')}
              </Text>
            </View>
            <View style={s.legDetailRow}>
              <Text style={[s.legDetailMuted, num]}>{rideLabel(leg)}</Text>
            </View>
          </View>
        ))}

        {trip.walkFromDestMin > 0 && (
          <View style={s.legRow}>
            <Ionicons name="walk-outline" size={14} color={WALK_COLOR} />
            <Text style={[s.legWalkText, num]}>
              {trip.walkFromDestMin} min walk to your destination
            </Text>
          </View>
        )}

        <View style={s.totalRow}>
          <View>
            <Text style={[s.totalText, num]}>Total {totalLabel(trip)}</Text>
            <Text style={[s.etaText, num]}>{arriveLabel(trip)}</Text>
          </View>
          <Pressable style={s.navBtn} onPress={() => onResultNavigate(trip)}>
            <Ionicons name="arrow-forward-circle" size={24} color={primaryColor} />
          </Pressable>
        </View>

        {selected && highlightLoading && (
          <View style={s.cardSpinnerRow}>
            <ActivityIndicator size="small" color={primaryColor} />
            <Text style={s.loadingHint}>Drawing the route…</Text>
          </View>
        )}
        {selected && highlightError && (
          <Text style={s.cardErrorText}>{highlightError}</Text>
        )}
      </TripCardShell>
    );
  }

  function renderWait(leg: TripLeg) {
    if (leg.waitSource === 'live' && leg.waitTimeMin !== null) {
      const bg = getArrivalColor(leg.waitTimeMin);
      return (
        <View style={[s.waitBadge, { backgroundColor: bg }]}>
          <Text style={[s.waitBadgeText, num, { color: onAccent(bg) }]}>
            ● {leg.waitTimeMin} min
          </Text>
        </View>
      );
    }
    if (leg.waitSource === 'scheduled' && leg.scheduledTime) {
      const long = (leg.waitTimeMin ?? 0) >= LONG_WAIT_WARN_MIN;
      return (
        <>
          <View style={[s.waitBadge, { backgroundColor: colors.border }]}>
            <Text style={[s.waitBadgeText, num, { color: colors.textMuted }]}>
              ○ {leg.scheduledTime}
            </Text>
          </View>
          {/* A long wait is surfaced, not used to delete the trip — Athens
              off-peak headways are routinely 20-40 minutes. */}
          {long && <Text style={[s.waitWarnText, num]}>{leg.waitTimeMin} min wait</Text>}
        </>
      );
    }
    // The old UI rendered a bare "?" here with no explanation.
    return <Text style={s.waitUnknownText}>Departure time unknown</Text>;
  }

  /* ── Main Render ────────────────────────────────────────────── */

  const placingLabel = placing === 'origin' ? 'start' : 'destination';

  return (
    <View style={ms.container}>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitle: 'Get Me There',
          headerTitleStyle: { color: colors.text, fontWeight: '700' },
        }}
      />

      <View style={s.mapFill}>
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
          style={ms.map}
          initialRegion={initialRegion}
          customMapStyle={GOOGLE_DARK_STYLE}
          mapPadding={mapPadding}
          showsUserLocation={false}
          showsMyLocationButton={false}
          showsCompass={false}
          toolbarEnabled={false}
          onPress={onMapPress}
          onLongPress={onMapLongPress}
          moveOnMarkerPress={false}
        >
          {metroData.map((line, i) => (
            <Polyline key={`mp-${i}`} coordinates={line.coords}
              strokeColor={line.color + '99'} strokeWidth={2.5} lineCap="round" />
          ))}

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

          {origin && (
            <Marker
              coordinate={{ latitude: origin.lat, longitude: origin.lng }}
              draggable
              onDragEnd={onOriginDragEnd}
              anchor={{ x: 0.5, y: 1 }}
              pinColor="#22C55E"
            />
          )}

          {destination && (
            <Marker
              coordinate={{ latitude: destination.lat, longitude: destination.lng }}
              draggable
              onDragEnd={onDestDragEnd}
              anchor={{ x: 0.5, y: 1 }}
              pinColor="#F44336"
            />
          )}

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

          {highlightMarkers.map((pin, i) => (
            <HighlightMarkerView key={`hm-${pin.type}-${pin.lat}-${pin.lng}-${i}`} pin={pin} />
          ))}
        </MapView>

        {/* Map furniture lives at the top: the sheet owns the bottom of the
            screen at every snap point, and a control that spends most of its
            life behind the panel is not a control. */}
        <View style={s.mapOverlay} pointerEvents="box-none">
          {placing && (
            <View style={[s.placingBanner, { borderColor: primaryColor }]} pointerEvents="none">
              <Ionicons name="location" size={16} color={primaryColor} />
              <Text style={s.placingText}>Tap the map to place your {placingLabel} pin</Text>
            </View>
          )}

          <View style={s.mapControls} pointerEvents="box-none">
            {/* Filled while placement is armed: the pill is the only thing on
                screen saying the next tap will move a pin, so it has to read
                as on rather than as merely highlighted. */}
            <Pressable
              style={[
                s.mapPill,
                placing != null && { backgroundColor: primaryColor, borderColor: primaryColor },
              ]}
              onPress={placing ? cancelPlacing : startPlacing}
              accessibilityRole="button"
              accessibilityLabel={placing ? 'Cancel pin placement' : 'Drop a pin on the map'}
            >
              <Ionicons
                name={placing ? 'close' : 'location-outline'}
                size={16}
                color={placing ? onAccent(primaryColor) : colors.text}
              />
              <Text style={[s.mapPillText, placing != null && { color: onAccent(primaryColor) }]}>
                {placing ? 'Cancel' : 'Drop pin'}
              </Text>
            </Pressable>

            <Pressable
              style={s.mapRoundBtn}
              onPress={recenter}
              accessibilityRole="button"
              accessibilityLabel="Centre the map on my location"
            >
              <View style={ms.locationIcon}><View style={ms.locationDot} /></View>
            </Pressable>
          </View>
        </View>
      </View>

      {/* The grabber the old fixed panel drew but could not honour. */}
      <BottomSheet
        ref={sheetRef}
        snapPoints={SNAP_POINTS}
        initialSnap={RESULTS_SNAP}
        style={s.sheet}
      >
        <View style={s.sheetBody}>{renderPanel()}</View>
      </BottomSheet>
    </View>
  );
}
