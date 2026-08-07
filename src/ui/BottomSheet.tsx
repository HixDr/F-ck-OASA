/**
 * BottomSheet — a sheet that actually responds to the handle drawn on it.
 *
 * The planner already rendered a grabber (`s.panelHandle`) above a fixed-height
 * panel, which is a promise the UI could not keep. The map screens went the
 * other way: real content in a fixed card with no way to resize or dismiss it,
 * so a tall stop covered the map you were trying to read.
 *
 * Snap points are fractions of the available height, largest last. The sheet
 * settles on the nearest one, biased by fling velocity, so a quick flick moves
 * a snap even when the finger barely travelled.
 */

import React, { useCallback, useEffect, useImperativeHandle, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme';
import { duration, easing, spring, useReduceMotion } from './motion';

/** Fling speed past which velocity, not position, picks the snap. */
const FLING_VELOCITY = 600;
/** Downward fling from the lowest snap that dismisses instead of settling. */
const DISMISS_VELOCITY = 900;

export interface BottomSheetHandle {
  /** Move to a snap point by index. */
  snapTo: (index: number) => void;
}

interface Props {
  /** Fractions of available height, ascending. e.g. [0.25, 0.6] */
  snapPoints: number[];
  /** Index into `snapPoints` to open at. */
  initialSnap?: number;
  /** Called when the user drags the sheet off the bottom. Omit to disable. */
  onDismiss?: () => void;
  /** Dim and block the content behind the sheet. */
  backdrop?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  ref?: React.Ref<BottomSheetHandle>;
}

export default function BottomSheet({
  snapPoints,
  initialSnap = 0,
  onDismiss,
  backdrop = false,
  style,
  children,
  ref,
}: Props) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReduceMotion();

  const available = Math.max(1, winH - insets.top);

  /* Snap points as absolute heights, ascending and clamped. Sorting here means
     a caller passing them out of order still gets sane nearest-snap maths. */
  const heights = useMemo(() => {
    const hs = snapPoints
      .map((f) => Math.round(Math.max(0.05, Math.min(1, f)) * available))
      .sort((a, b) => a - b);
    return hs.length > 0 ? hs : [Math.round(available * 0.4)];
  }, [snapPoints, available]);

  const maxH = heights[heights.length - 1];
  const startIdx = Math.max(0, Math.min(initialSnap, heights.length - 1));

  /** Current sheet height in px. Animated on the UI thread. */
  const h = useSharedValue(heights[startIdx]);
  /** Height at gesture start. */
  const startH = useSharedValue(0);

  /* Re-clamp when the window resizes (rotation, foldable, split screen). */
  useEffect(() => {
    if (h.value > maxH) h.value = withTiming(maxH, { duration: duration.fast });
  }, [maxH, h]);

  useImperativeHandle(ref, () => ({
    snapTo: (index: number) => {
      const i = Math.max(0, Math.min(index, heights.length - 1));
      h.value = reduced
        ? withTiming(heights[i], { duration: duration.fast, easing: easing.out })
        : withSpring(heights[i], spring);
    },
  }), [heights, h, reduced]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startH.value = h.value;
        })
        .onUpdate((e) => {
          // Dragging down (positive translationY) shrinks the sheet.
          const next = startH.value - e.translationY;
          // Rubber-band past the tallest snap rather than hard-stopping.
          h.value = next > maxH ? maxH + (next - maxH) * 0.15 : Math.max(0, next);
        })
        .onEnd((e) => {
          const v = e.velocityY;

          if (onDismiss && v > DISMISS_VELOCITY && h.value <= heights[0] * 1.15) {
            h.value = withTiming(0, { duration: duration.base, easing: easing.out });
            runOnJS(onDismiss)();
            return;
          }

          /* Velocity wins over position on a fling: the user's intent is the
             direction they threw it, not where their finger happened to stop. */
          let target: number;
          if (v < -FLING_VELOCITY) {
            target = heights.find((x) => x > h.value + 1) ?? maxH;
          } else if (v > FLING_VELOCITY) {
            const below = heights.filter((x) => x < h.value - 1);
            if (below.length === 0 && onDismiss) {
              h.value = withTiming(0, { duration: duration.base, easing: easing.out });
              runOnJS(onDismiss)();
              return;
            }
            target = below.length > 0 ? below[below.length - 1] : heights[0];
          } else {
            target = heights.reduce(
              (best, x) => (Math.abs(x - h.value) < Math.abs(best - h.value) ? x : best),
              heights[0],
            );
          }
          /* Inlined rather than calling a `useCallback`-wrapped worklet: that
             pattern depends on the Babel plugin transforming a closure created
             on the JS thread, and fails at runtime rather than compile time
             when it does not. */
          h.value = reduced
            ? withTiming(target, { duration: duration.fast, easing: easing.out })
            : withSpring(target, spring);
        }),
    [heights, maxH, h, startH, onDismiss, reduced],
  );

  const sheetStyle = useAnimatedStyle(() => ({ height: h.value }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: Math.min(0.6, (h.value / maxH) * 0.6),
  }));

  return (
    <>
      {backdrop && (
        <Animated.View style={[s.backdrop, backdropStyle]} pointerEvents="none" />
      )}
      <Animated.View style={[s.sheet, sheetStyle, style]}>
        {/* Only the handle area takes the pan. Attaching it to the whole sheet
            would fight every scroll view and list inside the content. */}
        <GestureDetector gesture={pan}>
          <View style={s.handleArea} accessibilityRole="adjustable" accessibilityLabel="Resize panel">
            <View style={s.handle} />
          </View>
        </GestureDetector>
        <View style={s.content}>{children}</View>
      </Animated.View>
    </>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    overflow: 'hidden',
  },
  handleArea: {
    alignItems: 'center',
    justifyContent: 'center',
    /* Generous: this is the only draggable strip, so it must be findable
       without looking. */
    height: 28,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  content: { flex: 1 },
});
