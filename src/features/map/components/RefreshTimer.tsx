/**
 * RefreshTimer — shows a countdown to the next API poll + stale data indicator.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../../theme';

const POLL_INTERVAL = 10;

interface Props {
  staleLabel: string | null;
}

export default function RefreshTimer({ staleLabel }: Props) {
  const [seconds, setSeconds] = useState(POLL_INTERVAL);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((prev) => (prev <= 1 ? POLL_INTERVAL : prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ alignItems: 'flex-end', gap: 4 }}>
      {staleLabel && (
        <View style={s.stalePill}>
          <Ionicons name="cloud-offline-outline" size={10} color={colors.warning} />
          <Text style={s.staleText}>{staleLabel}</Text>
        </View>
      )}
      <View style={s.timerPill}>
        <View style={[s.timerDot, staleLabel ? { backgroundColor: colors.warning } : null]} />
        <Text style={s.timerText}>{seconds}s</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
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
