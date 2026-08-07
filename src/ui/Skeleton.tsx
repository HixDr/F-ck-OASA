/**
 * Skeleton — a placeholder shaped like the content that will replace it.
 *
 * Used only where the final layout is genuinely known (a stop card, a search
 * row, a planner result). Where the shape is not known, a spinner is the honest
 * answer and stays.
 *
 * The point is not decoration: a skeleton that matches the real layout means
 * content resolves in place instead of the screen jumping when data lands.
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, radius, spacing } from '../theme';
import { useReduceMotion } from './motion';

const PULSE_MS = 1100;

interface BoxProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** One shimmering block. */
export function SkeletonBox({ width = '100%', height = 12, radius: r = radius.sm, style }: BoxProps) {
  const opacity = useSharedValue(0.35);
  const reduced = useReduceMotion();

  useEffect(() => {
    if (reduced) {
      // Static at the midpoint — still legible as "not real content yet".
      opacity.value = 0.3;
      return;
    }
    opacity.value = withRepeat(
      withTiming(0.75, { duration: PULSE_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [reduced, opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[{ width, height, borderRadius: r, backgroundColor: colors.border }, animStyle, style]}
    />
  );
}

/**
 * Stop-card skeleton — mirrors FavoriteStopCard: a title row and three arrival
 * rows, each with a line badge, a label and the big number on the right.
 */
export function SkeletonStopCard() {
  return (
    <View style={s.card} accessibilityLabel="Loading stop">
      <View style={s.headerRow}>
        <SkeletonBox width={14} height={14} radius={7} />
        <SkeletonBox width="55%" height={14} />
      </View>
      {[0, 1, 2].map((i) => (
        <View key={i} style={s.line}>
          <SkeletonBox width={44} height={22} radius={radius.sm} />
          <SkeletonBox width="42%" height={11} style={s.grow} />
          <SkeletonBox width={40} height={28} radius={radius.sm} />
        </View>
      ))}
    </View>
  );
}

/** Search / line-list row skeleton — badge, two text lines, trailing action. */
export function SkeletonListRow() {
  return (
    <View style={s.row}>
      <SkeletonBox width={44} height={24} radius={radius.sm} />
      <View style={s.rowMeta}>
        <SkeletonBox width="70%" height={12} />
        <SkeletonBox width="45%" height={10} style={s.gapTop} />
      </View>
      <SkeletonBox width={22} height={22} radius={11} />
    </View>
  );
}

/** Planner result-card skeleton — header chip, two legs, a total row. */
export function SkeletonTripCard() {
  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <SkeletonBox width={64} height={18} radius={radius.sm} />
        <View style={s.grow} />
        <SkeletonBox width={72} height={18} radius={radius.sm} />
      </View>
      <SkeletonBox width="80%" height={12} style={s.gapTop} />
      <SkeletonBox width="66%" height={12} style={s.gapTop} />
      <View style={s.totalRow}>
        <SkeletonBox width="40%" height={14} />
        <SkeletonBox width={24} height={24} radius={12} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    paddingHorizontal: spacing.md,
    minHeight: 60,
    marginBottom: spacing.xs + 2,
  },
  rowMeta: { flex: 1 },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  grow: { flex: 1 },
  gapTop: { marginTop: spacing.xs },
});
