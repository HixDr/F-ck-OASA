/**
 * ScheduleGrid — displays a time grid with auto-scroll to the next departure.
 * Shared by LiveMapScreen and FavoriteStopCard.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { colors, radius, font, onAccent } from '../theme';
import { athensNowMin, hhmmToMin } from '../utils/scheduleUtils';

interface Props {
  times: string[];
  nextDeparture: string | null;
  accentColor: string;
  maxHeight?: number;
}

/** One departure cell. Memoized: a busy line has 100-150 of these and the
 *  parent re-renders on every arrival poll. */
const TimeCell = React.memo(function TimeCell({
  time,
  isPast,
  isNext,
  accentColor,
  onLayout,
}: {
  time: string;
  isPast: boolean;
  isNext: boolean;
  accentColor: string;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  return (
    <View style={[s.time, isNext && { backgroundColor: accentColor }]} onLayout={onLayout}>
      <Text
        style={[
          s.timeText,
          isPast && s.timePast,
          /* The next departure is the one cell filled with the user's accent, so
             it is the one cell whose ink cannot be assumed white. */
          isNext && [s.timeNext, { color: onAccent(accentColor) }],
        ]}
      >
        {time}
      </Text>
    </View>
  );
});

function ScheduleGrid({ times, nextDeparture, accentColor, maxHeight = 160 }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  /** The auto-scroll is a one-shot. `onLayout` fires on every layout pass, so
   *  without this the grid yanked itself back to "next" whenever the parent
   *  re-rendered — which, with a 15s arrival poll, meant mid-scroll. */
  const hasScrolled = useRef(false);

  // A new timetable (different line, or the day rolled over) earns one more
  // scroll to the new "next".
  useEffect(() => {
    hasScrolled.current = false;
  }, [times, nextDeparture]);

  const onNextLayout = useCallback((e: LayoutChangeEvent) => {
    if (hasScrolled.current) return;
    hasScrolled.current = true;
    const y = e.nativeEvent.layout.y;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 40), animated: false });
  }, []);

  // "Now" is the same for all 150 cells — it used to be a `new Date()` per cell
  // inside the map. Recomputed only when the timetable itself changes; a cell
  // slipping into the past a minute early is not worth a per-second re-render.
  const cells = useMemo(() => {
    const nowMin = athensNowMin();
    return times.map((t) => ({
      time: t,
      isPast: (hhmmToMin(t) ?? 0) < nowMin,
      isNext: t === nextDeparture,
    }));
  }, [times, nextDeparture]);

  return (
    <ScrollView
      ref={scrollRef}
      style={[s.scroll, { maxHeight }]}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      accessibilityLabel={`Timetable, ${times.length} departures`}
    >
      <View style={s.grid}>
        {cells.map((c, i) => (
          <TimeCell
            key={`${c.time}-${i}`}
            time={c.time}
            isPast={c.isPast}
            isNext={c.isNext}
            accentColor={accentColor}
            onLayout={c.isNext ? onNextLayout : undefined}
          />
        ))}
      </View>
    </ScrollView>
  );
}

export default React.memo(ScheduleGrid);

const s = StyleSheet.create({
  scroll: { maxHeight: 160 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  time: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  timeText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  timePast: { color: colors.textMuted, opacity: 0.5 },
  /** Color comes from `onAccent(accentColor)` inline. */
  timeNext: { fontWeight: '700' },
});
