/**
 * Home Screen — saved stops first, then saved lines.
 *
 * The saved stops are the answer to "when is my bus coming?", so they are the
 * list itself: a real virtualized FlatList, not a ScrollView wearing a FlatList
 * costume with everything crammed into ListHeaderComponent.
 *
 * Two interactions are worth explaining up front.
 *
 * Reordering. Holding a card — or a saved-line badge — lifts it and the
 * neighbours open a gap. Both are backed by an accessible equivalent, because a
 * drag is not operable with a screen reader: chevrons in edit mode for the
 * cards, `moveLeft` / `moveRight` accessibility actions for the badges, which
 * are 44dp and have no room for chevrons. Those are the accessible path, not a
 * leftover. The maths behind the two is not shared — a list is one-dimensional
 * and a wrapping grid is not; see the geometry section below.
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
  FlatList,
  RefreshControl,
  Alert,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type CellRendererProps,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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

/* ── Drag-to-reorder ─────────────────────────────────────────── */

/** Hold before a card lifts. Long enough not to fire mid-scroll, short enough
 *  that the lift reads as a response rather than a delay. */
const LIFT_MS = 260;
const LIFT_SCALE = 1.03;

/** Row pitch assumed for a card the list has not mounted yet. Only the drop
 *  maths for off-screen rows leans on it, and it self-corrects to the mean of
 *  the measured cards as soon as anything has been laid out. */
const FALLBACK_PITCH = 168;

/** A held card near the edge of the list scrolls it, so a stop can be moved
 *  further than one screenful without putting it down. */
const EDGE_BAND = 96;
const EDGE_MAX_STEP = 16;
const EDGE_TICK_MS = 16;

/** Cards below this index get the first-paint entrance; the rest are scrolled
 *  to, and an animation on arrival would read as lag. */
const ENTRANCE_CARDS = 8;

/**
 * Where a card lifted from index `a` comes to rest if it is dropped at `k`.
 *
 * Stated in the *original* layout, which is what the drag maths has: dropping
 * at k puts the card after the first k cards of the list-with-it-removed, so
 * everything past its old slot has already closed the gap it left behind.
 */
function restingTop(k: number, a: number, tops: number[], pitches: number[]): number {
  'worklet';
  return k <= a ? tops[k] : tops[k] + pitches[k] - pitches[a];
}

/** The slot a card lifted from `a` is closest to, given its current top.
 *  Nearest-candidate rather than counting crossed midpoints, because the cards
 *  are of wildly different heights — a two-line stop next to an eight-line one. */
function slotFor(top: number, a: number, tops: number[], pitches: number[]): number {
  'worklet';
  let best = a;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let k = 0; k < tops.length; k++) {
    const d = Math.abs(restingTop(k, a, tops, pitches) - top);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

/** Keep a lifted card inside the run of stop cards. */
function clampOffset(
  a: number,
  raw: number,
  tops: number[],
  pitches: number[],
  contentH: number,
): number {
  'worklet';
  const min = -tops[a];
  const max = contentH - pitches[a] - tops[a];
  return raw < min ? min : raw > max ? max : raw;
}

/**
 * Everything a cell needs to take part in a drag. One object, created once —
 * see the warning where it is built.
 */
interface DragCtl {
  /** Index of the lifted card, -1 when nothing is held. */
  active: SharedValue<number>;
  /** Index the lifted card would land on if dropped now. */
  target: SharedValue<number>;
  /** The lifted card's travel from its laid-out position, in content px. */
  offset: SharedValue<number>;
  /** Raw gesture translation, kept separately so the edge auto-scroll can add
   *  its own contribution without the finger having moved. */
  pan: SharedValue<number>;
  lift: SharedValue<number>;
  /** Finger position in window coordinates — drives the edge auto-scroll. */
  pointerY: SharedValue<number>;
  scrollY: SharedValue<number>;
  scrollAt: SharedValue<number>;
  tops: SharedValue<number[]>;
  pitches: SharedValue<number[]>;
  contentH: SharedValue<number>;
  /** For worklets. Anything reading this on the React side wants `reducedRef`:
   *  `sv.value` from JS is a synchronous hop into the UI runtime, and doing it
   *  during a render also trips reanimated's own warning. */
  reduced: SharedValue<boolean>;
  reducedRef: React.RefObject<boolean>;
  /** True for the first moment after mount — gates the entrance stagger so a
   *  card scrolled into view later does not fade in as if it were new. */
  entrance: React.RefObject<boolean>;
  onLift: (index: number) => void;
  /** A drop target was crossed. Mirrors it back to JS so the auto-scroll tick
   *  does not have to read the shared value to know where it stands. */
  onTarget: (index: number) => void;
  onDrop: (from: number, to: number) => void;
  onMeasure: (stopCode: string, height: number) => void;
}

/**
 * Build the FlatList cell wrapper.
 *
 * The transform has to live on the cell, not inside `renderItem`: a lifted card
 * travels across its neighbours, and only the cell view is a sibling of the
 * cells it needs to be painted over.
 */
function createStopCell(ctl: DragCtl) {
  return function StopCell({
    index,
    item,
    style,
    onLayout,
    children,
  }: CellRendererProps<FavoriteStop>) {
    const measure = useCallback(
      (e: LayoutChangeEvent) => {
        // VirtualizedList's own metrics come first — dropping this breaks
        // scrollToIndex and the windowing maths.
        onLayout?.(e);
        ctl.onMeasure(item.stopCode, e.nativeEvent.layout.height);
      },
      [onLayout, item.stopCode],
    );

    const gesture = useMemo(
      () =>
        Gesture.Pan()
          .activateAfterLongPress(LIFT_MS)
          .maxPointers(1)
          .onStart((e) => {
            // One saved stop cannot be reordered; leave the card alone rather
            // than lifting it to nowhere.
            if (ctl.pitches.value.length < 2 || index >= ctl.pitches.value.length) return;
            /* The previous card is still settling into its slot and has not
               committed yet. Lifting a second one now would let that pending
               commit clear `active` out from under this drag. */
            if (ctl.active.value >= 0) return;
            ctl.active.value = index;
            ctl.target.value = index;
            ctl.pan.value = 0;
            ctl.offset.value = 0;
            ctl.scrollAt.value = ctl.scrollY.value;
            ctl.pointerY.value = e.absoluteY;
            ctl.lift.value = ctl.reduced.value ? 1 : withSpring(LIFT_SCALE, liftSpring);
            runOnJS(ctl.onLift)(index);
          })
          .onUpdate((e) => {
            if (ctl.active.value !== index) return;
            const tops = ctl.tops.value;
            const pitches = ctl.pitches.value;
            if (index >= tops.length) return;
            ctl.pan.value = e.translationY;
            ctl.pointerY.value = e.absoluteY;
            /* The card's travel is the gesture *plus* however far the list has
               auto-scrolled: the finger holding still while the content moves
               under it is still the card moving through the list. */
            ctl.offset.value = clampOffset(
              index,
              e.translationY + (ctl.scrollY.value - ctl.scrollAt.value),
              tops,
              pitches,
              ctl.contentH.value,
            );
            const k = slotFor(tops[index] + ctl.offset.value, index, tops, pitches);
            if (k !== ctl.target.value) {
              ctl.target.value = k;
              runOnJS(ctl.onTarget)(k);
            }
          })
          /* onFinalize rather than onEnd: a gesture cancelled from outside — a
             call arriving, a navigation — must still put the card down, and
             must still commit where the user had already moved it to. */
          .onFinalize(() => {
            if (ctl.active.value !== index) return;
            const k = ctl.target.value;
            const tops = ctl.tops.value;
            const rest =
              index < tops.length ? restingTop(k, index, tops, ctl.pitches.value) - tops[index] : 0;
            ctl.lift.value = withSpring(1, liftSpring);
            if (ctl.reduced.value) {
              ctl.offset.value = rest;
              runOnJS(ctl.onDrop)(index, k);
            } else {
              /* Commit once the card has physically landed. The neighbours are
                 already sitting in the new order by then, so the data swap that
                 follows changes nothing on screen. */
              ctl.offset.value = withSpring(rest, liftSpring, () => {
                runOnJS(ctl.onDrop)(index, k);
              });
            }
          }),
      [index],
    );

    /** How far this card slides to open (or close) the gap. */
    const shift = useDerivedValue(() => {
      const a = ctl.active.value;
      if (a < 0 || a === index) return 0;
      const k = ctl.target.value;
      const pitch = ctl.pitches.value[a] ?? 0;
      const to = a < index && index <= k ? -pitch : k <= index && index < a ? pitch : 0;
      return ctl.reduced.value ? to : withSpring(to, spring);
    });

    const animStyle = useAnimatedStyle(() => {
      const held = ctl.active.value === index;
      return {
        transform: [
          { translateY: held ? ctl.offset.value : shift.value },
          { scale: held ? ctl.lift.value : 1 },
        ],
        zIndex: held ? 2 : 0,
        elevation: held ? 10 : 0,
      };
    });

    /* Read during render on purpose: cells mount over the first few frames, so
       whether a given card is part of the first paint is a question only its
       own mount can answer. */
    const entering =
      ctl.entrance.current && !ctl.reducedRef.current && index < ENTRANCE_CARDS
        ? FadeInDown.duration(duration.slow).delay(index * 45).easing(easing.out)
        : undefined;

    return (
      <Animated.View style={[style, s.stopCell, animStyle]} onLayout={measure}>
        <GestureDetector gesture={gesture}>
          <Animated.View entering={entering}>{children}</Animated.View>
        </GestureDetector>
      </Animated.View>
    );
  };
}

/* ── Saved lines: the grid's own geometry ────────────────────── */

/**
 * None of the stop drag's maths transfers here.
 *
 * A list is one-dimensional: every card has the same width, so a neighbour only
 * ever moves by one row pitch and `restingTop` can be a scalar. The line grid
 * wraps, and its badges are content-sized — a 2-digit line and a 4-digit one are
 * different widths, and both grow with the system font scale. Inserting a badge
 * mid-grid reflows the tail *across row boundaries*, so every other badge's
 * travel is a different (dx, dy), and "which slot am I over?" is a nearest-point
 * search in two dimensions rather than a count of crossed midpoints.
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
  /** A card is being carried. The list must not scroll under it by touch. */
  const [dragging, setDragging] = useState(false);
  /** The same, for a saved-line badge. Separate state so the two drags cannot
   *  clear each other's flag. */
  const [linesDragging, setLinesDragging] = useState(false);

  // Offline data download state
  const [offlineAvailable, setOfflineAvailable] = useState(isOfflineDataDownloaded);
  const [offlineTs, setOfflineTs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<OfflineProgress | null>(null);

  // Preload lines cache in background
  useLines();

  /* ── Drag state ────────────────────────────────────────────── */

  const listRef = useRef<FlatList<FavoriteStop>>(null);
  /** The list as the drag maths sees it, readable from a gesture callback
   *  without waiting for a render. */
  const stopsRef = useRef<FavoriteStop[]>(favoriteStops);
  /** Measured cell heights by stop code. Cards vary from two rows to ten, and
   *  grow again when a timetable is expanded, so nothing here can assume a
   *  fixed row height. */
  const heightsRef = useRef<Map<string, number>>(new Map());
  const pitchesRef = useRef<number[]>([]);
  const topsRef = useRef<number[]>([]);
  const contentHRef = useRef(0);
  const scrollRef = useRef(0);
  const scrollMaxRef = useRef(0);
  const viewportRef = useRef({ top: 0, height: 0 });
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const entranceRef = useRef(true);
  const reducedRef = useRef(false);
  /* JS mirrors of the three drag values the auto-scroll tick needs 60 times a
     second. Reading a shared value from JS is a *synchronous* hop into the UI
     runtime — cheap once, not cheap in a frame loop competing with the drag it
     is meant to serve. `pointerY` and `pan` still have to be read, so the tick
     reads `pointerY` first and bails before touching `pan` unless it is
     actually going to scroll. */
  const activeRef = useRef(-1);
  const targetRef = useRef(-1);
  const scrollAtRef = useRef(0);

  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const offset = useSharedValue(0);
  const pan = useSharedValue(0);
  const lift = useSharedValue(1);
  const pointerY = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const scrollAt = useSharedValue(0);
  const topsSV = useSharedValue<number[]>([]);
  const pitchesSV = useSharedValue<number[]>([]);
  const contentHSV = useSharedValue(0);
  const reducedSV = useSharedValue(false);

  useEffect(() => {
    reducedRef.current = reduced;
    reducedSV.value = reduced;
  }, [reduced, reducedSV]);

  useEffect(() => {
    const t = setTimeout(() => {
      entranceRef.current = false;
    }, 900);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => () => {
    if (edgeTimer.current) clearInterval(edgeTimer.current);
  }, []);

  /**
   * Rebuild the row geometry the drag maths runs on, in both a JS copy (for the
   * auto-scroll tick) and a shared copy (for the gesture worklets).
   *
   * Skipped while a card is up: an arrival landing and growing a row mid-drag
   * would slide every drop target out from under the user's finger.
   */
  const syncGeometry = useCallback(() => {
    if (activeRef.current >= 0) return;
    const stops = stopsRef.current;
    const known = [...heightsRef.current.values()];
    const fallback =
      known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : FALLBACK_PITCH;
    const pitches: number[] = [];
    const tops: number[] = [];
    let acc = 0;
    for (const st of stops) {
      const p = heightsRef.current.get(st.stopCode) ?? fallback;
      pitches.push(p);
      tops.push(acc);
      acc += p;
    }
    pitchesRef.current = pitches;
    topsRef.current = tops;
    contentHRef.current = acc;
    pitchesSV.value = pitches;
    topsSV.value = tops;
    contentHSV.value = acc;
  }, [pitchesSV, topsSV, contentHSV]);

  const onMeasure = useCallback(
    (stopCode: string, height: number) => {
      const prev = heightsRef.current.get(stopCode);
      // Sub-pixel churn from a re-render is not a new measurement.
      if (prev != null && Math.abs(prev - height) < 1) return;
      heightsRef.current.set(stopCode, height);
      syncGeometry();
    },
    [syncGeometry],
  );

  useEffect(() => {
    stopsRef.current = favoriteStops;
    syncGeometry();
  }, [favoriteStops, syncGeometry]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      scrollRef.current = contentOffset.y;
      scrollY.value = contentOffset.y;
      scrollMaxRef.current = Math.max(0, contentSize.height - layoutMeasurement.height);
    },
    [scrollY],
  );

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    // The list's parent fills the screen from the top, so its own y doubles as
    // the window coordinate the gesture's absoluteY is measured against.
    viewportRef.current = { top: y, height };
  }, []);

  /**
   * One tick of the edge auto-scroll. Runs on a timer rather than off the pan
   * callback, because the case it exists for is a finger held still at the edge
   * of the screen — which produces no pan updates at all.
   */
  const edgeTick = useCallback(() => {
    const a = activeRef.current;
    const vp = viewportRef.current;
    const tops = topsRef.current;
    if (a < 0 || a >= tops.length || vp.height <= 0) return;

    const y = pointerY.value;
    const top = vp.top + EDGE_BAND;
    const bottom = vp.top + vp.height - EDGE_BAND;
    let step = 0;
    if (y < top) step = -EDGE_MAX_STEP * Math.min(1, (top - y) / EDGE_BAND);
    else if (y > bottom) step = EDGE_MAX_STEP * Math.min(1, (y - bottom) / EDGE_BAND);
    if (step === 0) return;

    const next = Math.max(0, Math.min(scrollMaxRef.current, scrollRef.current + step));
    if (Math.abs(next - scrollRef.current) < 0.5) return;
    /* Written optimistically: the onScroll event confirming this offset lands a
       frame later, and the card must not lag behind the content by that frame. */
    scrollRef.current = next;
    scrollY.value = next;
    listRef.current?.scrollToOffset({ offset: next, animated: false });

    /* The finger has not moved, so nothing else will recompute the carried
       card: from its point of view the whole list just slid past it. */
    const pitches = pitchesRef.current;
    const carried = clampOffset(
      a,
      pan.value + (next - scrollAtRef.current),
      tops,
      pitches,
      contentHRef.current,
    );
    offset.value = carried;
    const k = slotFor(tops[a] + carried, a, tops, pitches);
    if (k !== targetRef.current) {
      targetRef.current = k;
      target.value = k;
      hapticSelection();
    }
  }, [pointerY, scrollY, offset, pan, target]);

  const onLift = useCallback((index: number) => {
    activeRef.current = index;
    targetRef.current = index;
    scrollAtRef.current = scrollRef.current;
    hapticImpact();
    setDragging(true);
    if (!edgeTimer.current) edgeTimer.current = setInterval(edgeTick, EDGE_TICK_MS);
  }, [edgeTick]);

  const onTarget = useCallback((index: number) => {
    targetRef.current = index;
    hapticSelection();
  }, []);

  const onDrop = useCallback(
    (from: number, to: number) => {
      if (edgeTimer.current) {
        clearInterval(edgeTimer.current);
        edgeTimer.current = null;
      }
      activeRef.current = -1;
      targetRef.current = -1;
      setDragging(false);

      const stops = stopsRef.current;
      if (from !== to && from >= 0 && from < stops.length && to >= 0 && to < stops.length) {
        const next = stops.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        stopsRef.current = next;
        setFavoriteStops(next);
        // Outside the state updater: updaters must be pure, React may replay them.
        persistStopOrder(next);
        hapticImpact();
      }

      /* Cleared in the same JS frame as the reorder. Both the reordered rows
         and the zeroed transforms then reach the UI thread on the same frame;
         deferring either one shows the other alone for a frame, which reads as
         the card snapping back before it settles. */
      active.value = -1;
      target.value = -1;
      offset.value = 0;
      pan.value = 0;

      // Heights measured while the card was up were held back; take them now.
      syncGeometry();
    },
    [active, target, offset, pan, syncGeometry],
  );

  /**
   * Every field here is stable, and it has to be: this object is baked into the
   * `CellRendererComponent` identity below, and a new component type there
   * remounts every card — tearing down the live arrival queries they own.
   */
  const drag = useMemo<DragCtl>(
    () => ({
      active,
      target,
      offset,
      pan,
      lift,
      pointerY,
      scrollY,
      scrollAt,
      tops: topsSV,
      pitches: pitchesSV,
      contentH: contentHSV,
      reduced: reducedSV,
      reducedRef,
      entrance: entranceRef,
      onLift,
      onTarget,
      onDrop,
      onMeasure,
    }),
    [
      active, target, offset, pan, lift, pointerY, scrollY, scrollAt,
      topsSV, pitchesSV, contentHSV, reducedSV, onLift, onTarget, onDrop, onMeasure,
    ],
  );

  const StopCell = useMemo(() => createStopCell(drag), [drag]);

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

  /* ── List plumbing ─────────────────────────────────────────── */

  const listExtra = useMemo(
    () => ({ primaryColor, focused, editing, count: favoriteStops.length }),
    [primaryColor, focused, editing, favoriteStops.length],
  );

  const renderStop = useCallback(
    ({ item, index }: ListRenderItemInfo<FavoriteStop>) => (
      <FavoriteStopCard
        stop={item}
        primaryColor={primaryColor}
        active={focused}
        editing={editing}
        onRemove={handleRemoveStop}
        onMoveUp={moveStopUp}
        onMoveDown={moveStopDown}
        canMoveUp={index > 0}
        canMoveDown={index < favoriteStops.length - 1}
      />
    ),
    [primaryColor, focused, editing, handleRemoveStop, moveStopUp, moveStopDown, favoriteStops.length],
  );

  const listHeader = useMemo(
    () =>
      favoriteStops.length > 0 ? (
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>Saved Stops</Text>
          {/* The only advertisement a long press gets. */}
          {favoriteStops.length > 1 && <Text style={s.sectionHint}>Hold a card to reorder</Text>}
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
        <FlatList
          ref={listRef}
          data={favoriteStops}
          keyExtractor={(item) => item.stopCode}
          renderItem={renderStop}
          extraData={listExtra}
          CellRendererComponent={StopCell}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + spacing.xl * 2 }]}
          initialNumToRender={4}
          windowSize={5}
          // Cards contain nested ScrollViews (timetable grid, line filter),
          // which Android blanks out when their cell is clipped.
          removeClippedSubviews={false}
          // A carried card — or badge — would otherwise fight the list for the
          // same finger.
          scrollEnabled={!dragging && !linesDragging}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onLayout={onListLayout}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
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
