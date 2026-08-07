import { useCallback, useEffect, useRef, useState } from 'react';

export interface MarkerTracking {
  /** Feed straight into the Marker's `tracksViewChanges`. */
  tracksViewChanges: boolean;
  /** Feed into the Marker's top-level child `onLayout`. */
  onLayout: () => void;
}

/** Grace period after layout, so the bitmap capture sees the measured view. */
const SETTLE_MS = 120;

/**
 * Shared hook — enables `tracksViewChanges` on a react-native-maps Marker
 * while its custom view is being rasterized, then disables it so the map is
 * not re-capturing bitmaps every frame.
 *
 * The signal is the child's `onLayout`, not a wall clock. A fixed timer raced
 * Android's first layout pass: on a cold start the burst could expire before
 * the view had ever been measured, and the marker stayed permanently blank.
 * The timer survives only as an upper bound, because two cases never report
 * layout — a Marker rendered from an `image` (no child view at all), and a
 * dependency change that alters the view's *content* but not its size.
 *
 * Scope this per marker, not per screen: a shared burst flag turns on
 * per-frame rasterization for every marker on the map whenever any one of
 * them changes.
 */
export function useMarkerTracking(deps: unknown[], maxDurationMs = 1200): MarkerTracking {
  const [tracking, setTracking] = useState(true);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  const onLayout = useCallback(() => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => setTracking(false), SETTLE_MS);
  }, []);

  useEffect(() => {
    // On mount `tracking` is already true — writing it again just costs a
    // render before the marker has even been rasterized once.
    if (mounted.current) setTracking(true);
    else mounted.current = true;

    if (settle.current) clearTimeout(settle.current);
    if (cap.current) clearTimeout(cap.current);
    cap.current = setTimeout(() => setTracking(false), maxDurationMs);

    return () => {
      if (settle.current) clearTimeout(settle.current);
      if (cap.current) clearTimeout(cap.current);
    };
    // `maxDurationMs` belongs here: a caller that varied it was silently ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, maxDurationMs]);

  return { tracksViewChanges: tracking, onLayout };
}
