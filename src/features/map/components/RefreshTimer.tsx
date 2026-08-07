/**
 * RefreshTimer — countdown to the next live-data poll + stale data indicator.
 *
 * Driven by the query's own `dataUpdatedAt` rather than a free-running
 * interval. The old version counted 10→1 off its own duplicated constant, so
 * it drifted from the actual `refetchInterval` within seconds and kept
 * counting confidently through failed fetches, backgrounding and resumes.
 */

import React, { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../../theme';

interface Props {
  /** Timestamp of the last successful fetch (react-query's `dataUpdatedAt`). */
  dataUpdatedAt: number;
  /** The query's real poll interval. */
  intervalMs: number;
  /** True while a request is in flight. */
  fetching?: boolean;
  staleLabel: string | null;
}

function remainingSec(dataUpdatedAt: number, intervalMs: number): number {
  if (!dataUpdatedAt) return Math.round(intervalMs / 1000);
  const left = intervalMs - (Date.now() - dataUpdatedAt);
  return Math.max(0, Math.ceil(left / 1000));
}

const RefreshTimer = memo(function RefreshTimer({
  dataUpdatedAt, intervalMs, fetching = false, staleLabel,
}: Props) {
  const [seconds, setSeconds] = useState(() => remainingSec(dataUpdatedAt, intervalMs));

  useEffect(() => {
    // Recompute from the clock every tick, so the number stays correct across
    // a suspended JS timer (backgrounded app) instead of resuming mid-count.
    setSeconds(remainingSec(dataUpdatedAt, intervalMs));
    const id = setInterval(() => {
      setSeconds(remainingSec(dataUpdatedAt, intervalMs));
    }, 1000);
    return () => clearInterval(id);
  }, [dataUpdatedAt, intervalMs]);

  return (
    <View style={s.wrap}>
      {staleLabel && (
        <View style={s.stalePill}>
          <Ionicons name="cloud-offline-outline" size={10} color={colors.warning} />
          <Text style={s.staleText}>{staleLabel}</Text>
        </View>
      )}
      <View style={s.timerPill}>
        <View style={[s.timerDot, staleLabel ? { backgroundColor: colors.warning } : null]} />
        <Text style={s.timerText}>{fetching ? '···' : `${seconds}s`}</Text>
      </View>
    </View>
  );
});

export default RefreshTimer;

const s = StyleSheet.create({
  wrap: { alignItems: 'flex-end', gap: 4 },
  timerPill: {
    backgroundColor: colors.overlay,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 64,
    justifyContent: 'center',
  },
  timerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  timerText: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stalePill: {
    backgroundColor: colors.overlay, borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    borderWidth: 1, borderColor: colors.warning,
    flexDirection: 'row', alignItems: 'center', gap: 3,
  },
  staleText: { color: colors.warning, fontSize: 9, fontWeight: '700' },
});
