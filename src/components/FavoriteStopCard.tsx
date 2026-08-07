/**
 * FavoriteStopCard — live arrival dashboard for a saved stop.
 *
 * Arrivals come from `useArrivals` (the one sanctioned polling path: deduped
 * across cards, paused when Home is unfocused or the app is backgrounded).
 * Everything cosmetic — "to <destination>" labels, timetables — is filled in
 * afterwards and must never gate the numbers.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  Alert as RNAlert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontScaleCap, onAccent, radius } from '../theme';
import Pressable from '../ui/Pressable';
import { SkeletonBox } from '../ui/Skeleton';
import { getRoutes, getDailySchedule, isUsableSchedule } from '../services/api';
import {
  updateFavoriteStop,
  getCachedSchedule,
  setCachedSchedule,
  getCachedRoutes,
  setCachedRoutes,
} from '../services/storage';
import { useArrivals, useRoutesForStop, ARRIVALS_POLL_MS } from '../hooks';
import { useLinesMap } from '../hooks/useLinesMap';
import { useNetworkStatus } from '../services/network';
import {
  buildLineGroups,
  enrichWithDirectionHints,
  getArrivalColor,
  type LineGroup,
} from '../features/map/mapUtils';
import {
  startAlertWatch,
  stopAlertWatch,
  subscribeAlertConfig,
  type AlertConfig,
} from '../services/notifications';
import { hapticSuccess, hapticError } from '../services/haptics';
import { parseSchedule, athensNowMin, type LineSchedule } from '../utils/scheduleUtils';
import ScheduleGrid from './ScheduleGrid';
import AlertPickerModal from './AlertPickerModal';
import { s } from './FavoriteStopCard.styles';
import type { FavoriteStop, OasaDailySchedule } from '../types';

/** How often derived-from-clock values (next departure, arrival decay) are
 *  recomputed. Minute-resolution data does not need a per-second tick. */
const CLOCK_TICK_MS = 30_000;
/** Past this age the live numbers stop being trustworthy and are dimmed. */
const STALE_AFTER_MS = ARRIVALS_POLL_MS * 3;

/** Descending label widths, so the placeholder rows do not read as a bar chart. */
const SKELETON_WIDTHS = ['62%', '48%', '55%'] as const;

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();
const EMPTY_SCHEDULES: ReadonlyMap<string, LineSchedule> = new Map();
const EMPTY_RAW_SCHEDULES: ReadonlyMap<string, RawSchedule> = new Map();

interface RawSchedule {
  data: OasaDailySchedule;
  direction: 'go' | 'come';
}

interface Props {
  stop: FavoriteStop;
  primaryColor: string;
  /** False while Home is not the focused screen: pauses polling and clocks. */
  active?: boolean;
  /** Home is in edit mode — show the destructive / reordering affordances. */
  editing?: boolean;
  onRemove: (stop: FavoriteStop) => void;
  onMoveUp?: (stop: FavoriteStop) => void;
  onMoveDown?: (stop: FavoriteStop) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

/* ── Cold start ──────────────────────────────────────────────── */

/**
 * Placeholder arrival rows.
 *
 * The stop's name and the card around it are already known on the first frame
 * — only the arrivals are not. A spinner said "wait" and then let the card jump
 * to whatever height the answer turned out to be; these say what is coming and
 * are replaced in place.
 *
 * Rows rather than a whole-card placeholder: a placeholder standing in for the
 * title and chrome would hide a stop name that is already known.
 */
const LoadingRows = React.memo(function LoadingRows({ stopName }: { stopName: string }) {
  return (
    <View accessible accessibilityLabel={`Loading arrivals for ${stopName}`}>
      {SKELETON_WIDTHS.map((w, i) => (
        <View key={i} style={s.skeletonRow}>
          <SkeletonBox width={46} height={22} radius={radius.sm} />
          {/* Percentage of the flexible middle, not of the row: measured
              against the row it would overflow once the badge, the number
              block and three gaps are subtracted from a 360dp screen. */}
          <View style={s.skeletonGrow}>
            <SkeletonBox width={w} height={12} />
          </View>
          <SkeletonBox width={40} height={26} radius={radius.sm} />
        </View>
      ))}
    </View>
  );
});

/* ── Freshness indicator ─────────────────────────────────────── */

/**
 * "Live" / "updated 40s ago". Owns its own one-second interval so the seconds
 * counter does not re-render the arrival rows around it.
 */
const Freshness = React.memo(function Freshness({
  updatedAt,
  failed,
  offline,
  active,
}: {
  updatedAt: number;
  failed: boolean;
  offline: boolean;
  active: boolean;
}) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active || !updatedAt) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, updatedAt]);

  if (!updatedAt) return null;
  const age = Math.max(0, Date.now() - updatedAt);
  const fresh = !failed && age < ARRIVALS_POLL_MS + 5_000;
  const label = age < 10_000 ? 'just now' : age < 60_000 ? `${Math.floor(age / 1000)}s ago` : `${Math.floor(age / 60_000)}m ago`;

  return (
    <View style={s.footer} accessibilityLabel={fresh ? 'Arrivals are live' : `Arrivals last updated ${label}`}>
      <View style={[s.dot, { backgroundColor: fresh ? colors.success : colors.warning }]} />
      <Text style={[s.footerText, !fresh && { color: colors.warning }]}>
        {fresh
          ? 'Live'
          : offline
            ? `Offline · last updated ${label}`
            : `Not updating · last updated ${label}`}
      </Text>
    </View>
  );
});

/* ── One arrival row ─────────────────────────────────────────── */

interface RowProps {
  lineId: string;
  lineCode: string;
  label: string;
  /** Minutes to arrival, already decayed by the age of the data. */
  minutes: number | null;
  color: string;
  stale: boolean;
  nextDeparture: string | null;
  nextIsTomorrow: boolean;
  hasTimetable: boolean;
  scheduleOpen: boolean;
  alertActive: boolean;
  primaryColor: string;
  onPress: (lineCode: string) => void;
  onToggleSchedule: (lineCode: string) => void;
  onToggleAlert: (lineCode: string) => void;
}

const LineRow = React.memo(function LineRow({
  lineId,
  lineCode,
  label,
  minutes,
  color,
  stale,
  nextDeparture,
  nextIsTomorrow,
  hasTimetable,
  scheduleOpen,
  alertActive,
  primaryColor,
  onPress,
  onToggleSchedule,
  onToggleAlert,
}: RowProps) {
  const arrivalText =
    minutes == null ? null : minutes <= 0 ? 'now' : String(minutes);

  // Spoken form of the app's core datum. "4′" is announced as "4 feet".
  const spoken =
    minutes == null
      ? nextDeparture
        ? `next scheduled departure ${nextDeparture}${nextIsTomorrow ? ' tomorrow' : ''}`
        : 'no arrival information'
      : minutes <= 0
        ? 'arriving now'
        : `${minutes} minute${minutes === 1 ? '' : 's'}`;

  return (
    <View>
      <Pressable
        style={s.lineRow}
        onPress={() => onPress(lineCode)}
        accessibilityRole="button"
        accessibilityLabel={`Line ${lineId}, ${label}, ${spoken}${stale ? ', data may be out of date' : ''}`}
        accessibilityHint="Opens the live map for this line"
      >
        <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
          <Text style={[s.lineBadgeText, { color: onAccent(primaryColor) }]} maxFontSizeMultiplier={fontScaleCap.badge}>{lineId}</Text>
        </View>

        <View style={s.lineMain}>
          <Text style={s.lineDescr} numberOfLines={1}>{label}</Text>
          {hasTimetable && (
            <Pressable
              style={s.schedPill}
              onPress={() => onToggleSchedule(lineCode)}
              accessibilityRole="button"
              accessibilityState={{ expanded: scheduleOpen }}
              accessibilityLabel={
                nextDeparture
                  ? `Timetable, next departure ${nextDeparture}${nextIsTomorrow ? ' tomorrow' : ''}`
                  : 'Timetable'
              }
            >
              <Ionicons
                name={scheduleOpen ? 'time' : 'time-outline'}
                size={12}
                color={scheduleOpen ? primaryColor : colors.textMuted}
              />
              <Text style={[s.schedPillText, scheduleOpen && { color: primaryColor }]}>
                {nextDeparture
                  ? nextIsTomorrow ? `${nextDeparture} tomorrow` : nextDeparture
                  : 'Timetable'}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={[s.arrivalBlock, stale && s.stale]}>
          {arrivalText == null ? (
            <Text style={s.noArrival}>—</Text>
          ) : arrivalText === 'now' ? (
            <Text style={[s.arrivalNow, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>now</Text>
          ) : (
            <>
              <Text style={[s.arrivalMin, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>{arrivalText}</Text>
              <Text style={s.arrivalUnit}>min</Text>
            </>
          )}
        </View>

        <Pressable
          style={s.bellBtn}
          onPress={() => onToggleAlert(lineCode)}
          accessibilityRole="switch"
          accessibilityState={{ checked: alertActive }}
          accessibilityLabel={`Arrival alert for line ${lineId}`}
          accessibilityHint={alertActive ? 'Turns the alert off' : 'Choose how early to be warned'}
        >
          <Ionicons
            name={alertActive ? 'notifications' : 'notifications-outline'}
            size={22}
            color={alertActive ? colors.warning : colors.textMuted}
          />
        </Pressable>
      </Pressable>
    </View>
  );
});

/* ── Card ────────────────────────────────────────────────────── */

function FavoriteStopCard({
  stop,
  primaryColor,
  active = true,
  editing = false,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: Props) {
  const router = useRouter();
  const { linesMap, linesLoading, linesError, refetchLines } = useLinesMap();
  const isOnline = useNetworkStatus();

  const routesQuery = useRoutesForStop(stop.stopCode);
  const arrivalsQuery = useArrivals(stop.stopCode, active);

  /* Line groups are derived, not fetched: `buildLineGroups` already has every
     arrival minute the moment both queries resolve. Nothing else may delay it. */
  const built = useMemo(() => {
    if (!routesQuery.data) return null;
    return buildLineGroups(routesQuery.data, arrivalsQuery.data ?? [], linesMap);
  }, [routesQuery.data, arrivalsQuery.data, linesMap]);
  const allLineGroups = built?.lines ?? null;

  /* A *stable* identity for "which lines this stop serves". The arrival poll
     rebuilds `allLineGroups` every 15s with fresh object identities; effects
     keyed on that array re-ran a network call per line, forever. */
  const linesKey = useMemo(
    () => (allLineGroups ?? []).map((l) => `${l.lineCode}:${l.routeCode}`).sort().join('|'),
    [allLineGroups],
  );

  // Latest groups for effects that must not depend on their identity.
  const groupsRef = useRef<LineGroup[]>([]);
  useEffect(() => {
    groupsRef.current = allLineGroups ?? [];
  });

  /* Clock tick. Everything derived from "now" (next departure, decay of an
     arrival estimate) refreshes from here instead of from the poll. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Catch up after time spent unfocused, without a redundant render on mount.
    setNowMs((prev) => (Date.now() - prev > 1_000 ? Date.now() : prev));
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(EMPTY_LABELS);
  const [rawSchedules, setRawSchedules] = useState<ReadonlyMap<string, RawSchedule>>(EMPTY_RAW_SCHEDULES);
  const [filtering, setFiltering] = useState(false);
  const [visibleSet, setVisibleSet] = useState<Set<string> | null>(() =>
    stop.visibleLines ? new Set(stop.visibleLines) : null,
  );
  const [expandedScheduleLine, setExpandedScheduleLine] = useState<string | null>(null);

  // Home's edit mode owns the header while it is on, so the per-card line
  // filter cannot stay open underneath it.
  useEffect(() => {
    if (editing) setFiltering(false);
  }, [editing]);

  const [arrivalAlert, setArrivalAlert] = useState<AlertConfig | null>(null);
  useEffect(() => subscribeAlertConfig(setArrivalAlert), []);
  const [pickerLine, setPickerLine] = useState<string | null>(null);
  const [alertThreshold, setAlertThreshold] = useState('5');
  const [arming, setArming] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  /* "to <destination>" labels — one `getStops` per line, purely cosmetic.
     These used to be awaited before any arrival was rendered: ~10 requests
     before the user saw a single number at an 8-line stop. */
  useEffect(() => {
    if (!linesKey) return;
    let cancelled = false;
    (async () => {
      try {
        const enriched = await enrichWithDirectionHints(groupsRef.current, stop.stopCode);
        if (cancelled) return;
        setLabels(new Map(enriched.map((l) => [l.lineCode, l.lineDescrEng])));
      } catch {
        // Labels are decoration; the raw route description stays.
      }
    })();
    return () => { cancelled = true; };
  }, [linesKey, stop.stopCode]);

  /* Timetables — fetched once per set of lines, cache first. */
  useEffect(() => {
    if (!linesKey) return;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      const next = new Map<string, RawSchedule>();
      await Promise.allSettled(
        groupsRef.current.map(async (line) => {
          // Direction: our route's position in the line's route list decides
          // whether the "go" or "come" column of the timetable applies.
          let direction: 'go' | 'come' = 'go';
          let lineRoutes = await getCachedRoutes(line.lineCode).catch(() => null);
          if (!lineRoutes?.length) {
            try {
              lineRoutes = await getRoutes(line.lineCode, { signal: ctrl.signal });
              if (lineRoutes?.length) setCachedRoutes(line.lineCode, lineRoutes);
            } catch {
              lineRoutes = null;
            }
          }
          if (lineRoutes?.length) {
            const idx = lineRoutes.findIndex((r) => r.RouteCode === line.routeCode);
            direction = idx <= 0 ? 'come' : 'go';
          }

          let data = await getCachedSchedule(line.lineCode).catch(() => null);
          if (!isUsableSchedule(data)) {
            try {
              const fresh = await getDailySchedule(line.lineCode, { signal: ctrl.signal });
              if (isUsableSchedule(fresh)) {
                data = fresh;
                setCachedSchedule(line.lineCode, fresh);
              }
            } catch {
              // No timetable for this line right now — the row just omits it.
            }
          }
          if (isUsableSchedule(data)) next.set(line.lineCode, { data: data!, direction });
        }),
      );
      if (!cancelled) setRawSchedules(next);
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [linesKey]);

  /* Next departure is a function of the clock, so it is derived here rather
     than frozen into state when the timetable was fetched. */
  const schedules = useMemo(() => {
    if (rawSchedules.size === 0) return EMPTY_SCHEDULES;
    const nowMin = athensNowMin(new Date(nowMs));
    const m = new Map<string, LineSchedule>();
    rawSchedules.forEach((raw, lineCode) => {
      m.set(lineCode, parseSchedule(raw.data, raw.direction, nowMin));
    });
    return m;
  }, [rawSchedules, nowMs]);

  const displayLines = useMemo(() => {
    if (!allLineGroups) return null;
    if (!visibleSet) return allLineGroups;
    return allLineGroups.filter((l) => visibleSet.has(l.lineCode));
  }, [allLineGroups, visibleSet]);

  /* Freshness: how much of the last known estimate has already elapsed. */
  const updatedAt = arrivalsQuery.dataUpdatedAt;
  const ageMs = updatedAt ? Math.max(0, nowMs - updatedAt) : 0;
  const decayMin = updatedAt ? Math.floor(ageMs / 60_000) : 0;
  const isStale = !!updatedAt && ageMs > STALE_AFTER_MS;

  /* ── Handlers ──────────────────────────────────────────────── */

  const handleLinePress = useCallback((lineCode: string) => {
    const line = groupsRef.current.find((l) => l.lineCode === lineCode);
    if (!line) return;
    const info = linesMap.get(lineCode);
    router.push({
      pathname: '/map/[lineCode]',
      params: {
        lineCode,
        lineId: line.lineId,
        lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
      },
    });
  }, [linesMap, router]);

  const toggleSchedule = useCallback((lineCode: string) => {
    setExpandedScheduleLine((prev) => (prev === lineCode ? null : lineCode));
  }, []);

  const alertHere = arrivalAlert?.stopCode === stop.stopCode ? arrivalAlert : null;

  /**
   * One alert watch exists app-wide. Tapping a bell therefore means:
   * this line's alert is on → turn it off; anything else → open the picker and
   * *switch* to this line. It used to silently stop whatever was armed.
   */
  const handleAlertToggle = useCallback((lineCode: string) => {
    const line = groupsRef.current.find((l) => l.lineCode === lineCode);
    if (!line) return;
    if (alertHere && alertHere.lineId === line.lineId) {
      stopAlertWatch();
      return;
    }
    setAlertThreshold(String(alertHere?.thresholdMin ?? 5));
    setPickerError(null);
    setPickerLine(lineCode);
  }, [alertHere]);

  const handleAlertConfirm = useCallback(async () => {
    const line = groupsRef.current.find((l) => l.lineCode === pickerLine);
    const min = Number.parseInt(alertThreshold, 10);
    if (!line || !Number.isFinite(min) || min <= 0) return;
    const routeCodes: string[] = [];
    built?.routeToLine.forEach((lc, rc) => {
      if (lc === line.lineCode) routeCodes.push(rc);
    });

    setArming(true);
    setPickerError(null);
    // Arming can fail for reasons the user can act on (notifications denied,
    // Android refusing the foreground service). Closing the dialog regardless
    // would leave a bell that looks armed and an alert that can never fire.
    const result = await startAlertWatch({
      stopCode: stop.stopCode,
      stopName: stop.stopName,
      thresholdMin: min,
      lineId: line.lineId,
      routeCodes,
      color: primaryColor,
    });
    setArming(false);

    if (!result.ok) {
      hapticError();
      setPickerError(result.message);
      return;
    }
    hapticSuccess();
    setPickerLine(null);
    if (result.replaced) {
      // Only one watch exists app-wide, so this just cancelled someone else's.
      RNAlert.alert(
        'Alert switched',
        `The alert for line ${result.replaced.lineId} at ${result.replaced.stopName} was cancelled — only one alert can run at a time.`,
      );
    }
  }, [alertThreshold, pickerLine, built, stop.stopCode, stop.stopName, primaryColor]);

  /**
   * Visibility filter. The storage write used to live *inside* the state
   * updater, which React may replay during a concurrent render.
   */
  const toggleLineVisibility = useCallback((lineCode: string) => {
    const allCodes = groupsRef.current.map((l) => l.lineCode);
    // With no lines loaded, `next.size === allCodes.length` is 0 === 0 and we
    // would persist "show all" over the user's actual selection.
    if (allCodes.length === 0) return;
    const current = visibleSet ?? new Set(allCodes);
    const next = new Set(current);
    if (next.has(lineCode)) next.delete(lineCode);
    else next.add(lineCode);
    const result = next.size === allCodes.length ? null : next;
    setVisibleSet(result);
    updateFavoriteStop(stop.stopCode, { visibleLines: result ? [...result] : null });
  }, [visibleSet, stop.stopCode]);

  const handleRetry = useCallback(() => {
    refetchLines();
    routesQuery.refetch();
    arrivalsQuery.refetch();
  }, [refetchLines, routesQuery, arrivalsQuery]);

  /* ── Render ────────────────────────────────────────────────── */

  const hasLines = !!allLineGroups && allLineGroups.length > 0;
  const failed = (linesError || routesQuery.isError) && !hasLines;
  const loading = !failed && !allLineGroups && (linesLoading || routesQuery.isLoading);
  // An armed alert whose line the filter hides would otherwise be unreachable.
  const orphanAlert =
    alertHere && !(displayLines ?? []).some((l) => l.lineId === alertHere.lineId) ? alertHere : null;

  return (
    <View style={s.card}>
      <View style={s.header}>
        <Ionicons name="location" size={16} color={primaryColor} />
        <Text style={s.stopName} numberOfLines={1} accessibilityRole="header">{stop.stopName}</Text>

        {editing ? (
          /* The chevrons are not a leftover beside the drag gesture Home now
             offers — they are the only way to reorder that a screen reader can
             drive, since a lift-and-move has nothing to announce or activate. */
          <>
            <Pressable
              style={s.headerBtn}
              disabled={!canMoveUp}
              onPress={() => onMoveUp?.(stop)}
              accessibilityRole="button"
              accessibilityLabel={`Move ${stop.stopName} up`}
              accessibilityState={{ disabled: !canMoveUp }}
            >
              <Ionicons name="chevron-up" size={20} color={canMoveUp ? colors.text : colors.border} />
            </Pressable>
            <Pressable
              style={s.headerBtn}
              disabled={!canMoveDown}
              onPress={() => onMoveDown?.(stop)}
              accessibilityRole="button"
              accessibilityLabel={`Move ${stop.stopName} down`}
              accessibilityState={{ disabled: !canMoveDown }}
            >
              <Ionicons name="chevron-down" size={20} color={canMoveDown ? colors.text : colors.border} />
            </Pressable>
            <Pressable
              style={s.headerBtn}
              onPress={() => onRemove(stop)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${stop.stopName} from saved stops`}
            >
              <Ionicons name="remove-circle" size={22} color={colors.danger} />
            </Pressable>
          </>
        ) : hasLines ? (
          <Pressable
            style={s.headerBtn}
            onPress={() => setFiltering((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: filtering }}
            accessibilityLabel={filtering ? 'Done choosing lines' : 'Choose which lines to show'}
          >
            <Ionicons
              name={filtering ? 'checkmark-circle' : 'options-outline'}
              size={20}
              color={filtering ? primaryColor : colors.textMuted}
            />
          </Pressable>
        ) : null}
      </View>

      {/* Line visibility */}
      {filtering && hasLines && (
        <ScrollView style={s.editScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {allLineGroups!.map((line) => {
            const isVisible = !visibleSet || visibleSet.has(line.lineCode);
            return (
              <Pressable
                key={line.lineCode}
                style={s.editRow}
                onPress={() => toggleLineVisibility(line.lineCode)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isVisible }}
                accessibilityLabel={`Show line ${line.lineId}, ${line.lineDescrEng}`}
              >
                <Ionicons
                  name={isVisible ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={isVisible ? primaryColor : colors.textMuted}
                />
                <View style={[s.lineBadge, { backgroundColor: isVisible ? primaryColor : colors.border }]}>
                  {/* A hidden line's badge is neutral grey, where the accent's
                      own legible-text choice does not apply. */}
                  <Text style={[s.lineBadgeText, { color: isVisible ? onAccent(primaryColor) : colors.text }]}>
                    {line.lineId}
                  </Text>
                </View>
                <Text style={[s.lineDescrMuted, { flex: 1 }, !isVisible && { opacity: 0.4 }]} numberOfLines={1}>
                  {line.lineDescrEng}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {!filtering && (
        failed ? (
          <View style={s.errorBox}>
            <Text style={s.errorText}>
              {isOnline ? "Couldn't load this stop." : 'No connection — arrivals unavailable.'}
            </Text>
            <Pressable
              style={[s.retryBtn, { borderColor: primaryColor }]}
              onPress={handleRetry}
              accessibilityRole="button"
              accessibilityLabel="Retry loading this stop"
            >
              <Ionicons name="refresh" size={16} color={primaryColor} />
              <Text style={[s.retryText, { color: primaryColor }]}>Retry</Text>
            </Pressable>
          </View>
        ) : loading ? (
          <LoadingRows stopName={stop.stopName} />
        ) : displayLines && displayLines.length > 0 ? (
          displayLines.map((line) => {
            const sched = schedules.get(line.lineCode);
            const minutes = line.nextMin == null ? null : Math.max(0, line.nextMin - decayMin);
            return (
              <React.Fragment key={line.lineCode}>
                <LineRow
                  lineId={line.lineId}
                  lineCode={line.lineCode}
                  label={labels.get(line.lineCode) ?? line.lineDescrEng}
                  minutes={minutes}
                  // Recomputed from the decayed value: a 4-minute amber that
                  // has since aged into "1 minute" must read as urgent.
                  color={minutes != null ? getArrivalColor(minutes) : line.color}
                  stale={isStale && minutes != null}
                  nextDeparture={sched?.nextDeparture ?? null}
                  nextIsTomorrow={!!sched?.nextIsTomorrow}
                  hasTimetable={!!sched && sched.times.length > 0}
                  scheduleOpen={expandedScheduleLine === line.lineCode}
                  alertActive={!!alertHere && alertHere.lineId === line.lineId}
                  primaryColor={primaryColor}
                  onPress={handleLinePress}
                  onToggleSchedule={toggleSchedule}
                  onToggleAlert={handleAlertToggle}
                />
                {expandedScheduleLine === line.lineCode && sched && (
                  <View style={s.schedExpandContainer}>
                    <ScheduleGrid
                      times={sched.times}
                      nextDeparture={sched.nextDeparture}
                      accentColor={primaryColor}
                      maxHeight={120}
                    />
                  </View>
                )}
              </React.Fragment>
            );
          })
        ) : hasLines ? (
          <Text style={s.emptyText}>
            Tap <Ionicons name="options-outline" size={12} color={colors.textMuted} /> to choose lines
          </Text>
        ) : (
          // Only reachable once the request actually succeeded — a failure is
          // the `failed` branch above, not a claim about the stop.
          <Text style={s.emptyText}>No lines serve this stop.</Text>
        )
      )}

      {orphanAlert && (
        <View style={s.alertBanner}>
          <Ionicons name="notifications" size={14} color={colors.warning} />
          {/* Spelled out rather than "≤5′": the prime is announced as "feet",
              and the app has never agreed with itself on which glyph to use. */}
          <Text style={s.alertBannerText} numberOfLines={1}>
            Alerting {orphanAlert.lineId} at {orphanAlert.thresholdMin} min
          </Text>
          <Pressable
            style={s.alertBannerBtn}
            onPress={() => stopAlertWatch()}
            accessibilityRole="button"
            accessibilityLabel={`Stop the arrival alert for line ${orphanAlert.lineId}`}
          >
            <Text style={s.alertBannerBtnText}>Stop</Text>
          </Pressable>
        </View>
      )}

      {!filtering && !failed && hasLines && (
        arrivalsQuery.isError || (!isOnline && !updatedAt) ? (
          <View style={s.footer}>
            <View style={[s.dot, { backgroundColor: colors.warning }]} />
            <Text style={[s.footerText, { color: colors.warning }]}>
              {isOnline
                ? 'Live arrivals unavailable — showing the timetable'
                : 'Offline — showing the saved timetable'}
            </Text>
          </View>
        ) : (
          <Freshness
            updatedAt={updatedAt}
            failed={arrivalsQuery.isError}
            offline={!isOnline}
            active={active}
          />
        )
      )}

      <AlertPickerModal
        visible={!!pickerLine}
        subtitle={`${groupsRef.current.find((l) => l.lineCode === pickerLine)?.lineId ?? ''} at ${stop.stopName}`}
        threshold={alertThreshold}
        onChangeThreshold={setAlertThreshold}
        accentColor={primaryColor}
        confirmLabel={arrivalAlert ? 'Switch' : 'Start'}
        errorMessage={pickerError}
        busy={arming}
        onCancel={() => { setPickerLine(null); setPickerError(null); }}
        onConfirm={handleAlertConfirm}
      />
    </View>
  );
}

/** Memoized: Home re-renders on focus, refresh and accent changes, and each
 *  card owns live queries that must not be torn through for nothing. */
export default React.memo(FavoriteStopCard);
