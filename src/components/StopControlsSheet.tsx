/**
 * StopControlsSheet — the timetable, the line filter and the alarm picker,
 * lifted out of the card and into a sheet.
 *
 * All three used to be inline panels inside `FavoriteStopCard`: the timetable
 * expanded the row it belonged to, and the line filter expanded the header.
 * Both worked as long as the card was free to grow, which it no longer is —
 * Home's canvas now hands every card a fixed box (`overflow: 'hidden'`) inside
 * a scrolling grid, and an inline panel in a fixed box is either clipped or,
 * worse, still renders below the fold: the reported bug was exactly this,
 * opening the timetable on the bottom-most row and having it draw off the
 * bottom of the screen with no way to see it without first scrolling down to
 * where it was drawn.
 *
 * A `Modal` is what escapes both containers at once. It is not decoration on
 * top of `BottomSheet` — `BottomSheet` alone still lays out as a normal child
 * of whatever renders it, which is the card, which is still clipped and still
 * scrolled. The `Modal` is a separate native window above all of that, the
 * same way `SettingsModal` uses one to get its sheet above the map. Because
 * nothing here grows the card, the bottom-row bug cannot recur at any tier or
 * any scroll position — the sheet's own height is independent of where the
 * card that opened it sits.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  Pressable as RNPressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, fontScaleCap, onAccent, HIT_SIZE } from '../theme';
import BottomSheet from '../ui/BottomSheet';
import Pressable from '../ui/Pressable';
import ScheduleGrid from './ScheduleGrid';
import type { LineSchedule } from '../utils/scheduleUtils';

/** Resting and expanded heights. The taller one exists for the timetable: a
 *  busy line is 100-150 cells, and the resting snap alone would leave most of
 *  them a scroll away on every open. */
const SNAP_POINTS = [0.5, 0.9];

export type StopSheetMode = 'schedule' | 'alarm' | 'lines';

export interface SheetLine {
  lineCode: string;
  lineId: string;
  /** Destination label, already resolved by the card. */
  label: string;
}

interface Props {
  /** null closes it: the component renders nothing at all. */
  mode: StopSheetMode | null;
  stopName: string;
  accentColor: string;
  /** Every line the stop serves, in the card's own order. */
  lines: SheetLine[];
  /** Parsed timetables by lineCode. A line absent from this map has none. */
  schedules: ReadonlyMap<string, LineSchedule>;
  /** Which line the schedule opens on. Falls back to the first line with a timetable. */
  initialLine?: string | null;
  /** Visible line codes, or null meaning "all". */
  visibleLines: ReadonlySet<string> | null;
  /** lineId of the alert armed at this stop, or null. */
  alertLineId?: string | null;
  onToggleLine: (lineCode: string) => void;
  /** The user picked a line to alert on. The caller opens its own picker modal
   *  and closes this sheet; do not assume either happens here. */
  onPickAlarm: (lineCode: string) => void;
  onClose: () => void;
}

function hasTimetable(schedules: ReadonlyMap<string, LineSchedule>, lineCode: string): boolean {
  const sched = schedules.get(lineCode);
  return !!sched && sched.times.length > 0;
}

export default function StopControlsSheet({
  mode,
  stopName,
  accentColor,
  lines,
  schedules,
  initialLine = null,
  visibleLines,
  alertLineId = null,
  onToggleLine,
  onPickAlarm,
  onClose,
}: Props): React.ReactElement | null {
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();

  const linesWithTimetable = useMemo(
    () => lines.filter((l) => hasTimetable(schedules, l.lineCode)),
    [lines, schedules],
  );

  /* Local, and seeded rather than derived, because a derived value would be
     recomputed — and would overwrite a tap on a badge — every time `lines` or
     `schedules` get a new identity, which for a card polling arrivals every
     15s is constantly. Re-seeding is keyed on `initialLine` alone for the same
     reason: it is the one prop that actually means "open on a different line
     now", not "the same lines, refreshed". */
  const [selectedLine, setSelectedLine] = useState<string | null>(
    () => initialLine ?? linesWithTimetable[0]?.lineCode ?? null,
  );
  useEffect(() => {
    setSelectedLine(initialLine ?? linesWithTimetable[0]?.lineCode ?? null);
    // See the comment above: only `initialLine` should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLine]);

  /* What is actually drawn, as distinct from what was chosen. `selectedLine`
     can legitimately point at a line with nothing to show yet — schedules
     arrive asynchronously after the sheet can already be open — and falling
     back only here, rather than in the state above, means that race corrects
     itself on the next render instead of needing a second effect that would
     also have to be kept from fighting the same taps. */
  const effectiveLine = selectedLine && hasTimetable(schedules, selectedLine)
    ? selectedLine
    : linesWithTimetable[0]?.lineCode ?? null;
  const effectiveSchedule = effectiveLine ? schedules.get(effectiveLine) ?? null : null;

  if (!mode) return null;

  const closeLabel = mode === 'schedule'
    ? 'Close timetable'
    : mode === 'lines'
      ? 'Close line list'
      : 'Close arrival alert';

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Android runs a Modal as a separate native view hierarchy, outside the
          app-root GestureHandlerRootView — without one here the sheet's drag
          handle would receive no gestures at all. */}
      <GestureHandlerRootView style={s.root}>
        <View style={s.overlay}>
          {/* Bare RN Pressable: the shared one adds a press-scale and a
              haptic, neither of which belongs on a full-screen dismiss target. */}
          <RNPressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          />
          <BottomSheet
            snapPoints={SNAP_POINTS}
            initialSnap={0}
            onDismiss={onClose}
            backdrop
          >
            {/* No accessibilityViewIsModal here. The RN Modal above is a real
                modal window, so VoiceOver/TalkBack are already scoped to it;
                repeating the flag on this subtree would only hide its own
                siblings — the resize handle and the backdrop's close target. */}
            <View style={[s.sheetBody, { paddingBottom: insets.bottom + spacing.md }]}>
              {mode === 'schedule' && (
                <>
                  <Text style={s.title} accessibilityRole="header">Timetable</Text>
                  <Text style={s.subtitle} numberOfLines={1}>{stopName}</Text>

                  {linesWithTimetable.length > 1 && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={s.chipRow}
                    >
                      {linesWithTimetable.map((l) => {
                        const selected = l.lineCode === effectiveLine;
                        return (
                          <Pressable
                            key={l.lineCode}
                            style={[s.chip, selected
                              ? { backgroundColor: accentColor, borderColor: accentColor }
                              : s.chipNeutral]}
                            onPress={() => setSelectedLine(l.lineCode)}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`Line ${l.lineId}, ${l.label}`}
                          >
                            <Text
                              style={[s.chipText, { color: selected ? onAccent(accentColor) : colors.text }]}
                              /* The cap the app's line badges use, because that is
                                 what this is: a fixed-padding box sized to 2-4
                                 glyphs. A different cap here would let the same
                                 line's number be a different size in the sheet
                                 than on the card that opened it. */
                              maxFontSizeMultiplier={fontScaleCap.badge}
                            >
                              {l.lineId}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  )}

                  {effectiveSchedule ? (
                    <>
                      {/* "06:10 tomorrow", the same wording the card's pill uses
                          — the two are describing the same departure and must not
                          be two phrasings of it. Never null here: a schedule only
                          reaches this branch through `hasTimetable`, and
                          `parseSchedule` returns null only for an empty day. */}
                      <Text style={s.nextDeparture}>
                        {`Next departure ${effectiveSchedule.nextDeparture}${effectiveSchedule.nextIsTomorrow ? ' tomorrow' : ''}`}
                      </Text>
                      {/* `maxHeight` set to the window height rather than to a
                          fitted number: `ScheduleGrid`'s own ScrollView already
                          defaults to flexGrow/flexShrink 1 (RN's base vertical
                          scroll style), so wrapping it in a flex:1 View and
                          giving it a cap it can never actually reach lets the
                          surrounding flex layout decide the real height — which
                          tracks whatever the sheet is dragged to, at both
                          snaps, without this component measuring anything. */}
                      <View style={s.gridFill}>
                        <ScheduleGrid
                          times={effectiveSchedule.times}
                          nextDeparture={effectiveSchedule.nextDeparture}
                          accentColor={accentColor}
                          maxHeight={winH}
                        />
                      </View>
                    </>
                  ) : (
                    <Text style={s.emptyNote}>No line at this stop has a timetable right now.</Text>
                  )}
                </>
              )}

              {mode === 'lines' && (
                <>
                  <Text style={s.title} accessibilityRole="header">Lines shown</Text>
                  <ScrollView style={s.listFill} showsVerticalScrollIndicator={false}>
                    {lines.map((l) => {
                      const visible = !visibleLines || visibleLines.has(l.lineCode);
                      return (
                        <Pressable
                          key={l.lineCode}
                          style={s.row}
                          onPress={() => onToggleLine(l.lineCode)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: visible }}
                          accessibilityLabel={`Show line ${l.lineId}, ${l.label}`}
                        >
                          <Ionicons
                            name={visible ? 'checkbox' : 'square-outline'}
                            size={22}
                            color={visible ? accentColor : colors.textMuted}
                          />
                          <View style={[s.lineBadge, { backgroundColor: visible ? accentColor : colors.border }]}>
                            <Text style={[s.lineBadgeText, { color: visible ? onAccent(accentColor) : colors.text }]}>
                              {l.lineId}
                            </Text>
                          </View>
                          <Text
                            style={[s.rowLabel, !visible && s.rowLabelDim]}
                            numberOfLines={1}
                          >
                            {l.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </>
              )}

              {mode === 'alarm' && (
                <>
                  <Text style={s.title} accessibilityRole="header">Arrival alert</Text>
                  <Text style={s.subtitle}>
                    Only one arrival alert can run at a time, app-wide.
                  </Text>
                  <ScrollView style={s.listFill} showsVerticalScrollIndicator={false}>
                    {lines.map((l) => {
                      const armed = alertLineId != null && l.lineId === alertLineId;
                      return (
                        <Pressable
                          key={l.lineCode}
                          style={s.row}
                          onPress={() => onPickAlarm(l.lineCode)}
                          accessibilityRole="button"
                          accessibilityLabel={armed
                            ? `Stop the arrival alert for line ${l.lineId}`
                            : `Set an arrival alert for line ${l.lineId}`}
                        >
                          <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
                            <Text style={[s.lineBadgeText, { color: onAccent(accentColor) }]}>
                              {l.lineId}
                            </Text>
                          </View>
                          <Text
                            style={[s.rowLabel, armed && { color: colors.warning }]}
                            numberOfLines={1}
                          >
                            {l.label}
                          </Text>
                          <Ionicons
                            name={armed ? 'notifications' : 'notifications-outline'}
                            size={22}
                            color={armed ? colors.warning : colors.textMuted}
                          />
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </>
              )}
            </View>
          </BottomSheet>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  /* No dim of its own — `BottomSheet`'s own backdrop fades in step with its
     height, so a dismissing drag darkens and lightens with the finger. */
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBody: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: font.size.title,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: font.size.label,
    marginBottom: spacing.md,
  },
  chipRow: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  /* `minWidth`/`minHeight` rather than fixed padding: a sheet has no width
     pressure the way a three-column card does, so every radio here can clear
     the same 44pt floor as the rest of the app instead of the ~38dp the tile's
     own footer controls are stuck with. */
  chip: {
    minWidth: HIT_SIZE,
    minHeight: HIT_SIZE,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipNeutral: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  chipText: {
    ...font.num,
    fontSize: font.size.body,
    fontWeight: '800',
  },
  nextDeparture: {
    ...font.num,
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  gridFill: {
    flex: 1,
  },
  emptyNote: {
    color: colors.textMuted,
    fontSize: font.size.label,
    opacity: 0.8,
  },
  listFill: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: HIT_SIZE,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    minWidth: 46,
    alignItems: 'center',
  },
  lineBadgeText: {
    ...font.num,
    fontSize: font.size.label,
    fontWeight: '800',
  },
  rowLabel: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.body,
  },
  rowLabelDim: {
    opacity: 0.4,
  },
});
