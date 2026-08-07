/**
 * Motion vocabulary.
 *
 * One place for every duration, easing and spring in the app, so "how fast
 * should this be?" is answered once rather than per component.
 *
 * The reduce-motion hook is not optional garnish. This app previously animated
 * almost nothing outside the bus layer; adding gesture-driven sheets, drag
 * reordering and list transitions in one release takes vestibular-sensitive
 * users from a still interface to a moving one with no warning. Every animation
 * added in this pass asks `useReduceMotion()` first and degrades to an instant
 * state change.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';

/** Durations in ms. */
export const duration = {
  /** Press feedback, toggles — must feel instantaneous. */
  fast: 120,
  /** The default. Sheet snaps, fades, most transitions. */
  base: 200,
  /** Entrances, larger travel. Anything slower reads as lag. */
  slow: 320,
} as const;

/** Standard easing — decelerate. Things arrive, they do not bounce in. */
export const easing = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
} as const;

export const timing: WithTimingConfig = { duration: duration.base, easing: easing.out };

/** Sheet and drag physics. Critically damped — no overshoot on a transit UI. */
export const spring: WithSpringConfig = {
  damping: 22,
  stiffness: 220,
  mass: 0.7,
  overshootClamping: false,
  reduceMotion: ReduceMotion.System,
};

/** A lift, for a card picked up by a drag gesture. */
export const liftSpring: WithSpringConfig = {
  damping: 18,
  stiffness: 300,
  mass: 0.6,
  reduceMotion: ReduceMotion.System,
};

/**
 * Live OS reduce-motion setting.
 *
 * Subscribed rather than read once: the user can change it while the app is
 * running, and an accessibility setting that needs a restart to take effect is
 * not much of an accessibility setting.
 */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduced(v); })
      .catch(() => { /* Old Android without the setting — assume motion is fine. */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; sub.remove(); };
  }, []);

  return reduced;
}
