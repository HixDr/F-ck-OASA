/**
 * Home Screen — saved stops first, then saved lines.
 *
 * The saved stops used to be a virtualized FlatList. They are a canvas now:
 * every card is absolutely positioned on a surface that scrolls vertically and
 * grows to fit the lowest card, because a card the user may put anywhere is not
 * something a list can express. `features/home/layout` owns every number behind
 * that — units, size tiers, magnets, overlap resolution — and contains no React
 * on purpose, so the render pass, the gesture worklets and the accessibility
 * actions cannot quietly become three layout engines that disagree.
 *
 * Virtualization is the price, and it is a real one: every saved stop renders
 * at once and each card owns live arrival queries. That is fine at the 5-20
 * stops people actually save, and it is what turns `active` — the focus gate
 * handed to every card — from an optimisation into load-bearing code.
 *
 * A stop that has never been arranged *flows*: full width, sized by its own
 * content, stacked in saved order beneath anything that has been placed. An
 * install arriving from 1.2.4 has no saved placements at all, so every card
 * flows and this canvas reproduces the old column exactly. That is the whole
 * migration; see `layout.ts` for why it is expressed as a property of the
 * geometry rather than as a one-off upgrade step.
 *
 * Two interactions are worth explaining up front.
 *
 * Reordering. Holding a saved-line badge lifts it and the neighbours open a
 * gap, with `moveLeft` / `moveRight` accessibility actions as the equivalent a
 * screen reader can drive — a drag announces nothing, and a 44dp badge has
 * nowhere to put chevrons. That geometry is the grid's own and is shared with
 * nothing: see the section below for why a wrapping grid of content-sized
 * badges cannot borrow anything from the stop canvas.
 *
 * Removal. Nothing here asks "are you sure?" any more. Removing a saved stop or
 * line is one storage write and trivially reversible, so it happens at once and
 * an undo bar offers the way back — see `restoreStops` / `restoreLines` for why
 * "back" has to mean the position too, not just the item. A saved line is
 * removed in edit mode only: long press is the drag lift now, and a gesture
 * cannot mean "pick this up" and "delete this" at the same time.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  RefreshControl,
  Alert,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontScaleCap, onAccent, spacing } from '../../theme';
import {
  getFavorites,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  getFavoriteStops,
  removeFavoriteStop,
  addFavoriteStop,
  reorderFavoriteStops,
  updateFavoriteStops,
  isOfflineDataDownloaded,
  getOfflineTimestamp,
} from '../../services/storage';
import { downloadAllOfflineData, removeAllOfflineData, type OfflineProgress } from '../../services/offlineData';
import { useLines, usePrefetchLine, useArrivalsPollAt, useArrivalsStatus, ARRIVALS_POLL_MS } from '../../hooks';
import { USER_MARKER_BASE64 } from '../../data/userMarker';
import { useSettings } from '../settings/SettingsProvider';
import { hapticImpact, hapticSelection } from '../../services/haptics';
import { useNetworkStatus } from '../../services/network';
import Pressable from '../../ui/Pressable';
import LiveStatus from '../../ui/LiveStatus';
import { showUndo } from '../../ui/UndoBar';
import { duration, easing, liftSpring, spring, useReduceMotion } from '../../ui/motion';
import FavoriteStopCard from '../../components/FavoriteStopCard';
import SettingsModal from '../../components/SettingsModal';
import { s, LINE_GRID_GAP } from './HomeScreen.styles';
import { fitAll, placeAll, type PlacedCard } from './layout';
import type { FavoriteLine, FavoriteStop } from '../../types';

/* ── Order persistence ───────────────────────────────────────── */

/** Persist a new saved-stop order. One storage write, and one that keeps any
 *  code it was not told about — see `reorderFavoriteStops`. */
function persistStopOrder(next: FavoriteStop[]): void {
  reorderFavoriteStops(next.map((st) => st.stopCode));
}

/** The same, for saved lines. */
function persistLineOrder(next: FavoriteLine[]): void {
  reorderFavorites(next.map((f) => f.lineCode));
}

/**
 * Put a captured saved-stop array back, order included.
 *
 * `addFavoriteStop` appends, so undoing a removal by re-adding the one stop
 * would silently drop it to the bottom of the list — a "fix" that quietly
 * changes something else the user cared about. Re-adding and then replaying the
 * whole captured order is the only shape that restores what was actually there.
 * Anything saved *since* the removal survives: adding an existing code is a
 * no-op, and `reorderFavoriteStops` keeps codes it was not told about.
 */
function restoreStops(before: FavoriteStop[]): FavoriteStop[] {
  for (const st of before) addFavoriteStop(st);
  persistStopOrder(before);
  return getFavoriteStops();
}

/**
 * The same, for saved lines.
 *
 * This used to rebuild the diverging tail through remove/add, because lines had
 * no reorder API and churning the whole array would briefly persist an empty
 * list — a kill in that window was a user who lost every saved line to an undo.
 * `reorderFavorites` is one write of the final array, so that hazard is gone.
 */
function restoreLines(before: FavoriteLine[]): FavoriteLine[] {
  for (const f of before) addFavorite(f);
  persistLineOrder(before);
  return getFavorites();
}

/* ── Lift vocabulary ─────────────────────────────────────────── */

/** Hold before a card or a saved-line badge lifts. Long enough not to fire
 *  mid-scroll, short enough that the lift reads as a response, not a delay. */
const LIFT_MS = 260;
const LIFT_SCALE = 1.03;

/** Cards below this index get the first-paint entrance; the rest are scrolled
 *  to, and an animation on arrival would read as lag. */
const ENTRANCE_CARDS = 8;

/* ── A card on the canvas ────────────────────────────────────── */

interface StopCardProps {
  stop: FavoriteStop;
  index: number;
  count: number;
  /** Where the canvas has decided this card sits, in pixels. */
  card: PlacedCard;
  primaryColor: string;
  focused: boolean;
  editing: boolean;
  /** First paint only — a card mounting later must not fade in as if new. */
  entrance: boolean;
  reduced: boolean;
  onMeasure: (stopCode: string, height: number) => void;
  onRemove: (stop: FavoriteStop) => void;
  onMoveUp: (stop: FavoriteStop) => void;
  onMoveDown: (stop: FavoriteStop) => void;
}

/**
 * One absolutely positioned card.
 *
 * The wrapper carries the geometry and the card carries the content, which is
 * the split that lets a card be moved and resized without anything inside it
 * knowing. A *flowing* card is given no height at all so it can size itself
 * from its content exactly as it did in 1.2.4, and reports what that came to —
 * the canvas needs the measurement both to stack the card below it and to know
 * what box to freeze it at the moment it is first picked up.
 */
const StopCard = React.memo(function StopCard({
  stop,
  index,
  count,
  card,
  primaryColor,
  focused,
  editing,
  entrance,
  reduced,
  onMeasure,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StopCardProps) {
  const measure = useCallback(
    (e: LayoutChangeEvent) => {
      onMeasure(stop.stopCode, e.nativeEvent.layout.height);
    },
    [onMeasure, stop.stopCode],
  );

  const entering =
    entrance && !reduced && index < ENTRANCE_CARDS
      ? FadeInDown.duration(duration.slow).delay(index * 45).easing(easing.out)
      : undefined;

  return (
    <Animated.View
      style={[
        s.stopCard,
        { left: card.left, top: card.top, width: card.width },
        // A placed card is a fixed box; a flowing one is whatever it measures.
        card.flowing ? null : { height: card.height },
      ]}
      // Only a flowing card's measurement means anything: a placed card would
      // just report back the height the canvas already told it to be.
      onLayout={card.flowing ? measure : undefined}
      entering={entering}
    >
      <FavoriteStopCard
        stop={stop}
        primaryColor={primaryColor}
        active={focused}
        editing={editing}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        canMoveUp={index > 0}
        canMoveDown={index < count - 1}
      />
    </Animated.View>
  );
});

/* ── Saved lines: the grid's own geometry ────────────────────── */

/**
 * None of the stop canvas's maths transfers here, and it is worth saying why
 * before someone tries to share it.
 *
 * The canvas is free placement: a card is wherever the user put it, `layout.ts`
 * only has to say whether that position is legal, and no other card moves when
 * one does. This grid is the opposite — the badges have no positions of their
 * own at all. They are content-sized, wrapping flex children (a 2-digit line and
 * a 4-digit one are different widths, and both grow with the system font scale),
 * so inserting one mid-grid reflows the tail *across row boundaries* and every
 * other badge's travel is a different (dx, dy).
 *
 * So the grid's wrapping is re-run here, from measured widths, for the
 * hypothetical order. Everything is stated as a *difference* against the
 * identity layout (`k === a`), which means any disagreement between this
 * simulation and Yoga's own line-breaking cancels out instead of showing up as
 * every badge jumping the moment one is picked up.
 */

/** Which original index sits at position `p`, once the badge lifted from `a` has
 *  been re-inserted at slot `k`. */
function origAt(p: number, a: number, k: number): number {
  'worklet';
  if (p === k) return a;
  // Position in the array with `a` removed, then back to an original index.
  const j = p < k ? p : p - 1;
  return j < a ? j : j + 1;
}

/** The inverse: where original index `i` ends up. */
function posOf(i: number, a: number, k: number): number {
  'worklet';
  if (i === a) return k;
  const j = i < a ? i : i - 1;
  return j < k ? j : j + 1;
}

/**
 * Top-left of the badge at position `p` in that hypothetical order.
 *
 * Walks the prefix only: a wrapping row's geometry depends on everything before
 * an item and nothing after it.
 */
function slotXY(
  p: number,
  a: number,
  k: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): { x: number; y: number } {
  'worklet';
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (let q = 0; q <= p; q++) {
    const o = origAt(q, a, k);
    const w = ws[o] ?? 0;
    // The epsilon keeps a badge that measured a fraction over its share on the
    // row Yoga actually put it on.
    if (x > 0 && x + w > width + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    if (q === p) return { x, y };
    x += w + gap;
    const h = hs[o] ?? 0;
    if (h > rowH) rowH = h;
  }
  return { x, y };
}

/** How far the badge at `index` slides to open (or close) the gap. */
function shiftFor(
  index: number,
  a: number,
  k: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): { dx: number; dy: number } {
  'worklet';
  const from = slotXY(index, a, a, ws, hs, width, gap);
  const to = slotXY(posOf(index, a, k), a, k, ws, hs, width, gap);
  return { dx: to.x - from.x, dy: to.y - from.y };
}

/** The slot a badge lifted from `a` is closest to, given where it is now. */
function slotForXY(
  px: number,
  py: number,
  a: number,
  count: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): number {
  'worklet';
  let best = a;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const p = slotXY(k, a, k, ws, hs, width, gap);
    const dx = p.x - px;
    const dy = p.y - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

/** Total height of the grid as laid out. Only the drop clamp needs it. */
function gridHeight(ws: number[], hs: number[], width: number, gap: number): number {
  'worklet';
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (x > 0 && x + w > width + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    x += w + gap;
    if (hs[i] > rowH) rowH = hs[i];
  }
  return y + rowH;
}

function clamp(v: number, min: number, max: number): number {
  'worklet';
  return v < min ? min : v > max ? max : v;
}

/** Everything a badge needs to take part in the grid drag. Its own set of
 *  shared values — the stop drag's are screen-level singletons and a badge
 *  borrowing them would let one gesture clear the other's state. */
interface LineDragCtl {
  active: SharedValue<number>;
  target: SharedValue<number>;
  /** The lifted badge's travel from its laid-out position. */
  ox: SharedValue<number>;
  oy: SharedValue<number>;
  lift: SharedValue<number>;
  /** Measured badge sizes, in the current order. */
  ws: SharedValue<number[]>;
  hs: SharedValue<number[]>;
  gridW: SharedValue<number>;
  gridH: SharedValue<number>;
  reduced: SharedValue<boolean>;
  onLift: (index: number) => void;
  onTarget: (index: number) => void;
  onDrop: (from: number, to: number) => void;
  onMeasure: (lineCode: string, w: number, h: number) => void;
}

/* ── Saved line chip ─────────────────────────────────────────── */

interface LineChipProps {
  fav: FavoriteLine;
  index: number;
  count: number;
  editing: boolean;
  accentColor: string;
  ctl: LineDragCtl;
  onOpen: (fav: FavoriteLine) => void;
  onRemove: (fav: FavoriteLine) => void;
  onMove: (fav: FavoriteLine, delta: number) => void;
}

const LineChip = React.memo(function LineChip({
  fav,
  index,
  count,
  editing,
  accentColor,
  ctl,
  onOpen,
  onRemove,
  onMove,
}: LineChipProps) {
  const measure = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      ctl.onMeasure(fav.lineCode, width, height);
    },
    [ctl, fav.lineCode],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(LIFT_MS)
        .maxPointers(1)
        .onStart(() => {
          const ws = ctl.ws.value;
          // One saved line cannot be reordered, and nothing can be dropped
          // before the grid has been measured.
          if (ws.length < 2 || index >= ws.length || ctl.gridW.value <= 0) return;
          /* The previous badge is still settling and has not committed yet.
             Lifting a second one would let that pending commit clear `active`
             out from under this drag. */
          if (ctl.active.value >= 0) return;
          ctl.active.value = index;
          ctl.target.value = index;
          ctl.ox.value = 0;
          ctl.oy.value = 0;
          ctl.lift.value = ctl.reduced.value ? 1 : withSpring(LIFT_SCALE, liftSpring);
          runOnJS(ctl.onLift)(index);
        })
        .onUpdate((e) => {
          if (ctl.active.value !== index) return;
          const ws = ctl.ws.value;
          const hs = ctl.hs.value;
          if (index >= ws.length) return;
          const width = ctl.gridW.value;
          const base = slotXY(index, index, index, ws, hs, width, LINE_GRID_GAP);
          // Clamped as a position rather than as a translation, so a badge
          // cannot be carried outside the grid it belongs to.
          const px = clamp(base.x + e.translationX, 0, Math.max(0, width - (ws[index] ?? 0)));
          const py = clamp(base.y + e.translationY, 0, Math.max(0, ctl.gridH.value - (hs[index] ?? 0)));
          ctl.ox.value = px - base.x;
          ctl.oy.value = py - base.y;
          const k = slotForXY(px, py, index, ws.length, ws, hs, width, LINE_GRID_GAP);
          if (k !== ctl.target.value) {
            ctl.target.value = k;
            runOnJS(ctl.onTarget)(k);
          }
        })
        /* onFinalize rather than onEnd: a gesture cancelled from outside — a
           call arriving, a navigation — must still put the badge down, and must
           still commit where the user had already moved it to. */
        .onFinalize(() => {
          if (ctl.active.value !== index) return;
          const k = ctl.target.value;
          const ws = ctl.ws.value;
          const rest =
            index < ws.length
              ? shiftFor(index, index, k, ws, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP)
              : { dx: 0, dy: 0 };
          ctl.lift.value = withSpring(1, liftSpring);
          if (ctl.reduced.value) {
            ctl.ox.value = rest.dx;
            ctl.oy.value = rest.dy;
            runOnJS(ctl.onDrop)(index, k);
          } else {
            ctl.ox.value = withSpring(rest.dx, liftSpring);
            /* Commit once the badge has physically landed. The neighbours are
               already sitting in the new order by then, so the data swap that
               follows changes nothing on screen. */
            ctl.oy.value = withSpring(rest.dy, liftSpring, () => {
              runOnJS(ctl.onDrop)(index, k);
            });
          }
        }),
    [ctl, index],
  );

  /* Two scalars rather than one `{dx, dy}`: a derived value carrying an
     animation has to *be* the animation, and the animated style must not
     re-target a spring on every frame of someone else's drag. */
  const shiftX = useDerivedValue(() => {
    const a = ctl.active.value;
    if (a < 0 || a === index) return 0;
    const to = shiftFor(index, a, ctl.target.value, ctl.ws.value, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP);
    return ctl.reduced.value ? to.dx : withSpring(to.dx, spring);
  });
  const shiftY = useDerivedValue(() => {
    const a = ctl.active.value;
    if (a < 0 || a === index) return 0;
    const to = shiftFor(index, a, ctl.target.value, ctl.ws.value, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP);
    return ctl.reduced.value ? to.dy : withSpring(to.dy, spring);
  });

  const animStyle = useAnimatedStyle(() => {
    const held = ctl.active.value === index;
    return {
      transform: [
        { translateX: held ? ctl.ox.value : shiftX.value },
        { translateY: held ? ctl.oy.value : shiftY.value },
        { scale: held ? ctl.lift.value : 1 },
      ],
      zIndex: held ? 2 : 0,
      elevation: held ? 10 : 0,
    };
  });

  /* A drag announces nothing and a 44dp badge has no room for chevrons, so the
     screen-reader path is a pair of custom actions. Only the ones that can
     actually move this badge are offered. */
  const a11yActions = useMemo<AccessibilityActionInfo[] | undefined>(() => {
    if (count < 2) return undefined;
    const acts: AccessibilityActionInfo[] = [];
    if (index > 0) acts.push({ name: 'moveLeft', label: 'Move left' });
    if (index < count - 1) acts.push({ name: 'moveRight', label: 'Move right' });
    return acts;
  }, [index, count]);

  const onAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { actionName } = e.nativeEvent;
      if (actionName === 'moveLeft') onMove(fav, -1);
      else if (actionName === 'moveRight') onMove(fav, 1);
    },
    [fav, onMove],
  );

  return (
    /* The detector sits on the transformed wrapper rather than inside it: its
       one child is then a single element, which is all `GestureDetector` will
       accept. The stop cells attach one level down only because a FlatList
       owns their outermost view. */
    <GestureDetector gesture={gesture}>
      <Animated.View style={[s.lineCell, animStyle]} onLayout={measure}>
        <Pressable
          style={s.lineCard}
          onPress={() => (editing ? onRemove(fav) : onOpen(fav))}
          accessibilityRole="button"
          accessibilityLabel={
            editing
              ? `Remove line ${fav.lineId} from saved lines`
              : `Line ${fav.lineId}, ${fav.lineDescrEng}`
          }
          accessibilityHint={editing ? undefined : 'Opens the live map for this line'}
          accessibilityActions={a11yActions}
          onAccessibilityAction={a11yActions ? onAction : undefined}
        >
          <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
            <Text style={[s.lineBadgeText, { color: onAccent(accentColor) }]} maxFontSizeMultiplier={fontScaleCap.badge}>{fav.lineId}</Text>
          </View>
          {editing && (
            <Ionicons name="close-circle" size={20} color={colors.danger} style={s.lineRemove} />
          )}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

/* ── Saved lines grid ────────────────────────────────────────── */

interface SavedLinesProps {
  lines: FavoriteLine[];
  editing: boolean;
  accentColor: string;
  onOpen: (fav: FavoriteLine) => void;
  onRemove: (fav: FavoriteLine) => void;
  onReorder: (next: FavoriteLine[]) => void;
  onMove: (fav: FavoriteLine, delta: number) => void;
  /** The list must not scroll out from under a badge being carried. */
  onDragChange: (dragging: boolean) => void;
}

/**
 * The grid owns its drag state.
 *
 * It renders inside Home's `ListFooterComponent`, which is a `useMemo`: keeping
 * the state here means a lift does not touch that memo's dependencies, so the
 * footer element is not rebuilt — once per drag, let alone once per frame.
 */
const SavedLines = React.memo(function SavedLines({
  lines,
  editing,
  accentColor,
  onOpen,
  onRemove,
  onReorder,
  onMove,
  onDragChange,
}: SavedLinesProps) {
  const reduced = useReduceMotion();

  /** The grid as the drag maths sees it, readable from a callback without
   *  waiting for a render. */
  const linesRef = useRef<FavoriteLine[]>(lines);
  /** Measured badge boxes by line code — not by index, because a reorder
   *  renumbers every index but no badge changes size. */
  const sizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const activeRef = useRef(-1);
  /* JS mirror of the grid's width. Reading a shared value from JS is a
     synchronous hop into the UI runtime; the layout maths below needs the width
     on every measurement, and there is no reason to pay for it twice. */
  const gridWRef = useRef(0);

  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const ox = useSharedValue(0);
  const oy = useSharedValue(0);
  const lift = useSharedValue(1);
  const wsSV = useSharedValue<number[]>([]);
  const hsSV = useSharedValue<number[]>([]);
  const gridW = useSharedValue(0);
  const gridH = useSharedValue(0);
  const reducedSV = useSharedValue(false);

  useEffect(() => {
    reducedSV.value = reduced;
  }, [reduced, reducedSV]);

  /**
   * Rebuild the geometry the drag maths runs on.
   *
   * Skipped while a badge is up: a font-scale change or a late measurement
   * mid-drag would slide every drop target out from under the user's finger.
   */
  const syncGeometry = useCallback(() => {
    if (activeRef.current >= 0) return;
    const ws: number[] = [];
    const hs: number[] = [];
    for (const f of linesRef.current) {
      const box = sizesRef.current.get(f.lineCode);
      ws.push(box?.w ?? 0);
      hs.push(box?.h ?? 0);
    }
    wsSV.value = ws;
    hsSV.value = hs;
    gridH.value = gridHeight(ws, hs, gridWRef.current, LINE_GRID_GAP);
  }, [wsSV, hsSV, gridH]);

  const onMeasure = useCallback(
    (lineCode: string, w: number, h: number) => {
      const prev = sizesRef.current.get(lineCode);
      // Sub-pixel churn from a re-render is not a new measurement.
      if (prev && Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1) return;
      sizesRef.current.set(lineCode, { w, h });
      syncGeometry();
    },
    [syncGeometry],
  );

  const onGridLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width } = e.nativeEvent.layout;
      if (Math.abs(gridWRef.current - width) < 1) return;
      gridWRef.current = width;
      gridW.value = width;
      syncGeometry();
    },
    [gridW, syncGeometry],
  );

  useEffect(() => {
    linesRef.current = lines;
    syncGeometry();
  }, [lines, syncGeometry]);

  const onLift = useCallback(
    (index: number) => {
      activeRef.current = index;
      hapticImpact();
      onDragChange(true);
    },
    [onDragChange],
  );

  const onTarget = useCallback(() => {
    hapticSelection();
  }, []);

  const onDrop = useCallback(
    (from: number, to: number) => {
      activeRef.current = -1;
      onDragChange(false);

      const arr = linesRef.current;
      if (from !== to && from >= 0 && from < arr.length && to >= 0 && to < arr.length) {
        const next = arr.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        linesRef.current = next;
        // Persisted by the caller, outside the state updater: updaters must be
        // pure, React may replay them.
        onReorder(next);
        hapticImpact();
      }

      /* Cleared in the same JS frame as the reorder. Both the reordered badges
         and the zeroed transforms then reach the UI thread on the same frame;
         deferring either one shows the other alone, which reads as the badge
         snapping back before it settles. */
      active.value = -1;
      target.value = -1;
      ox.value = 0;
      oy.value = 0;

      // Sizes measured while the badge was up were held back; take them now.
      syncGeometry();
    },
    [onDragChange, onReorder, active, target, ox, oy, syncGeometry],
  );

  const ctl = useMemo<LineDragCtl>(
    () => ({
      active,
      target,
      ox,
      oy,
      lift,
      ws: wsSV,
      hs: hsSV,
      gridW,
      gridH,
      reduced: reducedSV,
      onLift,
      onTarget,
      onDrop,
      onMeasure,
    }),
    [active, target, ox, oy, lift, wsSV, hsSV, gridW, gridH, reducedSV, onLift, onTarget, onDrop, onMeasure],
  );

  return (
    <View style={s.linesSection}>
      <View style={s.sectionRow}>
        <Text style={s.sectionLabel}>Saved Lines</Text>
        {/* The only advertisement a long press gets. */}
        {lines.length > 1 && <Text style={s.sectionHint}>Hold a badge to reorder</Text>}
      </View>
      <View style={s.lineGrid} onLayout={onGridLayout}>
        {lines.map((fav, i) => (
          <LineChip
            key={fav.lineCode}
            fav={fav}
            index={i}
            count={lines.length}
            editing={editing}
            accentColor={accentColor}
            ctl={ctl}
            onOpen={onOpen}
            onRemove={onRemove}
            onMove={onMove}
          />
        ))}
      </View>
    </View>
  );
});

/* ── Header live indicator ───────────────────────────────────── */

/**
 * Its own component on purpose: the arrivals summary changes on every poll and
 * the countdown once a second, and Home is a screen full of live cards. This
 * way a tick re-renders one line of text instead of all of them.
 */
const HeaderLive = React.memo(function HeaderLive({
  codes,
  paused,
}: {
  codes: string[];
  paused: boolean;
}) {
  const { updatedAt, failing, fetching } = useArrivalsStatus(codes);
  const nextPollAt = useArrivalsPollAt();
  const online = useNetworkStatus();

  return (
    <LiveStatus
      updatedAt={updatedAt}
      nextPollAt={nextPollAt}
      intervalMs={ARRIVALS_POLL_MS}
      fetching={fetching}
      offline={!online}
      failing={failing}
      paused={paused}
    />
  );
});

/* ── Home Screen ─────────────────────────────────────────────── */

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const prefetchLine = usePrefetchLine();
  const { primaryColor, setPrimaryColor, iconStyle, setIconStyle } = useSettings();
  const reduced = useReduceMotion();

  /* Seeded from storage's synchronous mirror. These used to start empty and be
     filled in useFocusEffect — which runs after commit, so frame 1 told every
     existing user "No favorites yet" on every cold start. */
  const [favorites, setFavorites] = useState<FavoriteLine[]>(getFavorites);
  const [favoriteStops, setFavoriteStops] = useState<FavoriteStop[]>(getFavoriteStops);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Home stays mounted under /search, /map/* and /planner, so cards must be
   *  told to stop polling rather than relying on unmount. */
  const [focused, setFocused] = useState(true);
  /** A saved-line badge is being carried. The canvas must not scroll under it
   *  by touch. */
  const [linesDragging, setLinesDragging] = useState(false);

  // Offline data download state
  const [offlineAvailable, setOfflineAvailable] = useState(isOfflineDataDownloaded);
  const [offlineTs, setOfflineTs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<OfflineProgress | null>(null);

  // Preload lines cache in background
  useLines();

  /* ── Canvas geometry ───────────────────────────────────────── */

  /** Measured heights of the cards that still size themselves, by stop code —
   *  not by index, because saving or removing a stop renumbers every index and
   *  resizes nothing. Cards run from two rows to ten and grow again when a
   *  timetable is expanded, so nothing here may assume a fixed height. */
  const heightsRef = useRef<Map<string, number>>(new Map());
  /** Bumped when a measurement actually changes, purely to re-run `placeAll`.
   *  The map stays a ref: a card reporting the height it reported last frame
   *  must not cost a render, and there are up to twenty of them each doing it
   *  on every poll. */
  const [heightsVersion, setHeightsVersion] = useState(0);
  const entranceRef = useRef(true);

  /* The canvas's usable width — the unit every stored layout number is a
     fraction of. Seeded from the window rather than left at zero until the
     first onLayout: frame 1 would otherwise stack every card at width zero,
     and this screen has already been through one round of the first frame
     lying to existing users. */
  const { width: windowW } = useWindowDimensions();
  const [measuredW, setMeasuredW] = useState(0);
  const canvasW = measuredW > 0 ? measuredW : Math.max(1, windowW - spacing.lg * 2);

  /* Rotation. Without this the stale measurement places one frame of cards at
     the previous orientation's width, which at 90° is a visible lurch. */
  useEffect(() => {
    setMeasuredW(0);
  }, [windowW]);

  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    setMeasuredW((prev) => (Math.abs(prev - width) < 1 ? prev : width));
  }, []);

  const onMeasure = useCallback((stopCode: string, height: number) => {
    const prev = heightsRef.current.get(stopCode);
    // Sub-pixel churn from a re-render is not a new measurement.
    if (prev != null && Math.abs(prev - height) < 1) return;
    heightsRef.current.set(stopCode, height);
    setHeightsVersion((v) => v + 1);
  }, []);

  /**
   * Where every card sits.
   *
   * `heightsVersion` rather than the map itself is the dependency: the map is
   * mutated in place so its identity never changes, and the counter is the only
   * honest signal that its contents did.
   */
  const placed = useMemo(
    () => placeAll(favoriteStops, heightsRef.current, canvasW),
    [favoriteStops, canvasW, heightsVersion],
  );

  /**
   * Re-fit placed cards to the canvas.
   *
   * Fractions carry an arrangement across devices and orientations on their
   * own; what they cannot carry is the 120dp legibility floor, so a narrower
   * screen may need a card widened and everything it then collides with moved.
   * The other way in is an imported backup, which can carry an arrangement from
   * a phone of any size, so this watches the stops as well as the width.
   *
   * `fitAll` returns only what actually changed, which is what stops this from
   * chasing its own tail: the write it triggers re-runs the effect, the second
   * pass finds nothing to do, and the overwhelmingly common case — same phone,
   * same orientation, every launch — writes nothing at all.
   */
  useEffect(() => {
    const changed = fitAll(favoriteStops, canvasW);
    if (changed.size === 0) return;
    const patches = new Map<string, Partial<FavoriteStop>>();
    changed.forEach((rect, stopCode) => patches.set(stopCode, { layout: rect }));
    setFavoriteStops(updateFavoriteStops(patches));
  }, [favoriteStops, canvasW]);

  useEffect(() => {
    const t = setTimeout(() => {
      entranceRef.current = false;
    }, 900);
    return () => clearTimeout(t);
  }, []);

  /* ── Favorites ─────────────────────────────────────────────── */

  const loadFavorites = useCallback(() => {
    setFavorites(getFavorites());
    setFavoriteStops(getFavoriteStops());
    setOfflineAvailable(isOfflineDataDownloaded());
    getOfflineTimestamp().then(setOfflineTs);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      loadFavorites();
      return () => setFocused(false);
    }, [loadFavorites]),
  );

  const handleRemove = useCallback((fav: FavoriteLine) => {
    hapticImpact();
    // Captured before the write: `removeFavorite` swaps the mirror for a new
    // array, so this reference stays the pre-removal list.
    const before = getFavorites().slice();
    setFavorites(removeFavorite(fav.lineCode));
    showUndo({
      message: `Removed line ${fav.lineId}`,
      onUndo: () => setFavorites(restoreLines(before)),
    });
  }, []);

  /** Commit a dragged line order. */
  const handleReorderLines = useCallback((next: FavoriteLine[]) => {
    setFavorites(next);
    // Outside the state updater: updaters must be pure, React may replay them.
    persistLineOrder(next);
  }, []);

  /** Move a saved line by one position — the accessible counterpart to the
   *  drag, and the only path a screen reader can drive. Reads the order from
   *  storage's mirror rather than from state so the callback stays stable, and
   *  therefore so does the list footer it is handed to. */
  const moveLine = useCallback((fav: FavoriteLine, delta: number) => {
    const cur = getFavorites();
    const i = cur.findIndex((f) => f.lineCode === fav.lineCode);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.length) return;
    const next = cur.slice();
    next[i] = cur[j];
    next[j] = cur[i];
    setFavorites(next);
    hapticSelection();
    persistLineOrder(next);
  }, []);

  const handleOpenLine = useCallback((fav: FavoriteLine) => {
    // Start the request the map screen would otherwise wait to make, so it runs
    // under the push transition instead of after it.
    prefetchLine(fav.lineCode);
    router.push({
      pathname: '/map/[lineCode]',
      params: { lineCode: fav.lineCode, lineId: fav.lineId, lineDescr: fav.lineDescrEng },
    });
  }, [router, prefetchLine]);

  const handleRemoveStop = useCallback((stop: FavoriteStop) => {
    hapticImpact();
    const before = getFavoriteStops().slice();
    setFavoriteStops(removeFavoriteStop(stop.stopCode));
    showUndo({
      message: `Removed “${stop.stopName}”`,
      onUndo: () => setFavoriteStops(restoreStops(before)),
    });
  }, []);

  /** Reorder by one position. The accessible counterpart to the drag: this is
   *  the path a screen reader can actually drive. The storage write stays
   *  outside the state updater — updaters must be pure, React may replay them. */
  const moveStop = useCallback((stop: FavoriteStop, delta: number) => {
    const i = favoriteStops.findIndex((st) => st.stopCode === stop.stopCode);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= favoriteStops.length) return;
    const next = favoriteStops.slice();
    next[i] = favoriteStops[j];
    next[j] = favoriteStops[i];
    setFavoriteStops(next);
    hapticSelection();
    persistStopOrder(next);
  }, [favoriteStops]);

  const moveStopUp = useCallback((stop: FavoriteStop) => moveStop(stop, -1), [moveStop]);
  const moveStopDown = useCallback((stop: FavoriteStop) => moveStop(stop, 1), [moveStop]);

  /**
   * Pull to refresh. This used to call `loadFavorites()` between two batched
   * `setRefreshing` calls — the spinner never appeared and no arrival data was
   * ever refetched. It is the most natural gesture in a bus app.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    loadFavorites();
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['arrivals'] }),
        queryClient.refetchQueries({ queryKey: ['routesForStop'] }),
      ]);
    } catch {
      // A failed refresh is surfaced per-card; the spinner must still stop.
    } finally {
      setRefreshing(false);
    }
  }, [loadFavorites, queryClient]);

  const handleDownloadOffline = useCallback(async () => {
    setDownloading(true);
    setDlProgress(null);
    const ok = await downloadAllOfflineData((p) => setDlProgress(p));
    setDownloading(false);
    if (ok) {
      setOfflineAvailable(true);
      getOfflineTimestamp().then(setOfflineTs);
    }
  }, []);

  /* Still a dialog, unlike the removals above: this one deletes a bundle that
     takes minutes to re-download, so it is neither cheap nor reversible. */
  const handleClearOffline = useCallback(() => {
    Alert.alert('Clear Offline Data', 'This will remove all cached stops and schedules.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await removeAllOfflineData();
          setOfflineAvailable(false);
          setOfflineTs(null);
          setDlProgress(null);
        },
      },
    ]);
  }, []);

  /* ── Canvas plumbing ───────────────────────────────────────── */

  const stopsHeader = useMemo(
    () =>
      favoriteStops.length > 0 ? (
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>Saved Stops</Text>
        </View>
      ) : null,
    [favoriteStops.length],
  );

  const listFooter = useMemo(
    () =>
      favorites.length > 0 ? (
        <SavedLines
          lines={favorites}
          editing={editing}
          accentColor={primaryColor}
          onOpen={handleOpenLine}
          onRemove={handleRemove}
          onReorder={handleReorderLines}
          onMove={moveLine}
          onDragChange={setLinesDragging}
        />
      ) : null,
    [favorites, editing, primaryColor, handleOpenLine, handleRemove, handleReorderLines, moveLine],
  );

  /** Which stops the header's freshness readout speaks for. The map screens
   *  also populate `['arrivals', …]`, for stops nobody has saved. */
  const stopCodes = useMemo(() => favoriteStops.map((st) => st.stopCode), [favoriteStops]);

  const isEmpty = favorites.length === 0 && favoriteStops.length === 0;
  const canEdit = !isEmpty;
  const onPrimary = onAccent(primaryColor);

  return (
    <View style={[s.container, { paddingTop: insets.top + spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <View style={s.logoRow}>
          <Pressable
            style={s.avatarBtn}
            onPress={() => setShowSettings(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Image source={{ uri: USER_MARKER_BASE64 }} style={s.logoIcon} />
          </Pressable>
          {/* Wears the accent color: it was the one piece of chrome the
              setting never reached. */}
          <Text style={[s.logo, { color: primaryColor }]}>F*ck OASA</Text>
          {canEdit && (
            <Pressable
              style={s.editBtn}
              onPress={() => setEditing((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ selected: editing }}
              accessibilityLabel={editing ? 'Finish editing saved items' : 'Edit saved items'}
            >
              <Ionicons
                name={editing ? 'checkmark' : 'create-outline'}
                size={16}
                color={editing ? primaryColor : colors.textMuted}
              />
              <Text style={[s.editBtnText, { color: editing ? primaryColor : colors.textMuted }]}>
                {editing ? 'Done' : 'Edit'}
              </Text>
            </Pressable>
          )}
        </View>

        <Pressable
          style={s.searchBtn}
          onPress={() => router.push('/search')}
          accessibilityRole="button"
          accessibilityLabel="Search for a bus line"
        >
          <Ionicons name="search" size={20} color={colors.text} />
          <Text style={s.searchBtnText} numberOfLines={1}>Find a line…</Text>
        </Pressable>

        <View style={s.actionRow}>
          <Pressable
            style={s.actionBtn}
            onPress={() => router.push('/map/nearby')}
            accessibilityRole="button"
            accessibilityLabel="Stops near me"
          >
            <Ionicons name="location" size={20} color={primaryColor} />
            <Text style={s.actionBtnText}>Nearby</Text>
          </Pressable>
          <Pressable
            style={s.actionBtn}
            onPress={() => router.push('/planner')}
            accessibilityRole="button"
            accessibilityLabel="Plan a journey"
          >
            <Ionicons name="navigate" size={20} color={primaryColor} />
            <Text style={s.actionBtnText}>Go To</Text>
          </Pressable>
        </View>

        {/* Dismissing the settings sheet used to hide an in-flight download
            entirely, with no way to tell whether it was still running. */}
        {downloading && !showSettings && (
          <View style={s.headerProgress} accessibilityLabel="Downloading offline data">
            <Text style={s.headerProgressText}>Offline data…</Text>
            <View style={s.headerProgressTrack}>
              <View
                style={[
                  s.headerProgressFill,
                  {
                    backgroundColor: primaryColor,
                    width: dlProgress && dlProgress.total > 0
                      ? `${Math.round((dlProgress.current / dlProgress.total) * 100)}%`
                      : '5%',
                  },
                ]}
              />
            </View>
          </View>
        )}

        {/* One indicator for the whole screen. The cards used to carry one
            each, which was six components counting the same seconds and none
            of them able to say when the next refresh was due. */}
        {favoriteStops.length > 0 && <HeaderLive codes={stopCodes} paused={!focused} />}
      </View>

      {isEmpty ? (
        <View style={s.empty}>
          <Ionicons name="bus-outline" size={48} color={colors.border} />
          <Text style={s.emptyTitle}>Nothing saved yet</Text>
          <Text style={s.emptySubtitle}>
            Save the stops you use and their arrivals show up here.
          </Text>
          <View style={s.emptyActions}>
            <Pressable
              style={[s.emptyPrimaryBtn, { backgroundColor: primaryColor }]}
              onPress={() => router.push('/map/nearby')}
              accessibilityRole="button"
              accessibilityLabel="Find stops near me"
            >
              <Ionicons name="location" size={18} color={onPrimary} />
              <Text style={[s.emptyPrimaryText, { color: onPrimary }]}>Find stops near me</Text>
            </Pressable>
            <Pressable
              style={s.emptySecondaryBtn}
              onPress={() => router.push('/search')}
              accessibilityRole="button"
              accessibilityLabel="Search for a bus line"
            >
              <Ionicons name="search" size={18} color={colors.text} />
              <Text style={s.emptySecondaryText}>Search a line</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + spacing.xl * 2 }]}
          // A carried saved-line badge would otherwise fight the canvas for the
          // same finger.
          scrollEnabled={!linesDragging}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          showsVerticalScrollIndicator={false}
        >
          {stopsHeader}
          {/* Every card is absolutely positioned inside this box, so the box
              has to be told how tall it is — nothing inside it contributes to
              its height, and without that the saved lines below would sit on
              top of the stops. `placed.cards` is built from `favoriteStops` in
              the same pass, so the two are indexed alike by construction. */}
          {favoriteStops.length > 0 && (
            <View style={[s.canvas, { height: placed.height }]} onLayout={onCanvasLayout}>
              {favoriteStops.map((stop, i) => (
                <StopCard
                  key={stop.stopCode}
                  stop={stop}
                  index={i}
                  count={favoriteStops.length}
                  card={placed.cards[i]}
                  primaryColor={primaryColor}
                  focused={focused}
                  editing={editing}
                  entrance={entranceRef.current}
                  reduced={reduced}
                  onMeasure={onMeasure}
                  onRemove={handleRemoveStop}
                  onMoveUp={moveStopUp}
                  onMoveDown={moveStopDown}
                />
              ))}
            </View>
          )}
          {listFooter}
        </ScrollView>
      )}

      <SettingsModal
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        primaryColor={primaryColor}
        setPrimaryColor={setPrimaryColor}
        iconStyle={iconStyle}
        setIconStyle={setIconStyle}
        offlineAvailable={offlineAvailable}
        offlineTs={offlineTs}
        downloading={downloading}
        progress={dlProgress}
        onDownload={handleDownloadOffline}
        onClear={handleClearOffline}
        onDataRestored={loadFavorites}
      />
    </View>
  );
}
