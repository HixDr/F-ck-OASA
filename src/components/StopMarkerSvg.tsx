/**
 * SVG sources for the stop markers, captured once per accent colour and handed
 * to `<Marker image>`.
 *
 * A Marker with React children has to be rasterised on Android: the subtree is
 * drawn onto a software Canvas through `buildDrawingCache()`, driven by a
 * process-global `ViewChangesTracker` at ~25Hz. The stop marker is 4-5 views
 * plus a custom-font glyph, and a line has 60-120 stops, so that is hundreds of
 * software draws on the UI thread inside the first few hundred milliseconds. A
 * Marker with `image` and no children never enters the tracker at all, and
 * `MapMarkerManager` keeps a URI-keyed shared icon cache, so N markers on one
 * URI cost one decode and one texture. Same trick as `BusMarkerSvg`.
 *
 * One step further here: the glyph has to stay upright while the arrow rotates
 * with the direction of travel, which today is a native `rotation` plus a JS
 * counter-rotation on the glyph. No single pre-rendered image can do that, so
 * the marker is split into two images stacked on the same coordinate — arrow
 * (rotated) under dot+glyph (upright).
 *
 * Geometry is expressed in the same units as the view marker in
 * `LiveMapScreen.styles`, so the captured images and the fallback child-view
 * path line up pixel for pixel. All coordinates below are in the 40x40 canvas,
 * y down:
 *
 *   arrow   `stopArrow` is a 14x10 CSS-border triangle at the top of a
 *           40-wide, centre-aligned column: (20,0) (13,10) (27,10).
 *   dot     `stopDot` is 22x22, and `marginBottom:-2` on the arrow starts it at
 *           y=8, so its centre is (20,19).
 *   ring    `stopRing` is 32x32 centred on the dot: (4,3)..(36,35), which still
 *           fits the canvas — nothing is clipped out of the bitmap.
 *   pivot   `STOP_ANCHOR` is 0.65*40 = 26px down, i.e. 7px *below* the dot's
 *           centre. See `stopDotAnchor`.
 */

import React, { memo } from 'react';
import Svg, { Circle, G, Path, Polygon, Rect } from 'react-native-svg';

/* ── Route stop geometry ─────────────────────────────────────── */

/** Both route layers share this canvas, so their bitmaps compose 1:1. */
const CANVAS = 40;
const VIEW_BOX = `0 0 ${CANVAS} ${CANVAS}`;
const CX = CANVAS / 2;
/** Centre of the 22x22 dot inside the canvas. */
const DOT_CY = 19;
/** The rotation pivot: 0.65 of a 40px marker, unchanged from the view marker. */
const PIVOT_Y = 26;
/** Distance from pivot to dot centre — the radius the dot orbits on. */
const DOT_ORBIT = PIVOT_Y - DOT_CY;

/** Anchor for the arrow layer, and for the child-view fallback marker. */
export const STOP_ANCHOR = { x: CX / CANVAS, y: PIVOT_Y / CANVAS };

/**
 * Anchor for the dot layer.
 *
 * Google Maps rotates a marker about its anchor, and the pivot sits 7px below
 * the dot's centre — so on today's single rotated marker the dot orbits the
 * stop right along with the arrow; only the glyph inside it is held upright.
 * An unrotated dot layer on the *same* anchor would therefore park the dot up
 * to 14px away from where it sits now.
 *
 * Sliding the anchor around that same 7px circle instead reproduces the orbit
 * exactly: at bearing b the dot has to land at (7·sin b, -7·cos b) from the
 * stop, so the anchor moves the opposite way. Continuous in the bearing, so
 * there is no angle quantisation, and it stays correct under map rotation too —
 * both layers are `flat`, so the map's own bearing rotates the whole bitmap
 * about the anchor, composing with this offset the way the rigid marker did.
 */
export function stopDotAnchor(bearing: number): { x: number; y: number } {
  const rad = ((Number.isFinite(bearing) ? bearing : 0) * Math.PI) / 180;
  return {
    x: (CX - DOT_ORBIT * Math.sin(rad)) / CANVAS,
    y: (DOT_CY + DOT_ORBIT * Math.cos(rad)) / CANVAS,
  };
}

/**
 * Material Design "directions_bus" path (24x24 viewBox) — the same glyph the
 * bus pins use, rather than the Ionicons one the child-view path draws with.
 * A vector path renders identically in every capture; a font glyph would
 * depend on `ReactFontManager` resolving the icon typeface inside
 * react-native-svg, and a silent miss there produces a tofu box baked into the
 * bitmap with nothing to fall back to.
 */
const BUS_PATH =
  'M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 ' +
  '.55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4' +
  's-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33' +
  ' 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5' +
  '-1.5 1.5zm1.5-6H6V6h12v5z';

/**
 * Glyph ink spans x 4..20, y 2..21 of that 24-unit box. Scaled to ~8.5px tall
 * to match `<Ionicons size={10}>`, then translated so the ink centre (12,11.5)
 * lands on the dot centre.
 */
const GLYPH_SCALE = 0.45;
const GLYPH_TRANSFORM = `translate(${CX - 12 * GLYPH_SCALE}, ${
  DOT_CY - 11.5 * GLYPH_SCALE
}) scale(${GLYPH_SCALE})`;

/* ── Offscreen renderers ─────────────────────────────────────── */

interface LayerProps {
  selected: boolean;
  svgRef: React.RefObject<any>;
}

/** Layer 1: the direction arrow. Rotated by the marker, never by the SVG. */
export const StopArrowSvg = memo(function StopArrowSvg({ selected, svgRef }: LayerProps) {
  return (
    <Svg ref={svgRef} width={CANVAS} height={CANVAS} viewBox={VIEW_BOX}>
      {/* Selection hides the arrow (`borderBottomColor: 'transparent'`). The
          shape is still drawn, transparent, so the selected capture keeps the
          same canvas — the two layers must stay the same size to compose. */}
      <Polygon
        points={`${CX},0 ${CX - 7},10 ${CX + 7},10`}
        fill={selected ? 'transparent' : '#FFFFFF'}
      />
    </Svg>
  );
});

/** Layer 2: the dot, its ring, and the upright glyph. */
export const StopDotSvg = memo(function StopDotSvg({
  color, selected, svgRef,
}: LayerProps & { color: string }) {
  return (
    <Svg ref={svgRef} width={CANVAS} height={CANVAS} viewBox={VIEW_BOX}>
      {/* `stopRing`: 32x32 box, 2.5 border, 15% white fill. A centred stroke at
          r=14.75 covers 13.5..16 — the annulus a border draws inside that box.
          The opaque border hides the fill underneath it, as it does in RN. */}
      {selected && (
        <Circle
          cx={CX} cy={DOT_CY} r={14.75}
          fill="#FFFFFF" fillOpacity={0.15}
          stroke={color} strokeWidth={2.5}
        />
      )}
      {/* `stopDot`: 22x22 box. RN draws the border inside the box and the
          background under it, which a centred stroke reproduces exactly:
          unselected 2px white over an accent fill, selected 3px accent over
          white. */}
      {selected ? (
        <Circle cx={CX} cy={DOT_CY} r={9.5} fill="#FFFFFF" stroke={color} strokeWidth={3} />
      ) : (
        <Circle cx={CX} cy={DOT_CY} r={10} fill={color} stroke="#FFFFFF" strokeWidth={2} />
      )}
      <G transform={GLYPH_TRANSFORM}>
        <Path d={BUS_PATH} fill={selected ? color : '#FFFFFF'} />
      </G>
    </Svg>
  );
});

/* ── Nearby stop ─────────────────────────────────────────────── */

const PIN = 20;

/** The Nearby Map pin: no rotation, no selected state, so one image per accent. */
export const NearbyStopPinSvg = memo(function NearbyStopPinSvg({
  color, svgRef,
}: { color: string; svgRef: React.RefObject<any> }) {
  return (
    <Svg ref={svgRef} width={PIN} height={PIN} viewBox={`0 0 ${PIN} ${PIN}`}>
      {/* `stopPin`: 20x20, 1.5 white border inside the box, accent fill. */}
      <Circle cx={PIN / 2} cy={PIN / 2} r={9.25} fill={color} stroke="#FFFFFF" strokeWidth={1.5} />
      {/* `stopPinInner`: a centred 4x6 rounded bar. */}
      <Rect x={8} y={7} width={4} height={6} rx={1} fill="#FFFFFF" />
    </Svg>
  );
});
