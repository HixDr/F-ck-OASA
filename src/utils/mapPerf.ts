/**
 * Timing marks for the map warm-up investigation.
 *
 * The boot warm-up removes the process-wide half of map initialisation — the
 * maps_core dynamite load, MapsInitializer, renderer selection, the cloud style
 * fetch. It cannot remove the per-instance half: every screen builds a new
 * MapView, and that view's EGL surface and first frame are its own.
 *
 * Opening a line still costs a few hundred milliseconds, and there are two very
 * different explanations. Either that is the per-instance half, which no
 * warm-up can touch and only a single reused MapView would fix, or the warm-up
 * is quietly doing half its job — it is mounted offscreen at zero opacity, and
 * if Android declines to draw it then `onMapLoaded` never fires, the hard cap
 * tears it down, and only SDK init was ever warmed.
 *
 * These marks separate the two. Read them with:
 *
 *     adb logcat -s ReactNativeJS:V | grep mapperf
 *
 * Flip `MAP_PERF` to false to silence them. Deliberately not gated on __DEV__:
 * this app is diagnosed from release builds installed off GitHub Releases, and
 * a diagnostic that only runs where the problem does not is no diagnostic.
 */

/** Process start, near enough — this module is imported during boot. */
const T0 = Date.now();

/** Single switch. Turn off once the warm-up question is settled. */
export const MAP_PERF = true;

export function mapPerf(tag: string): void {
  if (!MAP_PERF) return;
  console.log(`[mapperf] +${Date.now() - T0}ms ${tag}`);
}
