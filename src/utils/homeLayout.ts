/**
 * Where Home's screen box actually is, for the "launched 90dp too low" bug.
 *
 * The complaint these exist to settle: intermittently, on a cold launch, Home
 * renders pushed down by ~83dp with a flat grey band across the top. Read them
 * with:
 *
 *     adb logcat -s ReactNativeJS:V | grep homelayout
 *
 * ── What the one line answers ──
 *
 * Home's container is `flex: 1` at the root of its native-stack screen, so its
 * measured height *is* the screen box's height. The window's height is the whole
 * window. `unaccounted` is the difference, and it is the whole diagnosis:
 *
 *  unaccounted ≈ 0
 *      The screen box fills the window. Home is where it should be, whatever
 *      else the line says.
 *
 *  unaccounted > 0, insets look right
 *      Something native is holding layout space above (or below) the screen box,
 *      and Home is being pushed by it rather than mispositioning itself. On
 *      2026-08-10 this was measured at exactly 83.0dp on a 420×933dp device and
 *      traced to the native stack's `AppBarLayout`: `app/_layout.tsx` does not
 *      set `headerShown`, so React Navigation's default (`true`) applies to Home
 *      until `<Stack.Screen options={HEADER_OFF} />` lands one commit later. On a
 *      launch that loses that race the toolbar is removed but the empty
 *      `AppBarLayout` keeps its measured height, and `AppBarLayout`'s
 *      `ScrollingViewBehavior` keeps the screen offset below it. The band is the
 *      window background (`#303030`) seen through the transparent app bar.
 *
 *      A number that is NOT ~83 is worth reporting rather than assuming: the
 *      stale height is whatever the header happened to have measured when the
 *      race resolved, so it is expected to vary between launches and devices.
 *
 *  insets.top wrong (not ~54dp here) with unaccounted ≈ 0
 *      Then it is not the header — Home really is padding itself by the wrong
 *      amount, and the inset is where to look. This is the hypothesis this line
 *      exists to *rule out*; it was already ruled out once by measurement (the
 *      offset launch still padded by insets.top + 8dp, correctly).
 *
 * A good launch prints exactly one line. A second line means the geometry
 * changed after first layout — rotation, a font-scale change, or the offset
 * correcting itself, and which of those it was is readable from the numbers.
 *
 * Deliberately not gated on __DEV__, and deliberately one line: this app is
 * diagnosed from release builds installed off GitHub Releases, and a diagnostic
 * that only runs where the problem does not is no diagnostic.
 */

/** Single switch. Turn off once the launch-offset question is settled. */
export const HOME_LAYOUT_TRACE = true;

export interface HomeFrame {
  /** `useWindowDimensions()`, in dp. */
  winW: number;
  winH: number;
  /** Home's container as `onLayout` measured it, in dp. Its height is the
   *  native-stack screen box's height. */
  frameW: number;
  frameH: number;
  /** `useSafeAreaInsets()`, in dp. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Last line printed, so a screen that re-lays-out with identical geometry is
 * silent. Module scope rather than a ref because there is only ever one Home,
 * and because a remount reporting the same numbers is not news either.
 */
let last = '';

const dp = (n: number) => n.toFixed(1);

export function traceHomeFrame(f: HomeFrame): void {
  if (!HOME_LAYOUT_TRACE) return;
  const line =
    `screen ${dp(f.frameW)}x${dp(f.frameH)} window ${dp(f.winW)}x${dp(f.winH)} ` +
    `unaccounted=${dp(f.winH - f.frameH)} ` +
    `insets t=${dp(f.top)} b=${dp(f.bottom)} l=${dp(f.left)} r=${dp(f.right)}`;
  if (line === last) return;
  last = line;
  console.log(`[homelayout] ${line}`);
}
