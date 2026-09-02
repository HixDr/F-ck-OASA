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
 * ## One rule, not three sizes
 *
 * The card no longer decides how big it is, or how much it holds. Home's canvas
 * hands it four numbers and this file only renders them: `span` picks the bus
 * layout, `maxBuses` says how many buses fit, `tier` is `span` said as a word,
 * and `boxHeight` is the exact box to fill. Every one of them defaults to what
 * this card was before the canvas existed — three columns, uncapped, detailed,
 * self-measured — so a caller that passes none of them renders unchanged.
 *
 * One number goes the other way, and it is the one the box is built from:
 * `onCountChange` reports how many buses this card is showing, and the canvas
 * makes the card exactly that tall. Height is not something the user can drag any
 * more — it is what the line filter below decides — so the two ends of that loop
 * are the same fact, and the cap above can only ever be the count that produced
 * the box.
 *
 * There are two bus layouts, which is why there are two tiers. Three columns is
 * the detailed row from 1.2.4, badge and destination and figure and bell across
 * 364dp. One and two columns are the *same* compact bus, badge stacked over
 * figure; the only difference between them is that two columns fits two of it
 * across. A width between two columns is not something a three-column grid can
 * hand out, so the middle tier of the free-width design went with the fractions
 * that produced it.
 *
 * Content is dropped around the arrival figure rather than the figure being
 * shrunk: the compact bus keeps the badge and the number and drops the
 * destination, the timetable pill and the per-line bell. The one place the figure
 * itself is shrunk is called out where it happens.
 *
 * ## The controls are not part of that
 *
 * Schedule, alarm and filter sit in a footer row at **every** span. They used to
 * be scattered — the schedule inside a row that only existed at three columns,
 * the filter in the header, both of them opening panels *inside* the card. So a
 * card the user had made small had no schedule at all, and a card that had one
 * grew when it was opened, which a fixed-width tile cannot absorb and which is
 * why the bottom-most row's timetable used to render off-screen.
 *
 * The footer is a fixed place, and both panels are now sheets
 * (`StopControlsSheet`), which are size-independent. A control that is
 * unavailable is dimmed and stays where it is, because a footer whose buttons
 * move is a footer the user has to re-read.
 *
 * Nothing above the layout varies by tier. The polling, the decay, the alert
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
import StopControlsSheet, { type StopSheetMode } from './StopControlsSheet';
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
   * card's column span.
   *
   * Defaults to `detailed`, which is this card exactly as it was before the
   * canvas existed — so every caller that knows nothing about tiers, and every
   * card the user has never resized, renders unchanged.
   */
  tier?: CardTier;
  /**
   * Columns this card covers, 1-3.
   *
   * Decides how many compact buses sit across a row; `tier` already covers which
   * layout, and the two are the same fact — one and two columns are `compact`,
   * three is `detailed`. Defaults to 3, so a caller that knows nothing about the
   * canvas gets the full-width card.
   */
  span?: number;
  /**
   * How many buses fit in the box the canvas gave this card, or null for a caller
   * that is not imposing a box at all.
   *
   * It is a guard rather than a policy: the canvas sizes the box from the count
   * this card reports through `onCountChange`, so in the ordinary case it admits
   * every line the stop is showing. What it is for is the frame between a line
   * being toggled here and the canvas hearing about it, where the card would
   * otherwise draw a row its box has no room for.
   */
  maxBuses?: number | null;
  /**
   * The exact height in px the canvas has given this card, or null/undefined
   * while the card is still allowed to size itself to its content.
   *
   * Home always passes one — every card's height is derived from its bus count,
   * whether or not the user has ever arranged it. The null case is what a caller
   * that knows nothing about the canvas gets, and is what keeps this component
   * renderable on its own.
   */
  boxHeight?: number | null;
  /**
   * How many buses this card is showing, reported whenever it changes.
   *
   * This is the input to the card's own height, so it is the one piece of layout
   * traffic that runs upwards. Only this component can supply it: the stop's line
   * list comes off the network, and the stored filter's default — `null`, meaning
   * "show all" — is not a number anybody else can count.
   */
  onCountChange?: (stopCode: string, buses: number) => void;
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

/**
 * Indices into `lines`, most imminent bus first.
 *
 * The card's ranking, in one place, because two things need it and they must
 * agree: which buses survive a cap, and which line the footer's schedule button
 * opens. A stop that truncated to one bus and then offered a *different* bus's
 * timetable would be describing two buses at once with nothing on screen to say
 * so.
 *
 * A line with no live estimate sorts last rather than first — a null is "we do
 * not know", not "very soon" — and ties, including the case where nothing has an
 * estimate at all, fall back to the stop's own order. The index tiebreak is
 * explicit rather than left to `Array.sort` being stable: it is, everywhere this
 * runs, but "the bus the card shows" is not a thing to settle by engine
 * behaviour.
 */
function byArrival(lines: readonly DecayedLine[]): number[] {
  const order = lines.map((_, i) => i);
  order.sort((a, b) => {
    const ma = lines[a].minutes;
    const mb = lines[b].minutes;
    if (ma == null) return mb == null ? a - b : 1;
    if (mb == null) return -1;
    return ma === mb ? a - b : ma - mb;
  });
  return order;
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
  span,
  count,
}: {
  stopName: string;
  tier: CardTier;
  span: number;
  count: number;
}) {
  /* The placeholder follows the tier, the span *and* the count, for the reason
     the component exists at all: it is standing in for a specific layout, and a
     grey shape that is replaced by a different number of real shapes is the jump
     this was written to remove, reintroduced one size down. Three grey rows in a
     box the canvas sized for one bus would scroll on the first frame and then
     not on the second. */
  if (tier === 'compact') {
    const tile = span === 2 ? s.busTileHalf : s.busTile;
    return (
      <View style={s.busGrid} accessible accessibilityLabel={`Loading arrivals for ${stopName}`}>
        {Array.from({ length: count }, (_, i) => (
          <View key={i} style={tile}>
            {/* The badge's own stacked-layout margin, so the grey pair sits at
                the spacing the real pair will. */}
            <SkeletonBox width={46} height={22} radius={radius.sm} style={s.compactBadge} />
            <SkeletonBox width={44} height={26} radius={radius.sm} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View accessible accessibilityLabel={`Loading arrivals for ${stopName}`}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={s.skeletonRow}>
          <SkeletonBox width={46} height={22} radius={radius.sm} />
          {/* Percentage of the flexible middle, not of the row: measured
              against the row it would overflow once the badge, the number
              block and three gaps are subtracted from a 360dp screen. The three
              widths cycle rather than run out, so a tall card gets varied rows
              instead of identical ones. */}
          <View style={s.skeletonGrow}>
            <SkeletonBox width={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]} height={12} />
          </View>
          <SkeletonBox width={40} height={26} radius={radius.sm} />
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
  alertActive: boolean;
  primaryColor: string;
  onPress: (lineCode: string) => void;
  onOpenSchedule: (lineCode: string) => void;
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
  alertActive,
  primaryColor,
  onPress,
  onOpenSchedule,
  onToggleAlert,
}: RowProps) {
  const arrivalText =
    minutes == null ? null : minutes <= 0 ? 'now' : String(minutes);

  const spoken = spokenArrival(minutes, nextDeparture, nextIsTomorrow);

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
          {/* The pill survived the schedule's move into a sheet because it was
              never only a control: it prints the next scheduled departure, which
              is the one piece of information a stop with no live estimate still
              has. What it lost is the expanded state — there is no longer
              anything of it on the card to expand, so there is no `expanded` to
              announce and no accent state to paint. */}
          {hasTimetable && (
            <Pressable
              style={s.schedPill}
              onPress={() => onOpenSchedule(lineCode)}
              accessibilityRole="button"
              accessibilityLabel={
                nextDeparture
                  ? `Timetable, next departure ${nextDeparture}${nextIsTomorrow ? ' tomorrow' : ''}`
                  : 'Timetable'
              }
              accessibilityHint="Opens the full timetable for this line"
            >
              <Ionicons name="time-outline" size={12} color={colors.textMuted} />
              <Text style={s.schedPillText}>
                {nextDeparture
                  ? nextIsTomorrow ? `${nextDeparture} tomorrow` : nextDeparture
                  : 'Timetable'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Everything in this block carries the figure's cap, including the two
            that are not the figure. Uncapped, at accessibility text sizes the
            `min` caption and the em dash outgrow the digits they annotate and
            become the widest thing in the block — which lifts it off the floor
            in `arrivalBlock` that keeps the row from reflowing on every poll,
            and makes a row with no arrival taller than the rows above it. */}
        <View style={[s.arrivalBlock, stale && s.stale]}>
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

/* ── The compact tier's bus ──────────────────────────────────── */

/**
 * A stacked badge and figure — everything a ~98dp card has room to say.
 *
 * Its own component rather than a branch inside `LineRow`, because it is not a
 * narrower row: the badge moves from beside the number to above it, the
 * `arrivalBlock` width reservation that keeps a row from reflowing has nothing
 * to reserve against, and there is no description, pill or bell to hide. A
 * shared component would have been two layouts sharing a name.
 *
 * One component for both compact spans, and that is the design rather than a
 * saving: two columns is *this* bus twice across, not a third layout. `half` is
 * therefore the only thing it knows about the span, and all it does with it is
 * pick which of two registered styles it occupies.
 *
 * It is a button for the same reason a row is: tapping the bus opens that line's
 * map, and losing that at the smallest size would make the compact card the only
 * place in the app where the arrival is not a way in.
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
  /** Two of these across, i.e. a two-column card. A boolean and not a style,
   *  because a composed style array would be a new identity on every arrival
   *  poll and would defeat this component's `memo`. */
  half: boolean;
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
  half,
  primaryColor,
  onPress,
}: CompactProps) {
  const spoken = spokenArrival(minutes, nextDeparture, nextIsTomorrow);

  return (
    <Pressable
      style={half ? s.busTileHalf : s.busTile}
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
  /* Three, matching `tier`'s default, because the two are one fact said twice.
     Written as a literal rather than imported as `COLS`: the type-only import
     below is what keeps this presentational component from depending on the
     canvas's geometry at runtime, and a default is not worth spending that on. */
  span = 3,
  maxBuses = null,
  boxHeight = null,
  onCountChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: Props) {
  const router = useRouter();
  const { linesMap, linesReady, linesLoading, linesError, refetchLines } = useLinesMap();
  const isOnline = useNetworkStatus();

  const routesQuery = useRoutesForStop(stop.stopCode);
  const arrivalsQuery = useArrivals(stop.stopCode, active);

  /* Line groups are derived, not fetched: `buildLineGroups` already has every
     arrival minute the moment both queries resolve. Nothing else may delay it. */
  const built = useMemo(() => {
    if (!routesQuery.data) return null;
    /* Not until the line catalogue is usable: a badge built without it reads
       out the internal LineCode instead of the line number. */
    if (!linesReady) return null;
    return buildLineGroups(routesQuery.data, arrivalsQuery.data ?? [], linesMap);
  }, [routesQuery.data, arrivalsQuery.data, linesMap, linesReady]);
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
  const [visibleSet, setVisibleSet] = useState<Set<string> | null>(() =>
    stop.visibleLines ? new Set(stop.visibleLines) : null,
  );

  /* Which sheet is up, and — for the schedule — on which line. Two pieces of
     state rather than a tagged union: `sheetLine` outlives the sheet closing,
     which costs nothing and means reopening the schedule from the footer does
     not have to re-derive a line the user already chose. */
  const [sheet, setSheet] = useState<StopSheetMode | null>(null);
  const [sheetLine, setSheetLine] = useState<string | null>(null);

  // Home's edit mode owns the header while it is on, and a sheet is over the
  // whole screen — including that header — so it cannot be left up underneath
  // it. Same rule the inline filter panel had, now that the panel is a sheet.
  useEffect(() => {
    if (editing) setSheet(null);
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

  /**
   * Tell the canvas how many buses this card is showing.
   *
   * The card's height is a function of this and nothing else, so this is the one
   * piece of layout traffic that runs upwards — and the only place it can come
   * from. `visibleLines` is stored, but its default is `null` meaning "show all",
   * and how many "all" is depends on a route list that arrives over the network.
   * The intersection is what matters, not the filter: a filter still naming a line
   * the stop no longer serves must not buy a row for a bus that cannot appear.
   *
   * A *number* is the dependency, not `displayLines` — the arrivals poll rebuilds
   * that array every fifteen seconds with fresh identities, and an effect keyed on
   * it would report the same count to the canvas on every poll for every card on
   * the screen.
   *
   * Nothing is reported while the list is still unknown. A zero would be a claim —
   * "this stop shows no buses" — and it would shrink the card to its floor and back
   * again the moment the request landed, on every cold start.
   */
  const busCount = displayLines?.length ?? null;
  useEffect(() => {
    if (busCount == null) return;
    onCountChange?.(stop.stopCode, busCount);
  }, [busCount, onCountChange, stop.stopCode]);

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
   * This used to be two lines inside the row loop. It is hoisted because the cap
   * below has to rank these, and a card that decided which bus was next by a
   * second, hand-copied version of the rule below would eventually disagree with
   * the rows it replaces — the same stop showing a different bus at two widths,
   * with nothing in the UI to explain it.
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
   * The buses this card actually shows, and the order it shows them in. Those
   * are two different questions and they get two different answers.
   *
   * **Which** is by arrival: a card with room for two out of five buses must drop
   * the three least imminent, not the last three in the list, or the cap would be
   * deciding what the user sees by an accident of how OASA orders routes.
   *
   * **In what order** is the stop's own. Rendering in arrival order instead would
   * reshuffle the rows every fifteen seconds as the estimates move past each
   * other, and a card whose rows swap places while you are reading it is worse
   * than one that shows a bus you did not need — you cannot re-find the row you
   * were looking at, and the one you tap is not the one you aimed for. So the cap
   * picks a *set* and the set is drawn in place.
   *
   * When the cap admits everything, both questions have the same answer and this
   * returns `decayed` untouched — which is what makes an unarranged, uncapped
   * card byte-for-byte 1.2.4.
   *
   * A one-bus card is the degenerate case of the same rule, and it inherits the
   * fallback that used to be written out here: with nothing ranked above it, a
   * stop where no line has a live estimate keeps its first line and shows an em
   * dash for it, because a compact card that blanked itself the moment its
   * estimates expired would be indistinguishable from one that failed to load.
   */
  const shown = useMemo<DecayedLine[] | null>(() => {
    if (!decayed) return null;
    if (maxBuses == null || decayed.length <= maxBuses) return decayed;
    const keep = byArrival(decayed).slice(0, maxBuses);
    // Back into the stop's own order, which is what `decayed`'s indices are.
    keep.sort((a, b) => a - b);
    return keep.map((i) => decayed[i]);
  }, [decayed, maxBuses]);

  /**
   * The line the footer's schedule button opens, or null if there is nothing to
   * open.
   *
   * The most imminent bus that *has* a timetable, rather than simply the most
   * imminent one: a fixed control that opened an empty sheet would be worse than
   * one that is visibly dead, and "no visible line has a timetable" is exactly
   * the condition that dims it.
   *
   * Ranked over every visible line rather than only the ones on screen, because
   * the button is about the stop and not about the rows the card had room for.
   */
  const scheduleLine = useMemo<string | null>(() => {
    if (!decayed) return null;
    for (const i of byArrival(decayed)) {
      const sched = schedules.get(decayed[i].line.lineCode);
      if (sched && sched.times.length > 0) return decayed[i].line.lineCode;
    }
    return null;
  }, [decayed, schedules]);

  /** Every line the stop serves, in card order, flattened for the sheet — which
   *  needs all of them and not just the visible ones, since choosing what is
   *  visible is one of the things it is for. */
  const sheetLines = useMemo(
    () => (allLineGroups ?? []).map((l) => ({
      lineCode: l.lineCode,
      lineId: l.lineId,
      label: labels.get(l.lineCode) ?? l.lineDescrEng,
    })),
    [allLineGroups, labels],
  );

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

  /* One way in to every sheet, so the mode and the line it applies to are always
     set together. `openSchedule` exists because a row's pill hands over only a
     line code and `LineRow` is memoized — it needs one stable callback, not a
     closure rebuilt per row. */
  const openSheet = useCallback((mode: StopSheetMode, line: string | null = null) => {
    setSheetLine(line);
    setSheet(mode);
  }, []);
  const openSchedule = useCallback(
    (lineCode: string) => openSheet('schedule', lineCode),
    [openSheet],
  );
  const closeSheet = useCallback(() => setSheet(null), []);

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

  /**
   * The footer's alarm button, which is one control standing in for a column of
   * per-line bells that only three columns has room for.
   *
   * It has to answer for the whole stop, so it takes the shortest true path:
   * something armed *here* → stop it, whichever of the stop's lines it is on,
   * because the button is the stop's and only one watch exists app-wide anyway.
   * Exactly one line visible → there is no choice to offer, so go straight to the
   * threshold picker the bell would have opened. Otherwise the choice is real and
   * the sheet is where it is made.
   *
   * The middle case is the one worth keeping: at one column a stop the user has
   * filtered down to a single line is the common shape, and making them pick that
   * line out of a sheet of one would be a tap that answers nothing.
   */
  const handleAlarmPress = useCallback(() => {
    if (alertHere) {
      stopAlertWatch();
      return;
    }
    const only = displayLines?.length === 1 ? displayLines[0].lineCode : null;
    if (only) {
      handleAlertToggle(only);
      return;
    }
    openSheet('alarm');
  }, [alertHere, displayLines, handleAlertToggle, openSheet]);

  /* From the sheet's own list. The sheet closes *first*: the threshold picker is
     a modal, and leaving a sheet under it would put two dismissable layers over
     the card with the lower one still holding the list the user just finished
     with. */
  const handlePickAlarm = useCallback((lineCode: string) => {
    setSheet(null);
    handleAlertToggle(lineCode);
  }, [handleAlertToggle]);

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
  /* Two buses across, i.e. a two-column card. The only thing `span` decides. */
  const pair = span === 2;
  /* How many grey shapes the cold start draws. The cap, because that is how many
     real ones will replace them; three when there is no cap, which is what a
     caller imposing no box has always shown and is a fair guess at a stop's line
     count — the canvas's own guess for a stop it has not heard from is the same
     three, for the same reason (`FALLBACK_BUSES`). Getting this wrong is not
     cosmetic in a fixed box: too many and the placeholder scrolls on the first
     frame and then does not. */
  const placeholderCount = maxBuses ?? SKELETON_WIDTHS.length;
  /* An armed alert whose line the filter hides would otherwise be unreachable —
     at `detailed`. Below it this banner is left out because the geometry does not
     count it: a compact card's box is exactly chrome, header, its buses and the
     controls row, so a banner here would not be added to the card, it would be
     taken out of a bus. Nothing is stranded. The footer's alarm button stops an
     alert armed at this stop at every span, whether or not the filter is hiding
     the line it is on; and only one watch exists app-wide, so `app/_layout.tsx`
     renders a pill with a "Stop alert" button on every screen for as long as
     `subscribeAlertConfig` reports one. */
  const orphanAlert =
    tier === 'detailed'
    && alertHere
    && !(displayLines ?? []).some((l) => l.lineId === alertHere.lineId)
      ? alertHere
      : null;

  /**
   * A card on the canvas is a fixed box, and `overflow` is what makes that claim
   * true: content that outgrew the box would paint over the card below it, and the
   * design rules overlap out entirely — one stop covering another stop's minutes
   * is worse than any arrangement it could enable.
   *
   * The box is sized for this card's buses, so in the ordinary case there is
   * nothing for `overflow` to cut off. What it still catches is the two things the
   * geometry cannot predict: a system font scale that grows a row past the height
   * the arithmetic assigned it, and the offline notice below, which appears when
   * the network says so rather than when the layout is decided.
   *
   * No height at all is what a caller outside the canvas gets, and it is why this
   * component still renders on its own.
   *
   * `cardCompact` narrows the *side* padding only, and it is here rather than in
   * `card` because it is only worth it where width is scarce: it is 10dp of a
   * 116dp column handed back to the three footer controls, and 10dp of 364 that
   * three columns has no use for.
   */
  const cardStyle = useMemo(
    () => {
      const base = compact ? [s.card, s.cardCompact] : [s.card];
      return boxHeight == null
        ? base
        : [...base, { height: boxHeight, overflow: 'hidden' as const }];
    },
    [boxHeight, compact],
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
    <LoadingRows stopName={stop.stopName} tier={tier} span={span} count={placeholderCount} />
  ) : shown && shown.length > 0 ? (
    shown.map(({ line, minutes }) => {
      const sched = schedules.get(line.lineCode);
      return (
        <LineRow
          key={line.lineCode}
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
          alertActive={!!alertHere && alertHere.lineId === line.lineId}
          primaryColor={primaryColor}
          onPress={handleLinePress}
          onOpenSchedule={openSchedule}
          onToggleAlert={handleAlertToggle}
        />
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
    <LoadingRows stopName={stop.stopName} tier={tier} span={span} count={placeholderCount} />
  ) : shown && shown.length > 0 ? (
    /* One tile per bus, wrapping. The container is the only place the two compact
       spans differ, and even there it is the tiles that carry the width — a grid
       that knew about spans would be the measured-breakpoint layout this rework
       replaced, wearing a new name. */
    <View style={s.busGrid}>
      {shown.map(({ line, minutes }) => {
        const sched = schedules.get(line.lineCode);
        return (
          <CompactArrival
            key={line.lineCode}
            lineId={line.lineId}
            lineCode={line.lineCode}
            label={labels.get(line.lineCode) ?? line.lineDescrEng}
            minutes={minutes}
            // The row's rule, for the row's reason: an amber that has aged into
            // one minute must read as urgent.
            color={minutes != null ? getArrivalColor(minutes) : line.color}
            stale={isStale && minutes != null}
            nextDeparture={sched?.nextDeparture ?? null}
            nextIsTomorrow={!!sched?.nextIsTomorrow}
            half={pair}
            primaryColor={primaryColor}
            onPress={handleLinePress}
          />
        );
      })}
    </View>
  ) : (
    <View style={s.compactBody}>
      {/* The wider card's "Tap ⚙ to choose lines" is a sentence, and this is not
          a card with room for one — but the button it points at is now in the
          footer at every span, so the instruction is true here and belongs in
          the label, where it costs no width. It used to say "make this card
          wider", which was the honest answer while the filter lived in a header
          that only three columns had room for. */}
      <Text
        style={s.compactNote}
        numberOfLines={2}
        accessibilityLabel={
          hasLines
            ? 'No lines are shown. Use the filter button below to choose which lines to show.'
            : 'No lines serve this stop.'
        }
      >
        {hasLines ? 'No lines shown' : 'No lines'}
      </Text>
    </View>
  );

  /**
   * Schedule, alarm and filter. The point of the rework: one row, in the same
   * place, at every span.
   *
   * Built as a value because it is the same three controls either way — only the
   * row's height and the icons' size change — and because it renders below both
   * body branches, which are otherwise structurally different.
   *
   * It renders in *every* state, including `failed`, and unavailable controls are
   * dimmed rather than dropped. The height is already spent: the canvas subtracted
   * a controls row when it decided how many buses this card gets, so hiding the
   * row would not give the card anything, it would only move the buttons — and a
   * footer whose contents move between a stop that has timetables and one that
   * does not is a footer that has to be re-read every time.
   */
  const iconSize = compact ? 18 : 20;
  const controls = (
    <View style={[s.controls, !compact && s.controlsWide]}>
      <Pressable
        style={s.controlBtn}
        disabled={!scheduleLine}
        onPress={() => openSheet('schedule', scheduleLine)}
        accessibilityRole="button"
        accessibilityState={{ disabled: !scheduleLine }}
        accessibilityLabel="Timetable"
        accessibilityHint={
          scheduleLine ? 'Opens the timetable for this stop' : 'No timetable for the lines shown'
        }
      >
        <Ionicons
          name="time-outline"
          size={iconSize}
          color={scheduleLine ? colors.textMuted : colors.border}
        />
      </Pressable>

      {/* A switch rather than a button, because from the user's side that is what
          it is: the stop's alert is on or off, and the line-and-threshold
          question the off→on direction asks is a step on the way rather than a
          different control. `disabled` spares a sheet that could only offer an
          empty list — but never while an alert is armed, or the one control that
          can stop it would go dead exactly when it is needed. */}
      <Pressable
        style={s.controlBtn}
        disabled={!hasLines && !alertHere}
        onPress={handleAlarmPress}
        accessibilityRole="switch"
        accessibilityState={{ checked: !!alertHere, disabled: !hasLines && !alertHere }}
        accessibilityLabel={
          alertHere ? `Arrival alert on for line ${alertHere.lineId}` : 'Arrival alert'
        }
        accessibilityHint={alertHere ? 'Turns the alert off' : 'Choose a line and how early to be warned'}
      >
        <Ionicons
          name={alertHere ? 'notifications' : 'notifications-outline'}
          size={iconSize}
          color={alertHere ? colors.warning : hasLines ? colors.textMuted : colors.border}
        />
      </Pressable>

      <Pressable
        style={s.controlBtn}
        disabled={!hasLines}
        onPress={() => openSheet('lines')}
        accessibilityRole="button"
        accessibilityState={{ disabled: !hasLines }}
        accessibilityLabel="Choose which lines to show"
        accessibilityHint={hasLines ? undefined : 'No lines serve this stop'}
      >
        <Ionicons
          name="options-outline"
          size={iconSize}
          color={hasLines ? colors.textMuted : colors.border}
        />
      </Pressable>
    </View>
  );

  return (
    <View style={cardStyle}>
      <View style={[s.header, compact && s.headerCompact]}>
        {/* Three columns only. The pin is 20dp of the ~98dp a one-column card
            has, which is a decoration charging the stop's own name a fifth of
            the width — and the name is the only thing in a compact header. */}
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
             120dp, and a one-column card has ~98dp of content in total — the
             chevrons would push the stop's name out of the card altogether and
             offer to reorder something the user can no longer identify. The
             remove button stays at every span, because a stop that could only be
             deleted after being resized would be a size that traps data. */
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
              style={compact ? s.headerBtnCompact : s.headerBtn}
              onPress={() => onRemove(stop)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${stop.stopName} from saved stops`}
            >
              <Ionicons name="remove-circle" size={compact ? 20 : 22} color={colors.danger} />
            </Pressable>
          </>
        ) : null}
        {/* Nothing else up here. The line filter used to be a header button, and
            it is in the controls footer now — at every span, which is the whole
            point, and one control in one place rather than a button that existed
            only where there was room for it. What the header gets back is the
            width, which goes to the stop's name. */}
      </View>

      {/* The compact grid is never wrapped in a scroll view. It centres itself in
          the exact box the canvas gave the card, and a scroll view would move
          that centring into a content container that knows nothing about the box.
          It does not need one either: the tiles are floored at the same
          `BUS_TILE_H_DP` the capacity arithmetic divided by, so the number of
          buses is chosen to fit rather than scrolled to.

          The residual failure mode, stated so it is not a surprise: a system font
          scale near the figure's 1.3 cap grows a tile past 66dp, and the card
          clips what will not fit. Centred, that costs the top and bottom rows
          equally. The detailed rows keep their scroll view because they have the
          width to be worth scrolling. */}
      {compact ? compactBody
        : boxHeight != null ? (
          <ScrollView style={s.bodyScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {rows}
          </ScrollView>
        ) : rows}

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
      {!compact && !failed && hasLines
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

      {/* Last, so the hairline above it reads as the card's own bottom rule and
          the notices above stay inside the body they are describing. */}
      {controls}

      {/* Both panels that used to grow the card, now one sheet. It renders
          nothing while `sheet` is null, so it costs a closed card nothing but the
          props it is handed. `visibleLines` and `alertLineId` are the same values
          the rows above read, so the sheet cannot show a different answer than
          the card behind it. */}
      <StopControlsSheet
        mode={sheet}
        stopName={stop.stopName}
        accentColor={primaryColor}
        lines={sheetLines}
        schedules={schedules}
        initialLine={sheetLine}
        visibleLines={visibleSet}
        alertLineId={alertHere?.lineId ?? null}
        onToggleLine={toggleLineVisibility}
        onPickAlarm={handlePickAlarm}
        onClose={closeSheet}
      />

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
