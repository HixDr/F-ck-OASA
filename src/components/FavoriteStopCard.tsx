/**
 * FavoriteStopCard — live arrival dashboard for a saved stop.
 *
 * Arrivals come from `useArrivals` (the one sanctioned polling path: deduped
 * across cards, paused when Home is unfocused or the app is backgrounded).
 * Everything cosmetic — "to <destination>" labels, timetables — is filled in
 * afterwards and must never gate the numbers.
 *
 * Losing signal does not blank the numbers: `useArrivals` falls back to the
 * last response it saved to disk, and the decay below keeps counting it down
 * from when it was *observed*. That is only honest as long as the card never
 * dresses it up as live — hence `isStale` and the footer.
 *
 * ## Tiers
 *
 * The card no longer decides how big it is. Home's canvas measures it, turns
 * that width into a `tier` and hands it back with the exact `boxHeight` it must
 * fill; this file's job is to decide what fits. `detailed` is this card
 * unchanged and is the default, so a caller that passes neither prop — and a
 * stop the user has never arranged — gets what it always got.
 *
 * Content is dropped around the arrival figure rather than the figure being
 * shrunk, in this order: the destination and the timetable go at `standard`,
 * then everything but the badge and one number at `compact`. Which content goes
 * at which width is not a taste question and the comments below say what each
 * omission buys in dp; the one place the figure itself is shrunk is called out
 * where it happens.
 *
 * Nothing above this line varies by tier. The polling, the decay, the alert
 * switching and the visibility filter are the card's contract with the rest of
 * the app, not its appearance, and a tier that quietly skipped one of them
 * would be a second, subtly different stop card.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
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
import { useArrivals, useRoutesForStop, arrivalsOrigin, ARRIVALS_POLL_MS } from '../hooks';
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
/* Type-only, so this does not tie a presentational component to the canvas's
   geometry at runtime — the tier is a number of dp turned into a word, and the
   one place that translation is allowed to live is `tierFor`. */
import type { CardTier } from '../features/home/layout';
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
  /**
   * How much content this card can afford, decided by the canvas from the
   * card's measured width.
   *
   * Defaults to `detailed`, which is this card exactly as it was before the
   * canvas existed — so every caller that knows nothing about tiers, and every
   * card the user has never resized, renders unchanged.
   */
  tier?: CardTier;
  /**
   * The exact height in px the canvas has given this card, or null/undefined
   * while the card is still allowed to size itself to its content.
   *
   * The second case is not a fallback, it is the migration: an install with no
   * saved arrangement has no heights, so every card flows and the screen is
   * byte-for-byte the single column it was.
   */
  boxHeight?: number | null;
  onRemove: (stop: FavoriteStop) => void;
  onMoveUp?: (stop: FavoriteStop) => void;
  onMoveDown?: (stop: FavoriteStop) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

/**
 * Spoken form of the app's core datum, built rather than read off the glyphs:
 * "4 min" is announced as "4 feet", and an em dash as nothing at all.
 *
 * Shared by the arrival row and by the compact tier's single arrival, because
 * the two are the same bus and a screen reader that heard them described
 * differently would have no way to know that.
 */
function spokenArrival(
  minutes: number | null,
  nextDeparture: string | null,
  nextIsTomorrow: boolean,
): string {
  if (minutes == null) {
    return nextDeparture
      ? `next scheduled departure ${nextDeparture}${nextIsTomorrow ? ' tomorrow' : ''}`
      : 'no arrival information';
  }
  return minutes <= 0 ? 'arriving now' : `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** One visible line and its arrival, after the age of the data has been taken
 *  off it. Computed once per render so that no two tiers can decide which bus
 *  is next by different rules. */
interface DecayedLine {
  line: LineGroup;
  minutes: number | null;
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
const LoadingRows = React.memo(function LoadingRows({
  stopName,
  tier,
}: {
  stopName: string;
  tier: CardTier;
}) {
  /* The placeholder follows the tier for the reason it exists at all. A grey
     description bar at `standard`, or three grey rows in a compact card that
     will resolve to one stacked figure, is the jump this component was written
     to remove, reintroduced one tier down. */
  if (tier === 'compact') {
    return (
      <View style={s.compactBody} accessible accessibilityLabel={`Loading arrivals for ${stopName}`}>
        {/* The badge's own stacked-layout margin, so the grey pair sits at the
            spacing the real pair will. */}
        <SkeletonBox width={46} height={22} radius={radius.sm} style={s.compactBadge} />
        <SkeletonBox width={44} height={26} radius={radius.sm} />
      </View>
    );
  }
  const dense = tier === 'standard';
  return (
    <View accessible accessibilityLabel={`Loading arrivals for ${stopName}`}>
      {SKELETON_WIDTHS.map((w, i) => (
        <View key={i} style={dense ? s.skeletonRowStandard : s.skeletonRow}>
          <SkeletonBox width={46} height={22} radius={radius.sm} />
          {dense ? (
            <View style={s.skeletonFill}>
              <SkeletonBox width={40} height={26} radius={radius.sm} />
            </View>
          ) : (
            <>
              {/* Percentage of the flexible middle, not of the row: measured
                  against the row it would overflow once the badge, the number
                  block and three gaps are subtracted from a 360dp screen. */}
              <View style={s.skeletonGrow}>
                <SkeletonBox width={w} height={12} />
              </View>
              <SkeletonBox width={40} height={26} radius={radius.sm} />
            </>
          )}
        </View>
      ))}
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
  /** `standard` keeps the badge and the figure and drops everything between and
   *  after them. `compact` does not use this row at all — it stacks, which is a
   *  different shape rather than a subset of this one. */
  tier: CardTier;
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
  tier,
  onPress,
  onToggleSchedule,
  onToggleAlert,
}: RowProps) {
  const arrivalText =
    minutes == null ? null : minutes <= 0 ? 'now' : String(minutes);

  const spoken = spokenArrival(minutes, nextDeparture, nextIsTomorrow);
  const dense = tier === 'standard';

  return (
    <View>
      {/* The label is the full one at every tier, destination included. What
          `standard` drops is 146dp of width it does not have, not a fact about
          the bus — and a screen reader is not reading the width. */}
      <Pressable
        style={dense ? s.lineRowStandard : s.lineRow}
        onPress={() => onPress(lineCode)}
        accessibilityRole="button"
        accessibilityLabel={`Line ${lineId}, ${label}, ${spoken}${stale ? ', data may be out of date' : ''}`}
        accessibilityHint="Opens the live map for this line"
      >
        <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
          <Text style={[s.lineBadgeText, { color: onAccent(primaryColor) }]} maxFontSizeMultiplier={fontScaleCap.badge}>{lineId}</Text>
        </View>

        {!dense && (
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
        )}

        {/* Everything in this block carries the figure's cap, including the two
            that are not the figure. Uncapped, at accessibility text sizes the
            `min` caption and the em dash outgrow the digits they annotate and
            become the widest thing in the block — which lifts it off the floor
            in `arrivalBlock` that keeps the row from reflowing on every poll,
            and makes a row with no arrival taller than the rows above it. */}
        <View style={[s.arrivalBlock, dense && s.arrivalBlockFill, stale && s.stale]}>
          {arrivalText == null ? (
            <Text style={s.noArrival} maxFontSizeMultiplier={fontScaleCap.figure}>—</Text>
          ) : arrivalText === 'now' ? (
            <Text style={[s.arrivalNow, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>now</Text>
          ) : (
            <>
              <Text style={[s.arrivalMin, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>{arrivalText}</Text>
              <Text style={s.arrivalUnit} maxFontSizeMultiplier={fontScaleCap.figure}>min</Text>
            </>
          )}
        </View>

        {/* No bell below `detailed`. It is a 44dp target, and `standard` has
            ~146dp of content of which the badge and the number block already
            take 102 — there is no arrangement of the remainder in which a
            fourth control is reachable rather than merely present.

            This never strands an armed alert, and the next reader should not
            "fix" it by putting the button back. `app/_layout.tsx` renders an
            app-wide alert pill with a "Stop alert" button on every screen for
            as long as `subscribeAlertConfig` reports a watch, because only one
            watch exists app-wide. What a narrow card loses is *arming* a new
            alert, which the user does from a card wide enough to offer it. */}
        {!dense && (
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
        )}
      </Pressable>
    </View>
  );
});

/* ── The compact tier's one arrival ──────────────────────────── */

/**
 * A stacked badge and figure — everything a ~88dp card has room to say.
 *
 * Its own component rather than a branch inside `LineRow`, because it is not a
 * narrower row: the badge moves from beside the number to above it, the
 * `arrivalBlock` width reservation that keeps a row from reflowing has nothing
 * to reserve against, and there is no description, pill or bell to hide. A
 * shared component would have been two layouts sharing a name.
 *
 * It is a button for the same reason a row is: tapping the stop's next bus
 * opens that line's map, and losing that at the smallest size would make the
 * compact card the only place in the app where the arrival is not a way in.
 */
interface CompactProps {
  lineId: string;
  lineCode: string;
  /** Not rendered — there is no room. Spoken, because a screen reader has all
   *  the room in the world and the destination is how the user tells two
   *  directions of the same line apart. */
  label: string;
  minutes: number | null;
  color: string;
  stale: boolean;
  nextDeparture: string | null;
  nextIsTomorrow: boolean;
  primaryColor: string;
  onPress: (lineCode: string) => void;
}

const CompactArrival = React.memo(function CompactArrival({
  lineId,
  lineCode,
  label,
  minutes,
  color,
  stale,
  nextDeparture,
  nextIsTomorrow,
  primaryColor,
  onPress,
}: CompactProps) {
  const spoken = spokenArrival(minutes, nextDeparture, nextIsTomorrow);

  return (
    <Pressable
      style={s.compactBody}
      onPress={() => onPress(lineCode)}
      accessibilityRole="button"
      accessibilityLabel={`Line ${lineId}, ${label}, ${spoken}${stale ? ', data may be out of date' : ''}`}
      accessibilityHint="Opens the live map for this line"
    >
      <View style={[s.lineBadge, s.compactBadge, { backgroundColor: primaryColor }]}>
        <Text style={[s.lineBadgeText, { color: onAccent(primaryColor) }]} maxFontSizeMultiplier={fontScaleCap.badge}>{lineId}</Text>
      </View>

      {/* The caps are the row's, for the row's reasons: the figure sits in a
          box the canvas fixed, and the caption and the em dash are capped with
          it so they cannot outgrow the digits they annotate. */}
      <View style={[s.compactFigureBlock, stale && s.stale]}>
        {minutes == null ? (
          <Text style={s.noArrival} maxFontSizeMultiplier={fontScaleCap.figure}>—</Text>
        ) : minutes <= 0 ? (
          <Text style={[s.arrivalNow, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>now</Text>
        ) : (
          <>
            <Text style={[s.compactFigure, { color }]} maxFontSizeMultiplier={fontScaleCap.figure}>{minutes}</Text>
            <Text style={s.arrivalUnit} maxFontSizeMultiplier={fontScaleCap.figure}>min</Text>
          </>
        )}
      </View>
    </Pressable>
  );
});

/* ── Card ────────────────────────────────────────────────────── */

function FavoriteStopCard({
  stop,
  primaryColor,
  active = true,
  editing = false,
  tier = 'detailed',
  boxHeight = null,
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

  /* Freshness: how much of the last known estimate has already elapsed.
     `observedAt`, not `dataUpdatedAt` — the latter is when the *query* resolved,
     and a request that failed into the disk cache resolves now. Decaying from
     that would redraw a twenty-minute-old "5 min" as a fresh one, which is the
     one thing this cache must never be allowed to do. On the network path the
     two are the same number, so nothing about live behaviour moves. */
  const { observedAt: updatedAt, fromCache } = arrivalsOrigin(
    stop.stopCode,
    arrivalsQuery.dataUpdatedAt,
  );
  const ageMs = updatedAt ? Math.max(0, nowMs - updatedAt) : 0;
  const decayMin = updatedAt ? Math.floor(ageMs / 60_000) : 0;
  const isStale = !!updatedAt && ageMs > STALE_AFTER_MS;
  /* Minute resolution, matching the numbers it is explaining: a seconds counter
     next to a decayed "4 min" invites arithmetic that the data cannot support. */
  const savedAgo = decayMin < 1 ? 'moments ago' : `${decayMin} min ago`;

  /**
   * Every visible line with the age of the data already taken off its estimate.
   *
   * This used to be two lines inside the row loop. It is hoisted because the
   * compact tier has to choose the soonest of these, and a card that decided
   * which bus was next by a second, hand-copied version of the rule below would
   * eventually disagree with the rows it replaces — the same stop showing a
   * different bus at two widths, with nothing in the UI to explain it.
   */
  const decayed = useMemo<DecayedLine[] | null>(() => {
    if (!displayLines) return null;
    return displayLines.map((line) => {
      /* A vehicle whose estimate has run out entirely is gone, not "arriving
         now". Clamping at zero — which is what this did — pins every expired row
         on the loudest word the card owns, and offline that is the whole card
         within half an hour. Dropping to "—" hands the row back to the
         timetable, which is the only thing that still knows anything. Mirrors
         the rule `useArrivals` applies when it serves a stop from disk, so the
         two never disagree. */
      const remaining = line.nextMin == null ? null : line.nextMin - decayMin;
      return { line, minutes: remaining != null && remaining >= 0 ? remaining : null };
    });
  }, [displayLines, decayMin]);

  /**
   * The one arrival a compact card has room for.
   *
   * Falls back to the first visible line when nothing has a live estimate, so
   * the card still says *which* bus it is talking about and shows an em dash
   * for it — a compact card that blanked itself the moment its estimates
   * expired would be indistinguishable from one that had failed to load.
   */
  const soonest = useMemo<DecayedLine | null>(() => {
    if (!decayed || decayed.length === 0) return null;
    let best: DecayedLine | null = null;
    let bestMin = Number.POSITIVE_INFINITY;
    for (const d of decayed) {
      if (d.minutes != null && d.minutes < bestMin) {
        bestMin = d.minutes;
        best = d;
      }
    }
    return best ?? decayed[0];
  }, [decayed]);

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

  const compact = tier === 'compact';
  const hasLines = !!allLineGroups && allLineGroups.length > 0;
  const failed = (linesError || routesQuery.isError) && !hasLines;
  const loading = !failed && !allLineGroups && (linesLoading || routesQuery.isLoading);
  /* "Is the line filter on screen", which is not the same as `filtering`: the
     only control that closes the list is a header button, and `compact` has no
     room for it. A card resized while the list was open would otherwise strand
     the user in a list they cannot dismiss with the arrivals hidden behind it.
     Deriving it also means the body no longer disappears in the one state where
     `filtering` was true and the lines had gone — the list needs `hasLines` and
     the body did not, so that combination used to render an empty card. */
  const filterOpen = filtering && hasLines && !compact;
  /* An armed alert whose line the filter hides would otherwise be unreachable —
     at `detailed`. Below it this banner goes the way of the bell it belongs to,
     and for the same reason: it is a row of chrome competing with the number
     the card exists to show. Nothing is stranded, because only one alert watch
     exists app-wide and `app/_layout.tsx` renders a pill with a "Stop alert"
     button on every screen for as long as `subscribeAlertConfig` reports one. */
  const orphanAlert =
    tier === 'detailed'
    && alertHere
    && !(displayLines ?? []).some((l) => l.lineId === alertHere.lineId)
      ? alertHere
      : null;

  /**
   * A card that has been arranged is a fixed box, and `overflow` is what makes
   * that claim true: content that outgrew the box would paint over the card
   * below it, and the design rules overlap out entirely — one stop covering
   * another stop's minutes is worse than any arrangement it could enable.
   *
   * No height at all is the other half of the migration. A stop the user has
   * never arranged still measures itself, so an install with no saved layout
   * renders the column it always did.
   */
  const cardStyle = useMemo(
    () => (boxHeight == null
      ? s.card
      : [s.card, { height: boxHeight, overflow: 'hidden' as const }]),
    [boxHeight],
  );

  /* The arrival region, built as a value because the two placements it can have
     are structural: inside a scroll view when the card owns a fixed box, and
     directly in the card's column when it is still measuring itself. Wrapping
     the flowing case in a ScrollView would hand the canvas a card with no
     intrinsic height to measure. */
  const rows = failed ? (
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
    <LoadingRows stopName={stop.stopName} tier={tier} />
  ) : decayed && decayed.length > 0 ? (
    decayed.map(({ line, minutes }) => {
      const sched = schedules.get(line.lineCode);
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
            tier={tier}
            onPress={handleLinePress}
            onToggleSchedule={toggleSchedule}
            onToggleAlert={handleAlertToggle}
          />
          {/* Gated on the tier and not only on the state: the pill that opens
              this grid exists at `detailed` alone, so a card narrowed while a
              timetable was open would otherwise carry a panel with nothing left
              on screen to close it. Resizing back reopens it, which is the
              behaviour the state was already describing. */}
          {tier === 'detailed' && expandedScheduleLine === line.lineCode && sched && (
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
  );

  /* The same four states at `compact`, where a sentence has nowhere to go and
     the retry pill does not fit. The wording shrinks to a phrase and the
     sentence moves into the accessibility label, which costs no width. */
  const compactBody = failed ? (
    /* The whole body is the retry target rather than a button inside it: a
       width at which a failed card could only be recovered by first resizing it
       would make the tier a trap instead of a size. */
    <Pressable
      style={s.compactBody}
      onPress={handleRetry}
      accessibilityRole="button"
      accessibilityLabel={`Retry loading ${stop.stopName}`}
      accessibilityHint={isOnline ? undefined : 'No connection — arrivals unavailable'}
    >
      <Text style={s.compactNote}>{isOnline ? 'Tap to retry' : 'Offline'}</Text>
    </Pressable>
  ) : loading ? (
    <LoadingRows stopName={stop.stopName} tier={tier} />
  ) : soonest ? (
    <CompactArrival
      lineId={soonest.line.lineId}
      lineCode={soonest.line.lineCode}
      label={labels.get(soonest.line.lineCode) ?? soonest.line.lineDescrEng}
      minutes={soonest.minutes}
      color={soonest.minutes != null ? getArrivalColor(soonest.minutes) : soonest.line.color}
      stale={isStale && soonest.minutes != null}
      nextDeparture={schedules.get(soonest.line.lineCode)?.nextDeparture ?? null}
      nextIsTomorrow={!!schedules.get(soonest.line.lineCode)?.nextIsTomorrow}
      primaryColor={primaryColor}
      onPress={handleLinePress}
    />
  ) : (
    <View style={s.compactBody}>
      {/* "Tap the filter to choose lines" is the wider card's wording and would
          be a lie here, where that button does not exist. */}
      <Text
        style={s.compactNote}
        numberOfLines={2}
        accessibilityLabel={
          hasLines
            ? 'No lines are shown. Make this card wider to choose which lines to show.'
            : 'No lines serve this stop.'
        }
      >
        {hasLines ? 'No lines shown' : 'No lines'}
      </Text>
    </View>
  );

  return (
    <View style={cardStyle}>
      <View style={[s.header, compact && s.headerCompact]}>
        {/* The pin is 20dp of a 146dp row at `standard` — a decoration charging
            the stop's own name for the space it takes. */}
        {tier === 'detailed' && <Ionicons name="location" size={16} color={primaryColor} />}
        <Text
          style={[s.stopName, compact && s.stopNameCompact]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {stop.stopName}
        </Text>

        {editing ? (
          /* The chevrons move a stop in the saved *order*, which is what
             positions a card that has never been arranged — so they still
             matter, and they are the only way to do it that a screen reader can
             drive, a lift-and-move having nothing to announce or activate. They
             are not the accessible path for the canvas itself: once a card has
             a placement, "up" and "down" are two of six directions and they
             live on Home's card wrapper as `accessibilityActions`, which is
             also why this whole subtree is hidden from the screen reader while
             arrange mode is on.

             `detailed` only: two 40dp buttons beside the 40dp remove button are
             120 of a 146dp row, which leaves the stop's name 26dp and offers to
             reorder a stop the user can no longer identify. */
          <>
            {tier === 'detailed' && (
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
              </>
            )}
            <Pressable
              style={s.headerBtn}
              onPress={() => onRemove(stop)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${stop.stopName} from saved stops`}
            >
              <Ionicons name="remove-circle" size={22} color={colors.danger} />
            </Pressable>
          </>
        ) : hasLines && !compact ? (
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
      {filterOpen && (
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

      {/* The compact tier is never wrapped: it holds one arrival, so there is
          nothing to scroll, and a scroll view would take the centring below it
          out of the box the card was given and into a content container that
          knows nothing about that box. */}
      {!filterOpen && (
        compact ? compactBody
        : boxHeight != null ? (
          <ScrollView style={s.bodyScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {rows}
          </ScrollView>
        ) : rows
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

      {/* Only what is specific to *this* stop. "Live / updated 40s ago" moved to
          the one indicator in Home's header — six cards each running their own
          seconds counter were six claims about a single shared clock. A stop
          whose own request is failing, or whose numbers came off disk, still
          says so here: which stop's numbers are guesses is not something a
          screen-level readout can say.

          The three cases are genuinely different and the wording must not blur
          them. Saved *arrivals* are real minutes still ticking down; the
          timetable fallback is a scheduled departure that knows nothing about
          where the bus is. Saying "showing the saved timetable" over live
          numbers held from ten minutes ago would undersell them, and saying
          "arrivals" over a timetable would oversell it.

          `fromCache` is qualified by `isStale` — the same threshold that dims
          the numbers — so one dropped poll on a flaky connection does not
          raise a warning about data that is fifteen seconds old and identical
          to what was already on screen. Past that the two appear together,
          which is the point: dimmed numbers, and a line saying why.

          `compact` is the one tier without it, and only because the notice
          needs a sentence: the shortest honest wording here is wider than the
          whole card. The dimming survives, so a compact card still shows that
          its number is not to be trusted even where it cannot say why. */}
      {!filterOpen && !compact && !failed && hasLines
        && ((fromCache && isStale) || arrivalsQuery.isError || (!isOnline && !updatedAt)) && (
        <View style={s.footer}>
          <View style={[s.dot, { backgroundColor: colors.warning }]} />
          {/* `flex: 1` so the longer saved-arrivals wording wraps inside the
              card instead of running off it at a large font scale. */}
          <Text style={[s.footerText, { flex: 1, color: colors.warning }]}>
            {fromCache && isStale
              ? `Not live — arrivals from ${savedAgo}, counting down`
              : isOnline
                ? 'Live arrivals unavailable — showing the timetable'
                : 'Offline — showing the saved timetable'}
          </Text>
        </View>
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
