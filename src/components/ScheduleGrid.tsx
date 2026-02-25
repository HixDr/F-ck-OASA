/**
 * ScheduleGrid — displays a time grid with auto-scroll to the next departure.
 * Shared by LiveMapScreen and FavoriteStopCard.
 */

import React, { useRef } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, font } from '../theme';

interface Props {
  times: string[];
  nextDeparture: string | null;
  accentColor: string;
  maxHeight?: number;
}

export default function ScheduleGrid({ times, nextDeparture, accentColor, maxHeight = 160 }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const nextY = useRef(0);

  return (
    <ScrollView
      ref={scrollRef}
      style={[s.scroll, { maxHeight }]}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
    >
      <View style={s.grid}>
        {times.map((t, i) => {
          const now = new Date();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const [h, m] = t.split(':').map(Number);
          const isPast = h * 60 + m < nowMin;
          const isNext = t === nextDeparture;
          return (
            <View
              key={i}
              style={[s.time, isNext && { backgroundColor: accentColor }]}
              onLayout={isNext ? (e) => {
                nextY.current = e.nativeEvent.layout.y;
                scrollRef.current?.scrollTo({ y: Math.max(0, nextY.current - 40), animated: false });
              } : undefined}
            >
              <Text style={[s.timeText, isPast && s.timePast, isNext && s.timeNext]}>{t}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { maxHeight: 160 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  time: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  timeText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  timePast: { color: colors.textMuted, opacity: 0.5 },
  timeNext: { color: '#FFF', fontWeight: '700' },
});
