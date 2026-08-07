/**
 * Loading / error feedback for the map screens.
 *
 * The map used to show a full-screen spinner gated only on the route list,
 * which vanished long before stops, shape and buses arrived — so the slowest
 * part of the load looked like an empty dark map. And a failing API was
 * indistinguishable from "no buses running". This surfaces both.
 */

import React, { memo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../../../theme';

interface Props {
  /** Nothing usable is on the map yet — take the screen. */
  blocking?: boolean;
  /** What is still in flight, e.g. "Loading stops…". Null when idle. */
  loadingLabel?: string | null;
  /** Non-blocking advice, e.g. "Zoom in to see stops". Rendered without a spinner. */
  hint?: string | null;
  /** Human-readable failure. Null when fine. */
  error?: string | null;
  onRetry?: () => void;
  onDismissError?: () => void;
}

const MapStatus = memo(function MapStatus({
  blocking = false, loadingLabel = null, hint = null, error = null, onRetry, onDismissError,
}: Props) {
  if (blocking) {
    return (
      <View style={s.blocking} pointerEvents="none">
        <ActivityIndicator size="large" color={colors.primaryLight} />
        {loadingLabel ? <Text style={s.blockingText}>{loadingLabel}</Text> : null}
      </View>
    );
  }

  if (!loadingLabel && !hint && !error) return null;

  return (
    <View style={s.stack} pointerEvents="box-none">
      {loadingLabel ? (
        <View style={s.pill}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={s.pillText}>{loadingLabel}</Text>
        </View>
      ) : hint ? (
        <View style={s.pill}>
          <Ionicons name="search-outline" size={12} color={colors.textMuted} />
          <Text style={s.pillText}>{hint}</Text>
        </View>
      ) : null}
      {error ? (
        <View style={s.errorPill}>
          <Ionicons name="warning-outline" size={12} color={colors.danger} />
          <Text style={s.errorText} numberOfLines={2}>{error}</Text>
          {onRetry ? (
            <TouchableOpacity onPress={onRetry} hitSlop={8}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
          {onDismissError ? (
            <TouchableOpacity onPress={onDismissError} hitSlop={8}>
              <Ionicons name="close" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export default MapStatus;

const s = StyleSheet.create({
  blocking: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    gap: spacing.sm,
  },
  blockingText: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600' },
  stack: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: 36 + spacing.sm * 2,
    alignItems: 'center',
    gap: spacing.xs,
  },
  pill: {
    backgroundColor: colors.overlay, borderRadius: radius.full,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderWidth: 1, borderColor: colors.border,
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
  },
  pillText: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600' },
  errorPill: {
    backgroundColor: colors.overlay, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2,
    borderWidth: 1, borderColor: colors.danger,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    maxWidth: '100%',
  },
  errorText: { color: colors.text, fontSize: font.size.xs, flexShrink: 1 },
  retryText: { color: colors.primaryLight, fontSize: font.size.xs, fontWeight: '700' },
});
