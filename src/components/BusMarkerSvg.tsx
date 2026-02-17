/**
 * SVG-based bus map marker — pin/drip shape with colored ring,
 * white interior, and a bus icon. Rendered to a PNG data URI via
 * react-native-svg's toDataURL for use with <Marker image> to
 * bypass Android's custom view size constraints.
 */

import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Path, G } from 'react-native-svg';

/**
 * Material Design "directions_bus" icon path (24×24 viewBox).
 */
const BUS_PATH =
  'M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 ' +
  '.55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4' +
  's-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33' +
  ' 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5' +
  '-1.5 1.5zm1.5-6H6V6h12v5z';

/**
 * Pin/drip outline path (48×64 viewBox — tall portrait).
 */
const PIN_PATH =
  'M24 4C14.06 4 6 12.06 6 22c0 12 18 38 18 38s18-26 18-38C42 12.06 33.94 4 24 4z';

/** Anchor Y ratio — pin tip at y=60 in a 64-tall viewBox. */
export const BUS_MARKER_ANCHOR_Y = 60 / 64;

/** Hidden SVG renderer — mount this once in the map screen. */
export const BusMarkerRenderer = memo(function BusMarkerRenderer({
  color,
  svgRef,
}: {
  color: string;
  svgRef: React.RefObject<any>;
}) {
  return (
    <View style={styles.hidden} pointerEvents="none">
      <Svg
        ref={svgRef}
        width={48}
        height={64}
        viewBox="0 0 48 64"
      >
        <Path d={PIN_PATH} fill={color} />
        <Circle cx={24} cy={22} r={14.5} fill="#FFFFFF" />
        <G transform="translate(14.5, 12.5) scale(0.79)">
          <Path d={BUS_PATH} fill={color} />
        </G>
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: -9999,
    left: -9999,
    opacity: 0,
  },
});
