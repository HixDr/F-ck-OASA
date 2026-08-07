/**
 * StopSheet — the one stop card.
 *
 * Live Map and Nearby Map each grew their own copy of "tap a stop, see what is
 * coming". They drifted: Live gained arrival alerts, an all-lines expander and
 * a next-departure row; Nearby never did, purely because it was written second.
 * This is the union of the two, so a capability added here shows up on both.
 *
 * The alert lifecycle lives here rather than in either screen. It is the same
 * three pieces of state (threshold, in-flight, failure reason) plus the same
 * "one alert at a time" replacement notice on both screens, and duplicating it
 * is exactly how the two cards diverged in the first place.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, fontScaleCap, onAccent, radius, spacing } from '../theme';
import {
  startAlertWatch,
  stopAlertWatch,
  subscribeAlertConfig,
  type AlertConfig,
} from '../services/notifications';
import AlertPickerModal from '../components/AlertPickerModal';
import BottomSheet from './BottomSheet';
import Pressable from './Pressable';

/**
 * Fractions of the available height the sheet settles on.
 *
 * Exported because the map's own controls have to know how much of the bottom
 * of the screen the sheet claims — see `useStopSheetInset`.
 */
export const STOP_SHEET_SNAPS = [0.3, 0.7];

/**
 * Height the collapsed sheet occupies, or 0 when closed.
 *
 * Mirrors `BottomSheet`'s own `winH - insets.top` so the two agree on what
 * "30%" means; a control lifted by a slightly wrong number still ends up
 * underneath the sheet, which is the bug this exists to avoid.
 */
export function useStopSheetInset(open: boolean): number {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  if (!open) return 0;
  return Math.round(STOP_SHEET_SNAPS[0] * Math.max(1, height - insets.top));
}

/**
 * A line calling at the stop.
 *
 * Structurally `mapUtils.LineGroup`, restated rather than imported: `src/ui`
 * is shared chrome and should not depend on a feature module.
 */
export interface StopSheetLine {
  lineCode: string;
  lineId: string;
  lineDescrEng: string;
  /** Minutes to the next bus on this line, null when nothing is reported. */
  nextMin: number | null;
  /** Urgency color for `nextMin`. */
  color: string;
}

export interface StopSheetStop {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

interface Props {
  stop: StopSheetStop;
  /** The user's accent color. */
  accentColor: string;
  onClose: () => void;

  /** Walking minutes from the user, null while unknown or unavailable. */
  walkMin: number | null;

  saved: boolean;
  onToggleSaved: () => void;

  /**
   * Arrivals for the single line the screen is tracking, already sorted and
   * colored. Omit on screens that are not scoped to one line.
   */
  arrivals?: Array<{ min: number; color: string }> | null;
  arrivalsLoading?: boolean;

  /** Next scheduled departure, "HH:MM". Needs a timetable for one known line. */
  nextDeparture?: string | null;

  lines: StopSheetLine[] | null;
  linesLoading?: boolean;
  onPressLine: (line: StopSheetLine) => void;
  /**
   * Present ⇒ the line list hides behind an "All lines" toggle and the caller
   * owns the open/closed state (Live defers fetching the routes until then).
   * Absent ⇒ the list is always shown.
   */
  linesExpanded?: boolean;
  onToggleLines?: () => void;

  /**
   * What an arrival alert at this stop would watch. `lineId` is spoken in the
   * notification ("🚌 550 arriving!"). Omit to hide the bell.
   */
  alert?: { lineId: string; routeCodes: string[] } | null;
}

export default function StopSheet({
  stop,
  accentColor,
  onClose,
  walkMin,
  saved,
  onToggleSaved,
  arrivals,
  arrivalsLoading = false,
  nextDeparture,
  lines,
  linesLoading = false,
  onPressLine,
  linesExpanded,
  onToggleLines,
  alert,
}: Props) {
  const onAccentColor = onAccent(accentColor);

  /* ── Arrival alert ─────────────────────────────────────────── */

  const [armed, setArmed] = useState<AlertConfig | null>(null);
  useEffect(() => subscribeAlertConfig(setArmed), []);

  const [showPicker, setShowPicker] = useState(false);
  const [threshold, setThreshold] = useState('5');
  const [alertError, setAlertError] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);

  // Selecting another stop reuses this component rather than remounting it, so
  // a half-finished dialog would otherwise carry over onto the new stop.
  useEffect(() => {
    setShowPicker(false);
    setAlertError(null);
  }, [stop.code]);

  const armedHere = armed?.stopCode === stop.code;
  // An alert scoped to no routes can never match anything, and the routes for
  // this stop may still be in flight.
  const canArm = !!alert && alert.routeCodes.length > 0;

  const toggleAlert = useCallback(() => {
    if (armedHere) {
      stopAlertWatch();
      setShowPicker(false);
      return;
    }
    setShowPicker((v) => !v);
  }, [armedHere]);

  const confirmAlert = useCallback(async () => {
    if (!alert) return;
    const min = Number.parseInt(threshold, 10);
    if (!Number.isFinite(min) || min <= 0) return;
    setAlertBusy(true);
    setAlertError(null);
    const res = await startAlertWatch({
      stopCode: stop.code,
      stopName: stop.name,
      thresholdMin: min,
      lineId: alert.lineId,
      routeCodes: alert.routeCodes,
      color: accentColor,
    });
    setAlertBusy(false);
    if (!res.ok) {
      // Keep the dialog open with the reason. Firing and forgetting made a
      // notifications denial look exactly like success.
      setAlertError(res.message);
      return;
    }
    setShowPicker(false);
    // Only one alert can be armed at a time; arming this one cancelled the
    // other, and saying nothing about it is silent data loss.
    if (res.replaced) {
      Alert.alert(
        'Alert moved',
        `Your alert for ${res.replaced.lineId} at ${res.replaced.stopName} was cancelled.`,
      );
    }
  }, [alert, threshold, stop.code, stop.name, accentColor]);

  /* ── Lines ─────────────────────────────────────────────────── */

  const collapsible = typeof onToggleLines === 'function';
  const showLines = !collapsible || linesExpanded === true;

  const linesBody = useMemo(() => {
    if (!showLines) return null;
    if (linesLoading) {
      return <ActivityIndicator size="small" color={colors.primaryLight} style={s.spinner} />;
    }
    if (!lines || lines.length === 0) {
      return <Text style={s.empty}>No lines found</Text>;
    }
    return lines.map((line) => (
      <Pressable
        key={line.lineCode}
        style={s.lineRow}
        onPress={() => onPressLine(line)}
        accessibilityRole="button"
        accessibilityLabel={
          `Line ${line.lineId}, ${line.lineDescrEng}, `
          + (line.nextMin == null
            ? 'no arrival information'
            : line.nextMin <= 0
              ? 'arriving now'
              : `${line.nextMin} minute${line.nextMin === 1 ? '' : 's'}`)
        }
        accessibilityHint="Opens the live map for this line"
      >
        <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
          <Text style={[s.lineBadgeText, { color: onAccentColor }]} maxFontSizeMultiplier={fontScaleCap.badge}>{line.lineId}</Text>
        </View>
        <Text style={s.lineDescr} numberOfLines={1}>{line.lineDescrEng}</Text>
        {line.nextMin != null ? (
          <View style={[s.lineEta, { backgroundColor: line.color }]}>
            {/* "5′" is announced as "5 feet"; the prime was already removed
                from the favourites card for the same reason. */}
            <Text style={[s.lineEtaText, { color: onAccent(line.color) }]}>
              {line.nextMin} min
            </Text>
          </View>
        ) : (
          <Text style={s.lineNone}>—</Text>
        )}
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} style={s.chevron} />
      </Pressable>
    ));
  }, [showLines, linesLoading, lines, onPressLine, accentColor, onAccentColor]);

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <BottomSheet
      snapPoints={STOP_SHEET_SNAPS}
      initialSnap={0}
      onDismiss={onClose}
      style={s.sheet}
    >
      <View style={s.header}>
        <Text style={s.name} numberOfLines={2} accessibilityRole="header">{stop.name}</Text>
        <View style={s.headerBtns}>
          <Pressable
            onPress={onToggleSaved}
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Remove this stop from saved stops' : 'Save this stop'}
            accessibilityState={{ selected: saved }}
          >
            <Ionicons
              name={saved ? 'bookmark' : 'bookmark-outline'}
              size={18}
              color={saved ? accentColor : colors.textMuted}
            />
          </Pressable>
          {alert && (
            <Pressable
              onPress={toggleAlert}
              disabled={!canArm && !armedHere}
              accessibilityRole="button"
              accessibilityLabel={armedHere ? 'Cancel the arrival alert for this stop' : 'Set an arrival alert for this stop'}
              accessibilityState={{ selected: armedHere, disabled: !canArm && !armedHere }}
            >
              <Ionicons
                name={armedHere ? 'notifications' : 'notifications-outline'}
                size={18}
                color={armedHere ? colors.warning : colors.textMuted}
              />
            </Pressable>
          )}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close stop details"
          >
            <Ionicons name="close" size={20} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>

      {walkMin !== null && (
        <View style={s.walkRow}>
          <Ionicons name="walk" size={14} color={WALK_BLUE} />
          <Text style={s.walkText}>{walkMin} min walk</Text>
        </View>
      )}

      {alert && (
        <AlertPickerModal
          visible={showPicker}
          subtitle={`${alert.lineId} at ${stop.name}`}
          threshold={threshold}
          onChangeThreshold={setThreshold}
          accentColor={accentColor}
          errorMessage={alertError}
          busy={alertBusy}
          onCancel={() => { setShowPicker(false); setAlertError(null); }}
          onConfirm={confirmAlert}
        />
      )}

      {/* One scroller for the whole body: the sheet's own height is the thing
          the user resizes, so nested independently-scrolling regions inside it
          just create two ways to be lost. */}
      <ScrollView
        style={s.body}
        contentContainerStyle={s.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {arrivals !== undefined && (
          arrivalsLoading ? (
            <ActivityIndicator size="small" color={colors.primaryLight} style={s.spinner} />
          ) : arrivals && arrivals.length > 0 ? (
            <View style={s.arrivalRow}>
              {arrivals.map((a, i) => (
                <View key={i} style={[s.arrivalBadge, { backgroundColor: a.color }]}>
                  <Text style={[s.arrivalMin, { color: onAccent(a.color) }]} maxFontSizeMultiplier={fontScaleCap.figure}>{a.min} min</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={s.empty}>No arrivals right now</Text>
          )
        )}

        {nextDeparture ? (
          <View style={s.nextDepRow}>
            <Ionicons name="time-outline" size={12} color={colors.textMuted} />
            <Text style={s.nextDepLabel}>Next: {nextDeparture}</Text>
          </View>
        ) : null}

        {collapsible && (
          <Pressable
            style={s.allLinesBtn}
            onPress={onToggleLines}
            accessibilityRole="button"
            accessibilityLabel={showLines ? 'Hide the other lines at this stop' : 'Show all lines at this stop'}
            accessibilityState={{ expanded: showLines }}
          >
            <Ionicons name={showLines ? 'chevron-up' : 'bus-outline'} size={14} color={accentColor} />
            <Text style={[s.allLinesText, { color: accentColor }]}>
              {showLines ? 'Hide lines' : 'All lines'}
            </Text>
          </Pressable>
        )}

        {linesBody}
      </ScrollView>
    </BottomSheet>
  );
}

/** Google's walking-directions blue — matches the dashed route drawn on the map. */
const WALK_BLUE = '#4285F4';

const NUM = font.num;

const s = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  name: { flex: 1, color: colors.text, fontSize: font.size.title, fontWeight: '700' },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  walkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  walkText: { color: WALK_BLUE, fontSize: font.size.label, fontWeight: '600', ...NUM },
  body: { flex: 1, marginTop: spacing.sm },
  bodyContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  spinner: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  empty: { color: colors.textMuted, fontSize: font.size.label, marginTop: spacing.xs },
  arrivalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  arrivalBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radius.sm,
  },
  arrivalMin: { fontSize: font.size.label, fontWeight: '700', ...NUM },
  nextDepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  nextDepLabel: { color: colors.textMuted, fontSize: font.size.micro, fontWeight: '600', ...NUM },
  allLinesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.edge,
  },
  allLinesText: { fontSize: font.size.label, fontWeight: '600' },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    marginRight: spacing.sm,
    minWidth: 44,
    alignItems: 'center',
  },
  lineBadgeText: { fontSize: font.size.label, fontWeight: '700' },
  lineDescr: { flex: 1, color: colors.textMuted, fontSize: font.size.label, marginRight: spacing.sm },
  lineEta: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radius.sm,
  },
  lineEtaText: { fontSize: font.size.micro, fontWeight: '700', ...NUM },
  lineNone: { color: colors.textMuted, fontSize: font.size.label, fontWeight: '600' },
  chevron: { marginLeft: spacing.xs },
});
