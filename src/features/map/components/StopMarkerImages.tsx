/**
 * Stop marker bitmaps — five captures per accent colour, shared by every stop
 * marker on both map screens.
 *
 * The cache is module-scoped rather than screen state on purpose: the capture
 * then outlives navigation, so only the first map of a session ever pays for
 * the child-view fallback. Accent colour is the only invalidation key — nothing
 * else about a stop marker's pixels varies per stop.
 *
 * ── Why the host is mounted outside `<MapView>` ──
 *
 * `MapView.addFeature` only attaches map *features* to the window. A plain
 * `<View>` child is matched by its `instanceof ViewGroup` branch, which recurses
 * looking for features and silently drops everything else — so a hidden host
 * rendered as a MapView child is never attached, never drawn, and an SvgView
 * that is never drawn never sets its `rendered` flag. `toDataURL` then parks the
 * request in a task that only runs from `onDraw`, and the callback never fires.
 *
 * So the host is a sibling of the map, exactly where `BusMarkerRenderer` already
 * puts its own offscreen SVG. The screens mount it; nothing here needs to know
 * which markers exist. An earlier revision hid the host inside a 1x1 Marker so
 * that this module could own it without the screens' help, which worked only if
 * two unverified assumptions about Android's rasterisation pass held — and cost
 * an election protocol to decide which of 120 churning markers carried it.
 */

import React, { memo, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Marker } from 'react-native-maps';
import { useMarkerTracking } from '../../../hooks/useMarkerTracking';
import {
  NearbyStopPinSvg,
  StopArrowSvg,
  StopDotSvg,
} from '../../../components/StopMarkerSvg';

export interface StopMarkerImages {
  /** Route stop layer 1, rotated by the marker. */
  arrow: string;
  /** Selection hides the arrow, so this capture is deliberately blank. */
  arrowSelected: string;
  /** Route stop layer 2, upright. */
  dot: string;
  dotSelected: string;
  /** Nearby Map pin. */
  pin: string;
}

const KEYS = ['arrow', 'arrowSelected', 'dot', 'dotSelected', 'pin'] as const;
type Key = (typeof KEYS)[number];

/* ── Cache ───────────────────────────────────────────────────── */

/** Complete sets, keyed by accent colour. */
const captured = new Map<string, StopMarkerImages>();
/** Captures in progress, so marker churn mid-capture resumes instead of restarting. */
const partial = new Map<string, Partial<StopMarkerImages>>();
/** Most recently published set, whatever its colour. See `useStopMarkerImages`. */
let newest: StopMarkerImages | null = null;

/** Each entry is five base64 PNGs, and the accent changes about never. */
const MAX_COLORS = 3;

type Notify = () => void;
/** Mounted markers, re-rendered when a capture publishes. */
const markers = new Set<Notify>();

function publish(color: string, images: StopMarkerImages): void {
  if (captured.has(color)) return;
  if (captured.size >= MAX_COLORS) {
    const oldest = captured.keys().next().value;
    if (oldest !== undefined) captured.delete(oldest);
  }
  captured.set(color, images);
  partial.delete(color);
  newest = images;
  for (const notify of markers) notify();
}

const tick = (n: number) => n + 1;

/**
 * Subscribes a marker to the cache and returns the images to draw with.
 *
 * Null only until the session's first capture lands; after that the module
 * cache outlives navigation, so later screen opens start on images.
 */
export function useStopMarkerImages(color: string): StopMarkerImages | null {
  const [, notify] = useReducer(tick, 0);

  useEffect(() => {
    markers.add(notify);
    return () => { markers.delete(notify); };
  }, [notify]);

  // Falling back to the previous accent's images rather than to null keeps
  // every marker on the image path while the new colour is captured. Null
  // would drop all 60-120 of them back onto the child-view path — and its
  // rasterisation burst — for the ~100ms the capture takes.
  return captured.get(color) ?? newest;
}

/* ── Capture host ────────────────────────────────────────────── */

/** First attempt is short; the ref is normally live well before this. */
const CAPTURE_FIRST_MS = 60;
const CAPTURE_MAX_ATTEMPTS = 8;
/** Upper bound on waiting for the decode below. */
const DECODE_TIMEOUT_MS = 1000;

interface HostProps {
  color: string;
}

/**
 * Mounts the offscreen SVGs and captures them to PNG data URIs.
 *
 * Mount this as a sibling of `<MapView>`, not inside it — see the note at the
 * top of this file. Parked far offscreen at zero opacity but still laid out,
 * because `toDataURL` sizes its bitmap from the measured width and has no node
 * handle to work from until the view exists. Same arrangement as
 * `BusMarkerRenderer`.
 *
 * Cheap to leave mounted: once a colour is captured the effect below short-
 * circuits, so it costs five laid-out but undrawn SVGs.
 */
export const StopMarkerCaptureHost = memo(function StopMarkerCaptureHost({
  color,
}: HostProps) {
  /** Captured, but not handed out until the bitmaps are decoded — see below. */
  const [ready, setReady] = useState<StopMarkerImages | null>(null);
  const arrow = useRef<any>(null);
  const arrowSelected = useRef<any>(null);
  const dot = useRef<any>(null);
  const dotSelected = useRef<any>(null);
  const pin = useRef<any>(null);

  const laidOut = useRef(false);
  // `toDataURL` sizes its bitmap from the measured width, and
  // `Bitmap.createBitmap(0, 0)` throws — so capture waits for a real layout.
  const onLayout = useCallback(() => { laidOut.current = true; }, []);

  useEffect(() => {
    const targets: Array<[Key, React.RefObject<any>]> = [
      ['arrow', arrow],
      ['arrowSelected', arrowSelected],
      ['dot', dot],
      ['dotSelected', dotSelected],
      ['pin', pin],
    ];

    const resumed = partial.get(color);
    const got: Partial<StopMarkerImages> = resumed ?? {};
    if (!resumed) partial.set(color, got);
    const complete = () => KEYS.every((key) => got[key] !== undefined);

    // A previous host already finished this colour and was culled before it
    // could hand the set over.
    if (complete()) {
      setReady(got as StopMarkerImages);
      return;
    }

    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const capture = () => {
      // `toDataURL` sizes its bitmap from the view's measured width, and a 0x0
      // Bitmap throws on the UI thread — so wait for layout rather than a wall
      // clock, the same signal `useMarkerTracking` waits on.
      if (laidOut.current) {
        for (const [key, ref] of targets) {
          if (got[key] !== undefined) continue;
          const svg = ref.current;
          if (!svg || typeof svg.toDataURL !== 'function') continue;
          svg.toDataURL((base64: string) => {
            // Deliberately not gated on `stopped`: a capture that lands after
            // this host was culled is still a valid bitmap, and the next host
            // resumes from `partial` rather than starting over. iOS invokes the
            // callback with nothing when it fails, hence the guard.
            if (!base64 || got[key] !== undefined) return;
            got[key] = 'data:image/png;base64,' + base64;
            if (complete()) setReady(got as StopMarkerImages);
          });
        }
      }
      if (stopped || complete()) return;
      // The ref can still be null well past 100ms on a cold start or a low-end
      // device; same retry shape as the bus pin capture in LiveMapScreen. If we
      // never succeed, the markers stay on the child-view fallback.
      if (++attempts <= CAPTURE_MAX_ATTEMPTS) timer = setTimeout(capture, 100 * attempts);
    };

    timer = setTimeout(capture, CAPTURE_FIRST_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [color]);

  /**
   * Decode the bitmaps before handing the URIs out.
   *
   * `MapMarker.setImage` loads through Fresco, and `getIcon()` falls back to
   * `BitmapDescriptorFactory.defaultMarker()` while that is in flight — so
   * publishing straight from the capture would put every stop on the map under
   * a red default pin for the frames the first decode takes. `Image.getSize`
   * runs the same request through the same pipeline, which leaves the bitmap in
   * Fresco's memory cache; Drawee then serves it synchronously inside
   * `setImage`, before the marker is ever added to the map.
   */
  useEffect(() => {
    if (!ready) return;
    let decoded = 0;
    const done = () => {
      if (++decoded >= KEYS.length) publish(color, ready);
    };
    for (const key of KEYS) Image.getSize(ready[key], done, done);
    // Publish regardless if the pipeline never answers — a red frame beats
    // never leaving the rasterised path.
    const timer = setTimeout(() => publish(color, ready), DECODE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, color]);

  return (
    <View style={s.hidden} pointerEvents="none" collapsable={false} onLayout={onLayout}>
      <StopArrowSvg svgRef={arrow} selected={false} />
      <StopArrowSvg svgRef={arrowSelected} selected />
      <StopDotSvg svgRef={dot} color={color} selected={false} />
      <StopDotSvg svgRef={dotSelected} color={color} selected />
      <NearbyStopPinSvg svgRef={pin} color={color} />
    </View>
  );
});

const s = StyleSheet.create({
  /** Offscreen but laid out — the same trick `BusMarkerSvg.hidden` uses. */
  hidden: { position: 'absolute', top: -9999, left: -9999, opacity: 0 },
});
