/**
 * Timing marks for the first-map-open investigation.
 *
 * The complaint these exist to settle: on a fresh launch, tapping a line freezes
 * the push animation for roughly half a second. A native-stack transition is
 * animated on the UI thread, so JS cannot be what freezes it — the suspect is
 * native map setup (the maps_core dynamite load, MapsInitializer, renderer
 * selection, the EGL surface) happening on that same thread at the same time.
 *
 * Read them with:
 *
 *     adb logcat -s ReactNativeJS:V | grep mapperf
 *
 * ── What each mark answers ──
 *
 *  warmup armed / warmup skipped (already on a map)
 *      When the hidden warm-up MapView was created. This is the mark that
 *      matters most: if it lands *after* `line map screen mounted`, the warm-up
 *      did nothing for this open, which is exactly what a 1,500ms arming delay
 *      used to guarantee for anyone who tapped quickly. It should now land at
 *      roughly (first paint + 250ms).
 *
 *  warmup onMapReady / warmup onMapLoaded
 *      The two halves of the warm-up. `onMapReady` alone means SDK init was
 *      warmed — the expensive, permanent half. `onMapLoaded` additionally means
 *      the hidden map was really composited, so the cloud style and tiles landed
 *      in the SDK's disk cache too.
 *
 *  warmup torn down (loaded) / (CAP — never loaded)
 *      The CAP branch is the standing hypothesis about the warm-up being parked
 *      offscreen at zero opacity: nothing composites it, so it never reports
 *      itself loaded. If this branch is what shows up, the sliver and non-zero
 *      opacity in MapWarmup.tsx are aimed at it — and if it *stops* showing up
 *      after those, they worked.
 *
 *  <screen> mount released (why, warmup=phase)
 *      When the screen's own MapView was finally created, and why. `why` should
 *      read `transitionEnd` every time; `CAP — no transitionEnd` means the event
 *      never arrived and the deferral degenerated into a plain timer, which is a
 *      bug to fix rather than a result to keep. `warmup=` says whether the warm-up
 *      was `done` (ideal), `warming`/`loaded` (the tap collided with it — the
 *      dynamite load was on the UI thread as the user tapped), `idle` (armed too
 *      late again) or `off`.
 *
 *  <screen> screen mounted → mount released → onMapReady → onMapLoaded
 *      The four-stage breakdown of an open. `mounted → released` is the
 *      deliberate deferral (expect ~400ms, one transition), `released →
 *      onMapReady` is native map construction, `onMapReady → onMapLoaded` is
 *      tiles.
 *
 *      `released → onMapReady` is the number that decides whether deferring was
 *      worth it, because that span is the UI-thread work that used to overlap the
 *      animation. Hundreds of milliseconds: it was the stall, and moving it past
 *      the transition is the right fix. Tens of milliseconds: constructing the
 *      view was never expensive, the freeze came from somewhere else, and the
 *      deferral is pure added latency — turn `MAP_MOUNT_AFTER_TRANSITION` off and
 *      look elsewhere. Whether the transition itself is smooth is still a
 *      question for eyes, not for the log; these marks only say where the time
 *      went.
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
