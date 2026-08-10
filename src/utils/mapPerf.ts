/**
 * Timing marks for the first-map-open investigation.
 *
 * The complaint these exist to settle: on a fresh launch, tapping a line freezes
 * the push animation for roughly half a second. A native-stack transition is
 * animated on the UI thread, so JS cannot be what freezes it — the suspect was
 * native map setup (the maps_core dynamite load, MapsInitializer, renderer
 * selection, the EGL surface) happening on that same thread at the same time.
 *
 * Read them with:
 *
 *     adb logcat -s ReactNativeJS:V | grep mapperf
 *
 * ── What the 1.2.5 build already settled ──
 *
 * Two things, both from marks read off a real device:
 *
 *     +1810ms  warmup armed
 *     +2071ms  warmup onMapReady          <- 261ms
 *     +2309ms  warmup onMapLoaded
 *     +2821ms  warmup torn down (loaded)
 *
 *     +81856ms line map screen mounted
 *     +82115ms line map onMapReady        <- 259ms
 *     +84677ms line map onMapLoaded          (tiles over the network)
 *
 *  1. A hidden map parked fully offscreen at zero opacity DOES composite and
 *     load — the teardown branch was `(loaded)`, not `(CAP — never loaded)`.
 *  2. Per-instance native construction costs ~259ms and is paid in full with the
 *     SDK already warm: the warm-up's own 261ms and the real screen's 259ms are
 *     the same number. Warming the process cannot remove it, because a MapView's
 *     EGL surface cannot be handed to another MapView. Only *not creating a
 *     second MapView* removes it.
 *
 * So there is now one MapView for the whole process, hosted behind the navigator
 * (`src/ui/MapHost.tsx`), and these marks exist to prove that the per-screen cost
 * is gone rather than moved.
 *
 * ── What each mark answers now ──
 *
 *  map host armed / armed (a screen is waiting for it)
 *      When the one and only MapView was created. Normally ~250ms after the
 *      first screen paints. The second form is the fallback for someone who
 *      opened a map before that — and it deliberately fires only once that
 *      screen's push animation is over, so even then construction never lands on
 *      the animation. Everything below happens once per process, never again.
 *
 *  map host onMapReady / map host onMapLoaded
 *      The construction that used to be paid per screen, paid once. `onMapReady`
 *      is SDK init and the EGL surface (~260ms); `onMapLoaded` additionally means
 *      tiles reached the screen.
 *
 *      THE HEADLINE TEST: these two marks, and the ~260ms between armed and
 *      onMapReady, must appear EXACTLY ONCE in a session's log. A second
 *      `onMapReady` from any source means something is still building a MapView
 *      per screen and the refactor did not land.
 *
 *  <screen> screen mounted
 *      The screen's React mount. The clock for everything below starts here.
 *
 *  <screen> claimed the surface
 *      The screen took ownership of the shared map. Should land in the same
 *      breath as `screen mounted` — it is a JS state change and nothing else. A
 *      gap here would mean focus is arriving late.
 *
 *  <screen> camera set / camera restored (Δ…)
 *      `set` is a first visit taking its `initialRegion`; `restored` is a pop
 *      back to a screen whose viewport was remembered, which is what stops a
 *      return trip showing the other screen's part of Athens. Both happen while
 *      the screen is still opaque, so neither is visible.
 *
 *  <screen> map usable (why, host=phase) Δ…
 *      **This is the number the whole exercise is about.** The moment the shared
 *      map is showing through this screen and can be touched. Δ runs from the
 *      screen *appearing* — its mount on a first visit, its refocus on a pop back
 *      — which is exactly the gap the user experiences as "waiting for the map".
 *
 *      Δ should be one push animation and nothing more: ~400ms on stock Android,
 *      ~800ms at a 2× animator scale. That is the transition we deliberately wait
 *      out, and it is now the *whole* wait. What must not be in there any more is
 *      the ~259ms of native construction — before this refactor the equivalent
 *      gap was one transition plus that 259ms plus the tile fetch.
 *
 *      `why` should read `transitionEnd` every time. `CAP — no transitionEnd`
 *      means react-native-screens never told us the animation finished and the
 *      reveal degenerated into a plain 900ms timer — a bug to fix, not a result
 *      to keep. `host=` must read `loaded`: it says the surface was already
 *      drawing tiles when the screen claimed it. `host=creating` means the user
 *      beat the boot arming — the only case left where anyone waits for a map,
 *      and the Δ there will carry the ~260ms of construction honestly.
 *
 *  <screen> released the surface
 *      The screen lost focus and gave the map back. Its markers come off and its
 *      viewport is remembered. Paired with the next screen's `claimed`, this is
 *      the handover, and there should be no `onMapReady` anywhere near it.
 *
 * Flip `MAP_PERF` to false to silence them. Deliberately not gated on __DEV__:
 * this app is diagnosed from release builds installed off GitHub Releases, and
 * a diagnostic that only runs where the problem does not is no diagnostic.
 */

/** Process start, near enough — this module is imported during boot. */
const T0 = Date.now();

/** Single switch. Turn off once the shared-surface question is settled. */
export const MAP_PERF = true;

/**
 * A clock reading to hand back to `mapPerf` later.
 *
 * The marks used to be moments only, and the questions they exist to answer are
 * all *spans* — "how long after the screen appeared was its map usable?". That
 * arithmetic was left to whoever read the log, across lines whose absolute
 * timestamps run into six figures on a session that has been open for a day.
 * Printing the span is the difference between a number you can read and a number
 * you can mis-subtract.
 */
export function mapNow(): number {
  return Date.now();
}

/**
 * Log a mark, optionally with the span since a `mapNow()` reading.
 *
 * `since` is deliberately not defaulted to T0: a span from process start is the
 * absolute timestamp we already print, and pretending otherwise would make the
 * two numbers on a line say the same thing.
 */
export function mapPerf(tag: string, since?: number): void {
  if (!MAP_PERF) return;
  const now = Date.now();
  const span = since == null ? '' : ` Δ${now - since}ms`;
  console.log(`[mapperf] +${now - T0}ms ${tag}${span}`);
}
