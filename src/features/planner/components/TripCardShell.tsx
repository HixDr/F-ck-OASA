/**
 * The card body a trip result is drawn into: entrance animation + press target.
 *
 * Results arrive in two waves — the estimate tier lands as a partial and the
 * live tier replaces it in place a moment later. Cards are keyed by `trip.id`,
 * which is stable across that upgrade, so this entrance runs once per genuinely
 * new trip instead of re-blinking the whole list when live times come back.
 *
 * The entrance lives on a wrapper rather than on the Pressable because
 * Pressable owns that element's `transform` for its press-scale; a second
 * animated style on the same node would simply lose.
 *
 * A hook cannot live in the screen's `renderCard`, which is a plain function
 * called a variable number of times per render — hence a real component.
 */

import React, { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Pressable from '../../../ui/Pressable';
import { duration, easing, useReduceMotion } from '../../../ui/motion';

/** Per-card offset. Long enough to read as a cascade, short enough that the
 *  last card is not still arriving when the user reaches for it. */
const STAGGER_MS = 45;
/** Cap the cascade so a long result list does not end in a visible queue. */
const MAX_STAGGER_STEPS = 5;
/** Rise of the entrance, in px. Small: this is a list settling, not a reveal. */
const RISE = 10;

interface Props {
  /** Position in the result list — drives the stagger only. */
  index: number;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
  children: React.ReactNode;
}

export default function TripCardShell({ index, style, onPress, children }: Props) {
  const reduced = useReduceMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      Math.min(index, MAX_STAGGER_STEPS) * STAGGER_MS,
      withTiming(1, { duration: duration.slow, easing: easing.out }),
    );
  }, [reduced, index, progress]);

  const anim = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * RISE }],
  }));

  return (
    <Animated.View style={anim}>
      <Pressable style={style} onPress={onPress}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
