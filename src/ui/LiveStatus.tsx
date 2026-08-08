/**
 * LiveStatus — the one live-data indicator on Home.
 *
 * Every saved stop card used to carry its own "Live / updated 40s ago" line, so
 * a screen with six stops made six claims about the same thing and none of them
 * could say when the next refresh was due. There is one clock now (see the
 * shared arrivals clock in hooks/index.ts) and one place that reports it.
 *
 * Deliberately not `RefreshTimer` from the map: that one is chrome designed to
 * float over a moving map — translucent pills, right-aligned column — and it has
 * no notion of being paused. Its countdown logic is what is worth borrowing:
 * recomputed from the wall clock on every tick, so it stays correct across a JS
 * timer the OS suspended, and clamped at zero rather than counting negative.
 */

import React, { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, font, radius, spacing } from '../theme';

interface Props {
  /** Oldest arrivals timestamp across the stops on screen; 0 before any land. */
  updatedAt: number;
  /** Wall-clock ms of the next shared refresh; 0 while the clock is parked. */
  nextPollAt: number;
  /** The shared poll interval — decides how old "Live" is allowed to be. */
  intervalMs: number;
  /** A refresh is in flight. */
  fetching?: boolean;
  offline?: boolean;
  /** Stops whose own arrivals request is failing. Their cards say so too; the
   *  count is here so a failure below the fold is still visible. */
  failing?: number;
  /**
   * Home is not the focused screen.
   *
   * Home stays mounted under /search, /map/* and /planner, so an ungated
   * interval here is a permanent 1 Hz re-render of a header nobody is looking
   * at — for a number that is frozen anyway, because the poll clock parks with
   * the screen.
   */
  paused?: boolean;
}

/** "just now" / "40s ago" / "3m ago". Minute resolution past a minute: nobody
 *  reads "94 seconds ago" as a quantity. */
function ageLabel(ms: number): string {
  if (ms < 10_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  return `${Math.floor(ms / 60_000)}m ago`;
}

const LiveStatus = memo(function LiveStatus({
  updatedAt,
  nextPollAt,
  intervalMs,
  fetching = false,
  offline = false,
  failing = 0,
  paused = false,
}: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing to count and nothing ageing — do not hold a timer for it.
    if (paused || (!updatedAt && !nextPollAt)) return;
    // Catch up on time spent away, without a redundant render on mount.
    setNow((prev) => (Date.now() - prev > 1_000 ? Date.now() : prev));
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [paused, updatedAt, nextPollAt]);

  const age = updatedAt ? Math.max(0, now - updatedAt) : 0;
  const seconds = nextPollAt ? Math.max(0, Math.ceil((nextPollAt - now) / 1000)) : null;
  const live = !!updatedAt && !offline && failing === 0 && age < intervalMs + 5_000;

  const label = !updatedAt
    ? offline
      ? 'Offline'
      : 'Waiting for arrivals'
    : offline
      ? `Offline · updated ${ageLabel(age)}`
      : failing > 0
        ? `${failing} stop${failing === 1 ? '' : 's'} not updating`
        : live
          ? 'Live'
          : `Updated ${ageLabel(age)}`;

  const countdown = fetching ? '···' : seconds == null ? '—' : `${seconds}s`;

  return (
    <View
      style={s.row}
      /* One accessible node, and deliberately not a live region: this text
         changes every second, and announcing that would bury everything else. */
      accessible
      accessibilityLabel={
        seconds == null
          ? label
          : fetching
            ? `${label}, refreshing now`
            : `${label}, next refresh in ${seconds} second${seconds === 1 ? '' : 's'}`
      }
    >
      <View
        style={[
          s.dot,
          { backgroundColor: live ? colors.success : updatedAt || offline ? colors.warning : colors.border },
        ]}
      />
      <Text style={[s.label, !live && !!updatedAt && { color: colors.warning }]}>{label}</Text>
      <Text style={s.countdown}>{countdown}</Text>
    </View>
  );
});

export default LiveStatus;

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 22,
    marginTop: spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  /** Left to grow and wrap rather than truncate: at a large font scale the row
   *  gets taller, which is the correct failure mode for a status line. */
  label: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '600',
  },
  /** `font.num` and a fixed width, so 9s → 10s does not shove the label. */
  countdown: {
    ...font.num,
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '700',
    minWidth: 30,
    textAlign: 'right',
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
});
