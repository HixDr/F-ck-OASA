/**
 * Stop markers for the two map screens.
 *
 * `MapMarker` is a plain `React.Component` with no `shouldComponentUpdate`, so
 * every parent render re-renders every marker's subtree — and on Fabric the
 * differ compares props by pointer, so each of those emits an Update mutation
 * and Android re-applies the whole prop set. Hence: memo, scalar props only,
 * and everything object-shaped (coordinate, anchor, style arrays) built inside.
 *
 * The markers draw from captured PNGs (`StopMarkerImages`) rather than from
 * child views. A Marker with children has to be rasterised on Android — 4-5
 * views plus a custom-font glyph, drawn onto a software Canvas by a global
 * tracker at ~25Hz, times 60-120 stops — while a Marker with `image` and no
 * children never enters that tracker and shares one decoded bitmap across every
 * marker on the same URI. The child-view path below survives as the fallback
 * for as long as the capture has not produced URIs; markers must never be
 * invisible because a capture was slow or failed.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { Marker } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { useMarkerTracking } from '../../../hooks/useMarkerTracking';
import { STOP_ANCHOR, stopDotAnchor } from '../../../components/StopMarkerSvg';
import { useStopMarkerImages } from './StopMarkerImages';
import { s as liveStyles } from '../LiveMapScreen.styles';
import { s as nearbyStyles } from '../NearbyMapScreen.styles';

/* ── Route stop (Live Map) ───────────────────────────────────── */

interface RouteStopProps {
  code: string;
  lat: number;
  lng: number;
  /** Direction of travel at this stop, for the arrow. */
  bearing: number;
  selected: boolean;
  color: string;
  onPress: (code: string) => void;
}

export const RouteStopMarker = memo(function RouteStopMarker({
  code, lat, lng, bearing, selected, color, onPress,
}: RouteStopProps) {
  const images = useStopMarkerImages(color);

  // The two paths are separate components so the image path never mounts the
  // tracking hook: its timer and the render it ends on would be pure waste for
  // 60-120 markers that have no view to rasterize. Which URI to use is resolved
  // here, so both stay on scalar props.
  return images ? (
    <RouteStopImageMarker
      lat={lat} lng={lng} bearing={bearing} selected={selected}
      arrow={selected ? images.arrowSelected : images.arrow}
      dot={selected ? images.dotSelected : images.dot}
      code={code} onPress={onPress}
    />
  ) : (
    <RouteStopViewMarker
      lat={lat} lng={lng} bearing={bearing} selected={selected}
      color={color} code={code} onPress={onPress}
    />
  );
});

/** Two stacked image markers — the normal path. */
function RouteStopImageMarker({
  code, lat, lng, bearing, selected, arrow, dot, onPress,
}: Omit<RouteStopProps, 'color'> & { arrow: string; dot: string }) {
  const handlePress = useCallback(() => onPress(code), [onPress, code]);
  // Constant per stop, so this object never changes identity.
  const dotAnchor = useMemo(() => stopDotAnchor(bearing), [bearing]);
  const coordinate = { latitude: lat, longitude: lng };

  return (
    <>
      {/* Layer 1 — the arrow, swung by the direction of travel. Google Maps
          rotates about the anchor, so this is the same swing the single rotated
          marker performed, with no angle quantisation. */}
      <Marker
        coordinate={coordinate}
        anchor={STOP_ANCHOR}
        tracksViewChanges={false}
        rotation={bearing}
        flat
        zIndex={selected ? 1050 : 999}
        image={{ uri: arrow }}
        onPress={handlePress}
      />
      {/* Layer 2 — dot and glyph, unrotated so the bus stays upright. That
          counter-rotation is exactly why one image cannot do the job.

          Its anchor is bearing-dependent rather than the arrow's constant one:
          the pivot sits 7px below the dot's centre, so on the single rotated
          marker the dot orbited the stop along with the arrow. `stopDotAnchor`
          slides the anchor around that same circle, which lands the dot where
          the rotation used to put it. Both layers are `flat`, so they share the
          ground plane and a tilted camera would foreshorten them identically;
          LiveMapScreen also sets `pitchEnabled={false}`. Anything that turns
          pitch on should re-check this pair.

          Half a step above layer 1 so the dot always covers the base of the
          arrow, and only half so that the pair still sits in the same band the
          single marker did — `UserLocationMarker` is on 999 and the buses on
          1100. Both carry `onPress`: the two 40x40 hit rects cover everything
          the single rotated one did, so no tap that works today stops working. */}
      <Marker
        coordinate={coordinate}
        anchor={dotAnchor}
        tracksViewChanges={false}
        rotation={0}
        flat
        zIndex={selected ? 1050.5 : 999.5}
        image={{ uri: dot }}
        onPress={handlePress}
      />
    </>
  );
}

/**
 * The original child-view marker, kept as the fallback while the capture has
 * not produced URIs — and permanently if it never does. Everything above is
 * measured off this geometry, so the two paths are interchangeable on screen.
 */
function RouteStopViewMarker({
  code, lat, lng, bearing, selected, color, onPress,
}: RouteStopProps) {
  // Scoped to this marker: a shared "something got selected" flag turned on
  // per-frame bitmap capture for all 60-120 stop markers on every tap.
  const { tracksViewChanges, onLayout } = useMarkerTracking([selected, color]);
  const handlePress = useCallback(() => onPress(code), [onPress, code]);

  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={STOP_ANCHOR}
      tracksViewChanges={tracksViewChanges}
      rotation={bearing}
      flat
      zIndex={selected ? 1050 : 999}
      onPress={handlePress}
    >
      <View style={liveStyles.stopMarkerOuter} collapsable={false} onLayout={onLayout}>
        <View style={[liveStyles.stopArrow, selected && TRANSPARENT_ARROW]} />
        <View style={liveStyles.stopDotWrap}>
          {selected && <View style={[liveStyles.stopRing, { borderColor: color }]} />}
          <View
            style={[
              liveStyles.stopDot,
              selected
                ? { backgroundColor: '#FFFFFF', borderColor: color, borderWidth: 3 }
                : { backgroundColor: color },
              // Cancel the marker rotation so the glyph stays upright.
              { transform: [{ rotate: `${-bearing}deg` }] },
            ]}
          >
            <Ionicons name="bus" size={10} color={selected ? color : '#FFFFFF'} />
          </View>
        </View>
      </View>
    </Marker>
  );
}

const TRANSPARENT_ARROW = { borderBottomColor: 'transparent' } as const;

/* ── Nearby stop (Nearby Map) ────────────────────────────────── */

interface NearbyStopProps {
  code: string;
  lat: number;
  lng: number;
  color: string;
  onPress: (code: string) => void;
}

export const NearbyStopMarker = memo(function NearbyStopMarker({
  code, lat, lng, color, onPress,
}: NearbyStopProps) {
  const images = useStopMarkerImages(color);
  // The accent colour used to be part of the marker key, which remounted every
  // pin on an accent change. A tracking burst repaints the existing one.
  const { tracksViewChanges, onLayout } = useMarkerTracking([color, images == null]);
  const handlePress = useCallback(() => onPress(code), [onPress, code]);

  return (
      <Marker
        coordinate={{ latitude: lat, longitude: lng }}
        anchor={CENTER_ANCHOR}
        // An `image` marker has no view to rasterize, so tracking is pure waste:
        // Android defaults it to true and iOS leaves GMSMarker.tracksViewChanges YES.
        tracksViewChanges={images ? false : tracksViewChanges}
        image={images ? { uri: images.pin } : undefined}
        onPress={handlePress}
      >
        {images ? null : (
          <View
            style={[nearbyStyles.stopPin, { backgroundColor: color }]}
            collapsable={false}
            onLayout={onLayout}
          >
            <View style={nearbyStyles.stopPinInner} />
          </View>
        )}
      </Marker>
  );
});

const CENTER_ANCHOR = { x: 0.5, y: 0.5 };
