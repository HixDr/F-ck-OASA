/**
 * Pressable — the app's standard touch target.
 *
 * Replaces bare `TouchableOpacity` for anything that behaves like a button or
 * a card. Three things it guarantees that scattered TouchableOpacity did not:
 *
 *  - a press is *felt* (scale + optional haptic), not just seen as an opacity dip
 *  - the target is never smaller than `HIT_SIZE`, via hitSlop rather than by
 *    forcing layout, so a 16px icon stays 16px but is still tappable
 *  - it respects reduce-motion
 */

import React, { useCallback, useMemo } from 'react';
import {
  Pressable as RNPressable,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { HIT_SIZE } from '../theme';
import { duration, easing, useReduceMotion } from './motion';
import { hapticSelection } from '../services/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

export interface Props extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Scale at full press. 1 disables the effect. */
  pressScale?: number;
  /** Fire a selection haptic on press-in. Default true. */
  haptic?: boolean;
  children?: React.ReactNode;
}

export default function Pressable({
  style,
  pressScale = 0.97,
  haptic = true,
  onPressIn,
  onPressOut,
  disabled,
  children,
  ...rest
}: Props) {
  const scale = useSharedValue(1);
  const reduced = useReduceMotion();

  /* Measured so hitSlop can top the target up to HIT_SIZE. A fixed slop would
     over-extend large targets and let neighbouring rows steal each other's
     taps. */
  const size = useSharedValue({ w: HIT_SIZE, h: HIT_SIZE });
  const [slop, setSlop] = React.useState({ top: 0, bottom: 0, left: 0, right: 0 });

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    size.value = { w: width, h: height };
    const x = Math.max(0, Math.ceil((HIT_SIZE - width) / 2));
    const y = Math.max(0, Math.ceil((HIT_SIZE - height) / 2));
    setSlop((prev) =>
      prev.left === x && prev.top === y ? prev : { top: y, bottom: y, left: x, right: x },
    );
  }, [size]);

  const handleIn = useCallback((e: Parameters<NonNullable<PressableProps['onPressIn']>>[0]) => {
    if (!reduced && pressScale !== 1) {
      scale.value = withTiming(pressScale, { duration: duration.fast, easing: easing.out });
    }
    if (haptic) hapticSelection();
    onPressIn?.(e);
  }, [reduced, pressScale, haptic, onPressIn, scale]);

  const handleOut = useCallback((e: Parameters<NonNullable<PressableProps['onPressOut']>>[0]) => {
    scale.value = withTiming(1, { duration: duration.fast, easing: easing.out });
    onPressOut?.(e);
  }, [onPressOut, scale]);

  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const composed = useMemo(
    () => [style, animStyle, disabled ? { opacity: 0.4 } : null],
    [style, animStyle, disabled],
  );

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onLayout={onLayout}
      hitSlop={slop}
      onPressIn={handleIn}
      onPressOut={handleOut}
      style={composed}
    >
      {children}
    </AnimatedPressable>
  );
}
