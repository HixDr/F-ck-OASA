/**
 * Stop markers for the two map screens.
 *
 * `MapMarker` is a plain `React.Component` with no `shouldComponentUpdate`, so
 * every parent render re-renders every marker's subtree — and on Fabric the
 * differ compares props by pointer, so each of those emits an Update mutation
 * and Android re-applies the whole prop set. Hence: memo, scalar props only,
 * and everything object-shaped (coordinate, anchor, style arrays) built inside.
 */

import React, { memo, useCallback } from 'react';
import { View } from 'react-native';
import { Marker } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { useMarkerTracking } from '../../../hooks/useMarkerTracking';
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
});

const STOP_ANCHOR = { x: 0.5, y: 0.65 };
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
  // The accent colour used to be part of the marker key, which remounted every
  // pin on an accent change. A tracking burst repaints the existing one.
  const { tracksViewChanges, onLayout } = useMarkerTracking([color]);
  const handlePress = useCallback(() => onPress(code), [onPress, code]);

  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={CENTER_ANCHOR}
      tracksViewChanges={tracksViewChanges}
      onPress={handlePress}
    >
      <View
        style={[nearbyStyles.stopPin, { backgroundColor: color }]}
        collapsable={false}
        onLayout={onLayout}
      >
        <View style={nearbyStyles.stopPinInner} />
      </View>
    </Marker>
  );
});

const CENTER_ANCHOR = { x: 0.5, y: 0.5 };
