/**
 * Bus marker layer.
 *
 * The whole point of this file is that bus motion never touches React state.
 * Each poll produces one `BusPlan` per vehicle; the plan is turned into a
 * single `Animated.Value` whose interpolation traces the route polyline, and
 * `Animated` writes the coordinate to the native marker through
 * `setNativeProps`. React renders here happen once per poll, not once per
 * frame — the previous implementation called `setInterpolatedBuses` from a
 * requestAnimationFrame loop and re-rendered the entire 775-line map screen
 * 60 times a second, forever, even with every bus parked.
 */

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { MarkerAnimated } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { BusInterpolator, type BusPlan, type LatLng } from '../busInterpolation';
import { BUS_MARKER_ANCHOR_Y } from '../../../components/BusMarkerSvg';
import { useMarkerTracking } from '../../../hooks/useMarkerTracking';

export interface RawBus {
  id: string;
  lat: number;
  lng: number;
}

interface Props {
  /** Latest positions from the feed — already deduplicated by vehicle. */
  buses: RawBus[];
  /** Geometry the interpolator snaps to. Same source as the drawn polyline. */
  route: LatLng[];
  /** Captured pin bitmap. Null falls back to a plain vector marker. */
  imageUri: string | null;
  /** Accent colour, used only by the fallback marker. */
  color: string;
  /** Tween length — pass the poll interval so a tween ends as the next lands. */
  durationMs: number;
  /** Feed is stale (offline cache): dim the pins and stop animating. */
  stale: boolean;
  /** False while the screen is unfocused — no animation off-screen. */
  active: boolean;
}

/* ── One vehicle ─────────────────────────────────────────────── */

interface MarkerProps {
  plan: BusPlan;
  imageUri: string | null;
  color: string;
  opacity: number;
  animate: boolean;
}

const BusMarker = memo(function BusMarker({ plan, imageUri, color, opacity, animate }: MarkerProps) {
  /** Position to render when nothing is animating. */
  const restRef = useRef<{ latitude: number; longitude: number }>(
    plan.snapTo ?? plan.from ?? { latitude: 0, longitude: 0 },
  );

  // Whether to animate is decided once, when the plan arrives — not on every
  // render. Making it a memo dependency meant regaining focus rebuilt the
  // driver from the *old* plan and visibly rewound the bus to its start.
  const animateRef = useRef(animate);
  animateRef.current = animate;

  const anim = useMemo(() => {
    if (plan.snapTo) {
      restRef.current = plan.snapTo;
      return null;
    }
    const end = plan.legs[plan.legs.length - 1];
    // No legs means the vehicle did not move — hold the last position rather
    // than re-animating to where it already is.
    if (!end || !plan.from) return null;

    if (!animateRef.current) {
      restRef.current = { latitude: end.latitude, longitude: end.longitude };
      return null;
    }

    const total = plan.legs.reduce((sum, l) => sum + l.durationMs, 0);
    if (total <= 0) {
      restRef.current = { latitude: end.latitude, longitude: end.longitude };
      return null;
    }

    // A single driver node keyed 0→1, with breakpoints at each polyline vertex
    // in proportion to leg length. One animated node per bus means one
    // setNativeProps per frame, and the marker traces the road instead of
    // cutting the corner off every turn.
    const input: number[] = [0];
    const lats: number[] = [plan.from.latitude];
    const lngs: number[] = [plan.from.longitude];
    let acc = 0;
    for (const leg of plan.legs) {
      acc += leg.durationMs;
      const t = Math.min(acc / total, 1);
      // interpolate() requires a strictly increasing input range.
      if (t <= input[input.length - 1]) continue;
      input.push(t);
      lats.push(leg.latitude);
      lngs.push(leg.longitude);
    }
    if (input.length < 2) {
      restRef.current = { latitude: end.latitude, longitude: end.longitude };
      return null;
    }

    // The marker is at `plan.from` right now and the driver starts at 0, so
    // the first committed frame lands exactly where the pin already is.
    const value = new Animated.Value(0);
    restRef.current = { latitude: end.latitude, longitude: end.longitude };
    return {
      value,
      total,
      latitude: value.interpolate({ inputRange: input, outputRange: lats, extrapolate: 'clamp' }),
      longitude: value.interpolate({ inputRange: input, outputRange: lngs, extrapolate: 'clamp' }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- animate is read
    // through a ref on purpose; see above.
  }, [plan]);

  useEffect(() => {
    if (!anim) return;
    const a = Animated.timing(anim.value, {
      toValue: 1,
      duration: anim.total,
      // Linear: a bus at constant speed must not decelerate to a stop every
      // poll and then jerk forward again, which is what ease-out produced.
      easing: Easing.linear,
      // `coordinate` is not a style prop, so the native driver cannot take it.
      useNativeDriver: false,
    });
    a.start();
    return () => a.stop();
  }, [anim]);

  const coordinate = anim
    ? { latitude: anim.latitude, longitude: anim.longitude }
    : restRef.current;

  // An `image` marker has no view to rasterize, so tracking is pure waste:
  // Android defaults it to true and iOS leaves GMSMarker.tracksViewChanges YES.
  // The fallback marker does have children, and needs one burst to appear.
  const fallback = useMarkerTracking([imageUri == null]);

  return (
    <MarkerAnimated
      coordinate={coordinate}
      anchor={imageUri ? BUS_ANCHOR : CENTER_ANCHOR}
      zIndex={1100}
      opacity={opacity}
      tracksViewChanges={imageUri ? false : fallback.tracksViewChanges}
      image={imageUri ? { uri: imageUri } : undefined}
    >
      {imageUri ? null : (
        // Fallback when the SVG→PNG capture never produced a bitmap. Without
        // it a failed capture meant no bus markers at all for the session.
        <View
          style={[s.fallbackPin, { backgroundColor: color }]}
          collapsable={false}
          onLayout={fallback.onLayout}
        >
          <Ionicons name="bus" size={11} color="#FFFFFF" />
        </View>
      )}
    </MarkerAnimated>
  );
});

const BUS_ANCHOR = { x: 0.5, y: BUS_MARKER_ANCHOR_Y };
const CENTER_ANCHOR = { x: 0.5, y: 0.5 };

/* ── Layer ───────────────────────────────────────────────────── */

const BusLayer = memo(function BusLayer({
  buses, route, imageUri, color, durationMs, stale, active,
}: Props) {
  // Lazy init — `useRef(new BusInterpolator())` constructs and throws away an
  // instance on every single render.
  const interpolatorRef = useRef<BusInterpolator | null>(null);
  if (interpolatorRef.current == null) interpolatorRef.current = new BusInterpolator();

  const [plans, setPlans] = useState<Map<string, BusPlan>>(() => new Map());

  // Declared before the plan effect so a geometry swap always lands first.
  useEffect(() => {
    interpolatorRef.current!.setRoute(route);
  }, [route]);

  useEffect(() => {
    const interp = interpolatorRef.current!;
    const next: BusPlan[] = interp.hasRoute()
      ? interp.update(buses, durationMs)
      // No usable geometry: place the raw fixes and skip interpolation.
      : buses.map((b) => ({
          id: b.id,
          snapTo: { latitude: b.lat, longitude: b.lng },
          from: null,
          legs: [],
          bearing: 0,
        }));
    setPlans(new Map(next.map((p) => [p.id, p])));
  }, [buses, route, durationMs]);

  const opacity = stale ? 0.35 : 1;
  const animate = active && !stale;

  return (
    <>
      {buses.map((bus) => {
        const plan = plans.get(bus.id);
        if (!plan) return null;
        return (
          <BusMarker
            // Never key on staleness: it unmounted and remounted every marker
            // the moment the feed went cold.
            key={`bus-${bus.id}`}
            plan={plan}
            imageUri={imageUri}
            color={color}
            opacity={opacity}
            animate={animate}
          />
        );
      })}
    </>
  );
});

export default BusLayer;

const s = StyleSheet.create({
  fallbackPin: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
});
